/**
 * Bounded, read-only AWS Cost Anomaly Detection collection.
 *
 * This runner executes only inside the credential-owning collector. It returns
 * normalized provider evidence; temporary credentials, subscriber addresses,
 * provider exception messages, and raw monitor expressions never cross the
 * broker boundary.
 */
import {
  CostExplorerClient,
  GetAnomaliesCommand,
  GetAnomalyMonitorsCommand,
  GetAnomalySubscriptionsCommand,
  type Anomaly,
  type AnomalyMonitor,
  type AnomalySubscription,
  type GetAnomaliesCommandInput,
  type GetAnomaliesCommandOutput,
  type GetAnomalyMonitorsCommandInput,
  type GetAnomalyMonitorsCommandOutput,
  type GetAnomalySubscriptionsCommandInput,
  type GetAnomalySubscriptionsCommandOutput,
} from "@aws-sdk/client-cost-explorer";

import { workloadIdentityAwsClientConfig } from "./role-broker.js";
import type { AwsPartition, AwsTemporaryCredentials } from "./types.js";

export const COST_ANOMALY_MAX_LOOKBACK_DAYS = 90;
export const COST_ANOMALY_MAX_PAGES_PER_OPERATION = 10;
export const COST_ANOMALY_MAX_ANOMALIES = 200;
export const COST_ANOMALY_MAX_MONITORS = 100;
export const COST_ANOMALY_MAX_SUBSCRIPTIONS = 100;
export const COST_ANOMALY_MAX_OUTPUT_BYTES = 2 * 1_024 * 1_024;
export const COST_ANOMALY_OVERALL_DEADLINE_MS = 75_000;
export const COST_ANOMALY_COMMAND_DEADLINE_MS = 10_000;
export const COST_ANOMALY_OFFICIAL_ENDPOINT =
  "https://ce.us-east-1.amazonaws.com" as const;

const PAGE_SIZE = 100;
const MAX_ROOT_CAUSES = 5;
const MAX_MONITOR_ARNS_PER_SUBSCRIPTION = 10;
const MAX_MONEY = 1_000_000_000_000;
const ACCOUNT_ID = /^\d{12}$/u;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const SAFE_TOKEN = /^[^\u0000-\u001f\u007f]{1,4096}$/u;

export type CostAnomalyCollectionStatus =
  | "COMPLETE"
  | "PARTIAL"
  | "UNAVAILABLE";
export type CostAnomalyOperationStatus =
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED";
export type CostAnomalyOperation =
  | "GET_ANOMALIES"
  | "GET_ANOMALY_MONITORS"
  | "GET_ANOMALY_SUBSCRIPTIONS";

export interface CostAnomalyOperationCoverage {
  readonly operation: CostAnomalyOperation;
  readonly status: CostAnomalyOperationStatus;
  readonly pagesObserved: number;
  readonly recordsObserved: number;
  readonly recordsAccepted: number;
  readonly recordsRejected: number;
  readonly recordsOmitted: number;
  readonly errorCode: string | null;
}

export interface NormalizedCostAnomalyRootCause {
  readonly service: string | null;
  readonly region: string | null;
  readonly linkedAccountId: string | null;
  readonly linkedAccountName: string | null;
  readonly usageType: string | null;
  readonly contribution: number | null;
}

export interface NormalizedAwsCostAnomaly {
  readonly anomalyId: string;
  readonly monitorArn: string;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly dimensionValue: string | null;
  readonly feedback: "YES" | "NO" | "PLANNED_ACTIVITY" | null;
  readonly score: {
    readonly current: number;
    readonly maximum: number;
  };
  readonly impact: {
    readonly maximum: number;
    readonly total: number | null;
    readonly actualSpend: number | null;
    readonly expectedSpend: number | null;
    readonly percentage: number | null;
  };
  readonly rootCauses: readonly NormalizedCostAnomalyRootCause[];
  readonly rootCausesOmitted: number;
}

export interface NormalizedAwsCostAnomalyMonitor {
  readonly monitorArn: string;
  readonly name: string;
  readonly type: "CUSTOM" | "DIMENSIONAL";
  readonly dimension:
    | "SERVICE"
    | "LINKED_ACCOUNT"
    | "TAG"
    | "COST_CATEGORY"
    | null;
  readonly specificationPresent: boolean;
  readonly dimensionalValueCount: number | null;
  readonly createdAt: string | null;
  readonly lastUpdatedAt: string | null;
  readonly lastEvaluatedAt: string | null;
}

