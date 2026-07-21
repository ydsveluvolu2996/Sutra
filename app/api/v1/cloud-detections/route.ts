import { getSecurityEventsWorkspace } from "../../../../db/security-event-repository";
import { getConnectionForOrg, getPilotStateForOrg } from "../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { buildCloudDetections } from "../../../../lib/cloud-detection";
import {
  buildCloudDetectionInputs,
  type NormalizedGuardDutyFinding,
} from "../../../../lib/cloud-detection-inputs";
import { errorResponse, jsonResponse } from "../../../../lib/pilot-server";
import type { PilotFinding } from "../../../../lib/pilot-types";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
// The engine analyzes the most-recent bounded window; the repository caps the
// query at 200, so at most that many events feed a single evaluation.
const EVENT_LIMIT = 200;
// GuardDuty findings are collected read-only (guardduty:ListDetectors /
// ListFindings / GetFindings) and persisted as AWS-native findings on the
// connection's inventory snapshot under this control key.
const GUARDDUTY_CONTROL_KEY = "AWS.NATIVE.GUARDDUTY.FINDING";
// Bound the number of GuardDuty findings fed into a single evaluation so a
// large finding backlog cannot make one detection pass unbounded.
const GUARDDUTY_LIMIT = 200;

function invalid(): never {
  throw Object.assign(new Error("The cloud-detection request is invalid"), { code: "INVALID_INPUT" });
}

function scalarString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function firstResourceRef(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item === "string" && item !== "") return item;
  }
  return null;
}

// The GuardDuty finding carries several timestamps; prefer the most specific
// observation time and never synthesize one.
function findingTime(evidence: Readonly<Record<string, unknown>>, fallback: string): string {
  return scalarString(evidence.lastObservedAt)
    ?? scalarString(evidence.updatedAt)
    ?? scalarString(evidence.createdAt)
    ?? scalarString(evidence.firstObservedAt)
    ?? fallback;
}

// Reshape already-collected AWS-native GuardDuty findings into the engine's
// GuardDuty input. Only the fields the pass-through rule needs are read; a
// finding with no numeric severity is skipped rather than assigned a fabricated
// band. This never adds a detection — it only forwards what GuardDuty found.
function guardDutyFindingsFromPilot(
  findings: readonly PilotFinding[],
): NormalizedGuardDutyFinding[] {
  const mapped: NormalizedGuardDutyFinding[] = [];
  for (const finding of findings) {
    if (finding.controlKey !== GUARDDUTY_CONTROL_KEY) continue;
    const evidence = finding.evidence as Readonly<Record<string, unknown>>;
    const severity = evidence.nativeSeverity;
    if (typeof severity !== "number" || !Number.isFinite(severity)) continue;
    const findingType = scalarString(evidence.nativeType) ?? finding.title;
    const resourceRef = firstResourceRef(evidence.resourceIds)
      ?? finding.resourceKey
      ?? "unknown";
    mapped.push({
      findingType,
      severity,
      resourceRef,
      time: findingTime(evidence, finding.evaluatedAt),
    });
    if (mapped.length >= GUARDDUTY_LIMIT) break;
  }
  return mapped;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId")) invalid();
    const connectionId = url.searchParams.get("connectionId");
    if (connectionId === null || !CONNECTION_ID.test(connectionId)) invalid();

    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);

    // Source 1 (always fed): already-collected, tenant-scoped CloudTrail
    // management events.
    const workspace = await getSecurityEventsWorkspace({
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId,
      limit: EVENT_LIMIT,
    });

    // Source 2 (fed when an inventory snapshot exists): read-only AWS GuardDuty
    // findings collected onto the connection's inventory head. When no snapshot
    // has been collected the source is declared absent — never faked empty.
    const pilot = await getPilotStateForOrg(authenticated.subject.orgId, connectionId);
    const guardDutyCollected = pilot.activeSnapshot !== null;
    const guardDutyFindings = guardDutyCollected
      ? guardDutyFindingsFromPilot(pilot.findings)
      : undefined;

    // The adapter merges the sources it is given, labels each event by source,
    // and computes an honest coverage disclosure (Kubernetes audit is not
    // collected anywhere in this app, so it is always declared absent — the
    // engine and adapter support it, but no detection is ever fabricated for a
    // source with no collection pipeline).
    const inputs = buildCloudDetectionInputs(workspace.events, {
      tenant: connection.customerId,
      ...(guardDutyFindings === undefined ? {} : { guardDutyFindings }),
    });
    const report = buildCloudDetections(inputs.events);

    return jsonResponse({
      report,
      coverage: inputs.coverage,
      source: {
        collected: workspace.source !== null,
        status: workspace.source?.status ?? "NOT_COLLECTED",
        eventsAnalyzed: inputs.coverage.eventsIngested,
        eventsBySource: inputs.coverage.ingestedBySource,
        totalEventsStored: workspace.counts.totalEvents,
        lastCollectedAt: workspace.source?.lastCollectedAt ?? null,
        windowStart: workspace.latestRun?.windowStart ?? null,
        windowEnd: workspace.latestRun?.windowEnd ?? null,
        guardDuty: {
          collected: guardDutyCollected,
          findingsAnalyzed: guardDutyFindings?.length ?? 0,
        },
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
