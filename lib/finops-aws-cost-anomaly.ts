/**
 * App-side trust boundary and tenant-pinned query contract for authoritative
 * AWS Cost Anomaly Detection evidence.
 *
 * The transport is expected to be the existing authenticated/signed broker
 * client. This module never receives AWS credentials and has no process-global
 * cache or tenant state.
 */
import type {
  AwsCostAnomalyCollection,
  CostAnomalyOperation,
  CostAnomalyOperationCoverage,
  NormalizedAwsCostAnomaly,
  NormalizedAwsCostAnomalyMonitor,
  NormalizedAwsCostAnomalySubscription,
} from "../services/aws-collector/src/cost-anomaly-runner.ts";
import type {
  AnomalyResult,
  DailyAnomaly,
} from "./finops-insights.ts";
import type {
  FinopsSourceEvidence,
  FinopsSourceScope,
} from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const AWS_REGION = /^[a-z]{2}(?:-gov)?-[a-z0-9-]{1,32}-[1-9]\d?$/u;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const MAX_LOOKBACK_DAYS = 90;
const MAX_OUTPUT_BYTES = 2 * 1_024 * 1_024;
const MAX_ANOMALIES = 200;
const MAX_MONITORS = 100;
const MAX_SUBSCRIPTIONS = 100;
const MAX_ROOT_CAUSES = 5;
const MAX_MONITOR_ARNS = 10;
const MAX_MONEY = 1_000_000_000_000;
const OPERATIONS: readonly CostAnomalyOperation[] = [
  "GET_ANOMALIES",
  "GET_ANOMALY_MONITORS",
  "GET_ANOMALY_SUBSCRIPTIONS",
];

export const AWS_COST_ANOMALY_SOURCE_ID = "cost_anomaly_detection" as const;
export const AWS_COST_ANOMALY_SOURCE_CONTRACT_ID =
  "cost-anomaly-primary-v1" as const;

export interface CostAnomalyTenantBoundary {
  readonly scope: FinopsSourceScope;
  readonly accountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
}

export interface CostAnomalyBrokerRequest {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
  readonly windowStartDate: string;
  readonly windowEndDate: string;
}

export interface CostAnomalyBrokerTransport {
  collect(request: CostAnomalyBrokerRequest): Promise<unknown>;
}

export interface CostAnomalyQuery {
  readonly lookbackDays?: number;
}

export interface CostAnomalyQueryService {
  query(input: unknown): Promise<AwsCostAnomalyCollection>;
}

export interface CostAnomalyDashboard {
  readonly aws: {
    readonly source: "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION";
    readonly collection: AwsCostAnomalyCollection;
    readonly disclaimer: string;
  };
  readonly sutra: {
    readonly source: "SUTRA_STATISTICAL_BILLING_SIGNALS";
    readonly anomalies: readonly DailyAnomaly[];
    readonly evaluatedDays: number;
    readonly disclaimer: string;
  };
  readonly disclaimer: string;
}

export interface AwsCostAnomalyDispatchMaterialization {
  readonly sourceId: typeof AWS_COST_ANOMALY_SOURCE_ID;
  readonly contractId: string;
  readonly collectionStatus: AwsCostAnomalyCollection["status"];
  readonly accountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly region: string | null;
  readonly collectedAt: string;
  readonly dataThroughAt: string | null;
  readonly coverage: {
    readonly pagesObserved: number;
    readonly recordsObserved: number;
    readonly recordsAccepted: number;
    readonly recordsRejected: number;
    readonly recordsOmitted: number;
  };
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly limitations: readonly string[];
}

export class CostAnomalyBoundaryError extends Error {
  public readonly code = "BROKER_RESPONSE_INVALID";

  public constructor() {
    super("The collector returned invalid cost anomaly evidence");
    this.name = "CostAnomalyBoundaryError";
  }
}

export class CostAnomalyQueryServiceError extends Error {
  public readonly code:
    | "INVALID_CONFIGURATION"
    | "INVALID_QUERY"
    | "COLLECTION_FAILED";

  public constructor(code: CostAnomalyQueryServiceError["code"]) {
    super("The AWS cost anomaly request could not be completed");
    this.name = "CostAnomalyQueryServiceError";
    this.code = code;
  }
}

function invalidBoundary(): never {
  throw new CostAnomalyBoundaryError();
}

