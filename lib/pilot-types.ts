export type AwsPartition = "aws" | "aws-us-gov" | "aws-cn";
export type ConnectionStatus = "pending" | "validating" | "active" | "needs_attention" | "disabled";
export type SyncStatus = "queued" | "running" | "partial" | "succeeded" | "failed" | "cancelled";
export type CoverageStatus = "succeeded" | "partial" | "failed" | "skipped";
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "informational";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export interface PilotConnection {
  readonly id: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly partition: AwsPartition;
  readonly awsAccountId: string;
  readonly roleArn: string | null;
  readonly status: ConnectionStatus;
  readonly enabledRegions: readonly string[];
  readonly permissionPackVersion: string;
  readonly lastValidatedAt: string | null;
  readonly lastSuccessfulSyncAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PilotResource {
  readonly resourceKey: string;
  readonly service: string;
  readonly resourceType: string;
  readonly nativeId: string;
  readonly arn: string | null;
  readonly name: string | null;
  readonly region: string;
  readonly state: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly source: {
    readonly api: string;
    readonly accountId: string;
    readonly collectedAt: string;
  };
  readonly contentSha256: string;
}

export interface PilotRelationship {
  readonly fromResourceKey: string;
  readonly toResourceKey: string;
  readonly relationType: string;
  readonly evidence: Readonly<Record<string, JsonValue>>;
}

export interface PilotFinding {
  readonly fingerprint: string;
  readonly resourceKey: string | null;
  readonly controlKey: string;
  readonly controlVersion: string;
  readonly severity: FindingSeverity;
  readonly status: "open" | "acknowledged" | "resolved" | "suppressed";
  readonly title: string;
  readonly summary: string;
  readonly remediation: string;
  readonly evidence: Readonly<Record<string, JsonValue>>;
  readonly evaluatedAt: string;
}

export interface PilotCoverageEntry {
  readonly collectorKey: string;
  readonly region: string;
  readonly status: CoverageStatus;
  readonly itemsObserved: number;
  readonly pagesObserved: number;
  readonly errorCode?: string;
  readonly message?: string;
}

export interface PilotSnapshotPayload {
  readonly schemaVersion: "sutra.inventory.v1";
  readonly jobId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly roleSessionName: string;
  readonly collectedAt: string;
  readonly coverageState: "complete" | "partial";
  readonly coverage: readonly PilotCoverageEntry[];
  readonly resources: readonly PilotResource[];
  readonly relationships: readonly PilotRelationship[];
  readonly findings: readonly PilotFinding[];
  readonly snapshotSha256: string;
}

export interface PilotSyncRun {
  readonly id: string;
  readonly connectionId: string;
  readonly status: SyncStatus;
  readonly coverageState: "complete" | "partial" | "unknown";
  readonly totals: Readonly<Record<string, JsonValue>>;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

export interface PilotState {
  readonly mode: "empty" | "live";
  readonly connection: PilotConnection | null;
  readonly resources: readonly PilotResource[];
  readonly relationships: readonly PilotRelationship[];
  readonly findings: readonly PilotFinding[];
  readonly coverage: readonly PilotCoverageEntry[];
  readonly syncRuns: readonly PilotSyncRun[];
  readonly activeSnapshot: {
    readonly id: string;
    readonly collectedAt: string;
    readonly coverageState: "complete" | "partial";
    readonly snapshotSha256: string;
  } | null;
}

export interface CollectorHealth {
  readonly ok: boolean;
  readonly mode: "fixture" | "live";
  readonly version: string;
  readonly principalArn: string | null;
  readonly sourceAccountId: string | null;
  readonly message: string;
}
