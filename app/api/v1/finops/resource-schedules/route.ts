import { getPilotStateForOrg } from "../../../../../db/pilot-repository";
import { FinopsWorkspaceRepository } from "../../../../../db/finops-workspace-repository";
import { ResourceScheduleRepository } from "../../../../../db/finops-resource-schedule-repository";
import type {
  ResourceScheduleInput,
  ResourceSchedulePatch,
  StoredResourceSchedule,
} from "../../../../../db/finops-resource-schedule-repository";
import {
  RESOURCE_SCHEDULE_DISCLAIMER,
  RESOURCE_SCHEDULE_READ_ONLY_NOTICE,
  buildResourceScheduleArtifacts,
  detectCurResourceTagKey,
  parseScheduleDefinition,
  parseScheduleSelector,
  planResourceSchedule,
} from "../../../../../lib/finops-resource-schedule";
import type { NormalizedCurLine } from "../../../../../lib/finops-cur";
import type { PilotResource } from "../../../../../lib/pilot-types";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { requireConnectionScope } from "../../../../../lib/api-connection-scope";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const SCHEDULE_ID = /^rs_[a-f0-9]{32}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const BILLING_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/u;
const RESOURCE_TAG_KEY = /^[A-Za-z0-9][A-Za-z0-9 ._:/+@-]{0,127}$/u;
// A schedule body is a name, a selector, and at most 28 windows.
const MAX_BODY_BYTES = 16 * 1024;
// Bound the per-schedule candidate rows returned to the browser. Totals are
// computed over EVERY candidate; only the row list is truncated (and disclosed).
const MAX_CANDIDATE_ROWS = 100;
const MAX_EXCLUDED_ROWS = 100;
const MAX_PLANNED_SCHEDULES = 25;

/**
 * Resolve the tenant scope from the explicitly selected connection.
 */
async function resolveScope(
  request: Request,
  capability: "connection:read" | "connection:manage",
) {
  return requireConnectionScope(request, capability);
}

function badRequest(): never {
  throw Object.assign(new Error("The resource-schedule request is invalid"), { code: "INVALID_INPUT" });
}

function readSchedule(value: unknown): ResourceScheduleInput["schedule"] {
  const parsed = parseScheduleDefinition(value);
  if (parsed === null) badRequest();
  return parsed;
}

function readSelector(value: unknown): ResourceScheduleInput["selector"] {
  const parsed = parseScheduleSelector(value);
  if (parsed === null) badRequest();
  return parsed;
}

interface PlanContext {
  readonly resources: readonly PilotResource[];
  readonly curLines: readonly NormalizedCurLine[];
  readonly period: string | null;
  readonly resourceTagKey: string | null;
}

/** Compute one schedule's advisory plan, truncating only the row lists. */
function planFor(stored: StoredResourceSchedule, context: PlanContext) {
  const plan = planResourceSchedule(
    {
      schedule: stored.schedule,
      selector: stored.selector,
      resources: context.resources,
      curLines: context.curLines,
      curResourceTagKey: context.resourceTagKey ?? undefined,
    },
    { now: () => new Date() },
  );
  return {
    ...plan,
    candidateCount: plan.candidates.length,
    excludedCount: plan.excluded.length,
    candidates: plan.candidates.slice(0, MAX_CANDIDATE_ROWS),
    excluded: plan.excluded.slice(0, MAX_EXCLUDED_ROWS),
    truncated: plan.candidates.length > MAX_CANDIDATE_ROWS || plan.excluded.length > MAX_EXCLUDED_ROWS,
  };
}