function invalidQuery(
  code: CostAnomalyQueryServiceError["code"],
): never {
  throw new CostAnomalyQueryServiceError(code);
}

export function parseAwsCostAnomalyCollection(
  value: unknown,
  expectedAccountId: string,
  now: Date = new Date(),
): AwsCostAnomalyCollection {
  let encodedBytes: number;
  try {
    encodedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return invalidBoundary();
  }
  if (encodedBytes > MAX_OUTPUT_BYTES) invalidBoundary();
  const root = exactRecord(value, [
    "schemaVersion",
    "source",
    "status",
    "accountId",
    "collectedAt",
    "windowStartDate",
    "windowEndDate",
    "dataThroughAt",
    "coverage",
    "anomalies",
    "monitors",
    "subscriptions",
    "limitations",
  ]);
  if (
    root.schemaVersion !== "sutra.aws-cost-anomaly-detection.v1"
    || root.source !== "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION"
    || !new Set(["COMPLETE", "PARTIAL", "UNAVAILABLE"]).has(
      root.status as string,
    )
    || root.accountId !== expectedAccountId
    || !ACCOUNT_ID.test(expectedAccountId)
  ) invalidBoundary();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) invalidBoundary();
  const collectedAt = timestamp(root.collectedAt, nowMs);
  const windowStartDate = day(root.windowStartDate);
  const windowEndDate = day(root.windowEndDate);
  const startMs = Date.parse(`${windowStartDate}T00:00:00.000Z`);
  const endMs = Date.parse(`${windowEndDate}T00:00:00.000Z`);
  if (
    startMs >= endMs
    || endMs > nowMs + 5 * 60 * 1_000
    || endMs - startMs > MAX_LOOKBACK_DAYS * 86_400_000
  ) invalidBoundary();
  const dataThroughAt = root.dataThroughAt === null
    ? null
    : timestamp(root.dataThroughAt, Date.parse(collectedAt) + 5 * 60 * 1_000);
  if (!Array.isArray(root.coverage) || root.coverage.length !== 3) {
    invalidBoundary();
  }
  const coverage = root.coverage.map(parseCoverage);
  if (
    new Set(coverage.map((entry) => entry.operation)).size !== 3
    || OPERATIONS.some((operation) =>
      !coverage.some((entry) => entry.operation === operation)
    )
  ) invalidBoundary();
  if (
    !Array.isArray(root.anomalies)
    || root.anomalies.length > MAX_ANOMALIES
    || !Array.isArray(root.monitors)
    || root.monitors.length > MAX_MONITORS
    || !Array.isArray(root.subscriptions)
    || root.subscriptions.length > MAX_SUBSCRIPTIONS
    || !Array.isArray(root.limitations)
    || root.limitations.length > 20
  ) invalidBoundary();
  const anomalies = root.anomalies.map((entry) =>
    parseAnomaly(entry, expectedAccountId, windowStartDate, windowEndDate)
  );
  const monitors = root.monitors.map((entry) =>
    parseMonitor(entry, expectedAccountId, Date.parse(collectedAt))
  );
  const subscriptions = root.subscriptions.map((entry) =>
    parseSubscription(entry, expectedAccountId)
  );
  const limitations = root.limitations.map((entry) => code(entry));
  if (new Set(limitations).size !== limitations.length) invalidBoundary();
  assertCoverageCount(coverage, "GET_ANOMALIES", anomalies.length);
  assertCoverageCount(coverage, "GET_ANOMALY_MONITORS", monitors.length);
  assertCoverageCount(
    coverage,
    "GET_ANOMALY_SUBSCRIPTIONS",
    subscriptions.length,
  );
  const allSucceeded = coverage.every((entry) => entry.status === "SUCCEEDED");
  const allFailed = coverage.every((entry) => entry.status === "FAILED");
  if (
    (root.status === "COMPLETE" && !allSucceeded)
    || (root.status === "UNAVAILABLE" && !allFailed)
    || (root.status === "PARTIAL" && (allSucceeded || allFailed))
  ) invalidBoundary();
  return {
    schemaVersion: "sutra.aws-cost-anomaly-detection.v1",
    source: "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION",
    status:
      root.status as AwsCostAnomalyCollection["status"],
    accountId: expectedAccountId,
    collectedAt,
    windowStartDate,
    windowEndDate,
    dataThroughAt,
    coverage,
    anomalies,
    monitors,
    subscriptions,
    limitations,
  };
}

