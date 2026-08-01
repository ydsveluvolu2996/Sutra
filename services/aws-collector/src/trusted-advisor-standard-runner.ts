/**
 * Bounded, read-only collection of every standard Trusted Advisor check made
 * available to one AWS account by the AWS Support API.
 *
 * The API is account-scoped and available only through the us-east-1 Support
 * endpoint. This runner never refreshes checks, never accepts caller-defined
 * check identifiers, and never transports provider exception messages.
 */
import {
  DescribeTrustedAdvisorCheckResultCommand,
  DescribeTrustedAdvisorChecksCommand,
  SupportClient,
  type DescribeTrustedAdvisorCheckResultRequest,
  type DescribeTrustedAdvisorCheckResultResponse,
  type DescribeTrustedAdvisorChecksRequest,
  type DescribeTrustedAdvisorChecksResponse,
  type TrustedAdvisorCheckDescription,
  type TrustedAdvisorCheckResult,
  type TrustedAdvisorResourceDetail,
} from "@aws-sdk/client-support";

import { workloadIdentityAwsClientConfig } from "./role-broker.js";
import type { AwsPartition, AwsTemporaryCredentials } from "./types.js";

export const TRUSTED_ADVISOR_STANDARD_MAX_CHECKS = 512;
export const TRUSTED_ADVISOR_STANDARD_MAX_RESOURCES = 25_000;
export const TRUSTED_ADVISOR_STANDARD_MAX_METADATA_FIELDS = 100;
export const TRUSTED_ADVISOR_STANDARD_MAX_OUTPUT_BYTES = 8 * 1_024 * 1_024;
export const TRUSTED_ADVISOR_STANDARD_OVERALL_DEADLINE_MS = 5 * 60_000;
export const TRUSTED_ADVISOR_STANDARD_COMMAND_DEADLINE_MS = 20_000;
export const TRUSTED_ADVISOR_STANDARD_MAX_CONCURRENCY = 2;
export const TRUSTED_ADVISOR_STANDARD_OFFICIAL_ENDPOINT =
  "https://support.us-east-1.amazonaws.com" as const;

const ACCOUNT_ID = /^\d{12}$/u;
const MAX_SAFE_COUNT = 1_000_000_000;

export type TrustedAdvisorStandardCollectionStatus =
  | "COMPLETE"
  | "PARTIAL"
  | "UNAVAILABLE";

export interface TrustedAdvisorStandardOperationCoverage {
  readonly operation:
    | "DESCRIBE_TRUSTED_ADVISOR_CHECKS"
    | "DESCRIBE_TRUSTED_ADVISOR_CHECK_RESULT";
  readonly status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  readonly requestsObserved: number;
  readonly recordsObserved: number;
  readonly recordsAccepted: number;
  readonly recordsRejected: number;
  readonly recordsOmitted: number;
  readonly errorCode: string | null;
}

export interface NormalizedTrustedAdvisorMetadataEntry {
  readonly name: string;
  readonly value: string;
}

export interface NormalizedTrustedAdvisorStandardResource {
  readonly resourceId: string;
  readonly region: string | null;
  readonly status: "ok" | "warning" | "error";
  readonly suppressed: boolean;
  readonly metadata: readonly NormalizedTrustedAdvisorMetadataEntry[];
}

export interface NormalizedTrustedAdvisorStandardCheck {
  readonly checkId: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly metadataSchema: readonly string[];
  readonly status: "ok" | "warning" | "error" | "not_available";
  readonly dataThroughAt: string | null;
  readonly resourcesSummary: {
    readonly processed: number;
    readonly flagged: number;
    readonly ignored: number;
    readonly suppressed: number;
  };
  readonly costOptimizingSummary: {
    readonly estimatedMonthlySavings: number | null;
    readonly estimatedPercentMonthlySavings: number | null;
  } | null;
  readonly flaggedResources: readonly NormalizedTrustedAdvisorStandardResource[];
}

