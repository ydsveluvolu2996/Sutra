import {
  FinopsFoundationalConfigRepository,
  type FinopsFoundationalTenantScope,
  type SaveFinopsKpiGoalInput,
} from "../../../../../db/finops-foundational-config-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { FINOPS_KPI_FORMULAS, type FinopsKpiId } from "../../../../../lib/finops-kpi";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const BODY_BYTES = 16 * 1_024;
const BODY_KEYS = new Set([
  "connectionId",
  "version",
  "kpiId",
  "targetDirection",
  "targetBasisPoints",
  "effectiveFromIso",
  "effectiveToIso",
  "auditReference",
]);
const FORMULA_BY_ID = new Map(
  FINOPS_KPI_FORMULAS.map((formula) => [formula.id, formula]),
);

function invalid(): never {
  throw Object.assign(
    new Error("The KPI-goal request is invalid"),
    { code: "INVALID_INPUT", status: 400 },
  );
}

function exactRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.has(key))
  ) invalid();
  return value as Readonly<Record<string, unknown>>;
}

type ApiSession = Awaited<ReturnType<typeof requireApiSession>>;

async function authorizedScope(
  authenticated: ApiSession,
  connectionId: string,
  capability: "connection:read" | "connection:manage",
): Promise<FinopsFoundationalTenantScope> {
  if (!CONNECTION_ID.test(connectionId)) invalid();
  const connection = await getConnectionForOrg(
    authenticated.subject.orgId,
    connectionId,
  );
  if (
    connection === null
    || connection.sourceKind !== "aws_trust_role"
    || connection.status !== "active"
  ) {
    throw Object.assign(
      new Error("Cloud connection not found"),
      { code: "NOT_FOUND", status: 404 },
    );
  }
  assertSessionCapability(authenticated, capability, connection.customerId);
  return {
    organizationId: authenticated.subject.orgId,
    customerId: connection.customerId,
    connectionId: connection.id,
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId")) {
      invalid();
    }
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const authenticated = await requireApiSession(request);
    const scope = await authorizedScope(
      authenticated,
      connectionId,
      "connection:read",
    );
    const goals = await new FinopsFoundationalConfigRepository()
      .listKpiGoals(scope);
    return jsonResponse({ connectionId, goals });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    // requireApiSession enforces configured same-origin on every mutation and
    // runs before the bounded body is parsed.
    const authenticated = await requireApiSession(request);
    const body = exactRecord(
      await readBoundedJson(request, BODY_BYTES),
      BODY_KEYS,
    );
    const connectionId = body.connectionId;
    const formula = typeof body.kpiId === "string"
      ? FORMULA_BY_ID.get(body.kpiId as FinopsKpiId)
      : undefined;
    if (
      typeof connectionId !== "string"
      || formula === undefined
      || !Number.isSafeInteger(body.version)
      || Number(body.version) < 1
      || body.targetDirection !== formula.targetDirection
      || !Number.isSafeInteger(body.targetBasisPoints)
      || Number(body.targetBasisPoints) < 0
      || Number(body.targetBasisPoints) > 10_000
      || typeof body.effectiveFromIso !== "string"
      || (
        body.effectiveToIso !== null
        && typeof body.effectiveToIso !== "string"
      )
      || typeof body.auditReference !== "string"
      || body.auditReference.length === 0
      || body.auditReference.length > 1_024
    ) invalid();
    const scope = await authorizedScope(
      authenticated,
      connectionId,
      "connection:manage",
    );
    const nowIso = new Date().toISOString();
    const actorId = authenticated.subject.userId;
    const decisionId = `krbac_${crypto.randomUUID().replaceAll("-", "")}`;
    const input: SaveFinopsKpiGoalInput = {
      version: Number(body.version),
      kpiId: formula.id,
      targetDirection: formula.targetDirection,
      targetBasisPoints: Number(body.targetBasisPoints),
      effectiveFromIso: body.effectiveFromIso,
      effectiveToIso: body.effectiveToIso as string | null,
      actorId,
      auditReference: body.auditReference,
      rbacDecision: {
        decisionId,
        decision: "allow",
        action: "finops:kpi-goal:write",
        resource: [
          "finops-kpi",
          scope.organizationId,
          scope.customerId,
          scope.connectionId,
          formula.id,
        ].join(":"),
        actorId,
        decidedAtIso: nowIso,
        policyVersion: "sutra-auth-policy-v1",
        evidenceReference:
          `session:${authenticated.session.id}:decision:${decisionId}`,
      },
    };
    const repository = new FinopsFoundationalConfigRepository();
    const saved = await repository.saveKpiGoal(scope, input);
    return jsonResponse({
      saved,
      goals: await repository.listKpiGoals(scope),
    }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