/**
 * Rehydrates the privacy-minimized signed broker projection into the canonical
 * dashboard model. Caller-defined monitor/subscription labels, anomaly
 * dimension labels, and linked-account names remain redacted. Per-operation
 * coverage and generic error codes are preserved so partial evidence is never
 * presented as complete.
 */
export function materializeAwsCostAnomalyDispatchEvidence(
  input: AwsCostAnomalyDispatchMaterialization,
  now: Date = new Date(),
): AwsCostAnomalyCollection {
  if (
    input.sourceId !== AWS_COST_ANOMALY_SOURCE_ID
    || input.contractId !== AWS_COST_ANOMALY_SOURCE_CONTRACT_ID
    || !ACCOUNT_ID.test(input.accountId)
    || !new Set(["aws", "aws-us-gov", "aws-cn"]).has(input.partition)
    || !Array.isArray(input.limitations)
    || input.limitations.length > 20
  ) invalidBoundary();
  const evidence = exactRecord(input.evidence, [
    "schemaVersion",
    "source",
    "windowStartDate",
    "windowEndDate",
    "coverage",
    "anomalies",
    "monitors",
    "subscriptions",
  ]);
  if (
    evidence.schemaVersion !== "sutra.aws-cost-anomaly-detection.v1"
    || evidence.source !== "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION"
    || !Array.isArray(evidence.coverage)
    || !Array.isArray(evidence.anomalies)
    || !Array.isArray(evidence.monitors)
    || !Array.isArray(evidence.subscriptions)
  ) invalidBoundary();

  const anomalies = evidence.anomalies.map((candidate) => {
    const anomaly = exactRecord(candidate, [
      "anomalyId",
      "monitorArn",
      "startDate",
      "endDate",
      "feedback",
      "score",
      "impact",
      "rootCauses",
      "rootCausesOmitted",
    ]);
    if (!Array.isArray(anomaly.rootCauses)) invalidBoundary();
    return {
      ...anomaly,
      dimensionValue: null,
      rootCauses: anomaly.rootCauses.map((candidateCause) => ({
        ...exactRecord(candidateCause, [
          "service",
          "region",
          "linkedAccountId",
          "usageType",
          "contribution",
        ]),
        linkedAccountName: null,
      })),
    };
  });
  const monitors = evidence.monitors.map((candidate) => ({
    ...exactRecord(candidate, [
      "monitorArn",
      "type",
      "dimension",
      "specificationPresent",
      "dimensionalValueCount",
      "createdAt",
      "lastUpdatedAt",
      "lastEvaluatedAt",
    ]),
    name: "AWS monitor label redacted",
  }));
  const subscriptions = evidence.subscriptions.map((candidate) => ({
    ...exactRecord(candidate, [
      "subscriptionArn",
      "frequency",
      "monitorArns",
      "monitorArnsOmitted",
      "threshold",
      "thresholdExpressionPresent",
      "subscriberCounts",
    ]),
    name: "AWS subscription label redacted",
  }));
  const parsed = parseAwsCostAnomalyCollection({
    schemaVersion: evidence.schemaVersion,
    source: evidence.source,
    status: input.collectionStatus,
    accountId: input.accountId,
    collectedAt: input.collectedAt,
    windowStartDate: evidence.windowStartDate,
    windowEndDate: evidence.windowEndDate,
    dataThroughAt: input.dataThroughAt,
    coverage: evidence.coverage,
    anomalies,
    monitors,
    subscriptions,
    limitations: input.limitations,
  }, input.accountId, now);

  const aggregate = parsed.coverage.reduce((total, operation) => ({
    pagesObserved: total.pagesObserved + operation.pagesObserved,
    recordsObserved: total.recordsObserved + operation.recordsObserved,
    recordsAccepted: total.recordsAccepted + operation.recordsAccepted,
    recordsRejected: total.recordsRejected + operation.recordsRejected,
    recordsOmitted: total.recordsOmitted + operation.recordsOmitted,
  }), {
    pagesObserved: 0,
    recordsObserved: 0,
    recordsAccepted: 0,
    recordsRejected: 0,
    recordsOmitted: 0,
  });
  for (const key of Object.keys(aggregate) as (keyof typeof aggregate)[]) {
    if (aggregate[key] !== input.coverage[key]) invalidBoundary();
  }
  return parsed;
}