export interface TrustedAdvisorStandardCollection {
  readonly schemaVersion: "sutra.aws-trusted-advisor-standard-checks.v1";
  readonly source: "AWS_SUPPORT_TRUSTED_ADVISOR_STANDARD_CHECKS";
  readonly status: TrustedAdvisorStandardCollectionStatus;
  readonly accountId: string;
  readonly collectedAt: string;
  /** The oldest accepted provider check timestamp; never the request time. */
  readonly dataThroughAt: string | null;
  readonly coverage: readonly TrustedAdvisorStandardOperationCoverage[];
  readonly checks: readonly NormalizedTrustedAdvisorStandardCheck[];
  readonly limitations: readonly string[];
}

export interface TrustedAdvisorStandardReader {
  describeTrustedAdvisorChecks(
    input: DescribeTrustedAdvisorChecksRequest,
    abortSignal?: AbortSignal,
  ): Promise<Pick<DescribeTrustedAdvisorChecksResponse, "checks">>;
  describeTrustedAdvisorCheckResult(
    input: DescribeTrustedAdvisorCheckResultRequest,
    abortSignal?: AbortSignal,
  ): Promise<Pick<DescribeTrustedAdvisorCheckResultResponse, "result">>;
}

export interface TrustedAdvisorStandardCollectionOptions {
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly credentials: AwsTemporaryCredentials;
  readonly now?: () => Date;
  readonly client?: TrustedAdvisorStandardReader;
  readonly maximumChecks?: number;
  readonly maximumResources?: number;
  readonly maximumMetadataFields?: number;
  readonly maximumOutputBytes?: number;
  readonly overallDeadlineMs?: number;
  readonly commandDeadlineMs?: number;
  readonly concurrency?: number;
  readonly abortSignal?: AbortSignal;
}

interface NormalizedResult {
  readonly check: NormalizedTrustedAdvisorStandardCheck | null;
  readonly recordsObserved: number;
  readonly recordsAccepted: number;
  readonly recordsRejected: number;
  readonly recordsOmitted: number;
  readonly errorCode: string | null;
}

