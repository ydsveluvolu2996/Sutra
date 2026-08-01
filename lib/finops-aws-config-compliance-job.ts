import type {
  AwsConfigComplianceRepositoryScope,
  StoredAwsConfigComplianceSnapshot,
} from "../db/finops-aws-config-compliance-repository.ts";
import {
  AWS_CONFIG_ACTIVITY_S3_READ_OPERATIONS,
  AWS_CONFIG_AGGREGATE_INVENTORY_QUERY,
  AWS_CONFIG_AGGREGATOR_READ_OPERATIONS,
  AWS_CONFIG_COMPLIANCE_BOUNDS,
  AWS_CONFIG_ORGANIZATION_READ_OPERATIONS,
  AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS,
  AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS,
  normalizeAwsConfigComplianceCapture,
  type AwsConfigComplianceCapture,
  type AwsConfigComplianceScope,
  type AwsConfigComplianceSnapshot,
} from "./finops-aws-config-compliance.ts";

export const AWS_CONFIG_COMPLIANCE_JOB_KIND = "finops-aws-config-compliance-collect";

const DAILY_WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;

export interface AwsConfigComplianceCollectionJob {
  readonly id: string;
  readonly orgId: string;
  readonly customerId: string | null;
  readonly connectionId: string | null;
  readonly payload: unknown;
}

export interface AwsConfigComplianceCollectorRequest {
  readonly schemaVersion: "sutra.aws-config-compliance-request.v1";
  readonly scope: AwsConfigComplianceScope;
  readonly scheduledWindow: string;
  readonly operations: {
    readonly aggregator: typeof AWS_CONFIG_AGGREGATOR_READ_OPERATIONS;
    readonly organization: typeof AWS_CONFIG_ORGANIZATION_READ_OPERATIONS;
    readonly ruleLifecycle: typeof AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS;
    readonly recorderCoverage: typeof AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS;
    readonly activityObjects: typeof AWS_CONFIG_ACTIVITY_S3_READ_OPERATIONS;
  };
  readonly inventoryQuery: typeof AWS_CONFIG_AGGREGATE_INVENTORY_QUERY;
  readonly cur2Source: "ACTIVE_RECONCILED_CUR2_GENERATION";
  readonly activityObjectPolicy: "SERVER_PINNED_EXACT_PREFIX_OR_UNAVAILABLE";
  readonly includeRawProviderMessages: false;
  readonly includeCredentialMaterial: false;
  readonly bounds: typeof AWS_CONFIG_COMPLIANCE_BOUNDS;
}

export interface AwsConfigComplianceCollectorAdapter {
  collect(
    request: AwsConfigComplianceCollectorRequest,
    signal: AbortSignal,
  ): Promise<AwsConfigComplianceCapture>;
}

export interface AwsConfigComplianceSnapshotStore {
  recordSnapshot(
    scope: AwsConfigComplianceRepositoryScope,
    snapshot: AwsConfigComplianceSnapshot,
    nowMs: number,
  ): Promise<StoredAwsConfigComplianceSnapshot>;
}

export class AwsConfigComplianceJobError extends Error {
  public constructor() {
    super("AWS Config compliance collection rejected");
    this.name = "AwsConfigComplianceJobError";
  }
}

function reject(): never {
  throw new AwsConfigComplianceJobError();
}

function parseWindow(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) reject();
  const values = payload as Record<string, unknown>;
  if (Object.keys(values).length !== 1 || typeof values.scheduledWindow !== "string"
    || !DAILY_WINDOW.test(values.scheduledWindow)) reject();
  return values.scheduledWindow;
}

function sameScope(
  expected: AwsConfigComplianceRepositoryScope,
  trusted: AwsConfigComplianceScope,
): boolean {
  return trusted.orgId === expected.organizationId
    && trusted.customerId === expected.customerId
    && trusted.connectionId === expected.connectionId;
}

export async function runAwsConfigComplianceCollectionJob(
  job: AwsConfigComplianceCollectionJob,
  dependencies: {
    readonly loadScope: (
      scope: AwsConfigComplianceRepositoryScope,
    ) => Promise<AwsConfigComplianceScope>;
    readonly adapter: AwsConfigComplianceCollectorAdapter;
    readonly store: AwsConfigComplianceSnapshotStore;
    readonly now?: () => number;
  },
): Promise<{
  readonly snapshotId: string;
  readonly state: AwsConfigComplianceSnapshot["state"];
  readonly captureId: string;
}> {
  if (job.customerId === null || job.connectionId === null) reject();
  const scheduledWindow = parseWindow(job.payload);
  const scope = {
    organizationId: job.orgId,
    customerId: job.customerId,
    connectionId: job.connectionId,
  };
  const trusted = await dependencies.loadScope(scope);
  if (!sameScope(scope, trusted)) reject();

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    AWS_CONFIG_COMPLIANCE_BOUNDS.maximumDurationMs,
  );
  let capture: AwsConfigComplianceCapture;
  try {
    capture = await dependencies.adapter.collect({
      schemaVersion: "sutra.aws-config-compliance-request.v1",
      scope: trusted,
      scheduledWindow,
      operations: {
        aggregator: AWS_CONFIG_AGGREGATOR_READ_OPERATIONS,
        organization: AWS_CONFIG_ORGANIZATION_READ_OPERATIONS,
        ruleLifecycle: AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS,
        recorderCoverage: AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS,
        activityObjects: AWS_CONFIG_ACTIVITY_S3_READ_OPERATIONS,
      },
      inventoryQuery: AWS_CONFIG_AGGREGATE_INVENTORY_QUERY,
      cur2Source: "ACTIVE_RECONCILED_CUR2_GENERATION",
      activityObjectPolicy: "SERVER_PINNED_EXACT_PREFIX_OR_UNAVAILABLE",
      includeRawProviderMessages: false,
      includeCredentialMaterial: false,
      bounds: AWS_CONFIG_COMPLIANCE_BOUNDS,
    }, controller.signal);
  } catch {
    reject();
  } finally {
    clearTimeout(timeout);
  }

  const nowMs = (dependencies.now ?? Date.now)();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) reject();
  const snapshot = normalizeAwsConfigComplianceCapture(capture, trusted, nowMs);
  if (!sameScope(scope, snapshot.scope)) reject();
  const stored = await dependencies.store.recordSnapshot(scope, snapshot, nowMs);
  if (stored.scope.organizationId !== scope.organizationId
    || stored.scope.customerId !== scope.customerId
    || stored.scope.connectionId !== scope.connectionId
    || stored.snapshot.captureId !== snapshot.captureId) reject();
  return {
    snapshotId: stored.snapshotId,
    state: stored.state,
    captureId: stored.snapshot.captureId,
  };
}