/** Parses the exact immutable evidence-object wrapper written by the source job. */
export function parsePersistedAwsCostAnomalyMaterialization(
  value: unknown,
  expected: {
    readonly accountId: string;
    readonly partition: AwsCostAnomalyDispatchMaterialization["partition"];
  },
  now: Date = new Date(),
): AwsCostAnomalyCollection {
  const artifact = exactRecord(value, [
    "schemaVersion",
    "sourceId",
    "contractId",
    "collectionStatus",
    "accountId",
    "partition",
    "region",
    "collectedAt",
    "dataThroughAt",
    "coverage",
    "evidence",
    "limitations",
  ]);
  if (
    artifact.schemaVersion !== "sutra.finops-source-evidence.v2"
    || artifact.sourceId !== AWS_COST_ANOMALY_SOURCE_ID
    || artifact.contractId !== AWS_COST_ANOMALY_SOURCE_CONTRACT_ID
    || artifact.accountId !== expected.accountId
    || artifact.partition !== expected.partition
    || (artifact.region !== null
      && (typeof artifact.region !== "string" || !AWS_REGION.test(artifact.region)))
    || typeof artifact.collectedAt !== "string"
    || (artifact.dataThroughAt !== null && typeof artifact.dataThroughAt !== "string")
    || typeof artifact.coverage !== "object"
    || artifact.coverage === null
    || Array.isArray(artifact.coverage)
    || typeof artifact.evidence !== "object"
    || artifact.evidence === null
    || Array.isArray(artifact.evidence)
    || !Array.isArray(artifact.limitations)
  ) invalidBoundary();
  const coverage = exactRecord(artifact.coverage, [
    "pagesObserved",
    "recordsObserved",
    "recordsAccepted",
    "recordsRejected",
    "recordsOmitted",
  ]);
  if (
    artifact.collectionStatus !== "COMPLETE"
    && artifact.collectionStatus !== "PARTIAL"
  ) invalidBoundary();
  return materializeAwsCostAnomalyDispatchEvidence({
    sourceId: AWS_COST_ANOMALY_SOURCE_ID,
    contractId: AWS_COST_ANOMALY_SOURCE_CONTRACT_ID,
    collectionStatus: artifact.collectionStatus,
    accountId: expected.accountId,
    partition: expected.partition,
    region: artifact.region,
    collectedAt: artifact.collectedAt,
    dataThroughAt: artifact.dataThroughAt,
    coverage: coverage as unknown as AwsCostAnomalyDispatchMaterialization["coverage"],
    evidence: artifact.evidence as Readonly<Record<string, unknown>>,
    limitations: artifact.limitations as readonly string[],
  }, now);
}

export function createCostAnomalyQueryService(
  boundary: CostAnomalyTenantBoundary,
  transport: CostAnomalyBrokerTransport,
  dependencies: {
    readonly now?: () => Date;
    readonly createJobId?: () => string;
  } = {},
): CostAnomalyQueryService {
  if (!validTenantBoundary(boundary) || typeof transport.collect !== "function") {
    invalidQuery("INVALID_CONFIGURATION");
  }
  const fixed = {
    scope: { ...boundary.scope },
    accountId: boundary.accountId,
    partition: boundary.partition,
  } as const;
  const now = dependencies.now ?? (() => new Date());
  const createJobId = dependencies.createJobId
    ?? (() => `cad_${crypto.randomUUID().replaceAll("-", "")}`);
  return {
    async query(input: unknown): Promise<AwsCostAnomalyCollection> {
      const query = parseQuery(input);
      const observedNow = now();
      if (!Number.isFinite(observedNow.getTime())) invalidQuery("INVALID_QUERY");
      const windowEnd = new Date(Date.UTC(
        observedNow.getUTCFullYear(),
        observedNow.getUTCMonth(),
        observedNow.getUTCDate(),
      ));
      const windowStart = new Date(
        windowEnd.getTime() - query.lookbackDays * 86_400_000,
      );
      const jobId = createJobId();
      if (!/^cad_[a-f0-9]{32}$/u.test(jobId)) {
        invalidQuery("INVALID_CONFIGURATION");
      }
      let response: unknown;
      try {
        const windowStartDate = windowStart.toISOString().slice(0, 10);
        const windowEndDate = windowEnd.toISOString().slice(0, 10);
        response = await transport.collect({
          tenantId: fixed.scope.orgId,
          connectionId: fixed.scope.connectionId,
          jobId,
          windowStartDate,
          windowEndDate,
        });
        const parsed = parseAwsCostAnomalyCollection(
          response,
          fixed.accountId,
          observedNow,
        );
        if (
          parsed.windowStartDate !== windowStartDate
          || parsed.windowEndDate !== windowEndDate
        ) invalidBoundary();
        return parsed;
      } catch {
        return invalidQuery("COLLECTION_FAILED");
      }
    },
  };
}