export async function collectTrustedAdvisorStandardChecks(
  options: TrustedAdvisorStandardCollectionOptions,
): Promise<TrustedAdvisorStandardCollection> {
  const now = options.now?.() ?? new Date();
  assertInput(options, now);
  const limits = {
    checks: boundedLimit(options.maximumChecks, TRUSTED_ADVISOR_STANDARD_MAX_CHECKS),
    resources: boundedLimit(
      options.maximumResources,
      TRUSTED_ADVISOR_STANDARD_MAX_RESOURCES,
    ),
    metadata: boundedLimit(
      options.maximumMetadataFields,
      TRUSTED_ADVISOR_STANDARD_MAX_METADATA_FIELDS,
    ),
    outputBytes: boundedLimit(
      options.maximumOutputBytes,
      TRUSTED_ADVISOR_STANDARD_MAX_OUTPUT_BYTES,
    ),
    overallDeadlineMs: boundedLimit(
      options.overallDeadlineMs,
      TRUSTED_ADVISOR_STANDARD_OVERALL_DEADLINE_MS,
    ),
    commandDeadlineMs: boundedLimit(
      options.commandDeadlineMs,
      TRUSTED_ADVISOR_STANDARD_COMMAND_DEADLINE_MS,
    ),
    concurrency: boundedLimit(
      options.concurrency,
      TRUSTED_ADVISOR_STANDARD_MAX_CONCURRENCY,
    ),
  };
  const collectedAt = now.toISOString();
  if (options.partition !== "aws") {
    return unavailable(options.accountId, collectedAt, "UNSUPPORTED_PARTITION");
  }

  const client = options.client ?? createReader(options.credentials);
  const overall = new AbortController();
  const forwardAbort = (): void => overall.abort(options.abortSignal?.reason);
  if (options.abortSignal?.aborted === true) forwardAbort();
  else options.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(
    () => overall.abort(new Error("Trusted Advisor collection deadline exceeded")),
    limits.overallDeadlineMs,
  );
  timer.unref?.();
  const cleanup = (): void => {
    clearTimeout(timer);
    options.abortSignal?.removeEventListener("abort", forwardAbort);
  };

  let rawCatalog: readonly TrustedAdvisorCheckDescription[];
  try {
    const response = await withCommandDeadline(
      (signal) => client.describeTrustedAdvisorChecks({ language: "en" }, signal),
      overall.signal,
      limits.commandDeadlineMs,
    );
    if (!Array.isArray(response.checks)) {
      cleanup();
      return unavailable(options.accountId, collectedAt, "PROVIDER_RESPONSE_INVALID");
    }
    rawCatalog = response.checks;
  } catch (error) {
    cleanup();
    return unavailable(
      options.accountId,
      collectedAt,
      publicErrorCode(error, overall.signal),
    );
  }

  let catalogRejected = 0;
  let catalogOmitted = 0;
  let catalogError: string | null = null;
  const catalog = new Map<string, TrustedAdvisorCheckDescription>();
  for (const candidate of rawCatalog) {
    if (catalog.size >= limits.checks) {
      catalogOmitted += 1;
      catalogError = "CHECK_LIMIT_REACHED";
      continue;
    }
    const identity = normalizeCheckDescription(candidate, limits.metadata);
    if (identity === null) {
      catalogRejected += 1;
      catalogError ??= "NORMALIZATION_DROPPED";
      continue;
    }
    const previous = catalog.get(identity.id);
    if (previous !== undefined) {
      catalogRejected += 1;
      catalogError = sameJson(previous, candidate)
        ? "DUPLICATE_CHECK_ID"
        : "CONFLICTING_DUPLICATE";
      continue;
    }
    catalog.set(identity.id, candidate);
  }

  const orderedCatalog = [...catalog.values()].sort((left, right) =>
    String(left.id).localeCompare(String(right.id))
  );
  const perCheckResourceLimit = orderedCatalog.length === 0
    ? limits.resources
    : Math.max(1, Math.floor(limits.resources / orderedCatalog.length));
  const results = await mapWithConcurrency(
    orderedCatalog,
    limits.concurrency,
    async (description): Promise<NormalizedResult> => {
      if (overall.signal.aborted) {
        return failedResult("COLLECTION_TIMEOUT");
      }
      const checkId = String(description.id);
      try {
        const response = await withCommandDeadline(
          (signal) => client.describeTrustedAdvisorCheckResult(
            { checkId, language: "en" },
            signal,
          ),
          overall.signal,
          limits.commandDeadlineMs,
        );
        if (response.result === undefined) {
          return failedResult("PROVIDER_RESPONSE_INVALID");
        }
        return normalizeCheckResult(
          description,
          response.result,
          limits.metadata,
          perCheckResourceLimit,
          now.getTime(),
        );
      } catch (error) {
        return failedResult(publicErrorCode(error, overall.signal));
      }
    },
  );

  cleanup();

  const checks = results
    .flatMap((entry) => entry.check === null ? [] : [entry.check])
    .sort((left, right) => left.checkId.localeCompare(right.checkId));
  const noChecks = orderedCatalog.length === 0;
  const resultCoverage: TrustedAdvisorStandardOperationCoverage = {
    operation: "DESCRIBE_TRUSTED_ADVISOR_CHECK_RESULT",
    status: noChecks ? "PARTIAL" : results.every((entry) => entry.errorCode === null)
      ? "SUCCEEDED"
      : checks.length === 0 ? "FAILED" : "PARTIAL",
    requestsObserved: results.length,
    recordsObserved: results.reduce((sum, entry) => sum + entry.recordsObserved, 0),
    recordsAccepted: results.reduce((sum, entry) => sum + entry.recordsAccepted, 0),
    recordsRejected: results.reduce((sum, entry) => sum + entry.recordsRejected, 0),
    recordsOmitted: results.reduce((sum, entry) => sum + entry.recordsOmitted, 0),
    errorCode: noChecks
      ? "NO_CHECKS_RETURNED"
      : results.find((entry) => entry.errorCode !== null)?.errorCode ?? null,
  };
  const catalogCoverage: TrustedAdvisorStandardOperationCoverage = {
    operation: "DESCRIBE_TRUSTED_ADVISOR_CHECKS",
    status: catalogError === null ? "SUCCEEDED" : "PARTIAL",
    requestsObserved: 1,
    recordsObserved: rawCatalog.length,
    recordsAccepted: orderedCatalog.length,
    recordsRejected: catalogRejected,
    recordsOmitted: catalogOmitted,
    errorCode: catalogError,
  };
  const coverage = [catalogCoverage, resultCoverage] as const;
  const allSucceeded = coverage.every((entry) => entry.status === "SUCCEEDED");
  const collection: TrustedAdvisorStandardCollection = {
    schemaVersion: "sutra.aws-trusted-advisor-standard-checks.v1",
    source: "AWS_SUPPORT_TRUSTED_ADVISOR_STANDARD_CHECKS",
    status: allSucceeded && checks.length > 0
      ? "COMPLETE"
      : rawCatalog.length === 0 ? "PARTIAL" : checks.length === 0 ? "UNAVAILABLE" : "PARTIAL",
    accountId: options.accountId,
    collectedAt,
    dataThroughAt: checks
      .flatMap((check) => check.dataThroughAt === null ? [] : [check.dataThroughAt])
      .sort()
      .at(0) ?? null,
    coverage,
    checks,
    limitations: [
      "ACCOUNT_SCOPED_AWS_SUPPORT_API",
      "CHECK_REFRESH_NOT_REQUESTED",
      "QUALIFYING_AWS_SUPPORT_PLAN_REQUIRED",
      ...(allSucceeded ? [] : ["SOURCE_COVERAGE_INCOMPLETE"]),
    ],
  };
  return boundedOutput(collection, limits.outputBytes);
}

