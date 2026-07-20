// Response and request types for the Sutra Public API v1.
//
// These are hand-maintained to mirror the OpenAPI spec served at
// GET /api/public/v1/openapi.json (app/api/public/v1/openapi.json/route.ts),
// which in turn mirrors the real handler outputs. The drift guard in
// tests/public-api-sdk-contract.test.ts keeps the endpoint surface in sync;
// these payload types must be edited by hand when a schema changes.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Envelope wrapping every paginated read. `page.next` is an opaque cursor. */
export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly next: string | null };
}

/** Envelope wrapping every single-object read/write. */
export interface Envelope<T> {
  readonly data: T;
}

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "informational";
export type FindingStatus = "open" | "acknowledged" | "resolved" | "suppressed";
export type CaseStatus = "open" | "investigating" | "resolved" | "closed";
/** The status values a caller may request via updateCaseStatus. */
export type CaseStatusRequest = "open" | "investigating" | "resolved" | "accepted_risk";
export type CasePriority = "critical" | "high" | "medium" | "low";
export type CaseSlaState = "on_track" | "due_soon" | "overdue" | "met" | "missed";
export type CaseActivityKind =
  | "created" | "status_changed" | "assignment_changed"
  | "priority_changed" | "due_date_changed" | "note_added";
export type CoverageStatus = "succeeded" | "partial" | "failed" | "skipped";
export type SyncStatus = "queued" | "running" | "partial" | "succeeded" | "failed" | "cancelled";
export type VulnerabilitySeverity = "critical" | "high" | "medium" | "low" | "unknown";
export type VulnerabilityStatus = "open" | "resolved";

export interface Resource {
  readonly resourceKey: string;
  readonly service: string;
  readonly resourceType: string;
  readonly region: string;
  readonly name: string | null;
  readonly state: string;
  readonly arn: string | null;
  readonly nativeId: string;
  readonly tags: Readonly<Record<string, string>>;
}

export interface Finding {
  readonly fingerprint: string;
  readonly resourceKey: string | null;
  readonly controlKey: string;
  readonly controlVersion: string;
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
  readonly title: string;
  readonly summary: string;
  readonly remediation: string;
  readonly evidence: Readonly<Record<string, JsonValue>>;
  readonly evaluatedAt: string;
}

export interface CaseAssignee {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: string;
}

export interface CaseActivity {
  readonly id: string;
  readonly caseId: string;
  readonly kind: CaseActivityKind;
  readonly actorId: string;
  readonly actorName: string;
  readonly occurredAt: string;
  readonly detail: Readonly<Record<string, string | null>>;
  readonly previousHash: string | null;
  readonly eventHash: string;
}

export interface Case {
  readonly id: string;
  readonly caseNumber: string;
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly findingFingerprint: string;
  readonly findingSnapshotId: string;
  readonly findingSeverity: string;
  readonly title: string;
  readonly status: CaseStatus;
  readonly priority: CasePriority;
  readonly assignee: CaseAssignee | null;
  readonly dueAt: string;
  readonly resolvedAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly slaState: CaseSlaState;
  readonly activities: readonly CaseActivity[];
}

export interface CoverageEntry {
  readonly collectorKey: string;
  readonly region: string;
  readonly status: CoverageStatus;
  readonly itemsObserved: number;
  readonly pagesObserved: number;
  readonly errorCode?: string;
  readonly message?: string;
}

export interface SyncRun {
  readonly id: string;
  readonly connectionId: string;
  readonly status: SyncStatus;
  readonly coverageState: "complete" | "partial" | "unknown";
  readonly totals: Readonly<Record<string, JsonValue>>;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

export interface ActiveSnapshot {
  readonly id: string;
  readonly collectedAt: string;
  readonly coverageState: "complete" | "partial";
  readonly snapshotSha256: string;
  readonly origin: {
    readonly kind: "unknown" | "simulated_fixture" | "aws_sandbox";
    readonly fixtureId: string | null;
    readonly fixtureVersion: string | null;
  };
}

export interface SnapshotStatus {
  readonly activeSnapshot: ActiveSnapshot | null;
  readonly coverage: readonly CoverageEntry[];
  readonly syncRuns: readonly SyncRun[];
}

export interface ReadinessScope {
  readonly tenantId: string | null;
  readonly collectionId: string | null;
  readonly collectedAt: string | null;
}

export interface ReadinessStateCounts {
  readonly PASS: number;
  readonly FAIL: number;
  readonly UNKNOWN: number;
  readonly NOT_COLLECTED: number;
}

export interface FrameworkSummary {
  readonly id: string;
  readonly title: string;
  readonly summary: ReadinessStateCounts;
  readonly disclaimer: string;
}

export interface ComplianceReport {
  readonly scope: ReadinessScope;
  readonly frameworks: readonly FrameworkSummary[];
}

export interface Vulnerability {
  readonly id: string;
  readonly findingKey: string;
  readonly resourceKey: string;
  readonly resourceKind: string;
  readonly cveId: string | null;
  readonly packageName: string | null;
  readonly installedVersion: string | null;
  readonly fixedVersion: string | null;
  readonly severity: VulnerabilitySeverity;
  readonly cvssScore: number | null;
  readonly source: string;
  readonly status: VulnerabilityStatus;
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
}

/** Query parameters accepted by the cursor-paginated list endpoints. */
export interface ListParams {
  readonly cursor?: string | null;
  readonly limit?: number;
}
