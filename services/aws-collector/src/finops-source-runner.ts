/**
 * Server-owned FinOps source dispatch.
 *
 * The public/job request names only a persisted contract identity. Every AWS
 * operation, endpoint, account, partition, region and collection limit comes
 * from this compiled catalog plus the encrypted connection registry.
 */
import {
  collectAwsCostAnomalyDetection,
  COST_ANOMALY_COMMAND_DEADLINE_MS,
  COST_ANOMALY_MAX_ANOMALIES,
  COST_ANOMALY_MAX_LOOKBACK_DAYS,
  COST_ANOMALY_MAX_MONITORS,
  COST_ANOMALY_MAX_OUTPUT_BYTES,
  COST_ANOMALY_MAX_PAGES_PER_OPERATION,
  COST_ANOMALY_MAX_SUBSCRIPTIONS,
  COST_ANOMALY_OVERALL_DEADLINE_MS,
  type AwsCostAnomalyCollection,
  type CostAnomalyReader,
} from "./cost-anomaly-runner.js";
import {
  FOUNDATIONAL_FINOPS_PERMISSION_PACK_VERSION,
  type AwsPartition,
  type FinopsSourceContract,
  type SafeJsonObject,
  type ScopedConnectionRegistry,
  type StoredAwsConnection,
  type ValidatedRoleSession,
} from "./types.js";
import {
  finopsSourceDefinition,
  resolveFinopsSourceContract,
  type FinopsCollectorSourceId,
  type FinopsSourceContractOwner,
} from "./finops-source-contract.js";
export {
  COST_ANOMALY_SOURCE_ACTIONS,
  COST_ANOMALY_SOURCE_PERMISSION_CONTRACT_ID,
  COST_ANOMALY_SOURCE_POLICY_NAME,
  FINOPS_COLLECTOR_SOURCE_IDS,
  FINOPS_SOURCE_DEFINITIONS,
  FinopsSourceContractError,
  actionsForFinopsSourceContracts,
  parseFinopsSourceContracts,
  resolveFinopsSourceContract,
  type FinopsCollectorSourceId,
  type FinopsSourceContractOwner,
} from "./finops-source-contract.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const DAY_MS = 86_400_000;

export const FINOPS_SOURCE_DISPATCH_MAX_BYTES =
  COST_ANOMALY_MAX_OUTPUT_BYTES + 64 * 1_024;
export const FINOPS_SOURCE_DISPATCH_DEADLINE_MS =
  COST_ANOMALY_OVERALL_DEADLINE_MS;
export const FINOPS_SOURCE_MAX_OPERATION_CONCURRENCY = 3;
export const FINOPS_SOURCE_MAX_CONCURRENT_DISPATCHES = 3;

let activeSourceDispatches = 0;
const sourceDispatchWaiters: Array<{
  readonly resolve: () => void;
  readonly reject: () => void;
}> = [];

export interface FinopsSourceDispatchRequest {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly contractId: string;
}

export interface FinopsSourceSessionBroker {
  assumeValidatedFinopsSourceSession(
    scope: { readonly tenantId: string },
    connectionId: string,
    jobId: string,
    contractId: string,
  ): Promise<ValidatedRoleSession>;
}

export interface FinopsSourceDispatchDependencies {
  readonly registry: ScopedConnectionRegistry;
  readonly broker: FinopsSourceSessionBroker;
  readonly now?: () => Date;
  /** Tests only. Production uses the fixed AWS SDK Cost Explorer endpoint. */
  readonly costAnomalyReader?: CostAnomalyReader;
}

export interface FinopsSourceDispatchCoverage {
  readonly pagesObserved: number;
  readonly recordsObserved: number;
  readonly recordsAccepted: number;
  readonly recordsRejected: number;
  readonly recordsOmitted: number;
}