function createReader(credentials: AwsTemporaryCredentials): TrustedAdvisorStandardReader {
  const client = new SupportClient({
    ...workloadIdentityAwsClientConfig("us-east-1", 3),
    endpoint: TRUSTED_ADVISOR_STANDARD_OFFICIAL_ENDPOINT,
    credentials,
  });
  return {
    describeTrustedAdvisorChecks: (input, abortSignal) => client.send(
      new DescribeTrustedAdvisorChecksCommand(input),
      abortSignal === undefined ? undefined : { abortSignal },
    ),
    describeTrustedAdvisorCheckResult: (input, abortSignal) => client.send(
      new DescribeTrustedAdvisorCheckResultCommand(input),
      abortSignal === undefined ? undefined : { abortSignal },
    ),
  };
}

function normalizeCheckDescription(
  value: TrustedAdvisorCheckDescription,
  maximumMetadata: number,
): { readonly id: string } | null {
  const metadata = value.metadata;
  return safeText(value.id, 128) !== null
      && safeText(value.name, 512) !== null
      && safeText(value.description, 16_384) !== null
      && safeText(value.category, 128) !== null
      && Array.isArray(metadata)
      && metadata.length <= maximumMetadata
      && metadata.every((entry) => safeText(entry, 512) !== null)
    ? { id: value.id as string }
    : null;
}

function normalizeCheckResult(
  description: TrustedAdvisorCheckDescription,
  result: TrustedAdvisorCheckResult,
  maximumMetadata: number,
  remainingResources: number,
  nowMs: number,
): NormalizedResult {
  const identity = normalizeCheckDescription(description, maximumMetadata);
  const checkId = safeText(result.checkId, 128);
  const timestamp = nullableTimestamp(result.timestamp, nowMs);
  const status = result.status;
  const rawResources = result.flaggedResources;
  const summary = result.resourcesSummary;
  if (
    identity === null
    || checkId !== identity.id
    || !new Set(["ok", "warning", "error", "not_available"]).has(status ?? "")
    || timestamp === null
    || !Array.isArray(rawResources)
    || summary === undefined
    || !safeCount(summary.resourcesProcessed)
    || !safeCount(summary.resourcesFlagged)
    || !safeCount(summary.resourcesIgnored)
    || !safeCount(summary.resourcesSuppressed)
  ) return failedResult("PROVIDER_RESPONSE_INVALID");

  const schema = description.metadata as readonly string[];
  const resources: NormalizedTrustedAdvisorStandardResource[] = [];
  let rejected = 0;
  let omitted = 0;
  let errorCode: string | null = null;
  for (const resource of rawResources) {
    if (resources.length >= remainingResources) {
      omitted += 1;
      errorCode = "RESOURCE_LIMIT_REACHED";
      continue;
    }
    const normalized = normalizeResource(resource, schema);
    if (normalized === null) {
      rejected += 1;
      errorCode ??= "NORMALIZATION_DROPPED";
      continue;
    }
    resources.push(normalized);
  }
  if (summary.resourcesFlagged !== rawResources.length) {
    errorCode = "RESOURCE_SUMMARY_MISMATCH";
  }
  const cost = result.categorySpecificSummary?.costOptimizing;
  const savings = nullableFinite(cost?.estimatedMonthlySavings, 0, 1_000_000_000_000);
  const percent = nullableFinite(cost?.estimatedPercentMonthlySavings, 0, 100);
  if (
    (cost?.estimatedMonthlySavings !== undefined && savings === null)
    || (cost?.estimatedPercentMonthlySavings !== undefined && percent === null)
  ) errorCode ??= "CATEGORY_SUMMARY_INVALID";

  return {
    check: {
      checkId: identity.id,
      name: description.name as string,
      description: description.description as string,
      category: description.category as string,
      metadataSchema: [...schema],
      status: status as NormalizedTrustedAdvisorStandardCheck["status"],
      dataThroughAt: timestamp,
      resourcesSummary: {
        processed: summary.resourcesProcessed as number,
        flagged: summary.resourcesFlagged as number,
        ignored: summary.resourcesIgnored as number,
        suppressed: summary.resourcesSuppressed as number,
      },
      costOptimizingSummary: cost === undefined ? null : {
        estimatedMonthlySavings: savings,
        estimatedPercentMonthlySavings: percent,
      },
      flaggedResources: resources.sort(compareResources),
    },
    recordsObserved: 1 + rawResources.length,
    recordsAccepted: 1 + resources.length,
    recordsRejected: rejected,
    recordsOmitted: omitted,
    errorCode,
  };
}