/**
 * Presents the two anomaly engines together without conflating their evidence.
 * AWS findings retain AWS attribution; local CUR/FOCUS findings retain the
 * existing statistical disclaimer.
 */
export function buildCostAnomalyDashboard(
  awsCollection: AwsCostAnomalyCollection,
  sutraStatisticalFindings: AnomalyResult,
): CostAnomalyDashboard {
  const sutra = validateStatisticalFindings(sutraStatisticalFindings);
  return {
    aws: {
      source: "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION",
      collection: awsCollection,
      disclaimer:
        "AWS findings, impact, scores, and root causes are provider observations "
        + "returned by AWS Cost Anomaly Detection for the displayed window.",
    },
    sutra: {
      source: "SUTRA_STATISTICAL_BILLING_SIGNALS",
      ...sutra,
    },
    disclaimer:
      "AWS Cost Anomaly Detection findings and Sutra statistical billing signals "
      + "are independent sources. Absence in one source is not evidence that the "
      + "other source is complete or that spend is correct.",
  };
}

/**
 * Converts a validated signed-broker result into the common source-readiness
 * contract. Callers must persist this evidence in the same tenant scope before
 * treating it as durable source health.
 */
export function buildAwsCostAnomalySourceEvidence(
  scope: FinopsSourceScope,
  collection: AwsCostAnomalyCollection,
): FinopsSourceEvidence {
  if (!validScope(scope)) invalidBoundary();
  const configured = collection.monitors.length > 0;
  const delivered = collection.coverage.some(
    (entry) => entry.status !== "FAILED",
  );
  const accepted = collection.coverage.reduce(
    (total, entry) => total + entry.recordsAccepted,
    0,
  );
  const rejected = collection.coverage.reduce(
    (total, entry) => total + entry.recordsRejected + entry.recordsOmitted,
    0,
  );
  return {
    scope: { ...scope },
    sourceId: "cost_anomaly_detection",
    configured,
    deliveryObserved: delivered,
    lastAttemptAt: collection.collectedAt,
    lastAttemptOutcome:
      collection.status === "COMPLETE"
        ? "succeeded"
        : collection.status === "PARTIAL"
          ? "partial"
          : "failed",
    lastSuccessAt: delivered ? collection.collectedAt : null,
    dataThroughAt: collection.dataThroughAt,
    coverage: {
      assessment:
        collection.status === "COMPLETE"
          ? "complete"
          : collection.status === "PARTIAL"
            ? "partial"
            : "unknown",
      acceptedRecords: delivered ? accepted : null,
      // Cost Explorer pagination does not expose a source-wide expected count.
      expectedRecords: null,
      rejectedRecords: delivered ? rejected : null,
    },
    lastError: collection.status === "UNAVAILABLE"
      ? {
          code: "COST_ANOMALY_COLLECTION_FAILED",
          message: "The latest AWS Cost Anomaly Detection collection failed.",
          at: collection.collectedAt,
        }
      : null,
    evidenceBasis:
      "Tenant-pinned signed-broker reads of ce:GetAnomalies, "
      + "ce:GetAnomalyMonitors, and ce:GetAnomalySubscriptions; "
      + `account=${collection.accountId}; window=`
      + `${collection.windowStartDate}/${collection.windowEndDate}.`,
    limitations: [
      ...collection.limitations,
      ...(!configured
        ? ["No AWS Cost Anomaly Detection monitor was returned."]
        : []),
      "AWS does not provide an expected total-record count for these paginated APIs.",
    ],
  };
}

