/** Credential-side, privacy-minimized Step Functions collector for ADV-12. */
import { createHash } from "node:crypto";

export const DCF_PROVIDER_ACTIONS = Object.freeze([
  "states:ListExecutions", "states:DescribeExecution", "states:DescribeStateMachine",
] as const);
export const DCF_PROVIDER_BOUNDS = Object.freeze({
  listPageSize: 1_000, maximumModules: 500, maximumExecutions: 10_000,
  maximumPages: 1_000, maximumRequests: 25_000, maximumAttemptsPerRequest: 3,
  retryBaseDelayMs: 200, maximumDurationMs: 15 * 60 * 1_000,
} as const);
export const DCF_PROVIDER_SESSION_ACTIONS = DCF_PROVIDER_ACTIONS;

type Partition = "aws" | "aws-us-gov" | "aws-cn";
type Status = "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "ABORTED";
type Failure = "AUTHORIZATION_FAILED" | "SOURCE_UNAVAILABLE" | "THROTTLED" | "TIMEOUT" | "SCHEMA_MISMATCH" | "SCOPE_MISMATCH" | "UNSUPPORTED_STATE_MACHINE" | "LIMIT_REACHED" | "INTERNAL_ERROR";
interface Scope { readonly orgId: string; readonly customerId: string; readonly connectionId: string; readonly managementAccountId: string; readonly partition: Partition; readonly region: string }
interface Module { readonly moduleId: string; readonly moduleName: string; readonly sourceId: string | null; readonly enabled: boolean; readonly expectedCadenceMinutes: number; readonly stateMachineArn: string }
export interface DcfProviderRequest {
  readonly schemaVersion: "sutra.dcf-step-functions-provider-request.v1";
  readonly boundary: { readonly schemaVersion: "sutra.dcf-step-functions-boundary.v1"; readonly boundaryId: string; readonly binding: "SERVER_RESOLVED_DCF_STACK"; readonly scope: Scope; readonly schedulerRegistered: boolean; readonly modules: readonly Module[] };
  readonly operations: typeof DCF_PROVIDER_ACTIONS;
  readonly bounds: typeof DCF_PROVIDER_BOUNDS;
  readonly credentials: "SERVER_OWNED_TRUST_ROLE_SESSION";
  readonly includeRawInput: false;
  readonly includeRawOutput: false;
  readonly includeRawProviderErrors: false;
  readonly includeRawPaginationTokens: false;
  readonly deadlineAtIso: string;
}
export interface DcfProviderReader {
  describeStateMachine(input: { readonly stateMachineArn: string; readonly includedData: "METADATA_ONLY" }, signal: AbortSignal): Promise<unknown>;
  listExecutions(input: { readonly stateMachineArn: string; readonly maxResults: 1_000; readonly nextToken: string | null }, signal: AbortSignal): Promise<unknown>;
  describeExecution(input: { readonly executionArn: string; readonly includedData: "METADATA_ONLY" }, signal: AbortSignal): Promise<unknown>;
}
interface Execution { readonly executionArn: string; readonly stateMachineArn: string; readonly status: Status; readonly startedAt: string; readonly stoppedAt: string | null; readonly attempt: number; readonly retryOfExecutionArn: null; readonly inputSha256: string | null; readonly acceptedRecords: null; readonly rejectedRecords: null; readonly expectedRecords: null; readonly processedBytes: null; readonly errorCode: "AUTHORIZATION_FAILED" | "SOURCE_UNAVAILABLE" | "THROTTLED" | "TIMEOUT" | "SCHEMA_MISMATCH" | "RECONCILIATION_FAILED" | "CANCELLED" | "INTERNAL_ERROR" | null }
interface Capture { readonly schemaVersion: "sutra.dcf-execution-history.capture.v1"; readonly scope: Scope; readonly captureId: string; readonly startedAt: string; readonly completedAt: string; readonly providerAccess: "ENABLED" | "DISABLED" | "UNAVAILABLE"; readonly schedulerRegistered: boolean; readonly pagesExhausted: boolean; readonly pageCount: number; readonly modules: readonly { readonly moduleId: string; readonly moduleName: string; readonly sourceId: string | null; readonly enabled: boolean; readonly expectedCadenceMinutes: number; readonly executions: readonly Execution[] }[] }
export interface DcfProviderCollectionResult { readonly schemaVersion: "sutra.dcf-step-functions-collection-result.v1"; readonly sourceState: "READY" | "PARTIAL" | "STALE" | "UNAVAILABLE"; readonly failureCodes: readonly Failure[]; readonly requestCount: number; readonly retryCount: number; readonly capture: Capture }

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const BOUNDARY = /^dcfb_[a-f0-9]{64}$/u;
const TOKEN = /^[^\u0000-\u001f\u007f]{1,3096}$/u;
const MACHINE = /^arn:(aws|aws-us-gov|aws-cn):states:([a-z0-9-]+):(\d{12}):stateMachine:([A-Za-z0-9._+-]{1,80})(?::([A-Za-z0-9._+-]{1,80}))?$/u;
const EXECUTION = /^arn:(aws|aws-us-gov|aws-cn):states:([a-z0-9-]+):(\d{12}):execution:([A-Za-z0-9._+-]{1,80}):([A-Za-z0-9._+-]{1,80})$/u;
const STATUSES = new Set<Status>(["RUNNING", "SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"]);