function normalizeResource(
  value: TrustedAdvisorResourceDetail,
  schema: readonly string[],
): NormalizedTrustedAdvisorStandardResource | null {
  const resourceId = safeText(value.resourceId, 2_048);
  const region = value.region === undefined ? null : safeText(value.region, 128);
  const status = value.status;
  if (
    resourceId === null
    || (value.region !== undefined && region === null)
    || !new Set(["ok", "warning", "error"]).has(status ?? "")
    || typeof value.isSuppressed !== "boolean"
    || !Array.isArray(value.metadata)
    || value.metadata.length > schema.length
  ) return null;
  const metadata: NormalizedTrustedAdvisorMetadataEntry[] = [];
  for (let index = 0; index < value.metadata.length; index += 1) {
    const item = safeText(value.metadata[index], 16_384, true);
    if (item === null) return null;
    metadata.push({ name: schema[index] as string, value: item });
  }
  return {
    resourceId,
    region,
    status: status as NormalizedTrustedAdvisorStandardResource["status"],
    suppressed: value.isSuppressed,
    metadata,
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, values.length)) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await run(values[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function withCommandDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  overallSignal: AbortSignal,
  deadlineMs: number,
): Promise<T> {
  if (overallSignal.aborted) throw namedError("OverallCollectionTimeout");
  const command = new AbortController();
  let timedOut = false;
  const forward = (): void => command.abort(overallSignal.reason);
  overallSignal.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    command.abort(new Error("Trusted Advisor command deadline exceeded"));
  }, deadlineMs);
  timer.unref?.();
  try {
    return await run(command.signal);
  } catch (error) {
    if (timedOut) throw namedError("CommandTimeout");
    if (overallSignal.aborted) throw namedError("OverallCollectionTimeout");
    throw error;
  } finally {
    clearTimeout(timer);
    overallSignal.removeEventListener("abort", forward);
  }
}

function unavailable(
  accountId: string,
  collectedAt: string,
  errorCode: string,
): TrustedAdvisorStandardCollection {
  return {
    schemaVersion: "sutra.aws-trusted-advisor-standard-checks.v1",
    source: "AWS_SUPPORT_TRUSTED_ADVISOR_STANDARD_CHECKS",
    status: "UNAVAILABLE",
    accountId,
    collectedAt,
    dataThroughAt: null,
    coverage: [{
      operation: "DESCRIBE_TRUSTED_ADVISOR_CHECKS",
      status: "FAILED",
      requestsObserved: errorCode === "UNSUPPORTED_PARTITION" ? 0 : 1,
      recordsObserved: 0,
      recordsAccepted: 0,
      recordsRejected: 0,
      recordsOmitted: 0,
      errorCode,
    }, {
      operation: "DESCRIBE_TRUSTED_ADVISOR_CHECK_RESULT",
      status: "FAILED",
      requestsObserved: 0,
      recordsObserved: 0,
      recordsAccepted: 0,
      recordsRejected: 0,
      recordsOmitted: 0,
      errorCode: "DEPENDENCY_UNAVAILABLE",
    }],
    checks: [],
    limitations: [errorCode, "NO_PROVIDER_DATA_RETURNED"],
  };
}