export interface CostAnomalySubscriberCounts {
  readonly emailConfirmed: number;
  readonly emailDeclined: number;
  readonly snsConfirmed: number;
  readonly snsDeclined: number;
  readonly unknown: number;
}

export interface NormalizedAwsCostAnomalySubscription {
  readonly subscriptionArn: string;
  readonly name: string;
  readonly frequency: "IMMEDIATE" | "DAILY" | "WEEKLY";
  readonly monitorArns: readonly string[];
  readonly monitorArnsOmitted: number;
  readonly threshold: number | null;
  readonly thresholdExpressionPresent: boolean;
  readonly subscriberCounts: CostAnomalySubscriberCounts;
}

export interface AwsCostAnomalyCollection {
  readonly schemaVersion: "sutra.aws-cost-anomaly-detection.v1";
  readonly source: "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION";
  readonly status: CostAnomalyCollectionStatus;
  readonly accountId: string;
  readonly collectedAt: string;
  readonly windowStartDate: string;
  readonly windowEndDate: string;
  /** Latest provider monitor evaluation, not the request completion time. */
  readonly dataThroughAt: string | null;
  readonly coverage: readonly CostAnomalyOperationCoverage[];
  readonly anomalies: readonly NormalizedAwsCostAnomaly[];
  readonly monitors: readonly NormalizedAwsCostAnomalyMonitor[];
  readonly subscriptions: readonly NormalizedAwsCostAnomalySubscription[];
  readonly limitations: readonly string[];
}