/** Stable, credential-free envelope consumed by app jobs and HTTP callers. */
export interface FinopsSourceDispatchResult {
  readonly schemaVersion: "sutra.finops-source-dispatch.v1";
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly contractId: string;
  readonly sourceId: FinopsCollectorSourceId | null;
  readonly configured: boolean;
  readonly implementationState:
    | "NOT_CONFIGURED"
    | "NOT_IMPLEMENTED"
    | "IMPLEMENTED";
  readonly collectionStatus: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly region: string | null;
  readonly collectedAt: string;
  readonly dataThroughAt: string | null;
  readonly coverage: FinopsSourceDispatchCoverage;
  readonly evidence: SafeJsonObject | null;
  readonly errorCode: string | null;
  readonly limitations: readonly string[];
}

export class FinopsSourceDispatchError extends Error {
  public constructor() {
    super("The FinOps source collection did not complete");
    this.name = "FinopsSourceDispatchError";
  }
}

export function parseFinopsSourceDispatchRequest(
  value: unknown,
): FinopsSourceDispatchRequest {
  const record = exactRecord(value, [
    "tenantId",
    "connectionId",
    "jobId",
    "contractId",
  ]);
  if (
    typeof record.tenantId !== "string" || !IDENTIFIER.test(record.tenantId) ||
    typeof record.connectionId !== "string" || !IDENTIFIER.test(record.connectionId) ||
    typeof record.jobId !== "string" || !IDENTIFIER.test(record.jobId) ||
    typeof record.contractId !== "string" || !IDENTIFIER.test(record.contractId)
  ) throw new FinopsSourceDispatchError();
  return {
    tenantId: record.tenantId,
    connectionId: record.connectionId,
    jobId: record.jobId,
    contractId: record.contractId,
  };
}

/**
 * App/job-callable security boundary. It resolves the persisted source binding,
 * asks the broker for an exact attested STS session and dispatches only a
 * compiled adapter. No request-controlled AWS SDK input reaches the adapter.
 */
