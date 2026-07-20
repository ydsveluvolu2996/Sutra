import type { JobHandler, RunnableJob } from "../lib/background-job-runner.ts";
import { deliverItsmTicket } from "../lib/itsm-delivery.ts";
import type { CaseStatusLike, ItsmCaseLike } from "../lib/itsm-sync.ts";
import { addCaseNote } from "./case-repository";
import { ItsmConnectorRepository } from "./itsm-connector-repository";
import { JobQueueRepository } from "./job-queue-repository";
import { RetentionSweepRepository } from "./retention-sweep-repository";

const CASE_STATUSES: ReadonlySet<CaseStatusLike> = new Set<CaseStatusLike>([
  "open", "investigating", "resolved", "accepted_risk",
]);

interface ItsmDispatchPayload {
  readonly customerId: string;
  readonly connectionId: string;
  readonly connectorId: string;
  readonly connectorName: string;
  readonly actorUserId: string;
  readonly itsmCase: ItsmCaseLike;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseItsmCase(value: unknown): ItsmCaseLike | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const caseId = asString(record.caseId);
  const title = asString(record.title);
  const severity = asString(record.severity);
  const priority = asString(record.priority);
  const summary = typeof record.summary === "string" ? record.summary : null;
  const status = record.status;
  if (
    caseId === null || title === null || severity === null || priority === null || summary === null ||
    typeof status !== "string" || !CASE_STATUSES.has(status as CaseStatusLike)
  ) return null;
  return { caseId, title, summary, severity, priority, status: status as CaseStatusLike };
}

function parseItsmDispatchPayload(payload: unknown): ItsmDispatchPayload | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const customerId = asString(record.customerId);
  const connectionId = asString(record.connectionId);
  const connectorId = asString(record.connectorId);
  const connectorName = asString(record.connectorName);
  const actorUserId = asString(record.actorUserId);
  const itsmCase = parseItsmCase(record.itsmCase);
  if (customerId === null || connectionId === null || connectorId === null || connectorName === null || actorUserId === null || itsmCase === null) {
    return null;
  }
  return { customerId, connectionId, connectorId, connectorName, actorUserId, itsmCase };
}

function deliveryOutcome(result: { readonly delivered: boolean; readonly statusCode?: number; readonly error?: string }): string {
  if (result.delivered) return `delivered (${result.statusCode})`;
  if (result.statusCode === undefined) return `failed (${result.error ?? "dispatch-error"})`;
  return `rejected (${result.statusCode})`;
}

async function runItsmDispatch(job: RunnableJob): Promise<void> {
  const payload = parseItsmDispatchPayload(job.payload);
  if (payload === null) throw new Error("itsm-dispatch-payload-invalid");
  const connector = await new ItsmConnectorRepository().getForDispatch(
    { orgId: job.orgId, customerId: payload.customerId },
    payload.connectorId,
  );
  if (connector === null || !connector.enabled) throw new Error("itsm-connector-unavailable");
  const result = await deliverItsmTicket({
    connector: {
      baseUrl: connector.baseUrl,
      sharedSecret: connector.sharedSecret,
      connectorType: connector.connectorType,
      projectKey: connector.projectKey,
    },
    itsmCase: payload.itsmCase,
  });
  const outcome = deliveryOutcome(result);
  await addCaseNote({
    orgId: job.orgId,
    customerId: payload.customerId,
    connectionId: payload.connectionId,
    caseId: payload.itsmCase.caseId,
    actorUserId: payload.actorUserId,
    note: `ITSM dispatch (durable retry) to '${connector.name}' ${outcome}.`,
  });
  // Rethrow on a non-delivery so the queue's own backoff/dead-letter policy
  // decides the next attempt — the note above records what actually happened.
  if (!result.delivered) throw new Error(`itsm-dispatch ${outcome}`);
}

/**
 * The app-side registry of durable job handlers. Each handler does real work and
 * throws on failure — nothing is fabricated, and the runner completes a job only
 * when its handler returns without throwing.
 */
export function buildJobHandlers(): Record<string, JobHandler> {
  return {
    "retention-sweep": async (job) => {
      await new RetentionSweepRepository().sweep(job.orgId);
    },
    "itsm-dispatch": runItsmDispatch,
  };
}

/**
 * Ensure every given org has at most one in-flight retention sweep. For each org
 * with no queued/leased `retention-sweep`, enqueue one. Idempotent: a second call
 * before the first sweep drains enqueues nothing. Returns the number enqueued.
 */
export async function ensureRetentionSweepsEnqueued(
  queue: JobQueueRepository,
  orgIds: readonly string[],
  now = Date.now(),
): Promise<number> {
  let enqueued = 0;
  for (const orgId of orgIds) {
    const existing = await queue.list(orgId, null);
    const active = existing.some(
      (job) => job.kind === "retention-sweep" && (job.status === "queued" || job.status === "leased"),
    );
    if (active) continue;
    await queue.enqueue({ orgId, customerId: null, kind: "retention-sweep", payload: { orgId } }, now);
    enqueued += 1;
  }
  return enqueued;
}
