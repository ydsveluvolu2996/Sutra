// Governance policy CRUD. Auth mirrors the FinOps allocation-rules route: the
// tenant scope is resolved from the org's latest cloud connection and the
// capability is checked against THAT customer, never against a caller-supplied
// org or customer. Reads need `connection:read`; every mutation needs
// `connection:manage` plus a same-origin check (these are browser-form writes).
//
// GET also returns a live evaluation of the stored policies against the signals
// Sutra has already computed for the selected billing period (budget burn-down,
// cost anomalies, allocation coverage). Signals that need collector inputs this
// route does not load are simply absent — the engine discloses them as
// unavailable and never treats a missing signal as zero.
import { AllocationRuleRepository } from "../../../../../db/allocation-rules-repository";
import { FinopsWorkspaceRepository } from "../../../../../db/finops-workspace-repository";
import { governancePublicError, GovernancePolicyRepository } from "../../../../../db/governance-policy-repository";
import type {
  GovernancePolicyInput,
  GovernancePolicyPatch,
} from "../../../../../db/governance-policy-repository";
import {
  evaluateGovernancePolicies,
  GOVERNANCE_ACTION_DESCRIPTORS,
  GOVERNANCE_SIGNAL_DESCRIPTORS,
  isGovernanceActionKind,
  type GovernanceCondition,
  type GovernanceSignals,
} from "../../../../../lib/governance-policy-engine";
import { buildBudgetBurndown } from "../../../../../lib/finops-budget-burndown";
import { detectAnomalies } from "../../../../../lib/finops-insights";
import { applyAllocationRules } from "../../../../../lib/finops-allocation-rules";
import { requireConnectionScope } from "../../../../../lib/api-connection-scope";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const POLICY_ID = /^gpol_[a-f0-9]{32}$/u;
const BODY_BYTES = 16384;

async function resolveScope(request: Request, capability: "connection:read" | "connection:manage") {
  return requireConnectionScope(request, capability);
}

function badRequest(): never {
  throw Object.assign(new Error("The governance-policy request is invalid"), { code: "INVALID_INPUT" });
}