export class DcfProviderAdapterError extends Error {
  public readonly code: "INVALID_REQUEST" | "PROVIDER_RESPONSE_INVALID" | "BOUND_REACHED" | "ABORTED";
  public constructor(code: DcfProviderAdapterError["code"]) {
    super("Data Collection Monitor provider collection did not complete");
    this.name = "DcfProviderAdapterError"; this.code = code;
  }
}
function reject(code: DcfProviderAdapterError["code"]): never { throw new DcfProviderAdapterError(code); }
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject("PROVIDER_RESPONSE_INVALID");
  return value as Readonly<Record<string, unknown>>;
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function iso(value: unknown): string {
  const milliseconds = value instanceof Date ? value.getTime()
    : typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds)) reject("PROVIDER_RESPONSE_INVALID");
  return new Date(milliseconds).toISOString();
}
function matchesRegion(partition: Partition, region: string): boolean {
  return partition === "aws-cn" ? /^cn-[a-z]+-\d$/u.test(region)
    : partition === "aws-us-gov" ? /^us-gov-[a-z]+-\d$/u.test(region)
      : /^(?!cn-|us-gov-)[a-z]{2}-[a-z]+-\d$/u.test(region);
}
function machineArn(value: string, scope: Scope): RegExpExecArray {
  const match = MACHINE.exec(value);
  if (!match || match[1] !== scope.partition || match[2] !== scope.region || match[3] !== scope.managementAccountId) reject("INVALID_REQUEST");
  return match;
}
function executionArn(value: string, stateMachineArn: string, scope: Scope): void {
  const state = machineArn(stateMachineArn, scope); const match = EXECUTION.exec(value);
  if (!match || match[1] !== scope.partition || match[2] !== scope.region
    || match[3] !== scope.managementAccountId || match[4] !== state[4]) reject("PROVIDER_RESPONSE_INVALID");
}
function validRequest(request: DcfProviderRequest): boolean {
  const boundary = request.boundary; const scope = boundary.scope;
  if (request.schemaVersion !== "sutra.dcf-step-functions-provider-request.v1"
    || boundary.schemaVersion !== "sutra.dcf-step-functions-boundary.v1"
    || !BOUNDARY.test(boundary.boundaryId) || boundary.binding !== "SERVER_RESOLVED_DCF_STACK"
    || !IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId) || !CONNECTION.test(scope.connectionId)
    || !ACCOUNT.test(scope.managementAccountId) || !matchesRegion(scope.partition, scope.region)
    || boundary.schedulerRegistered !== true || boundary.modules.length < 1
    || boundary.modules.length > DCF_PROVIDER_BOUNDS.maximumModules || !boundary.modules.some((item) => item.enabled)
    || !same(request.operations, DCF_PROVIDER_ACTIONS) || !same(request.bounds, DCF_PROVIDER_BOUNDS)
    || request.credentials !== "SERVER_OWNED_TRUST_ROLE_SESSION" || request.includeRawInput !== false
    || request.includeRawOutput !== false || request.includeRawProviderErrors !== false
    || request.includeRawPaginationTokens !== false || !Number.isFinite(Date.parse(request.deadlineAtIso))
    || new Date(Date.parse(request.deadlineAtIso)).toISOString() !== request.deadlineAtIso) return false;
  const modules = new Set<string>(); const machines = new Set<string>();
  for (const item of boundary.modules) {
    if (!IDENTIFIER.test(item.moduleId) || modules.has(item.moduleId)
      || item.moduleName.length < 1 || item.moduleName.length > 256 || /[\u0000-\u001f\u007f<>]/u.test(item.moduleName)
      || (item.sourceId !== null && !IDENTIFIER.test(item.sourceId)) || typeof item.enabled !== "boolean"
      || !Number.isSafeInteger(item.expectedCadenceMinutes) || item.expectedCadenceMinutes < 5 || item.expectedCadenceMinutes > 10_080
      || machines.has(item.stateMachineArn)) return false;
    try { machineArn(item.stateMachineArn, scope); } catch { return false; }
    modules.add(item.moduleId); machines.add(item.stateMachineArn);
  }
  return true;
}
function providerFailure(error: unknown, signal: AbortSignal): Failure {
  if (signal.aborted) return "TIMEOUT";
  const name = typeof error === "object" && error !== null && "name" in error ? String((error as { readonly name: unknown }).name) : "";
  if (/accessdenied|unauthorized|notauthorized|kmsaccessdenied/iu.test(name)) return "AUTHORIZATION_FAILED";
  if (/throttl|toomanyrequest|requestlimit|kmsthrottl/iu.test(name)) return "THROTTLED";
  if (/timeout|abort/iu.test(name)) return "TIMEOUT";
  if (/serviceunavailable|executiondoesnotexist|statemachinedoesnotexist|network|socket|internal/iu.test(name)) return "SOURCE_UNAVAILABLE";
  return "INTERNAL_ERROR";
}
function retryable(code: Failure): boolean { return code === "THROTTLED" || code === "TIMEOUT" || code === "SOURCE_UNAVAILABLE"; }
function genericExecutionError(value: unknown): Execution["errorCode"] {
  if (typeof value !== "string" || value === "") return "INTERNAL_ERROR";
  if (/accessdenied|unauthorized|notauthorized/iu.test(value)) return "AUTHORIZATION_FAILED";
  if (/throttl|toomanyrequest|requestlimit/iu.test(value)) return "THROTTLED";
  if (/timeout|timedout/iu.test(value)) return "TIMEOUT";
  if (/cancel|abort/iu.test(value)) return "CANCELLED";
  if (/schema|validation|parse|deserialize/iu.test(value)) return "SCHEMA_MISMATCH";
  if (/reconcil/iu.test(value)) return "RECONCILIATION_FAILED";
  if (/unavailable|notfound|doesnotexist/iu.test(value)) return "SOURCE_UNAVAILABLE";
  return "INTERNAL_ERROR";
}
async function inputDigest(output: Readonly<Record<string, unknown>>): Promise<string | null> {
  const details = output.inputDetails;
  if (details === undefined || details === null) return null;
  const included = record(details).included;
  if (included === false && output.input === undefined) return null;
  if (included !== true || typeof output.input !== "string" || Buffer.byteLength(output.input, "utf8") > 262_144) reject("PROVIDER_RESPONSE_INVALID");
  return createHash("sha256").update(output.input, "utf8").digest("hex");
}
function summary(raw: unknown, module: Module, scope: Scope, now: number): { executionArn: string; stateMachineArn: string; status: Status; startedAt: string; stoppedAt: string | null } {
  const value = record(raw); const execution = value.executionArn; const stateMachine = value.stateMachineArn;
  if (typeof execution !== "string" || typeof stateMachine !== "string" || stateMachine !== module.stateMachineArn
    || typeof value.status !== "string" || !STATUSES.has(value.status as Status)) reject("PROVIDER_RESPONSE_INVALID");
  executionArn(execution, stateMachine, scope); const startedAt = iso(value.startDate ?? value.startedAt);
  const stoppedAt = value.stopDate === undefined && value.stoppedAt === undefined ? null : iso(value.stopDate ?? value.stoppedAt);
  if (Date.parse(startedAt) > now + 300_000 || (stoppedAt !== null && Date.parse(stoppedAt) > now + 300_000)
    || (stoppedAt !== null && Date.parse(stoppedAt) < Date.parse(startedAt))
    || (value.status === "RUNNING") !== (stoppedAt === null)) reject("PROVIDER_RESPONSE_INVALID");
  return { executionArn: execution, stateMachineArn: stateMachine, status: value.status as Status, startedAt, stoppedAt };
}
async function metadata(raw: unknown, listed: ReturnType<typeof summary>, module: Module, scope: Scope): Promise<Execution> {
  const value = record(raw); const execution = value.executionArn; const stateMachine = value.stateMachineArn;
  if (execution !== listed.executionArn || stateMachine !== module.stateMachineArn
    || typeof value.status !== "string" || !STATUSES.has(value.status as Status)) reject("PROVIDER_RESPONSE_INVALID");
  executionArn(String(execution), String(stateMachine), scope);
  const startedAt = iso(value.startDate ?? value.startedAt);
  const stoppedAt = value.stopDate === undefined && value.stoppedAt === undefined ? null : iso(value.stopDate ?? value.stoppedAt);
  const redriveCount = value.redriveCount ?? 0;
  if (startedAt !== listed.startedAt || (listed.status !== "RUNNING" && value.status !== listed.status)
    || (listed.stoppedAt !== null && stoppedAt !== listed.stoppedAt)
    || !Number.isSafeInteger(redriveCount) || Number(redriveCount) < 0 || Number(redriveCount) > 1_000
    || (value.status === "RUNNING") !== (stoppedAt === null)) reject("PROVIDER_RESPONSE_INVALID");
  const failure = ["FAILED", "TIMED_OUT", "ABORTED"].includes(String(value.status));
  return Object.freeze({
    executionArn: String(execution), stateMachineArn: String(stateMachine), status: value.status as Status,
    startedAt, stoppedAt, attempt: Number(redriveCount) + 1, retryOfExecutionArn: null,
    inputSha256: await inputDigest(value), acceptedRecords: null, rejectedRecords: null,
    expectedRecords: null, processedBytes: null,
    errorCode: failure ? (value.status === "TIMED_OUT" ? "TIMEOUT" : value.status === "ABORTED" ? "CANCELLED" : genericExecutionError(value.error)) : null,
  });
}

