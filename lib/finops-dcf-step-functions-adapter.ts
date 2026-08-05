/**
 * Server-owned, privacy-minimized AWS Step Functions collector for the Data
 * Collection Framework monitor. The provider boundary returns metadata and a
 * precomputed input digest only; raw execution input/output and causes never
 * cross this interface.
 */
import {
  DCF_EXECUTION_BOUNDS,
  normalizeDcfCapture,
  type DcfCapture,
  type DcfExecution,
  type DcfModuleExecution,
  type DcfScope,
  type DcfStatus,
} from "./finops-dcf-execution-history.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const BOUNDARY_ID = /^dcfb_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]{1,256}$/u;
const TOKEN = /^[^\u0000-\u001f\u007f]{1,3096}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const STATE_MACHINE_ARN = /^arn:(aws|aws-us-gov|aws-cn):states:([a-z0-9-]+):(\d{12}):stateMachine:([A-Za-z0-9._+-]{1,80})(?::([A-Za-z0-9._+-]{1,80}))?$/u;
const EXECUTION_ARN = /^arn:(aws|aws-us-gov|aws-cn):states:([a-z0-9-]+):(\d{12}):execution:([A-Za-z0-9._+-]{1,80}):([A-Za-z0-9._+-]{1,80})$/u;
const STATUSES = new Set<DcfStatus>([
  "RUNNING", "SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED",
]);
const ERROR_CODES = new Set<NonNullable<DcfExecution["errorCode"]>>([
  "AUTHORIZATION_FAILED",
  "SOURCE_UNAVAILABLE",
  "THROTTLED",
  "TIMEOUT",
  "SCHEMA_MISMATCH",
  "RECONCILIATION_FAILED",
  "CANCELLED",
  "INTERNAL_ERROR",
]);

export const DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS = Object.freeze({
  listPageSize: 1_000,
  maximumModules: DCF_EXECUTION_BOUNDS.maximumModules,
  maximumExecutions: 10_000,
  maximumPages: 1_000,
  maximumRequests: 25_000,
  maximumAttemptsPerRequest: 3,
  retryBaseDelayMs: 200,
  maximumDurationMs: DCF_EXECUTION_BOUNDS.maximumDurationMs,
} as const);

export type DcfStepFunctionsFailureCode =
  | "AUTHORIZATION_FAILED"
  | "SOURCE_UNAVAILABLE"
  | "THROTTLED"
  | "TIMEOUT"
  | "SCHEMA_MISMATCH"
  | "SCOPE_MISMATCH"
  | "UNSUPPORTED_STATE_MACHINE"
  | "LIMIT_REACHED"
  | "INTERNAL_ERROR";

export interface DcfStepFunctionsModuleBinding {
  readonly moduleId: string;
  readonly moduleName: string;
  readonly sourceId: string | null;
  readonly enabled: boolean;
  readonly expectedCadenceMinutes: number;
  readonly stateMachineArn: string;
}

export interface DcfStepFunctionsBoundary {
  readonly schemaVersion: "sutra.dcf-step-functions-boundary.v1";
  readonly boundaryId: string;
  readonly binding: "SERVER_RESOLVED_DCF_STACK";
  readonly scope: DcfScope;
  readonly schedulerRegistered: boolean;
  readonly modules: readonly DcfStepFunctionsModuleBinding[];
}

export interface DcfStepFunctionsExecutionSummary {
  readonly executionArn: string;
  readonly stateMachineArn: string;
  readonly status: DcfStatus;
  readonly startedAt: string;
  readonly stoppedAt: string | null;
}

export interface DcfStepFunctionsExecutionMetadata {
  readonly executionArn: string;
  readonly stateMachineArn: string;
  readonly status: DcfStatus;
  readonly startedAt: string;
  readonly stoppedAt: string | null;
  readonly redriveCount: number;
  readonly inputSha256: string | null;
  readonly acceptedRecords: number | null;
  readonly rejectedRecords: number | null;
  readonly expectedRecords: number | null;
  readonly processedBytes: number | null;
  readonly errorCode: DcfExecution["errorCode"];
}