export async function executeFinopsSourceDispatch(
  unsafeRequest: FinopsSourceDispatchRequest,
  dependencies: FinopsSourceDispatchDependencies,
): Promise<FinopsSourceDispatchResult> {
  const dispatchDeadlineAt = Date.now() + FINOPS_SOURCE_DISPATCH_DEADLINE_MS;
  const request = parseFinopsSourceDispatchRequest(unsafeRequest);
  const collectedAtDate = dependencies.now?.() ?? new Date();
  if (!Number.isFinite(collectedAtDate.getTime())) throw new FinopsSourceDispatchError();
  const collectedAt = collectedAtDate.toISOString();
  const connection = await dependencies.registry.resolve(
    { tenantId: request.tenantId },
    request.connectionId,
  );
  if (connection === null) throw new FinopsSourceDispatchError();
  assertConnectionBoundary(connection, request);
  const owner = contractOwner(connection);
  let contract: FinopsSourceContract | null;
  try {
    contract = resolveFinopsSourceContract(
      connection.finopsSourceContracts,
      owner,
      request.contractId,
    );
  } catch {
    throw new FinopsSourceDispatchError();
  }
  if (contract === null) {
    return emptyResult({
      request,
      connection,
      collectedAt,
      sourceId: null,
      configured: false,
      implementationState: "NOT_CONFIGURED",
      region: null,
      errorCode: "SOURCE_NOT_CONFIGURED",
      limitations: ["SOURCE_NOT_CONFIGURED", "NO_PROVIDER_DATA_RETURNED"],
    });
  }

  const definition = finopsSourceDefinition(contract.sourceId);
  if (definition.implementationState === "NOT_IMPLEMENTED") {
    return emptyResult({
      request,
      connection,
      collectedAt,
      sourceId: contract.sourceId as FinopsCollectorSourceId,
      configured: true,
      implementationState: "NOT_IMPLEMENTED",
      region: contract.region,
      errorCode: "SOURCE_ADAPTER_NOT_IMPLEMENTED",
      limitations: ["SOURCE_ADAPTER_NOT_IMPLEMENTED", "NO_PROVIDER_DATA_RETURNED"],
    });
  }

  let session: ValidatedRoleSession;
  try {
    session = await dependencies.broker.assumeValidatedFinopsSourceSession(
      { tenantId: request.tenantId },
      request.connectionId,
      request.jobId,
      request.contractId,
    );
  } catch {
    throw new FinopsSourceDispatchError();
  }
  if (
    session.connectionId !== request.connectionId ||
    session.accountId !== contract.accountId ||
    session.partition !== contract.partition ||
    session.roleArn !== connection.roleArn ||
    session.expiresAt.getTime() <= collectedAtDate.getTime()
  ) throw new FinopsSourceDispatchError();

  if (contract.sourceId !== "cost_anomaly_detection") {
    throw new FinopsSourceDispatchError();
  }
  const windowEnd = collectedAtDate;
  const windowStart = new Date(
    windowEnd.getTime() - COST_ANOMALY_MAX_LOOKBACK_DAYS * DAY_MS,
  );
  let collection: AwsCostAnomalyCollection;
  try {
    collection = await withSourceDispatchPermit(
      (remainingMs) => collectAwsCostAnomalyDetection({
        accountId: session.accountId,
        partition: session.partition,
        credentials: session.credentials,
        windowStart,
        windowEnd,
        now: () => collectedAtDate,
        ...(dependencies.costAnomalyReader === undefined
          ? {}
          : { client: dependencies.costAnomalyReader }),
        maxPagesPerOperation: COST_ANOMALY_MAX_PAGES_PER_OPERATION,
        maxAnomalies: COST_ANOMALY_MAX_ANOMALIES,
        maxMonitors: COST_ANOMALY_MAX_MONITORS,
        maxSubscriptions: COST_ANOMALY_MAX_SUBSCRIPTIONS,
        overallDeadlineMs: Math.min(
          COST_ANOMALY_OVERALL_DEADLINE_MS,
          remainingMs,
        ),
        commandDeadlineMs: Math.min(
          COST_ANOMALY_COMMAND_DEADLINE_MS,
          remainingMs,
        ),
      }),
      dispatchDeadlineAt,
    );
  } catch {
    return emptyResult({
      request,
      connection,
      collectedAt,
      sourceId: contract.sourceId,
      configured: true,
      implementationState: "IMPLEMENTED",
      region: contract.region,
      errorCode: "COLLECTION_FAILED",
      limitations: ["COLLECTION_FAILED", "NO_PROVIDER_DATA_RETURNED"],
    });
  }

  const result = costAnomalyResult(request, contract, collection);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > FINOPS_SOURCE_DISPATCH_MAX_BYTES) {
    return emptyResult({
      request,
      connection,
      collectedAt,
      sourceId: contract.sourceId,
      configured: true,
      implementationState: "IMPLEMENTED",
      region: contract.region,
      errorCode: "OUTPUT_SIZE_LIMIT_REACHED",
      limitations: ["OUTPUT_SIZE_LIMIT_REACHED", "NO_PROVIDER_DATA_RETURNED"],
      coverage: aggregateCoverage(collection),
    });
  }
  return result;
}

function costAnomalyResult(
  request: FinopsSourceDispatchRequest,
  contract: FinopsSourceContract,
  collection: AwsCostAnomalyCollection,
): FinopsSourceDispatchResult {
  const evidence = minimizeCostAnomalyEvidence(collection);
  return {
    schemaVersion: "sutra.finops-source-dispatch.v1",
    tenantId: request.tenantId,
    connectionId: request.connectionId,
    jobId: request.jobId,
    contractId: request.contractId,
    sourceId: "cost_anomaly_detection",
    configured: true,
    implementationState: "IMPLEMENTED",
    collectionStatus: collection.status,
    accountId: collection.accountId,
    partition: contract.partition,
    region: contract.region,
    collectedAt: collection.collectedAt,
    dataThroughAt: collection.dataThroughAt,
    coverage: aggregateCoverage(collection),
    evidence,
    errorCode: collection.status === "COMPLETE"
      ? null
      : firstCoverageError(collection) ?? "SOURCE_COVERAGE_INCOMPLETE",
    limitations: [...new Set([
      ...collection.limitations,
      "CALLER_DEFINED_LABELS_REDACTED_BEFORE_TRANSPORT",
      `MAX_OPERATION_CONCURRENCY_${FINOPS_SOURCE_MAX_OPERATION_CONCURRENCY}`,
    ])],
  };
}