function parseQuery(value: unknown): { readonly lookbackDays: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidQuery("INVALID_QUERY");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length > 1
    || keys.some((key) => key !== "lookbackDays")
  ) invalidQuery("INVALID_QUERY");
  const lookbackDays = record.lookbackDays ?? 30;
  if (
    !Number.isSafeInteger(lookbackDays)
    || (lookbackDays as number) < 1
    || (lookbackDays as number) > MAX_LOOKBACK_DAYS
  ) invalidQuery("INVALID_QUERY");
  return { lookbackDays: lookbackDays as number };
}

function parseCoverage(value: unknown): CostAnomalyOperationCoverage {
  const record = exactRecord(value, [
    "operation",
    "status",
    "pagesObserved",
    "recordsObserved",
    "recordsAccepted",
    "recordsRejected",
    "recordsOmitted",
    "errorCode",
  ]);
  if (
    !OPERATIONS.includes(record.operation as CostAnomalyOperation)
    || !new Set(["SUCCEEDED", "PARTIAL", "FAILED"]).has(
      record.status as string,
    )
  ) invalidBoundary();
  const pagesObserved = integer(record.pagesObserved, 0, 10);
  const recordsObserved = integer(record.recordsObserved, 0, 10_000);
  const recordsAccepted = integer(record.recordsAccepted, 0, 10_000);
  const recordsRejected = integer(record.recordsRejected, 0, 10_000);
  const recordsOmitted = integer(record.recordsOmitted, 0, 10_000);
  const errorCode = record.errorCode === null ? null : code(record.errorCode);
  if (
    recordsObserved !== recordsAccepted + recordsRejected + recordsOmitted
    || (record.status === "SUCCEEDED" && errorCode !== null)
    || (record.status !== "SUCCEEDED" && errorCode === null)
    || (record.status === "FAILED" && recordsAccepted !== 0)
  ) invalidBoundary();
  return {
    operation: record.operation as CostAnomalyOperation,
    status:
      record.status as CostAnomalyOperationCoverage["status"],
    pagesObserved,
    recordsObserved,
    recordsAccepted,
    recordsRejected,
    recordsOmitted,
    errorCode,
  };
}

function parseAnomaly(
  value: unknown,
  accountId: string,
  windowStartDate: string,
  windowEndDate: string,
): NormalizedAwsCostAnomaly {
  const record = exactRecord(value, [
    "anomalyId",
    "monitorArn",
    "startDate",
    "endDate",
    "dimensionValue",
    "feedback",
    "score",
    "impact",
    "rootCauses",
    "rootCausesOmitted",
  ]);
  const anomalyId = text(record.anomalyId, 256);
  const monitorArn = costAnomalyArn(
    record.monitorArn,
    accountId,
    "anomalymonitor",
  );
  const startDate = record.startDate === null ? null : day(record.startDate);
  const endDate = record.endDate === null ? null : day(record.endDate);
  if (
    startDate !== null && endDate !== null && endDate < startDate
    || endDate !== null
      && (endDate < windowStartDate || endDate > windowEndDate)
  ) invalidBoundary();
  const score = exactRecord(record.score, ["current", "maximum"]);
  const current = number(score.current, 0, 100);
  const maximum = number(score.maximum, 0, 100);
  if (current > maximum) invalidBoundary();
  const impact = exactRecord(record.impact, [
    "maximum",
    "total",
    "actualSpend",
    "expectedSpend",
    "percentage",
  ]);
  if (
    !Array.isArray(record.rootCauses)
    || record.rootCauses.length > MAX_ROOT_CAUSES
  ) invalidBoundary();
  const rootCauses = record.rootCauses.map((candidate) => {
    const cause = exactRecord(candidate, [
      "service",
      "region",
      "linkedAccountId",
      "linkedAccountName",
      "usageType",
      "contribution",
    ]);
    return {
      service: nullableText(cause.service, 256),
      region: nullableText(cause.region, 64),
      linkedAccountId: cause.linkedAccountId === null
        ? null
        : account(cause.linkedAccountId),
      linkedAccountName: nullableText(cause.linkedAccountName, 256),
      usageType: nullableText(cause.usageType, 256),
      contribution: nullableNumber(cause.contribution, 0, MAX_MONEY),
    };
  });
  const feedback = record.feedback;
  if (
    feedback !== null
    && !new Set(["YES", "NO", "PLANNED_ACTIVITY"]).has(feedback as string)
  ) invalidBoundary();
  return {
    anomalyId,
    monitorArn,
    startDate,
    endDate,
    dimensionValue: nullableText(record.dimensionValue, 256),
    feedback: feedback as NormalizedAwsCostAnomaly["feedback"],
    score: { current, maximum },
    impact: {
      maximum: number(impact.maximum, 0, MAX_MONEY),
      total: nullableNumber(impact.total, 0, MAX_MONEY),
      actualSpend: nullableNumber(impact.actualSpend, 0, MAX_MONEY),
      expectedSpend: nullableNumber(impact.expectedSpend, 0, MAX_MONEY),
      percentage: nullableNumber(
        impact.percentage,
        -1_000_000,
        1_000_000,
      ),
    },
    rootCauses,
    rootCausesOmitted: integer(record.rootCausesOmitted, 0, 10_000),
  };
}