/** Days in the calendar month named by a `YYYY-MM` period (no wall clock). */
function daysInBillingMonth(period: string): number {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Build the signal set from data already ingested for this tenant. Nothing is
 * fabricated: when there is no billing period yet, every FinOps signal is left
 * absent so the engine reports "signal-unavailable" instead of a false negative.
 */
async function buildSignals(
  scope: { orgId: string; customerId: string },
  connectionId: string,
  requestedPeriod: string | null,
): Promise<{ signals: GovernanceSignals; period: string | null }> {
  const workspace = new FinopsWorkspaceRepository();
  const periods = await workspace.listPeriods(scope, connectionId);
  const period = requestedPeriod ?? periods[0]?.period ?? null;
  if (period === null) return { signals: {}, period: null };
  const lines = await workspace.linesForPeriod(scope, connectionId, period);
  const budgets = await workspace.listBudgets(scope);
  // "As of" is the latest usage day PRESENT in the ingested lines, matching the
  // billing file rather than today — the same rule the burn-down route uses.
  let asOfDayIndex = 0;
  for (const line of lines) {
    if (line.usageStartIso.slice(0, 7) !== period) continue;
    const day = Number(line.usageStartIso.slice(8, 10));
    if (Number.isInteger(day) && day > asOfDayIndex) asOfDayIndex = day;
  }
  const allocationRules = await new AllocationRuleRepository().list(scope);
  return {
    period,
    signals: {
      budgetBurndown: buildBudgetBurndown({
        budgets,
        dailyLines: lines,
        period,
        asOfDayIndex,
        daysInMonth: daysInBillingMonth(period),
      }),
      anomalies: detectAnomalies(lines),
      allocation: applyAllocationRules(lines, allocationRules),
    },
  };
}

function readCondition(value: unknown): GovernanceCondition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) badRequest();
  // Shape validation (depth, node budget, leaf field types) is the repository's
  // single authoritative check; this only rejects obvious non-objects early.
  return value as GovernanceCondition;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const period = url.searchParams.get("period");
    if (period !== null && !/^\d{4}-(0[1-9]|1[0-2])$/u.test(period)) badRequest();
    const { connection, scope } = await resolveScope(request, "connection:read");
    const repository = new GovernancePolicyRepository();
    const policies = await repository.list(scope);
    const { signals, period: selectedPeriod } = await buildSignals(scope, connection.id, period);
    const evaluation = evaluateGovernancePolicies(
      policies,
      { orgId: scope.orgId, customerId: scope.customerId, connectionId: connection.id, signals },
      Date.now(),
    );
    return jsonResponse({
      connectionId: connection.id,
      period: selectedPeriod,
      policies,
      evaluation,
      pendingApprovals: await repository.listPendingApprovals(scope),
      actions: GOVERNANCE_ACTION_DESCRIPTORS,
      signals: GOVERNANCE_SIGNAL_DESCRIPTORS,
    });
  } catch (error) {
    return errorResponse(governancePublicError(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body: unknown = await readBoundedJson(request, BODY_BYTES);
    if (typeof body !== "object" || body === null) badRequest();
    const {
      name, priority, condition, actionKind, actionTarget, actionExpiresInDays, actionNote,
      requiresApproval, enabled,
    } = body as Record<string, unknown>;
    if (typeof name !== "string" || typeof actionKind !== "string" || !isGovernanceActionKind(actionKind)) badRequest();
    if (priority !== undefined && typeof priority !== "number") badRequest();
    if (actionTarget !== undefined && actionTarget !== null && typeof actionTarget !== "string") badRequest();
    if (actionExpiresInDays !== undefined && actionExpiresInDays !== null && typeof actionExpiresInDays !== "number") badRequest();
    if (actionNote !== undefined && actionNote !== null && typeof actionNote !== "string") badRequest();
    if (requiresApproval !== undefined && typeof requiresApproval !== "boolean") badRequest();
    if (enabled !== undefined && typeof enabled !== "boolean") badRequest();
    const { authenticated, connection, scope } = await resolveScope(request, "connection:manage");
    const input: GovernancePolicyInput = {
      name,
      priority: priority as number | undefined,
      condition: readCondition(condition),
      actionKind,
      actionTarget: (actionTarget ?? null) as string | null,
      actionExpiresInDays: (actionExpiresInDays ?? null) as number | null,
      actionNote: (actionNote ?? null) as string | null,
      requiresApproval: requiresApproval as boolean | undefined,
      enabled: enabled as boolean | undefined,
      connectionId: connection.id,
    };
    const repository = new GovernancePolicyRepository();
    const saved = await repository.create(scope, input, authenticated.subject.userId);
    return jsonResponse({ saved, policies: await repository.list(scope) });
  } catch (error) {
    return errorResponse(governancePublicError(error));
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    if (!POLICY_ID.test(id)) badRequest();
    const body: unknown = await readBoundedJson(request, BODY_BYTES);
    if (typeof body !== "object" || body === null) badRequest();
    const {
      name, priority, condition, actionKind, actionTarget, actionExpiresInDays, actionNote,
      requiresApproval, enabled,
    } = body as Record<string, unknown>;
    if (name !== undefined && typeof name !== "string") badRequest();
    if (priority !== undefined && typeof priority !== "number") badRequest();
    if (actionKind !== undefined && (typeof actionKind !== "string" || !isGovernanceActionKind(actionKind))) badRequest();
    if (actionTarget !== undefined && actionTarget !== null && typeof actionTarget !== "string") badRequest();
    if (actionExpiresInDays !== undefined && actionExpiresInDays !== null && typeof actionExpiresInDays !== "number") badRequest();
    if (actionNote !== undefined && actionNote !== null && typeof actionNote !== "string") badRequest();
    if (requiresApproval !== undefined && typeof requiresApproval !== "boolean") badRequest();
    if (enabled !== undefined && typeof enabled !== "boolean") badRequest();
    const patch: GovernancePolicyPatch = {
      name: name as string | undefined,
      priority: priority as number | undefined,
      condition: condition === undefined ? undefined : readCondition(condition),
      actionKind: actionKind as GovernancePolicyPatch["actionKind"],
      actionTarget: actionTarget as string | null | undefined,
      actionExpiresInDays: actionExpiresInDays as number | null | undefined,
      actionNote: actionNote as string | null | undefined,
      requiresApproval: requiresApproval as boolean | undefined,
      enabled: enabled as boolean | undefined,
    };
    const { scope } = await resolveScope(request, "connection:manage");
    const repository = new GovernancePolicyRepository();
    const updated = await repository.update(scope, id, patch);
    if (updated === null) throw Object.assign(new Error("Governance policy not found"), { code: "NOT_FOUND" });
    return jsonResponse({ updated, policies: await repository.list(scope) });
  } catch (error) {
    return errorResponse(governancePublicError(error));
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    if (!POLICY_ID.test(id)) badRequest();
    const { scope } = await resolveScope(request, "connection:manage");
    const repository = new GovernancePolicyRepository();
    const deleted = await repository.delete(scope, id);
    return jsonResponse({ deleted, policies: await repository.list(scope) });
  } catch (error) {
    return errorResponse(governancePublicError(error));
  }
}