export interface DcfStepFunctionsProvider {
  describeStateMachine(request: {
    readonly scope: DcfScope;
    readonly stateMachineArn: string;
    readonly includedData: "METADATA_ONLY";
  }, signal: AbortSignal): Promise<{
    readonly stateMachineArn: string;
    readonly status: "ACTIVE" | "DELETING";
    readonly type: "STANDARD" | "EXPRESS";
  }>;
  listExecutions(request: {
    readonly scope: DcfScope;
    readonly stateMachineArn: string;
    readonly maxResults: 1_000;
    readonly nextToken: string | null;
  }, signal: AbortSignal): Promise<{
    readonly executions: readonly DcfStepFunctionsExecutionSummary[];
    readonly nextToken: string | null;
  }>;
  describeExecution(request: {
    readonly scope: DcfScope;
    readonly executionArn: string;
    readonly includedData: "METADATA_ONLY";
  }, signal: AbortSignal): Promise<DcfStepFunctionsExecutionMetadata>;
}

export class DcfStepFunctionsProviderError extends Error {
  public readonly code:
    | "AUTHORIZATION_FAILED"
    | "SOURCE_UNAVAILABLE"
    | "THROTTLED"
    | "TIMEOUT";

  public constructor(code: DcfStepFunctionsProviderError["code"]) {
    super("Step Functions provider request failed");
    this.name = "DcfStepFunctionsProviderError";
    this.code = code;
  }
}

export class DcfStepFunctionsAdapterError extends Error {
  public readonly code: "INVALID_BOUNDARY" | "COLLECTION_FAILED";

  public constructor(code: DcfStepFunctionsAdapterError["code"]) {
    super("Data Collection Monitor Step Functions adapter rejected the operation");
    this.name = "DcfStepFunctionsAdapterError";
    this.code = code;
  }
}

export interface DcfStepFunctionsCollectionResult {
  readonly schemaVersion: "sutra.dcf-step-functions-collection-result.v1";
  readonly sourceState: "READY" | "PARTIAL" | "STALE" | "UNAVAILABLE";
  readonly failureCodes: readonly DcfStepFunctionsFailureCode[];
  readonly requestCount: number;
  readonly retryCount: number;
  readonly capture: DcfCapture;
}

interface AdapterDependencies {
  readonly provider: DcfStepFunctionsProvider;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

class CollectionFailure extends Error {
  public readonly code: DcfStepFunctionsFailureCode;

  public constructor(code: DcfStepFunctionsFailureCode) {
    super("Step Functions collection request failed");
    this.name = "CollectionFailure";
    this.code = code;
  }
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): number {
  if (typeof value !== "string" || !ISO.test(value)) throw new CollectionFailure("SCHEMA_MISMATCH");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new CollectionFailure("SCHEMA_MISMATCH");
  }
  return parsed;
}

function compatibleRegion(partition: DcfScope["partition"], region: string): boolean {
  if (partition === "aws-cn") return /^cn-[a-z]+-\d$/u.test(region);
  if (partition === "aws-us-gov") return /^us-gov-[a-z]+-\d$/u.test(region);
  return /^(?!cn-|us-gov-)[a-z]{2}-[a-z]+-\d$/u.test(region);
}

function stateMachine(value: string, scope: DcfScope): RegExpExecArray {
  const match = STATE_MACHINE_ARN.exec(value);
  if (!match
    || match[1] !== scope.partition
    || match[2] !== scope.region
    || match[3] !== scope.managementAccountId) {
    throw new CollectionFailure("SCOPE_MISMATCH");
  }
  return match;
}

function execution(value: string, stateMachineArn: string, scope: DcfScope): void {
  const machine = stateMachine(stateMachineArn, scope);
  const match = EXECUTION_ARN.exec(value);
  if (!match
    || match[1] !== scope.partition
    || match[2] !== scope.region
    || match[3] !== scope.managementAccountId
    || match[4] !== machine[4]) {
    throw new CollectionFailure("SCOPE_MISMATCH");
  }
}