export async function collectDcfProviderEvidence(input: {
  readonly request: DcfProviderRequest;
  readonly reader: DcfProviderReader;
  readonly signal: AbortSignal;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<DcfProviderCollectionResult> {
  if (!validRequest(input.request) || !(input.signal instanceof AbortSignal) || input.signal.aborted) reject("INVALID_REQUEST");
  const now = input.now ?? Date.now; const started = now(); const deadline = Date.parse(input.request.deadlineAtIso);
  if (!Number.isSafeInteger(started) || started < 0 || !Number.isSafeInteger(deadline) || deadline <= started
    || deadline - started > DCF_PROVIDER_BOUNDS.maximumDurationMs) reject("INVALID_REQUEST");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(deadline - started)]);
  const sleep = input.sleep ?? (async (milliseconds: number, sleepSignal: AbortSignal) => {
    await new Promise<void>((resolve, rejectPromise) => {
      const timer = setTimeout(resolve, milliseconds);
      sleepSignal.addEventListener("abort", () => { clearTimeout(timer); rejectPromise(new Error("aborted")); }, { once: true });
    });
  });
  let requestCount = 0, retryCount = 0, successfulRequests = 0, pageCount = 0, executionCount = 0;
  let pagesExhausted = true; let providerAccess: Capture["providerAccess"] = "ENABLED";
  const failures = new Set<Failure>(); const executionArns = new Set<string>();
  const invoke = async <T>(operation: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; attempt <= DCF_PROVIDER_BOUNDS.maximumAttemptsPerRequest; attempt += 1) {
      if (signal.aborted || requestCount >= DCF_PROVIDER_BOUNDS.maximumRequests) reject(signal.aborted ? "ABORTED" : "BOUND_REACHED");
      requestCount += 1;
      try { const result = await operation(); successfulRequests += 1; return result; }
      catch (error) {
        const code = providerFailure(error, signal);
        if (!retryable(code) || attempt === DCF_PROVIDER_BOUNDS.maximumAttemptsPerRequest) throw error;
        retryCount += 1; await sleep(DCF_PROVIDER_BOUNDS.retryBaseDelayMs * 2 ** (attempt - 1), signal);
      }
    }
    return reject("PROVIDER_RESPONSE_INVALID");
  };
  const modules: Array<{ moduleId: string; moduleName: string; sourceId: string | null; enabled: boolean; expectedCadenceMinutes: number; executions: Execution[] }> = [];
  for (const moduleDefinition of input.request.boundary.modules) {
    const executions: Execution[] = [];
    modules.push({ moduleId: moduleDefinition.moduleId, moduleName: moduleDefinition.moduleName, sourceId: moduleDefinition.sourceId, enabled: moduleDefinition.enabled, expectedCadenceMinutes: moduleDefinition.expectedCadenceMinutes, executions });
    if (!moduleDefinition.enabled || providerAccess === "DISABLED") continue;
    try {
      const described = record(await invoke(() => input.reader.describeStateMachine({ stateMachineArn: moduleDefinition.stateMachineArn, includedData: "METADATA_ONLY" }, signal)));
      if (described.stateMachineArn !== moduleDefinition.stateMachineArn || !new Set(["ACTIVE", "DELETING"]).has(String(described.status))
        || !new Set(["STANDARD", "EXPRESS"]).has(String(described.type))) reject("PROVIDER_RESPONSE_INVALID");
      if (described.status !== "ACTIVE") throw Object.assign(new Error("unavailable"), { name: "StateMachineDoesNotExist" });
      if (described.type !== "STANDARD") { failures.add("UNSUPPORTED_STATE_MACHINE"); pagesExhausted = false; continue; }
      let token: string | null = null; const tokens = new Set<string>();
      do {
        if (pageCount >= DCF_PROVIDER_BOUNDS.maximumPages) reject("BOUND_REACHED");
        const page = record(await invoke(() => input.reader.listExecutions({ stateMachineArn: moduleDefinition.stateMachineArn, maxResults: 1_000, nextToken: token }, signal)));
        const rawExecutions = page.executions; const rawToken = page.nextToken ?? null; pageCount += 1;
        if (!Array.isArray(rawExecutions) || rawExecutions.length > DCF_PROVIDER_BOUNDS.listPageSize
          || (rawToken !== null && (typeof rawToken !== "string" || !TOKEN.test(rawToken)))) reject("PROVIDER_RESPONSE_INVALID");
        if (executionCount + rawExecutions.length > DCF_PROVIDER_BOUNDS.maximumExecutions) reject("BOUND_REACHED");
        for (const raw of rawExecutions) {
          const listed = summary(raw, moduleDefinition, input.request.boundary.scope, now());
          if (executionArns.has(listed.executionArn)) reject("PROVIDER_RESPONSE_INVALID");
          executionArns.add(listed.executionArn); executionCount += 1;
          executions.push(await metadata(await invoke(() => input.reader.describeExecution({ executionArn: listed.executionArn, includedData: "METADATA_ONLY" }, signal)), listed, moduleDefinition, input.request.boundary.scope));
        }
        token = rawToken as string | null;
        if (token !== null) { if (tokens.has(token)) reject("PROVIDER_RESPONSE_INVALID"); tokens.add(token); }
      } while (token !== null);
    } catch (error) {
      pagesExhausted = false;
      const code: Failure = error instanceof DcfProviderAdapterError
        ? error.code === "BOUND_REACHED" ? "LIMIT_REACHED" : error.code === "ABORTED" ? "TIMEOUT" : "SCHEMA_MISMATCH"
        : providerFailure(error, signal);
      failures.add(code); if (code === "AUTHORIZATION_FAILED") providerAccess = "DISABLED";
    }
  }
  if (providerAccess === "ENABLED" && failures.size > 0 && successfulRequests === 0) providerAccess = "UNAVAILABLE";
  const completed = now();
  if (!Number.isSafeInteger(completed) || completed < started || completed > deadline) {
    failures.add("TIMEOUT"); pagesExhausted = false; if (successfulRequests === 0) providerAccess = "UNAVAILABLE";
  }
  const captureBase = { schemaVersion: "sutra.dcf-execution-history.capture.v1" as const,
    scope: input.request.boundary.scope, startedAt: new Date(started).toISOString(), completedAt: new Date(completed).toISOString(),
    providerAccess, schedulerRegistered: input.request.boundary.schedulerRegistered, pagesExhausted, pageCount, modules };
  const capture: Capture = Object.freeze({ ...captureBase, captureId: `dcf_${createHash("sha256").update(JSON.stringify(captureBase), "utf8").digest("hex")}` });
  let sourceState: DcfProviderCollectionResult["sourceState"] = "READY";
  if (providerAccess !== "ENABLED") sourceState = "UNAVAILABLE";
  else if (!pagesExhausted || !capture.schedulerRegistered) sourceState = "PARTIAL";
  else if (modules.filter((item) => item.enabled).some((item) => {
    const latest = item.executions.map((execution) => Date.parse(execution.startedAt)).sort((a, b) => b - a)[0];
    return latest === undefined || completed - latest > item.expectedCadenceMinutes * 2 * 60_000;
  })) sourceState = "STALE";
  return Object.freeze({ schemaVersion: "sutra.dcf-step-functions-collection-result.v1", sourceState,
    failureCodes: Object.freeze([...failures].sort()), requestCount, retryCount, capture });
}
