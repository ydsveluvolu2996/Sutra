import { buildContainmentPlan, type ContainmentPlan } from "./kubernetes-containment.ts";

export const FALCO_PRIORITIES = [
  "emergency",
  "alert",
  "critical",
  "error",
  "warning",
  "notice",
  "informational",
  "debug",
] as const;

export type FalcoPriority = (typeof FALCO_PRIORITIES)[number];

export interface FalcoProcessMetadata {
  readonly name: string | null;
  readonly executable: string | null;
  readonly pid: number | null;
  readonly parentPid: number | null;
  readonly userName: string | null;
  readonly userId: string | null;
  readonly eventType: string | null;
}

export interface NormalizedFalcoRuntimeEvent {
  readonly schemaVersion: "sutra.falco.runtime-event.v1";
  readonly eventId: string;
  readonly clusterId: string;
  readonly occurredAt: string;
  readonly rule: string;
  readonly priority: FalcoPriority;
  readonly source: string;
  readonly nodeName: string | null;
  readonly namespace: string | null;
  readonly podName: string | null;
  readonly podUid: string | null;
  readonly containerId: string | null;
  readonly containerName: string | null;
  readonly containerImage: string | null;
  readonly process: FalcoProcessMetadata;
  readonly evidenceSha256: string;
}

export interface FalcoRuntimeCoverage {
  readonly clusterId: string;
  readonly status: "active" | "stale" | "not_configured";
  readonly lastHeartbeatAt: string | null;
  readonly lastEventAt: string | null;
  readonly falcoVersion: string | null;
}

export interface FalcoInvestigationTimelineItem {
  readonly type: "falco_runtime_event";
  readonly id: string;
  readonly occurredAt: string;
  readonly title: string;
  readonly priority: FalcoPriority;
  readonly subject: string;
  readonly evidenceSha256: string;
  /** Severity-scaled containment plan for operator review; never auto-applied. */
  readonly containment: ContainmentPlan;
}

/**
 * This projection can be handed to case management only after an operator
 * explicitly asks for it. Runtime ingestion never performs containment.
 */
export interface FalcoCaseCandidate {
  readonly sourceType: "falco_runtime_event";
  readonly sourceId: string;
  readonly title: string;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly occurredAt: string;
  readonly evidenceSha256: string;
  readonly requiresHumanApproval: true;
  readonly automaticContainment: false;
  readonly permittedNextAction: "create_case";
}

function caseSeverity(priority: FalcoPriority): FalcoCaseCandidate["severity"] {
  if (priority === "emergency" || priority === "alert" || priority === "critical") return "critical";
  if (priority === "error") return "high";
  if (priority === "warning") return "medium";
  return "low";
}

export function projectFalcoTimeline(
  event: NormalizedFalcoRuntimeEvent,
): FalcoInvestigationTimelineItem {
  const subject = [
    event.namespace,
    event.podName,
    event.containerName,
  ].filter((value): value is string => value !== null).join("/");
  return {
    type: "falco_runtime_event",
    id: event.eventId,
    occurredAt: event.occurredAt,
    title: event.rule,
    priority: event.priority,
    subject: subject || event.nodeName || event.clusterId,
    evidenceSha256: event.evidenceSha256,
    containment: buildContainmentPlan({ event }),
  };
}

export function falcoCaseCandidate(
  event: NormalizedFalcoRuntimeEvent,
): FalcoCaseCandidate {
  return {
    sourceType: "falco_runtime_event",
    sourceId: event.eventId,
    title: `Runtime detection: ${event.rule}`,
    severity: caseSeverity(event.priority),
    occurredAt: event.occurredAt,
    evidenceSha256: event.evidenceSha256,
    requiresHumanApproval: true,
    automaticContainment: false,
    permittedNextAction: "create_case",
  };
}