function validateBoundary(value: DcfStepFunctionsBoundary): void {
  const unknownValue: unknown = value;
  if (!record(unknownValue)
    || !exactKeys(unknownValue, [
      "binding", "boundaryId", "modules", "schedulerRegistered",
      "schemaVersion", "scope",
    ])
    || !record(unknownValue.scope)
    || !exactKeys(unknownValue.scope, [
      "connectionId", "customerId", "managementAccountId", "orgId",
      "partition", "region",
    ])
    || value.schemaVersion !== "sutra.dcf-step-functions-boundary.v1"
    || value.binding !== "SERVER_RESOLVED_DCF_STACK"
    || !BOUNDARY_ID.test(value.boundaryId)
    || !IDENTIFIER.test(value.scope.orgId)
    || !IDENTIFIER.test(value.scope.customerId)
    || !CONNECTION_ID.test(value.scope.connectionId)
    || !ACCOUNT_ID.test(value.scope.managementAccountId)
    || !new Set(["aws", "aws-us-gov", "aws-cn"]).has(value.scope.partition)
    || !compatibleRegion(value.scope.partition, value.scope.region)
    || typeof value.schedulerRegistered !== "boolean"
    || !Array.isArray(value.modules)
    || value.modules.length === 0
    || !value.modules.some((moduleEntry) => moduleEntry.enabled)
    || value.modules.length > DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS.maximumModules) {
    throw new DcfStepFunctionsAdapterError("INVALID_BOUNDARY");
  }
  const moduleIds = new Set<string>();
  const stateMachines = new Set<string>();
  try {
    for (const moduleEntry of value.modules) {
      const unknownModule: unknown = moduleEntry;
      if (!record(unknownModule)
        || !exactKeys(unknownModule, [
          "enabled", "expectedCadenceMinutes", "moduleId", "moduleName",
          "sourceId", "stateMachineArn",
        ])
        || !IDENTIFIER.test(moduleEntry.moduleId)
        || !SAFE_TEXT.test(moduleEntry.moduleName)
        || (moduleEntry.sourceId !== null && !IDENTIFIER.test(moduleEntry.sourceId))
        || typeof moduleEntry.enabled !== "boolean"
        || !Number.isSafeInteger(moduleEntry.expectedCadenceMinutes)
        || moduleEntry.expectedCadenceMinutes < 5
        || moduleEntry.expectedCadenceMinutes > 10_080
        || moduleIds.has(moduleEntry.moduleId)
        || stateMachines.has(moduleEntry.stateMachineArn)) {
        throw new CollectionFailure("SCHEMA_MISMATCH");
      }
      stateMachine(moduleEntry.stateMachineArn, value.scope);
      moduleIds.add(moduleEntry.moduleId);
      stateMachines.add(moduleEntry.stateMachineArn);
    }
  } catch {
    throw new DcfStepFunctionsAdapterError("INVALID_BOUNDARY");
  }
}

function validStatus(value: unknown): value is DcfStatus {
  return typeof value === "string" && STATUSES.has(value as DcfStatus);
}

function machineMetadata(
  value: unknown,
  binding: DcfStepFunctionsModuleBinding,
  scope: DcfScope,
): void {
  if (!record(value)
    || !exactKeys(value, ["stateMachineArn", "status", "type"])
    || value.stateMachineArn !== binding.stateMachineArn
    || !new Set(["ACTIVE", "DELETING"]).has(value.status as string)
    || !new Set(["STANDARD", "EXPRESS"]).has(value.type as string)) {
    throw new CollectionFailure("SCHEMA_MISMATCH");
  }
  stateMachine(value.stateMachineArn, scope);
  if (value.status !== "ACTIVE") throw new CollectionFailure("SOURCE_UNAVAILABLE");
  if (value.type !== "STANDARD") {
    throw new CollectionFailure("UNSUPPORTED_STATE_MACHINE");
  }
}