/**
 * List the tenant's schedules with the savings each WOULD produce, and — when a
 * single `id` is requested — the CloudFormation/Terraform the customer applies
 * in their own account. Sutra performs no start/stop of any kind.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionIdParam = url.searchParams.get("connectionId");
    const idParam = url.searchParams.get("id");
    const periodParam = url.searchParams.get("period");
    const tagKeyParam = url.searchParams.get("resourceTagKey");
    if (
      connectionIdParam === null || !CONNECTION_ID.test(connectionIdParam) ||
      (idParam !== null && !SCHEDULE_ID.test(idParam)) ||
      (periodParam !== null && !BILLING_PERIOD.test(periodParam)) ||
      (tagKeyParam !== null && !RESOURCE_TAG_KEY.test(tagKeyParam))
    ) {
      badRequest();
    }
    const { connection, scope } = await resolveScope(request, "connection:read");
    const repository = new ResourceScheduleRepository();
    const schedules = idParam === null
      ? await repository.list(scope)
      : [await repository.get(scope, idParam)].filter((row): row is StoredResourceSchedule => row !== null);
    if (idParam !== null && schedules.length === 0) {
      throw Object.assign(new Error("Resource schedule not found"), { code: "NOT_FOUND" });
    }

    // Candidacy comes from the tenant-scoped CMDB snapshot; the rate comes from
    // the tenant's ingested billing lines for the selected month. Both are read
    // through the same authorized scope.
    const resources: readonly PilotResource[] =
      (await getPilotStateForOrg(scope.orgId, connection.id)).resources;
    const workspace = new FinopsWorkspaceRepository();
    const periods = await workspace.listPeriods(scope, connection.id);
    const period = periodParam ?? periods[0]?.period ?? null;
    const curLines = period === null ? [] : await workspace.linesForPeriod(scope, connection.id, period);
    // Prefer the operator's named resource-id cost-allocation tag; otherwise
    // detect it from the data. When neither yields a key, every candidate
    // discloses that its cost is not attributable instead of guessing a rate.
    const resourceTagKey = tagKeyParam ?? detectCurResourceTagKey(curLines, resources);
    const context: PlanContext = { resources, curLines, period, resourceTagKey };

    const planned = schedules.slice(0, MAX_PLANNED_SCHEDULES).map((stored) => {
      const plan = planFor(stored, context);
      // Artefacts are only built for a single explicitly requested schedule:
      // two templates per row would make the list response large for no gain.
      // A schedule that never changes state has nothing to automate, and that is
      // reported rather than raised as a failure.
      const buildable = idParam !== null && plan.transitions.length > 0;
      return {
        schedule: stored,
        plan,
        artifacts: !buildable ? null : buildResourceScheduleArtifacts({
          scheduleName: stored.name,
          schedule: stored.schedule,
          selector: stored.selector,
        }),
        artifactUnavailableReason: buildable || idParam === null
          ? null
          : "This schedule never changes state, so there is nothing to automate.",
      };
    });

    return jsonResponse({
      connectionId: connection.id,
      periods,
      period,
      resourceTagKey,
      resourceCount: resources.length,
      schedules,
      planned,
      enforcement: "customer-applied",
      readOnlyNotice: RESOURCE_SCHEDULE_READ_ONLY_NOTICE,
      disclaimer: RESOURCE_SCHEDULE_DISCLAIMER,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readBoundedJson(request, MAX_BODY_BYTES);
    if (typeof body !== "object" || body === null || Array.isArray(body)) badRequest();
    const { name, schedule, selector, enabled } = body as {
      name?: unknown; schedule?: unknown; selector?: unknown; enabled?: unknown;
    };
    if (typeof name !== "string") badRequest();
    if (enabled !== undefined && typeof enabled !== "boolean") badRequest();
    const { connection, scope } = await resolveScope(request, "connection:manage");
    const input: ResourceScheduleInput = {
      name,
      schedule: readSchedule(schedule),
      selector: readSelector(selector),
      enabled: enabled as boolean | undefined,
      connectionId: connection.id,
    };
    const repository = new ResourceScheduleRepository();
    const saved = await repository.create(scope, input);
    return jsonResponse({ saved, schedules: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    if (!SCHEDULE_ID.test(id)) badRequest();
    const body = await readBoundedJson(request, MAX_BODY_BYTES);
    if (typeof body !== "object" || body === null || Array.isArray(body)) badRequest();
    const { name, schedule, selector, enabled } = body as {
      name?: unknown; schedule?: unknown; selector?: unknown; enabled?: unknown;
    };
    if (name !== undefined && typeof name !== "string") badRequest();
    if (enabled !== undefined && typeof enabled !== "boolean") badRequest();
    const patch: ResourceSchedulePatch = {
      name: name as string | undefined,
      schedule: schedule === undefined ? undefined : readSchedule(schedule),
      selector: selector === undefined ? undefined : readSelector(selector),
      enabled: enabled as boolean | undefined,
    };
    const { scope } = await resolveScope(request, "connection:manage");
    const repository = new ResourceScheduleRepository();
    const updated = await repository.update(scope, id, patch);
    if (updated === null) throw Object.assign(new Error("Resource schedule not found"), { code: "NOT_FOUND" });
    return jsonResponse({ updated, schedules: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    if (!SCHEDULE_ID.test(id)) badRequest();
    const { scope } = await resolveScope(request, "connection:manage");
    const repository = new ResourceScheduleRepository();
    const deleted = await repository.delete(scope, id);
    return jsonResponse({ deleted, schedules: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}