function parseMonitor(
  value: unknown,
  accountId: string,
  collectedAtMs: number,
): NormalizedAwsCostAnomalyMonitor {
  const record = exactRecord(value, [
    "monitorArn",
    "name",
    "type",
    "dimension",
    "specificationPresent",
    "dimensionalValueCount",
    "createdAt",
    "lastUpdatedAt",
    "lastEvaluatedAt",
  ]);
  if (
    !new Set(["CUSTOM", "DIMENSIONAL"]).has(record.type as string)
    || (
      record.dimension !== null
      && !new Set(["SERVICE", "LINKED_ACCOUNT", "TAG", "COST_CATEGORY"])
        .has(record.dimension as string)
    )
    || typeof record.specificationPresent !== "boolean"
  ) invalidBoundary();
  return {
    monitorArn: costAnomalyArn(
      record.monitorArn,
      accountId,
      "anomalymonitor",
    ),
    name: text(record.name, 256),
    type: record.type as NormalizedAwsCostAnomalyMonitor["type"],
    dimension:
      record.dimension as NormalizedAwsCostAnomalyMonitor["dimension"],
    specificationPresent: record.specificationPresent,
    dimensionalValueCount: record.dimensionalValueCount === null
      ? null
      : integer(record.dimensionalValueCount, 0, 10_000_000),
    createdAt: record.createdAt === null
      ? null
      : timestamp(record.createdAt, collectedAtMs + 5 * 60 * 1_000),
    lastUpdatedAt: record.lastUpdatedAt === null
      ? null
      : timestamp(record.lastUpdatedAt, collectedAtMs + 5 * 60 * 1_000),
    lastEvaluatedAt: record.lastEvaluatedAt === null
      ? null
      : timestamp(record.lastEvaluatedAt, collectedAtMs + 5 * 60 * 1_000),
  };
}

function parseSubscription(
  value: unknown,
  accountId: string,
): NormalizedAwsCostAnomalySubscription {
  const record = exactRecord(value, [
    "subscriptionArn",
    "name",
    "frequency",
    "monitorArns",
    "monitorArnsOmitted",
    "threshold",
    "thresholdExpressionPresent",
    "subscriberCounts",
  ]);
  if (
    !new Set(["IMMEDIATE", "DAILY", "WEEKLY"]).has(
      record.frequency as string,
    )
    || !Array.isArray(record.monitorArns)
    || record.monitorArns.length > MAX_MONITOR_ARNS
    || typeof record.thresholdExpressionPresent !== "boolean"
  ) invalidBoundary();
  const monitorArns = record.monitorArns.map((arn) =>
    costAnomalyArn(arn, accountId, "anomalymonitor")
  );
  if (new Set(monitorArns).size !== monitorArns.length) invalidBoundary();
  const counts = exactRecord(record.subscriberCounts, [
    "emailConfirmed",
    "emailDeclined",
    "snsConfirmed",
    "snsDeclined",
    "unknown",
  ]);
  return {
    subscriptionArn: costAnomalyArn(
      record.subscriptionArn,
      accountId,
      "anomalysubscription",
    ),
    name: text(record.name, 256),
    frequency:
      record.frequency as NormalizedAwsCostAnomalySubscription["frequency"],
    monitorArns,
    monitorArnsOmitted: integer(record.monitorArnsOmitted, 0, 10_000),
    threshold: nullableNumber(record.threshold, 0, 10_000_000_000),
    thresholdExpressionPresent: record.thresholdExpressionPresent,
    subscriberCounts: {
      emailConfirmed: integer(counts.emailConfirmed, 0, 100),
      emailDeclined: integer(counts.emailDeclined, 0, 100),
      snsConfirmed: integer(counts.snsConfirmed, 0, 100),
      snsDeclined: integer(counts.snsDeclined, 0, 100),
      unknown: integer(counts.unknown, 0, 100),
    },
  };
}