export interface CostAnomalyReader {
  getAnomalies(
    input: GetAnomaliesCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<Pick<GetAnomaliesCommandOutput, "Anomalies" | "NextPageToken">>;
  getAnomalyMonitors(
    input: GetAnomalyMonitorsCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<Pick<
    GetAnomalyMonitorsCommandOutput,
    "AnomalyMonitors" | "NextPageToken"
  >>;
  getAnomalySubscriptions(
    input: GetAnomalySubscriptionsCommandInput,
    abortSignal?: AbortSignal,
  ): Promise<Pick<
    GetAnomalySubscriptionsCommandOutput,
    "AnomalySubscriptions" | "NextPageToken"
  >>;
}

export interface CostAnomalyCollectionOptions {
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly credentials: AwsTemporaryCredentials;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly now?: () => Date;
  readonly client?: CostAnomalyReader;
  readonly maxPagesPerOperation?: number;
  readonly maxAnomalies?: number;
  readonly maxMonitors?: number;
  readonly maxSubscriptions?: number;
  readonly overallDeadlineMs?: number;
  readonly commandDeadlineMs?: number;
  readonly abortSignal?: AbortSignal;
}

interface PageResult<T> {
  readonly items: readonly T[] | undefined;
  readonly nextPageToken: string | undefined;
}

interface BoundedOperationResult<T> {
  readonly coverage: CostAnomalyOperationCoverage;
  readonly records: readonly T[];
}

interface OperationInput<TProvider, TNormalized> {
  readonly operation: CostAnomalyOperation;
  readonly maximumPages: number;
  readonly maximumRecords: number;
  readonly overallSignal: AbortSignal;
  readonly commandDeadlineMs: number;
  readonly readPage: (
    nextPageToken: string | undefined,
    abortSignal: AbortSignal,
  ) => Promise<PageResult<TProvider>>;
  readonly normalize: (value: TProvider) => TNormalized | null;
  readonly normalizedPartialCode?: (value: TNormalized) => string | null;
}

export async function collectAwsCostAnomalyDetection(
  options: CostAnomalyCollectionOptions,
): Promise<AwsCostAnomalyCollection> {
  const now = options.now?.() ?? new Date();
  const maximumPages = boundedInteger(
    options.maxPagesPerOperation ?? COST_ANOMALY_MAX_PAGES_PER_OPERATION,
    1,
    COST_ANOMALY_MAX_PAGES_PER_OPERATION,
  );
  const maximumAnomalies = boundedInteger(
    options.maxAnomalies ?? COST_ANOMALY_MAX_ANOMALIES,
    1,
    COST_ANOMALY_MAX_ANOMALIES,
  );
  const maximumMonitors = boundedInteger(
    options.maxMonitors ?? COST_ANOMALY_MAX_MONITORS,
    1,
    COST_ANOMALY_MAX_MONITORS,
  );
  const maximumSubscriptions = boundedInteger(
    options.maxSubscriptions ?? COST_ANOMALY_MAX_SUBSCRIPTIONS,
    1,
    COST_ANOMALY_MAX_SUBSCRIPTIONS,
  );
  const overallDeadlineMs = boundedInteger(
    options.overallDeadlineMs ?? COST_ANOMALY_OVERALL_DEADLINE_MS,
    1,
    COST_ANOMALY_OVERALL_DEADLINE_MS,
  );
  const commandDeadlineMs = boundedInteger(
    options.commandDeadlineMs ?? COST_ANOMALY_COMMAND_DEADLINE_MS,
    1,
    COST_ANOMALY_COMMAND_DEADLINE_MS,
  );
  assertCollectionInput(options, now);
  const windowStartDate = isoDay(options.windowStart);
  const windowEndDate = isoDay(options.windowEnd);
  const collectedAt = now.toISOString();

  if (options.partition !== "aws") {
    return unavailableCollection(
      options.accountId,
      collectedAt,
      windowStartDate,
      windowEndDate,
      "UNSUPPORTED_PARTITION",
    );
  }

  const client = options.client ?? createCostAnomalyReader(options.credentials);
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(options.abortSignal?.reason);
  if (options.abortSignal?.aborted === true) forwardAbort();
  else options.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Cost anomaly collection deadline exceeded")),
    overallDeadlineMs,
  );
  timer.unref?.();

  let anomalyResult: BoundedOperationResult<NormalizedAwsCostAnomaly>;
  let monitorResult: BoundedOperationResult<NormalizedAwsCostAnomalyMonitor>;
  let subscriptionResult:
    BoundedOperationResult<NormalizedAwsCostAnomalySubscription>;
  try {
    [anomalyResult, monitorResult, subscriptionResult] = await Promise.all([
      collectBoundedOperation<Anomaly, NormalizedAwsCostAnomaly>({
        operation: "GET_ANOMALIES",
        maximumPages,
        maximumRecords: maximumAnomalies,
        overallSignal: controller.signal,
        commandDeadlineMs,
        readPage: async (nextPageToken, abortSignal) => {
          const output = await client.getAnomalies({
            DateInterval: {
              StartDate: windowStartDate,
              EndDate: windowEndDate,
            },
            MaxResults: PAGE_SIZE,
            ...(nextPageToken === undefined
              ? {}
              : { NextPageToken: nextPageToken }),
          }, abortSignal);
          return {
            items: output.Anomalies,
            nextPageToken: output.NextPageToken,
          };
        },
        normalize: (value) => normalizeAnomaly(
          value,
          options.partition,
          options.accountId,
          windowStartDate,
          windowEndDate,
        ),
        normalizedPartialCode: (value) =>
          value.rootCausesOmitted > 0 ? "ROOT_CAUSE_DETAIL_OMITTED" : null,
      }),
      collectBoundedOperation<AnomalyMonitor, NormalizedAwsCostAnomalyMonitor>({
        operation: "GET_ANOMALY_MONITORS",
        maximumPages,
        maximumRecords: maximumMonitors,
        overallSignal: controller.signal,
        commandDeadlineMs,
        readPage: async (nextPageToken, abortSignal) => {
          const output = await client.getAnomalyMonitors({
            MaxResults: PAGE_SIZE,
            ...(nextPageToken === undefined
              ? {}
              : { NextPageToken: nextPageToken }),
          }, abortSignal);
          return {
            items: output.AnomalyMonitors,
            nextPageToken: output.NextPageToken,
          };
        },
        normalize: (value) => normalizeMonitor(
          value,
          options.partition,
          options.accountId,
        ),
      }),
      collectBoundedOperation<
        AnomalySubscription,
        NormalizedAwsCostAnomalySubscription
      >({
        operation: "GET_ANOMALY_SUBSCRIPTIONS",
        maximumPages,
        maximumRecords: maximumSubscriptions,
        overallSignal: controller.signal,
        commandDeadlineMs,
        readPage: async (nextPageToken, abortSignal) => {
          const output = await client.getAnomalySubscriptions({
            MaxResults: PAGE_SIZE,
            ...(nextPageToken === undefined
              ? {}
              : { NextPageToken: nextPageToken }),
          }, abortSignal);
          return {
            items: output.AnomalySubscriptions,
            nextPageToken: output.NextPageToken,
          };
        },
        normalize: (value) => normalizeSubscription(
          value,
          options.partition,
          options.accountId,
        ),
        normalizedPartialCode: (value) =>
          value.monitorArnsOmitted > 0
            ? "MONITOR_REFERENCE_LIMIT_REACHED"
            : null,
      }),
    ]);
  } finally {
    clearTimeout(timer);
    options.abortSignal?.removeEventListener("abort", forwardAbort);
  }

  const coverage = [
    anomalyResult.coverage,
    monitorResult.coverage,
    subscriptionResult.coverage,
  ];
  const allFailed = coverage.every((entry) => entry.status === "FAILED");
  const allSucceeded = coverage.every((entry) => entry.status === "SUCCEEDED");
  const dataThroughAt = monitorResult.records
    .map((monitor) => monitor.lastEvaluatedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;
  const collection: AwsCostAnomalyCollection = {
    schemaVersion: "sutra.aws-cost-anomaly-detection.v1",
    source: "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION",
    status: allFailed ? "UNAVAILABLE" : allSucceeded ? "COMPLETE" : "PARTIAL",
    accountId: options.accountId,
    collectedAt,
    windowStartDate,
    windowEndDate,
    dataThroughAt,
    coverage,
    anomalies: [...anomalyResult.records].sort(compareAnomalies),
    monitors: [...monitorResult.records].sort((left, right) =>
      left.name.localeCompare(right.name)
      || left.monitorArn.localeCompare(right.monitorArn)
    ),
    subscriptions: [...subscriptionResult.records].sort((left, right) =>
      left.name.localeCompare(right.name)
      || left.subscriptionArn.localeCompare(right.subscriptionArn)
    ),
    limitations: [
      "SUBSCRIBER_ADDRESSES_REDACTED",
      "RAW_MONITOR_AND_THRESHOLD_EXPRESSIONS_NOT_RETAINED",
      "AWS_PROVIDER_FINDINGS_SEPARATE_FROM_SUTRA_STATISTICAL_SIGNALS",
      "AWS_NET_UNBLENDED_COST_SOURCE",
      "AWS_EVALUATION_APPROXIMATELY_THREE_TIMES_DAILY",
      "AWS_MARKETPLACE_THIRD_PARTY_PRODUCTS_NOT_MONITORED",
      "GET_ANOMALIES_INCLUDES_BELOW_SUBSCRIPTION_THRESHOLD",
      "IMPACT_PERCENTAGE_ABSENT_WHEN_EXPECTED_SPEND_ZERO",
      ...(allSucceeded ? [] : ["SOURCE_COVERAGE_INCOMPLETE"]),
    ],
  };
  return boundedOutput(collection);
}

function createCostAnomalyReader(
  credentials: AwsTemporaryCredentials,
): CostAnomalyReader {
  const client = new CostExplorerClient({
    ...workloadIdentityAwsClientConfig("us-east-1", 3),
    // Pin the official regional endpoint so environment-level SDK endpoint
    // overrides cannot redirect customer evidence to an arbitrary host.
    endpoint: COST_ANOMALY_OFFICIAL_ENDPOINT,
    credentials,
  });
  return {
    getAnomalies: (input, abortSignal) =>
      abortSignal === undefined
        ? client.send(new GetAnomaliesCommand(input))
        : client.send(new GetAnomaliesCommand(input), { abortSignal }),
    getAnomalyMonitors: (input, abortSignal) =>
      abortSignal === undefined
        ? client.send(new GetAnomalyMonitorsCommand(input))
        : client.send(new GetAnomalyMonitorsCommand(input), { abortSignal }),
    getAnomalySubscriptions: (input, abortSignal) =>
      abortSignal === undefined
        ? client.send(new GetAnomalySubscriptionsCommand(input))
        : client.send(
          new GetAnomalySubscriptionsCommand(input),
          { abortSignal },
        ),
  };
}

async function collectBoundedOperation<TProvider, TNormalized>(
  input: OperationInput<TProvider, TNormalized>,
): Promise<BoundedOperationResult<TNormalized>> {
  const records: TNormalized[] = [];
  let nextPageToken: string | undefined;
  const seenTokens = new Set<string>();
  let pagesObserved = 0;
  let recordsObserved = 0;
  let recordsRejected = 0;
  let recordsOmitted = 0;
  let status: CostAnomalyOperationStatus = "SUCCEEDED";
  let errorCode: string | null = null;

  try {
    for (let page = 0; page < input.maximumPages; page += 1) {
      const output = await withCommandDeadline(
        (signal) => input.readPage(nextPageToken, signal),
        input.overallSignal,
        input.commandDeadlineMs,
      );
      pagesObserved += 1;
      if (!Array.isArray(output.items)) {
        status = "PARTIAL";
        errorCode = "PROVIDER_RESPONSE_INVALID";
        break;
      }
      for (const candidate of output.items) {
        recordsObserved += 1;
        if (records.length >= input.maximumRecords) {
          recordsOmitted += 1;
          status = "PARTIAL";
          errorCode = "RECORD_LIMIT_REACHED";
          continue;
        }
        const normalized = input.normalize(candidate);
        if (normalized === null) {
          recordsRejected += 1;
          status = "PARTIAL";
          errorCode ??= "NORMALIZATION_DROPPED";
          continue;
        }
        records.push(normalized);
        const detailCode = input.normalizedPartialCode?.(normalized) ?? null;
        if (detailCode !== null) {
          status = "PARTIAL";
          errorCode ??= detailCode;
        }
      }
      if (records.length >= input.maximumRecords && output.nextPageToken) {
        status = "PARTIAL";
        errorCode = "RECORD_LIMIT_REACHED";
        break;
      }
      const token = parseNextPageToken(output.nextPageToken);
      if (token.kind === "end") break;
      if (token.kind === "invalid") {
        status = "PARTIAL";
        errorCode = "PAGINATION_TOKEN_INVALID";
        break;
      }
      if (seenTokens.has(token.value)) {
        status = "PARTIAL";
        errorCode = "PAGINATION_TOKEN_REPEATED";
        break;
      }
      seenTokens.add(token.value);
      nextPageToken = token.value;
      if (page === input.maximumPages - 1) {
        status = "PARTIAL";
        errorCode = "PAGE_LIMIT_REACHED";
      }
    }
  } catch (error) {
    errorCode = input.overallSignal.aborted
      ? "COLLECTION_TIMEOUT"
      : publicCostAnomalyErrorCode(error);
    status = records.length > 0 ? "PARTIAL" : "FAILED";
  }

  return {
    coverage: {
      operation: input.operation,
      status,
      pagesObserved,
      recordsObserved,
      recordsAccepted: records.length,
      recordsRejected,
      recordsOmitted,
      errorCode,
    },
    records,
  };
}

async function withCommandDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  overallSignal: AbortSignal,
  deadlineMs: number,
): Promise<T> {
  if (overallSignal.aborted) {
    throw Object.assign(new Error("Collection stopped"), {
      name: "OverallCollectionTimeout",
    });
  }
  const controller = new AbortController();
  let commandTimedOut = false;
  const forwardAbort = (): void => controller.abort(overallSignal.reason);
  overallSignal.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    commandTimedOut = true;
    controller.abort(new Error("Cost anomaly command deadline exceeded"));
  }, deadlineMs);
  timer.unref?.();
  try {
    return await run(controller.signal);
  } catch (error) {
    if (commandTimedOut) {
      throw Object.assign(new Error("Cost anomaly command timed out"), {
        name: "CommandTimeout",
      });
    }
    if (overallSignal.aborted) {
      throw Object.assign(new Error("Cost anomaly collection timed out"), {
        name: "OverallCollectionTimeout",
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    overallSignal.removeEventListener("abort", forwardAbort);
  }
}

function normalizeAnomaly(
  value: Anomaly,
  partition: AwsPartition,
  accountId: string,
  windowStartDate: string,
  windowEndDate: string,
): NormalizedAwsCostAnomaly | null {
  const anomalyId = safeText(value.AnomalyId, 256);
  const monitorArn = costAnomalyArn(
    value.MonitorArn,
    partition,
    accountId,
    "anomalymonitor",
  );
  const score = value.AnomalyScore;
  const impact = value.Impact;
  const startDate = nullableDay(value.AnomalyStartDate);
  const endDate = nullableDay(value.AnomalyEndDate);
  const dimensionValue = nullableText(value.DimensionValue, 256);
  const feedback = value.Feedback;
  if (
    anomalyId === null
    || monitorArn === null
    || score === undefined
    || impact === undefined
    || (value.AnomalyStartDate !== undefined && startDate === null)
    || (value.AnomalyEndDate !== undefined && endDate === null)
    || (value.DimensionValue !== undefined && dimensionValue === null)
    || (
      feedback !== undefined
      && !new Set(["YES", "NO", "PLANNED_ACTIVITY"]).has(feedback)
    )
    || !boundedNumber(score.CurrentScore, 0, 100)
    || !boundedNumber(score.MaxScore, 0, 100)
    || score.CurrentScore > score.MaxScore
    || !boundedNumber(impact.MaxImpact, 0, MAX_MONEY)
    || (
      impact.TotalImpact !== undefined
      && !boundedNumber(impact.TotalImpact, 0, MAX_MONEY)
    )
    || (
      impact.TotalActualSpend !== undefined
      && !boundedNumber(impact.TotalActualSpend, 0, MAX_MONEY)
    )
    || (
      impact.TotalExpectedSpend !== undefined
      && !boundedNumber(impact.TotalExpectedSpend, 0, MAX_MONEY)
    )
    || (
      impact.TotalImpactPercentage !== undefined
      && !boundedNumber(
        impact.TotalImpactPercentage,
        -1_000_000,
        1_000_000,
      )
    )
    || (startDate !== null && endDate !== null && endDate < startDate)
    || (endDate !== null
      && (endDate < windowStartDate || endDate > windowEndDate))
  ) return null;

  const rawCauses = Array.isArray(value.RootCauses) ? value.RootCauses : [];
  const normalizedCauses = rawCauses
    .slice(0, MAX_ROOT_CAUSES)
    .map((cause) => normalizeRootCause(cause))
    .filter((cause): cause is NormalizedCostAnomalyRootCause => cause !== null);
  return {
    anomalyId,
    monitorArn,
    startDate,
    endDate,
    dimensionValue,
    feedback: feedback ?? null,
    score: {
      current: score.CurrentScore,
      maximum: score.MaxScore,
    },
    impact: {
      maximum: impact.MaxImpact,
      total: nullableNumber(impact.TotalImpact, 0, MAX_MONEY),
      actualSpend: nullableNumber(impact.TotalActualSpend, 0, MAX_MONEY),
      expectedSpend: nullableNumber(impact.TotalExpectedSpend, 0, MAX_MONEY),
      percentage: nullableNumber(
        impact.TotalImpactPercentage,
        -1_000_000,
        1_000_000,
      ),
    },
    rootCauses: normalizedCauses,
    rootCausesOmitted:
      Math.max(0, rawCauses.length - MAX_ROOT_CAUSES)
      + Math.max(0, Math.min(rawCauses.length, MAX_ROOT_CAUSES)
        - normalizedCauses.length),
  };
}

function normalizeRootCause(
  value: NonNullable<Anomaly["RootCauses"]>[number],
): NormalizedCostAnomalyRootCause | null {
  const contribution = nullableNumber(
    value.Impact?.Contribution,
    0,
    MAX_MONEY,
  );
  if (
    value.Impact?.Contribution !== undefined
    && contribution === null
  ) return null;
  const linkedAccountId = value.LinkedAccount === undefined
    ? null
    : ACCOUNT_ID.test(value.LinkedAccount)
      ? value.LinkedAccount
      : null;
  if (value.LinkedAccount !== undefined && linkedAccountId === null) return null;
  const service = nullableText(value.Service, 256);
  const region = nullableText(value.Region, 64);
  const linkedAccountName = nullableText(value.LinkedAccountName, 256);
  const usageType = nullableText(value.UsageType, 256);
  if (
    (value.Service !== undefined && service === null)
    || (value.Region !== undefined && region === null)
    || (
      value.LinkedAccountName !== undefined
      && linkedAccountName === null
    )
    || (value.UsageType !== undefined && usageType === null)
  ) return null;
  return {
    service,
    region,
    linkedAccountId,
    linkedAccountName,
    usageType,
    contribution,
  };
}

function normalizeMonitor(
  value: AnomalyMonitor,
  partition: AwsPartition,
  accountId: string,
): NormalizedAwsCostAnomalyMonitor | null {
  const monitorArn = costAnomalyArn(
    value.MonitorArn,
    partition,
    accountId,
    "anomalymonitor",
  );
  const name = safeText(value.MonitorName, 256);
  const type = value.MonitorType;
  const dimension = value.MonitorDimension;
  if (
    monitorArn === null
    || name === null
    || (type !== "CUSTOM" && type !== "DIMENSIONAL")
    || (
      dimension !== undefined
      && !new Set(["SERVICE", "LINKED_ACCOUNT", "TAG", "COST_CATEGORY"])
        .has(dimension)
    )
    || (
      value.DimensionalValueCount !== undefined
      && (
        !Number.isSafeInteger(value.DimensionalValueCount)
        || value.DimensionalValueCount < 0
        || value.DimensionalValueCount > 10_000_000
      )
    )
  ) return null;
  const createdAt = nullableTimestamp(value.CreationDate);
  const lastUpdatedAt = nullableTimestamp(value.LastUpdatedDate);
  const lastEvaluatedAt = nullableTimestamp(value.LastEvaluatedDate);
  if (
    (value.CreationDate !== undefined && createdAt === null)
    || (value.LastUpdatedDate !== undefined && lastUpdatedAt === null)
    || (value.LastEvaluatedDate !== undefined && lastEvaluatedAt === null)
  ) return null;
  return {
    monitorArn,
    name,
    type,
    dimension: dimension ?? null,
    specificationPresent: value.MonitorSpecification !== undefined,
    dimensionalValueCount: value.DimensionalValueCount ?? null,
    createdAt,
    lastUpdatedAt,
    lastEvaluatedAt,
  };
}

function normalizeSubscription(
  value: AnomalySubscription,
  partition: AwsPartition,
  accountId: string,
): NormalizedAwsCostAnomalySubscription | null {
  const subscriptionArn = costAnomalyArn(
    value.SubscriptionArn,
    partition,
    accountId,
    "anomalysubscription",
  );
  const name = safeText(value.SubscriptionName, 256);
  if (
    subscriptionArn === null
    || name === null
    || !new Set(["IMMEDIATE", "DAILY", "WEEKLY"]).has(value.Frequency ?? "")
    || (value.AccountId !== undefined && value.AccountId !== accountId)
    || !Array.isArray(value.MonitorArnList)
    || !Array.isArray(value.Subscribers)
    || value.Threshold !== undefined
      && !boundedNumber(value.Threshold, 0, 10_000_000_000)
  ) return null;
  const monitorArns: string[] = [];
  for (const candidate of value.MonitorArnList) {
    const arn = costAnomalyArn(
      candidate,
      partition,
      accountId,
      "anomalymonitor",
    );
    if (arn === null) return null;
    if (
      monitorArns.length < MAX_MONITOR_ARNS_PER_SUBSCRIPTION
      && !monitorArns.includes(arn)
    ) monitorArns.push(arn);
  }
  const subscriberCounts = {
    emailConfirmed: 0,
    emailDeclined: 0,
    snsConfirmed: 0,
    snsDeclined: 0,
    unknown: 0,
  };
  for (const subscriber of value.Subscribers.slice(0, 100)) {
    if (subscriber.Type === "EMAIL" && subscriber.Status === "CONFIRMED") {
      subscriberCounts.emailConfirmed += 1;
    } else if (
      subscriber.Type === "EMAIL"
      && subscriber.Status === "DECLINED"
    ) {
      subscriberCounts.emailDeclined += 1;
    } else if (
      subscriber.Type === "SNS"
      && subscriber.Status === "CONFIRMED"
    ) {
      subscriberCounts.snsConfirmed += 1;
    } else if (
      subscriber.Type === "SNS"
      && subscriber.Status === "DECLINED"
    ) {
      subscriberCounts.snsDeclined += 1;
    } else {
      subscriberCounts.unknown += 1;
    }
  }
  subscriberCounts.unknown += Math.max(0, value.Subscribers.length - 100);
  return {
    subscriptionArn,
    name,
    frequency:
      value.Frequency as NormalizedAwsCostAnomalySubscription["frequency"],
    monitorArns,
    monitorArnsOmitted: Math.max(
      0,
      value.MonitorArnList.length - monitorArns.length,
    ),
    threshold: value.Threshold ?? null,
    thresholdExpressionPresent: value.ThresholdExpression !== undefined,
    subscriberCounts,
  };
}

function assertCollectionInput(
  options: CostAnomalyCollectionOptions,
  now: Date,
): void {
  const start = options.windowStart.getTime();
  const end = options.windowEnd.getTime();
  const nowMs = now.getTime();
  if (
    !ACCOUNT_ID.test(options.accountId)
    || !Number.isFinite(start)
    || !Number.isFinite(end)
    || !Number.isFinite(nowMs)
    || start >= end
    || end > nowMs + 5 * 60 * 1_000
    || end - start > COST_ANOMALY_MAX_LOOKBACK_DAYS * 86_400_000
  ) throw new Error("Cost anomaly collection input is invalid");
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error("Cost anomaly collection limit is invalid");
  }
  return value;
}

function parseNextPageToken(
  value: string | undefined,
): { readonly kind: "end" }
  | { readonly kind: "invalid" }
  | { readonly kind: "token"; readonly value: string } {
  if (value === undefined || value.length === 0) return { kind: "end" };
  if (!SAFE_TOKEN.test(value)) return { kind: "invalid" };
  return { kind: "token", value };
}

function safeText(value: unknown, maximum: number): string | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) return null;
  return value;
}