function nullableCount(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function summary(
  value: unknown,
  binding: DcfStepFunctionsModuleBinding,
  scope: DcfScope,
  observedAtMs: number,
): DcfStepFunctionsExecutionSummary {
  if (!record(value)
    || !exactKeys(value, ["executionArn", "startedAt", "stateMachineArn", "status", "stoppedAt"])
    || typeof value.executionArn !== "string"
    || value.stateMachineArn !== binding.stateMachineArn
    || !validStatus(value.status)
    || (value.stoppedAt !== null && typeof value.stoppedAt !== "string")) {
    throw new CollectionFailure("SCHEMA_MISMATCH");
  }
  execution(value.executionArn, binding.stateMachineArn, scope);
  const startedAt = timestamp(value.startedAt);
  const stoppedAt = value.stoppedAt === null ? null : timestamp(value.stoppedAt);
  if (stoppedAt !== null && stoppedAt < startedAt
    || startedAt > observedAtMs + 300_000
    || (stoppedAt !== null && stoppedAt > observedAtMs + 300_000)
    || value.status === "RUNNING" && stoppedAt !== null
    || value.status !== "RUNNING" && stoppedAt === null) {
    throw new CollectionFailure("SCHEMA_MISMATCH");
  }
  return value as unknown as DcfStepFunctionsExecutionSummary;
}

function metadata(value: unknown, listed: DcfStepFunctionsExecutionSummary, binding: DcfStepFunctionsModuleBinding, scope: DcfScope): DcfExecution {
  if (!record(value)
    || !exactKeys(value, [
      "acceptedRecords", "errorCode", "executionArn", "expectedRecords",
      "inputSha256", "processedBytes", "redriveCount", "rejectedRecords",
      "startedAt", "stateMachineArn", "status", "stoppedAt",
    ])
    || value.executionArn !== listed.executionArn
    || value.stateMachineArn !== binding.stateMachineArn
    || !validStatus(value.status)
    || typeof value.startedAt !== "string"
    || value.startedAt !== listed.startedAt
    || (value.stoppedAt !== null && typeof value.stoppedAt !== "string")
    || !Number.isSafeInteger(value.redriveCount)
    || (value.redriveCount as number) < 0
    || (value.redriveCount as number) > 1_000
    || (value.inputSha256 !== null
      && (typeof value.inputSha256 !== "string" || !SHA256.test(value.inputSha256)))
    || !nullableCount(value.acceptedRecords)
    || !nullableCount(value.rejectedRecords)
    || !nullableCount(value.expectedRecords)
    || !nullableCount(value.processedBytes)
    || (value.errorCode !== null
      && (typeof value.errorCode !== "string"
        || !ERROR_CODES.has(value.errorCode as NonNullable<DcfExecution["errorCode"]>)))) {
    throw new CollectionFailure("SCHEMA_MISMATCH");
  }
  execution(value.executionArn, binding.stateMachineArn, scope);
  const startedAt = timestamp(value.startedAt);
  const stoppedAt = value.stoppedAt === null ? null : timestamp(value.stoppedAt);
  if (stoppedAt !== null && stoppedAt < startedAt
    || value.status === "RUNNING" && stoppedAt !== null
    || value.status !== "RUNNING" && stoppedAt === null
    || (listed.status !== "RUNNING" && listed.status !== value.status)
    || (listed.stoppedAt !== null && listed.stoppedAt !== value.stoppedAt)
    || (["RUNNING", "SUCCEEDED"].includes(value.status) && value.errorCode !== null)
    || (value.expectedRecords !== null
      && value.acceptedRecords !== null
      && value.rejectedRecords !== null
      && (value.acceptedRecords as number) + (value.rejectedRecords as number)
        > (value.expectedRecords as number))) {
    throw new CollectionFailure("SCHEMA_MISMATCH");
  }
  return {
    executionArn: value.executionArn as string,
    stateMachineArn: value.stateMachineArn as string,
    status: value.status as DcfStatus,
    startedAt: value.startedAt,
    stoppedAt: value.stoppedAt as string | null,
    attempt: (value.redriveCount as number) + 1,
    retryOfExecutionArn: null,
    inputSha256: value.inputSha256 as string | null,
    acceptedRecords: value.acceptedRecords as number | null,
    rejectedRecords: value.rejectedRecords as number | null,
    expectedRecords: value.expectedRecords as number | null,
    processedBytes: value.processedBytes as number | null,
    errorCode: value.errorCode as DcfExecution["errorCode"],
  };
}

function failureCode(error: unknown, signal: AbortSignal): DcfStepFunctionsFailureCode {
  if (signal.aborted) return "TIMEOUT";
  if (error instanceof CollectionFailure) return error.code;
  if (error instanceof DcfStepFunctionsProviderError) return error.code;
  return "INTERNAL_ERROR";
}

function retryable(error: unknown): boolean {
  return error instanceof DcfStepFunctionsProviderError
    && new Set(["SOURCE_UNAVAILABLE", "THROTTLED", "TIMEOUT"]).has(error.code);
}

async function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DcfStepFunctionsProviderError("TIMEOUT"));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new DcfStepFunctionsProviderError("TIMEOUT"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(hash)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function state(capture: DcfCapture, completedAtMs: number): DcfStepFunctionsCollectionResult["sourceState"] {
  if (capture.providerAccess !== "ENABLED") return "UNAVAILABLE";
  if (!capture.schedulerRegistered || !capture.pagesExhausted) return "PARTIAL";
  for (const moduleEntry of capture.modules.filter((entry) => entry.enabled)) {
    const latest = moduleEntry.executions
      .map((executionEntry) => Date.parse(executionEntry.startedAt))
      .sort((left, right) => right - left)[0];
    if (latest === undefined
      || completedAtMs - latest > moduleEntry.expectedCadenceMinutes * 2 * 60_000) {
      return "STALE";
    }
  }
  return "READY";
}

export class DcfStepFunctionsAdapter {
  private readonly provider: DcfStepFunctionsProvider;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  public constructor(dependencies: AdapterDependencies) {
    this.provider = dependencies.provider;
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? defaultSleep;
  }

  public async collect(
    boundary: DcfStepFunctionsBoundary,
    parentSignal: AbortSignal,
  ): Promise<DcfStepFunctionsCollectionResult> {
    validateBoundary(boundary);
    const startedAtMs = this.now();
    if (!Number.isSafeInteger(startedAtMs)
      || startedAtMs < 0
      || startedAtMs > 8_640_000_000_000_000) {
      throw new DcfStepFunctionsAdapterError("COLLECTION_FAILED");
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS.maximumDurationMs);
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener("abort", abort, { once: true });

    let requestCount = 0;
    let retryCount = 0;
    let successfulRequests = 0;
    let pageCount = 0;
    let executionCount = 0;
    let pagesExhausted = true;
    let providerAccess: DcfCapture["providerAccess"] = "ENABLED";
    const failures = new Set<DcfStepFunctionsFailureCode>();
    const seenExecutionArns = new Set<string>();
    const modules: DcfModuleExecution[] = [];

    const invoke = async <T>(operation: () => Promise<T>): Promise<T> => {
      for (let attempt = 1; attempt <= DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS.maximumAttemptsPerRequest; attempt += 1) {
        if (controller.signal.aborted
          || this.now() - startedAtMs > DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS.maximumDurationMs) {
          throw new CollectionFailure("TIMEOUT");
        }
        if (requestCount >= DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS.maximumRequests) {
          throw new CollectionFailure("LIMIT_REACHED");
        }
        requestCount += 1;
        try {
          const result = await operation();
          successfulRequests += 1;
          return result;
        } catch (error) {
          if (!retryable(error)
            || attempt === DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS.maximumAttemptsPerRequest) {
            throw error;
          }
          retryCount += 1;
          await this.sleep(
            DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS.retryBaseDelayMs * 2 ** (attempt - 1),
            controller.signal,
          );
        }
      }
      throw new CollectionFailure("INTERNAL_ERROR");
    };

    try {
      for (const binding of boundary.modules) {
        const executions: DcfExecution[] = [];
        modules.push({
          moduleId: binding.moduleId,
          moduleName: binding.moduleName,
          sourceId: binding.sourceId,
          enabled: binding.enabled,
          expectedCadenceMinutes: binding.expectedCadenceMinutes,
          executions,
        });
        if (!binding.enabled || providerAccess === "DISABLED") continue;
        const seenTokens = new Set<string>();
        let nextToken: string | null = null;
        try {
          const rawMachine: unknown = await invoke(() => this.provider.describeStateMachine({
            scope: boundary.scope,
            stateMachineArn: binding.stateMachineArn,
            includedData: "METADATA_ONLY",
          }, controller.signal));
          machineMetadata(rawMachine, binding, boundary.scope);
          do {
            if (pageCount >= DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS.maximumPages) {
              throw new CollectionFailure("LIMIT_REACHED");
            }
            const rawPage: unknown = await invoke(() => this.provider.listExecutions({
              scope: boundary.scope,
              stateMachineArn: binding.stateMachineArn,
              maxResults: DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS.listPageSize,
              nextToken,
            }, controller.signal));
            pageCount += 1;
            if (!record(rawPage)
              || !exactKeys(rawPage, ["executions", "nextToken"])
              || !Array.isArray(rawPage.executions)
              || rawPage.executions.length > DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS.listPageSize
              || (rawPage.nextToken !== null
                && (typeof rawPage.nextToken !== "string" || !TOKEN.test(rawPage.nextToken)))) {
              throw new CollectionFailure("SCHEMA_MISMATCH");
            }
            if (executionCount + rawPage.executions.length
              > DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS.maximumExecutions) {
              throw new CollectionFailure("LIMIT_REACHED");
            }
            const observedAtMs = this.now();
            if (!Number.isSafeInteger(observedAtMs)
              || observedAtMs < startedAtMs
              || observedAtMs > 8_640_000_000_000_000) {
              throw new CollectionFailure("TIMEOUT");
            }
            const listed = rawPage.executions.map((item) => summary(
              item,
              binding,
              boundary.scope,
              observedAtMs,
            ));
            for (const item of listed) {
              if (seenExecutionArns.has(item.executionArn)) {
                throw new CollectionFailure("SCHEMA_MISMATCH");
              }
              seenExecutionArns.add(item.executionArn);
              executionCount += 1;
              const described: unknown = await invoke(() => this.provider.describeExecution({
                scope: boundary.scope,
                executionArn: item.executionArn,
                includedData: "METADATA_ONLY",
              }, controller.signal));
              executions.push(metadata(described, item, binding, boundary.scope));
            }
            nextToken = rawPage.nextToken as string | null;
            if (nextToken !== null) {
              if (seenTokens.has(nextToken)) throw new CollectionFailure("SCHEMA_MISMATCH");
              seenTokens.add(nextToken);
              if (pageCount >= DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS.maximumPages) {
                throw new CollectionFailure("LIMIT_REACHED");
              }
            }
          } while (nextToken !== null);
        } catch (error) {
          pagesExhausted = false;
          const code = failureCode(error, controller.signal);
          failures.add(code);
          if (code === "AUTHORIZATION_FAILED") providerAccess = "DISABLED";
        }
      }

      if (providerAccess === "ENABLED" && failures.size > 0 && successfulRequests === 0) {
        providerAccess = "UNAVAILABLE";
      }
      const completedAtMs = this.now();
      if (!Number.isSafeInteger(completedAtMs)
        || completedAtMs < startedAtMs
        || completedAtMs > 8_640_000_000_000_000
        || completedAtMs - startedAtMs > DCF_STEP_FUNCTIONS_ADAPTER_BOUNDS.maximumDurationMs) {
        failures.add("TIMEOUT");
        pagesExhausted = false;
        if (successfulRequests === 0) providerAccess = "UNAVAILABLE";
      }
      const captureBase = {
        schemaVersion: "sutra.dcf-execution-history.capture.v1" as const,
        scope: boundary.scope,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        providerAccess,
        schedulerRegistered: boundary.schedulerRegistered,
        pagesExhausted,
        pageCount,
        modules,
      };
      const capture: DcfCapture = {
        ...captureBase,
        captureId: `dcf_${await digest(captureBase)}`,
      };
      try {
        normalizeDcfCapture(capture, boundary.scope, completedAtMs);
      } catch {
        throw new DcfStepFunctionsAdapterError("COLLECTION_FAILED");
      }
      return {
        schemaVersion: "sutra.dcf-step-functions-collection-result.v1",
        sourceState: state(capture, completedAtMs),
        failureCodes: [...failures].sort(),
        requestCount,
        retryCount,
        capture,
      };
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", abort);
    }
  }
}