function minimizeCostAnomalyEvidence(
  collection: AwsCostAnomalyCollection,
): SafeJsonObject {
  return {
    schemaVersion: collection.schemaVersion,
    source: collection.source,
    windowStartDate: collection.windowStartDate,
    windowEndDate: collection.windowEndDate,
    coverage: collection.coverage.map((entry) => ({
      operation: entry.operation,
      status: entry.status,
      pagesObserved: entry.pagesObserved,
      recordsObserved: entry.recordsObserved,
      recordsAccepted: entry.recordsAccepted,
      recordsRejected: entry.recordsRejected,
      recordsOmitted: entry.recordsOmitted,
      errorCode: entry.errorCode,
    })),
    anomalies: collection.anomalies.map((anomaly) => ({
      anomalyId: anomaly.anomalyId,
      monitorArn: anomaly.monitorArn,
      startDate: anomaly.startDate,
      endDate: anomaly.endDate,
      feedback: anomaly.feedback,
      score: anomaly.score,
      impact: anomaly.impact,
      rootCauses: anomaly.rootCauses.map((cause) => ({
        service: cause.service,
        region: cause.region,
        linkedAccountId: cause.linkedAccountId,
        usageType: cause.usageType,
        contribution: cause.contribution,
      })),
      rootCausesOmitted: anomaly.rootCausesOmitted,
    })),
    monitors: collection.monitors.map((monitor) => ({
      monitorArn: monitor.monitorArn,
      type: monitor.type,
      dimension: monitor.dimension,
      specificationPresent: monitor.specificationPresent,
      dimensionalValueCount: monitor.dimensionalValueCount,
      createdAt: monitor.createdAt,
      lastUpdatedAt: monitor.lastUpdatedAt,
      lastEvaluatedAt: monitor.lastEvaluatedAt,
    })),
    subscriptions: collection.subscriptions.map((subscription) => ({
      subscriptionArn: subscription.subscriptionArn,
      frequency: subscription.frequency,
      monitorArns: subscription.monitorArns,
      monitorArnsOmitted: subscription.monitorArnsOmitted,
      threshold: subscription.threshold,
      thresholdExpressionPresent: subscription.thresholdExpressionPresent,
      subscriberCounts: {
        emailConfirmed: subscription.subscriberCounts.emailConfirmed,
        emailDeclined: subscription.subscriberCounts.emailDeclined,
        snsConfirmed: subscription.subscriberCounts.snsConfirmed,
        snsDeclined: subscription.subscriberCounts.snsDeclined,
        unknown: subscription.subscriberCounts.unknown,
      },
    })),
  };
}

async function withSourceDispatchPermit<T>(
  run: (remainingMs: number) => Promise<T>,
  deadlineAt: number,
): Promise<T> {
  await acquireSourceDispatchPermit(deadlineAt);
  try {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < 1) throw new FinopsSourceDispatchError();
    return await run(remainingMs);
  } finally {
    releaseSourceDispatchPermit();
  }
}

async function acquireSourceDispatchPermit(deadlineAt: number): Promise<void> {
  const deadlineMs = deadlineAt - Date.now();
  if (deadlineMs < 1) throw new FinopsSourceDispatchError();
  if (activeSourceDispatches < FINOPS_SOURCE_MAX_CONCURRENT_DISPATCHES) {
    activeSourceDispatches += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const waiter = {
      resolve: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        activeSourceDispatches += 1;
        resolve();
      },
      reject: () => {
        if (settled) return;
        settled = true;
        reject(new FinopsSourceDispatchError());
      },
    };
    const timer = setTimeout(() => {
      const index = sourceDispatchWaiters.indexOf(waiter);
      if (index >= 0) sourceDispatchWaiters.splice(index, 1);
      waiter.reject();
    }, deadlineMs);
    timer.unref?.();
    sourceDispatchWaiters.push(waiter);
  });
}