function nullableText(value: unknown, maximum: number): string | null {
  if (value === undefined) return null;
  return safeText(value, maximum);
}

function nullableDay(value: unknown): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== "string"
    || value.length > 64
    || /[\u0000-\u001f\u007f]/u.test(value)
    || !Number.isFinite(Date.parse(value))
  ) return null;
  const candidate = value.slice(0, 10);
  return validIsoDay(candidate) ? candidate : null;
}

function nullableTimestamp(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 64) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum;
}

function nullableNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined) return null;
  return boundedNumber(value, minimum, maximum) ? value : null;
}

function costAnomalyArn(
  value: unknown,
  partition: AwsPartition,
  accountId: string,
  resourceType: "anomalymonitor" | "anomalysubscription",
): string | null {
  const candidate = safeText(value, 512);
  if (candidate === null) return null;
  const prefix = `arn:${partition}:ce::${accountId}:${resourceType}/`;
  return candidate.startsWith(prefix) && candidate.length > prefix.length
    ? candidate
    : null;
}

function validIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString().slice(0, 10) === value;
}

function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function compareAnomalies(
  left: NormalizedAwsCostAnomaly,
  right: NormalizedAwsCostAnomaly,
): number {
  return (right.endDate ?? right.startDate ?? "").localeCompare(
    left.endDate ?? left.startDate ?? "",
  )
    || right.impact.maximum - left.impact.maximum
    || left.anomalyId.localeCompare(right.anomalyId);
}

