export type SecurityEventCollectionStatus = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
export type SecurityEventCoverageStatus = "SUCCEEDED" | "PARTIAL" | "FAILED";
export type SecurityDetectionSeverity = "critical" | "high" | "medium" | "low";

export interface NormalizedSecurityEventResource {
  readonly type: string | null;
  readonly name: string | null;
}

export interface NormalizedSecurityEvent {
  readonly schemaVersion: "sutra.security-event.v1";
  readonly providerEventId: string;
  readonly accountId: string;
  readonly region: string;
  readonly eventTime: string;
  readonly eventName: string;
  readonly eventSource: string;
  readonly readOnly: boolean | null;
  readonly managementEvent: boolean | null;
  readonly eventCategory: string | null;
  readonly username: string | null;
  readonly identityType: string | null;
  readonly principalArn: string | null;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  readonly errorCode: string | null;
  readonly requestId: string | null;
  readonly consoleLoginResult: "Success" | "Failure" | null;
  readonly mfaUsed: boolean | null;
  readonly detailStatus: "AVAILABLE" | "UNAVAILABLE";
  readonly resources: readonly NormalizedSecurityEventResource[];
}

export interface SecurityEventDetection {
  readonly detectionId: string;
  readonly ruleKey: string;
  readonly ruleVersion: "1.0.0";
  readonly severity: SecurityDetectionSeverity;
  readonly title: string;
  readonly summary: string;
  readonly firstEventAt: string;
  readonly lastEventAt: string;
  readonly eventIds: readonly string[];
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
  readonly limitation: string;
}

export interface SecurityEventRegionCoverage {
  readonly region: string;
  readonly status: SecurityEventCoverageStatus;
  readonly pagesObserved: number;
  readonly eventsObserved: number;
  readonly eventsDropped: number;
  readonly errorCode: string | null;
}

export interface AwsSecurityEventCollection {
  readonly schemaVersion: "sutra.security-events.v1";
  readonly source: "AWS_CLOUDTRAIL_LOOKUP_EVENTS";
  readonly status: SecurityEventCollectionStatus;
  readonly accountId: string;
  readonly collectedAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly retentionDays: 30;
  readonly coverage: readonly SecurityEventRegionCoverage[];
  readonly events: readonly NormalizedSecurityEvent[];
  readonly detections: readonly SecurityEventDetection[];
  readonly limitations: readonly string[];
}

export interface SecurityEventSourceState {
  readonly sourceId: string;
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly source: "AWS_CLOUDTRAIL_LOOKUP_EVENTS";
  readonly status: SecurityEventCollectionStatus | "NOT_COLLECTED";
  readonly retentionDays: number;
  readonly lookbackHours: number;
  readonly overlapMinutes: number;
  readonly lastWindowStart: string | null;
  readonly lastWindowEnd: string | null;
  readonly lastCollectedAt: string | null;
  readonly lastRunId: string | null;
  readonly lastErrorCode: string | null;
  readonly updatedAt: string;
}

export interface SecurityEventRun {
  readonly runId: string;
  readonly status: SecurityEventCollectionStatus;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly collectedAt: string;
  readonly finishedAt: string;
  readonly coverage: readonly SecurityEventRegionCoverage[];
  readonly eventsObserved: number;
  readonly eventsInserted: number;
  readonly duplicateEvents: number;
  readonly detectionsObserved: number;
  readonly payloadSha256: string;
}

export interface StoredSecurityEvent extends NormalizedSecurityEvent {
  readonly ingestedAt: string;
  readonly sourceRunId: string;
}

export interface StoredSecurityDetection extends SecurityEventDetection {
  readonly status: "open" | "acknowledged";
  readonly note: string | null;
  readonly actorId: string | null;
  readonly updatedAt: string;
  readonly sourceRunId: string;
}

export interface SecurityEventsWorkspace {
  readonly source: SecurityEventSourceState | null;
  readonly latestRun: SecurityEventRun | null;
  readonly counts: {
    readonly totalEvents: number;
    readonly matchingEvents: number;
    readonly totalDetections: number;
    readonly openDetections: number;
  };
  readonly events: readonly StoredSecurityEvent[];
  readonly detections: readonly StoredSecurityDetection[];
}