function validateStatisticalFindings(value: AnomalyResult): AnomalyResult {
  if (
    !Array.isArray(value.anomalies)
    || value.anomalies.length > 500
    || !Number.isSafeInteger(value.evaluatedDays)
    || value.evaluatedDays < 0
    || value.evaluatedDays > 10_000_000
  ) invalidBoundary();
  const anomalies = value.anomalies.map((entry) => ({
    dateIso: day(entry.dateIso),
    service: text(entry.service, 256),
    currency: text(entry.currency, 16),
    amountMicros: micros(entry.amountMicros),
    baselineMicros: micros(entry.baselineMicros),
    ratio: number(entry.ratio, 0, 1_000_000),
  }));
  return {
    anomalies,
    evaluatedDays: value.evaluatedDays,
    disclaimer: text(value.disclaimer, 1_024),
  };
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidBoundary();
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (
    actual.length !== keys.length
    || actual.some((key) => !keys.includes(key))
  ) invalidBoundary();
  return record;
}

function text(value: unknown, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) invalidBoundary();
  return value;
}

function nullableText(value: unknown, maximum: number): string | null {
  return value === null ? null : text(value, maximum);
}

function number(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) invalidBoundary();
  return value;
}

function nullableNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return value === null ? null : number(value, minimum, maximum);
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) invalidBoundary();
  return value as number;
}

function day(value: unknown): string {
  const candidate = text(value, 10);
  const milliseconds = Date.parse(`${candidate}T00:00:00.000Z`);
  if (
    !ISO_DAY.test(candidate)
    || !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString().slice(0, 10) !== candidate
  ) invalidBoundary();
  return candidate;
}

function timestamp(value: unknown, maximumMs: number): string {
  const candidate = text(value, 40);
  const milliseconds = Date.parse(candidate);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== candidate
    || milliseconds > maximumMs
  ) invalidBoundary();
  return candidate;
}

function code(value: unknown): string {
  const candidate = text(value, 96);
  if (!SAFE_CODE.test(candidate)) invalidBoundary();
  return candidate;
}

function account(value: unknown): string {
  const candidate = text(value, 12);
  if (!ACCOUNT_ID.test(candidate)) invalidBoundary();
  return candidate;
}

function costAnomalyArn(
  value: unknown,
  accountId: string,
  type: "anomalymonitor" | "anomalysubscription",
): string {
  const candidate = text(value, 512);
  if (
    !new RegExp(
      `^arn:(?:aws|aws-us-gov|aws-cn):ce::${accountId}:${type}/.+$`,
      "u",
    ).test(candidate)
  ) invalidBoundary();
  return candidate;
}

function micros(value: unknown): string {
  const candidate = text(value, 32);
  if (!/^(?:0|[1-9]\d{0,30})$/u.test(candidate)) invalidBoundary();
  return candidate;
}

function assertCoverageCount(
  coverage: readonly CostAnomalyOperationCoverage[],
  operation: CostAnomalyOperation,
  count: number,
): void {
  if (
    coverage.find((entry) => entry.operation === operation)?.recordsAccepted
    !== count
  ) invalidBoundary();
}

function validScope(value: FinopsSourceScope): boolean {
  return value !== null
    && typeof value === "object"
    && IDENTIFIER.test(value.orgId)
    && IDENTIFIER.test(value.customerId)
    && CONNECTION_ID.test(value.connectionId);
}

function validTenantBoundary(value: CostAnomalyTenantBoundary): boolean {
  return value !== null
    && typeof value === "object"
    && validScope(value.scope)
    && ACCOUNT_ID.test(value.accountId)
    && new Set(["aws", "aws-us-gov", "aws-cn"]).has(value.partition);
}