function publicCostAnomalyErrorCode(error: unknown): string {
  const name = typeof error === "object"
      && error !== null
      && "name" in error
      && typeof error.name === "string"
    ? error.name
    : "UnknownError";
  if (
    new Set([
      "AccessDenied",
      "AccessDeniedException",
      "UnauthorizedException",
    ]).has(name)
  ) return "ACCESS_DENIED";
  if (
    new Set([
      "DataUnavailableException",
      "BillExpirationException",
    ]).has(name)
  ) return "DATA_UNAVAILABLE";
  if (
    new Set([
      "ThrottlingException",
      "LimitExceededException",
      "RequestTimeout",
    ]).has(name)
  ) return "TEMPORARILY_UNAVAILABLE";
  if (name === "CommandTimeout") return "TIMEOUT";
  return "COLLECTION_FAILED";
}

function unavailableCollection(
  accountId: string,
  collectedAt: string,
  windowStartDate: string,
  windowEndDate: string,
  errorCode: string,
): AwsCostAnomalyCollection {
  return {
    schemaVersion: "sutra.aws-cost-anomaly-detection.v1",
    source: "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION",
    status: "UNAVAILABLE",
    accountId,
    collectedAt,
    windowStartDate,
    windowEndDate,
    dataThroughAt: null,
    coverage: ([
      "GET_ANOMALIES",
      "GET_ANOMALY_MONITORS",
      "GET_ANOMALY_SUBSCRIPTIONS",
    ] as const).map((operation) => ({
      operation,
      status: "FAILED",
      pagesObserved: 0,
      recordsObserved: 0,
      recordsAccepted: 0,
      recordsRejected: 0,
      recordsOmitted: 0,
      errorCode,
    })),
    anomalies: [],
    monitors: [],
    subscriptions: [],
    limitations: [
      errorCode,
      "SUBSCRIBER_ADDRESSES_REDACTED",
      "RAW_MONITOR_AND_THRESHOLD_EXPRESSIONS_NOT_RETAINED",
      "AWS_PROVIDER_FINDINGS_SEPARATE_FROM_SUTRA_STATISTICAL_SIGNALS",
      "AWS_NET_UNBLENDED_COST_SOURCE",
      "AWS_EVALUATION_APPROXIMATELY_THREE_TIMES_DAILY",
      "AWS_MARKETPLACE_THIRD_PARTY_PRODUCTS_NOT_MONITORED",
      "GET_ANOMALIES_INCLUDES_BELOW_SUBSCRIPTION_THRESHOLD",
      "IMPACT_PERCENTAGE_ABSENT_WHEN_EXPECTED_SPEND_ZERO",
      "SOURCE_COVERAGE_INCOMPLETE",
    ],
  };
}

function boundedOutput(
  collection: AwsCostAnomalyCollection,
): AwsCostAnomalyCollection {
  if (
    Buffer.byteLength(JSON.stringify(collection), "utf8")
    <= COST_ANOMALY_MAX_OUTPUT_BYTES
  ) return collection;
  return {
    ...collection,
    status: "PARTIAL",
    coverage: collection.coverage.map((entry) => ({
      ...entry,
      status: entry.status === "FAILED" ? "FAILED" : "PARTIAL",
      recordsAccepted: 0,
      recordsOmitted: entry.recordsOmitted + entry.recordsAccepted,
      errorCode: entry.errorCode ?? "OUTPUT_SIZE_LIMIT_REACHED",
    })),
    anomalies: [],
    monitors: [],
    subscriptions: [],
    dataThroughAt: null,
    limitations: [
      ...collection.limitations,
      "OUTPUT_SIZE_LIMIT_REACHED",
      "SOURCE_COVERAGE_INCOMPLETE",
    ].filter((value, index, values) => values.indexOf(value) === index),
  };
}