function boundedOutput(
  collection: TrustedAdvisorStandardCollection,
  maximumBytes: number,
): TrustedAdvisorStandardCollection {
  if (Buffer.byteLength(JSON.stringify(collection), "utf8") <= maximumBytes) {
    return collection;
  }
  const accepted = collection.coverage.reduce(
    (sum, entry) => sum + entry.recordsAccepted,
    0,
  );
  const bounded: TrustedAdvisorStandardCollection = {
    ...collection,
    status: "PARTIAL",
    dataThroughAt: null,
    coverage: collection.coverage.map((entry) => ({
      ...entry,
      status: entry.status === "FAILED" ? "FAILED" : "PARTIAL",
      recordsOmitted: entry.recordsOmitted + entry.recordsAccepted,
      recordsAccepted: 0,
      errorCode: "OUTPUT_SIZE_LIMIT_REACHED",
    })),
    checks: [],
    limitations: [...new Set([
      ...collection.limitations,
      "OUTPUT_SIZE_LIMIT_REACHED",
      `NORMALIZED_RECORDS_OMITTED_${accepted}`,
      "SOURCE_COVERAGE_INCOMPLETE",
    ])],
  };
  if (Buffer.byteLength(JSON.stringify(bounded), "utf8") > maximumBytes) {
    throw new Error("Trusted Advisor collection output limit is too small");
  }
  return bounded;
}

function failedResult(errorCode: string): NormalizedResult {
  return {
    check: null,
    recordsObserved: 1,
    recordsAccepted: 0,
    recordsRejected: 1,
    recordsOmitted: 0,
    errorCode,
  };
}

function publicErrorCode(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return "COLLECTION_TIMEOUT";
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { readonly name: unknown }).name)
    : "";
  if (name === "CommandTimeout" || name === "OverallCollectionTimeout") {
    return "COLLECTION_TIMEOUT";
  }
  if (name === "SubscriptionRequiredException") return "SUPPORT_PLAN_REQUIRED";
  if (name === "AccessDeniedException" || name === "AccessDenied") {
    return "ACCESS_DENIED";
  }
  if (name === "ThrottlingException" || name === "TooManyRequestsException") {
    return "THROTTLED";
  }
  return "PROVIDER_REQUEST_FAILED";
}

function assertInput(
  options: TrustedAdvisorStandardCollectionOptions,
  now: Date,
): void {
  if (!ACCOUNT_ID.test(options.accountId) || !Number.isFinite(now.getTime())) {
    throw new Error("Trusted Advisor collection input is invalid");
  }
}

function boundedLimit(value: number | undefined, maximum: number): number {
  const result = value ?? maximum;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new Error("Trusted Advisor collection limit is invalid");
  }
  return result;
}

function safeText(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): string | null {
  return typeof value === "string"
      && (allowEmpty || value.length > 0)
      && value.length <= maximum
      && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function nullableTimestamp(value: unknown, nowMs: number): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 64) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= nowMs + 5 * 60_000
    ? new Date(parsed).toISOString()
    : null;
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 0
    && (value as number) <= MAX_SAFE_COUNT;
}

function nullableFinite(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined) return null;
  return typeof value === "number"
      && Number.isFinite(value)
      && value >= minimum
      && value <= maximum
    ? value
    : null;
}

function compareResources(
  left: NormalizedTrustedAdvisorStandardResource,
  right: NormalizedTrustedAdvisorStandardResource,
): number {
  return left.resourceId.localeCompare(right.resourceId)
    || (left.region ?? "").localeCompare(right.region ?? "")
    || left.status.localeCompare(right.status);
}

function namedError(name: string): Error {
  return Object.assign(new Error("Trusted Advisor collection stopped"), { name });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