function releaseSourceDispatchPermit(): void {
  activeSourceDispatches = Math.max(0, activeSourceDispatches - 1);
  sourceDispatchWaiters.shift()?.resolve();
}

function aggregateCoverage(
  collection: AwsCostAnomalyCollection,
): FinopsSourceDispatchCoverage {
  return collection.coverage.reduce<FinopsSourceDispatchCoverage>((total, entry) => ({
    pagesObserved: total.pagesObserved + entry.pagesObserved,
    recordsObserved: total.recordsObserved + entry.recordsObserved,
    recordsAccepted: total.recordsAccepted + entry.recordsAccepted,
    recordsRejected: total.recordsRejected + entry.recordsRejected,
    recordsOmitted: total.recordsOmitted + entry.recordsOmitted,
  }), emptyCoverage());
}

function firstCoverageError(collection: AwsCostAnomalyCollection): string | null {
  return collection.coverage.find((entry) => entry.errorCode !== null)?.errorCode ?? null;
}

function emptyResult(input: {
  readonly request: FinopsSourceDispatchRequest;
  readonly connection: StoredAwsConnection;
  readonly collectedAt: string;
  readonly sourceId: FinopsCollectorSourceId | null;
  readonly configured: boolean;
  readonly implementationState: FinopsSourceDispatchResult["implementationState"];
  readonly region: string | null;
  readonly errorCode: string;
  readonly limitations: readonly string[];
  readonly coverage?: FinopsSourceDispatchCoverage;
}): FinopsSourceDispatchResult {
  return {
    schemaVersion: "sutra.finops-source-dispatch.v1",
    tenantId: input.request.tenantId,
    connectionId: input.request.connectionId,
    jobId: input.request.jobId,
    contractId: input.request.contractId,
    sourceId: input.sourceId,
    configured: input.configured,
    implementationState: input.implementationState,
    collectionStatus: "UNAVAILABLE",
    accountId: input.connection.expectedAccountId,
    partition: contractPartition(input.connection),
    region: input.region,
    collectedAt: input.collectedAt,
    dataThroughAt: null,
    coverage: input.coverage ?? emptyCoverage(),
    evidence: null,
    errorCode: input.errorCode,
    limitations: input.limitations,
  };
}

function emptyCoverage(): FinopsSourceDispatchCoverage {
  return {
    pagesObserved: 0,
    recordsObserved: 0,
    recordsAccepted: 0,
    recordsRejected: 0,
    recordsOmitted: 0,
  };
}

function assertConnectionBoundary(
  connection: StoredAwsConnection,
  request: FinopsSourceDispatchRequest,
): void {
  const partition = contractPartition(connection);
  if (
    connection.tenantId !== request.tenantId ||
    connection.connectionId !== request.connectionId ||
    connection.status !== "ACTIVE" ||
    connection.permissionPackVersion !== FOUNDATIONAL_FINOPS_PERMISSION_PACK_VERSION ||
    !ACCOUNT_ID.test(connection.expectedAccountId) ||
    !connection.roleArn.startsWith(
      `arn:${partition}:iam::${connection.expectedAccountId}:role/`,
    )
  ) throw new FinopsSourceDispatchError();
}

function contractOwner(connection: StoredAwsConnection): FinopsSourceContractOwner {
  return {
    tenantId: connection.tenantId,
    connectionId: connection.connectionId,
    expectedAccountId: connection.expectedAccountId,
    partition: contractPartition(connection),
  };
}

function contractPartition(connection: StoredAwsConnection): AwsPartition {
  const match = /^arn:(aws|aws-us-gov|aws-cn):iam::\d{12}:role\//u.exec(
    connection.roleArn,
  );
  if (match?.[1] === undefined) throw new FinopsSourceDispatchError();
  return match[1] as AwsPartition;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FinopsSourceDispatchError();
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new FinopsSourceDispatchError();
  }
  return record;
}
