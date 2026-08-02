/**
 * Credential-owning AWS Support Cases collector.
 *
 * Raw subjects, correspondence, submitter/contact identifiers, attachment
 * metadata, provider diagnostics, credentials and pagination tokens never
 * leave this module. Sensitive values are reduced to per-job HMAC evidence
 * before the capture is returned to the signed broker route.
 */
import { createHash, createHmac } from "node:crypto";
import {
  DescribeCasesCommand,
  DescribeCommunicationsCommand,
  type CaseDetails,
  type Communication,
} from "@aws-sdk/client-support";
import { AWS_SUPPORT_CASES_PERMISSION_ACTIONS } from
  "./aws-support-cases-permission-contract.js";

const ACCOUNT_ID = /^\d{12}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const JOB_ID = /^supportjob_[a-f0-9]{32}$/u;
const CASE_ID = /^case-[A-Za-z0-9-]{1,240}$/u;
const DISPLAY_ID = /^\d{1,64}$/u;
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const TOKEN = /^[A-Za-z0-9+/=_.:-]{1,4096}$/u;
const STATUSES = new Set([
  "all-open", "customer-action-completed", "opened", "pending-customer-action",
  "reopened", "resolved", "unassigned", "work-in-progress",
]);
const SEVERITIES = new Set(["low", "normal", "high", "urgent", "critical"]);
const MAX_TEXT_BYTES = 1 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

export const AWS_SUPPORT_CASES_PROVIDER_SESSION_ACTIONS = Object.freeze([
  "sts:GetCallerIdentity",
  ...AWS_SUPPORT_CASES_PERMISSION_ACTIONS,
] as const);

export const AWS_SUPPORT_CASES_PROVIDER_BOUNDS = Object.freeze({
  casePageSize: 100,
  communicationPageSize: 100,
  maximumRequestsPerSecondPerAccount: 4,
  maximumConcurrency: 2,
  maximumDurationMs: 15 * 60 * 1_000,
  maximumCaptureBytes: 64 * 1_024 * 1_024,
  maximumAccounts: 200,
  maximumCasePages: 10_000,
  maximumCommunicationPages: 50_000,
  maximumCases: 50_000,
  maximumCommunications: 250_000,
});

export type AwsSupportCasesProviderPartition = "aws" | "aws-us-gov";

export interface AwsSupportCasesProviderRequest {
  readonly tenantId: string;
  readonly customerId: string;
  readonly parentConnectionId: string;
  readonly partition: AwsSupportCasesProviderPartition;
  readonly endpointRegion: "us-east-1" | "us-gov-west-1";
  readonly jobId: string;
  readonly window: {
    readonly mode: "INITIAL" | "INCREMENTAL";
    readonly afterTime: string;
    readonly beforeTime: string;
    readonly priorWatermark: string | null;
    readonly nextWatermark: string;
  };
  readonly intendedAccounts: readonly {
    readonly accountId: string;
    readonly connectionId: string;
  }[];
}

export interface AwsSupportCasesProviderClient {
  send(
    command: DescribeCasesCommand | DescribeCommunicationsCommand,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<unknown>;
  destroy?(): void;
}

export class AwsSupportCasesProviderAdapterError extends Error {
  public readonly code: "INVALID_REQUEST" | "PROVIDER_RESPONSE_INVALID" | "BOUND_REACHED" | "ABORTED";
  public constructor(code: AwsSupportCasesProviderAdapterError["code"]) {
    super("AWS Support cases provider collection did not complete");
    this.name = "AwsSupportCasesProviderAdapterError";
    this.code = code;
  }
}

function reject(code: AwsSupportCasesProviderAdapterError["code"]): never {
  throw new AwsSupportCasesProviderAdapterError(code);
}

function iso(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return reject("PROVIDER_RESPONSE_INVALID");
  }
  return new Date(Date.parse(value)).toISOString();
}

function bytes(value: unknown): number {
  if (typeof value !== "string") return reject("PROVIDER_RESPONSE_INVALID");
  const length = Buffer.byteLength(value, "utf8");
  if (length > MAX_TEXT_BYTES) return reject("BOUND_REACHED");
  return length;
}

function required(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    return reject("PROVIDER_RESPONSE_INVALID");
  }
  return value;
}

function token(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !TOKEN.test(value)) {
    return reject("PROVIDER_RESPONSE_INVALID");
  }
  return value;
}

function nextToken(value: unknown, prior: string | null, seen: Set<string>): string | null {
  const next = token(value);
  if (next !== null && (next === prior || seen.has(next))) {
    return reject("PROVIDER_RESPONSE_INVALID");
  }
  if (next !== null) seen.add(next);
  return next;
}

function failure(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return "TIMEOUT" as const;
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { readonly name: unknown }).name) : "";
  if (/subscriptionrequired|supportplan/iu.test(name)) return "SUBSCRIPTION_REQUIRED" as const;
  if (/accessdenied|unauthorized|notauthorized/iu.test(name)) return "ACCESS_DENIED" as const;
  if (/casenotfound/iu.test(name)) return "CASE_NOT_FOUND" as const;
  if (/throttl|toomanyrequest|requestlimit/iu.test(name)) return "THROTTLED" as const;
  if (/timeout|abort/iu.test(name)) return "TIMEOUT" as const;
  if (error instanceof AwsSupportCasesProviderAdapterError && error.code === "BOUND_REACHED") {
    return "BOUND_REACHED" as const;
  }
  if (/serviceunavailable|internalerror|network|socket/iu.test(name)) {
    return "PROVIDER_UNAVAILABLE" as const;
  }
  return "UNKNOWN" as const;
}

function actor(value: unknown): "AWS" | "CUSTOMER" | "UNKNOWN" {
  if (typeof value !== "string" || value.length === 0) return "UNKNOWN";
  return /amazon web services|aws support/iu.test(value) ? "AWS" : "CUSTOMER";
}

function hmac(key: Uint8Array, jobId: string, kind: string, value: unknown): string {
  return `hmac-sha256:${createHmac("sha256", key)
    .update(JSON.stringify({ schemaVersion: "sutra.aws-support-evidence.v1", jobId, kind, value }))
    .digest("hex")}`;
}

function sanitizeCase(value: CaseDetails, key: Uint8Array, jobId: string) {
  const caseId = required(value.caseId, CASE_ID);
  const displayId = required(value.displayId, DISPLAY_ID);
  const categoryCode = required(value.categoryCode, SAFE_CODE);
  const serviceCode = required(value.serviceCode, SAFE_CODE);
  const severityCode = required(value.severityCode, SAFE_CODE);
  const status = required(value.status, SAFE_CODE);
  const language = required(value.language ?? "en", /^[a-z]{2}$/u);
  if (!SEVERITIES.has(severityCode) || !STATUSES.has(status)) {
    return reject("PROVIDER_RESPONSE_INVALID");
  }
  const subjectBytes = bytes(value.subject ?? "");
  const cc = value.ccEmailAddresses ?? [];
  if (!Array.isArray(cc) || cc.length > MAX_ATTACHMENTS
    || cc.some((entry) => typeof entry !== "string" || bytes(entry) > 320)) {
    return reject("BOUND_REACHED");
  }
  return Object.freeze({
    caseId,
    displayId,
    categoryCode,
    language,
    serviceCode,
    severityCode,
    status,
    createdAt: iso(value.timeCreated),
    submittedByKind: actor(value.submittedBy),
    ccRecipientCount: cc.length,
    subjectBytes,
    subjectEvidenceHash: hmac(key, jobId, "case-subject", value.subject ?? ""),
    contactEvidenceHash: hmac(key, jobId, "case-contacts", {
      submittedBy: value.submittedBy ?? null,
      cc,
    }),
    metadataEvidenceHash: hmac(key, jobId, "case-metadata", {
      caseId, displayId, categoryCode, language, serviceCode, severityCode, status,
      createdAt: iso(value.timeCreated),
    }),
    recentCommunicationsOmitted: true as const,
  });
}

function sanitizeCommunication(
  value: Communication,
  expectedCaseId: string,
  key: Uint8Array,
  jobId: string,
) {
  const caseId = required(value.caseId, CASE_ID);
  if (caseId !== expectedCaseId) return reject("PROVIDER_RESPONSE_INVALID");
  const bodyBytes = bytes(value.body ?? "");
  const attachments = value.attachmentSet ?? [];
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) {
    return reject("BOUND_REACHED");
  }
  for (const item of attachments) {
    if (item === null || typeof item !== "object") return reject("PROVIDER_RESPONSE_INVALID");
    bytes(item.attachmentId ?? "");
    bytes(item.fileName ?? "");
  }
  const createdAt = iso(value.timeCreated);
  return Object.freeze({
    caseId,
    createdAt,
    submittedByKind: actor(value.submittedBy),
    bodyBytes,
    bodyEvidenceHash: hmac(key, jobId, "communication-body", value.body ?? ""),
    submitterEvidenceHash: hmac(key, jobId, "communication-submitter", value.submittedBy ?? ""),
    attachmentCount: attachments.length,
    attachmentEvidenceHash: hmac(key, jobId, "communication-attachments", attachments),
    metadataEvidenceHash: hmac(key, jobId, "communication-metadata", {
      caseId, createdAt, submittedBy: value.submittedBy ?? null, body: value.body ?? "", attachments,
    }),
  });
}

function cursorEvidence(key: Uint8Array, jobId: string, tokenValue: string | null): string | null {
  return tokenValue === null ? null : hmac(key, jobId, "pagination-token", tokenValue);
}

function validRequest(request: AwsSupportCasesProviderRequest): boolean {
  const endpoint = request.partition === "aws" ? "us-east-1" : "us-gov-west-1";
  return JOB_ID.test(request.jobId)
    && CONNECTION_ID.test(request.parentConnectionId)
    && request.endpointRegion === endpoint
    && request.intendedAccounts.length >= 1
    && request.intendedAccounts.length <= AWS_SUPPORT_CASES_PROVIDER_BOUNDS.maximumAccounts
    && request.intendedAccounts.every((item) => ACCOUNT_ID.test(item.accountId)
      && CONNECTION_ID.test(item.connectionId))
    && JSON.stringify(request.intendedAccounts) === JSON.stringify(
      [...request.intendedAccounts].sort((left, right) => left.accountId.localeCompare(right.accountId)),
    )
    && new Set(request.intendedAccounts.map((item) => item.accountId)).size === request.intendedAccounts.length
    && new Set(request.intendedAccounts.map((item) => item.connectionId)).size === request.intendedAccounts.length;
}

async function collectAccount(input: {
  readonly request: AwsSupportCasesProviderRequest;
  readonly account: AwsSupportCasesProviderRequest["intendedAccounts"][number];
  readonly evidenceKey: Uint8Array;
  readonly signal: AbortSignal;
  readonly clientForAccount: (
    account: AwsSupportCasesProviderRequest["intendedAccounts"][number],
    signal: AbortSignal,
  ) => Promise<AwsSupportCasesProviderClient>;
  readonly now: () => number;
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}) {
  const started = input.now();
  let client: AwsSupportCasesProviderClient | null = null;
  try {
    if (input.signal.aborted) return reject("ABORTED");
    client = await input.clientForAccount(input.account, input.signal);
    let requestCount = 0;
    const send = async (command: DescribeCasesCommand | DescribeCommunicationsCommand) => {
      if (requestCount > 0) await input.wait(250, input.signal);
      requestCount += 1;
      return client!.send(command, { abortSignal: input.signal });
    };
    const casePages: unknown[] = [];
    const cases: ReturnType<typeof sanitizeCase>[] = [];
    let rawToken: string | null = null;
    const caseTokens = new Set<string>();
    do {
      if (casePages.length >= AWS_SUPPORT_CASES_PROVIDER_BOUNDS.maximumCasePages
        || cases.length > AWS_SUPPORT_CASES_PROVIDER_BOUNDS.maximumCases) reject("BOUND_REACHED");
      const output = await send(new DescribeCasesCommand({
        afterTime: input.request.window.afterTime,
        beforeTime: input.request.window.beforeTime,
        includeResolvedCases: true,
        includeCommunications: false,
        maxResults: 100,
        ...(rawToken === null ? {} : { nextToken: rawToken }),
      })) as { readonly cases?: CaseDetails[]; readonly nextToken?: string };
      if (!Array.isArray(output.cases) || output.cases.length > 100) {
        return reject("PROVIDER_RESPONSE_INVALID");
      }
      const sanitized = output.cases.map((item) => sanitizeCase(item, input.evidenceKey, input.request.jobId));
      cases.push(...sanitized);
      const returnedToken = nextToken(output.nextToken, rawToken, caseTokens);
      casePages.push(Object.freeze({
        request: {
          pageIndex: casePages.length,
          cursorEvidenceHash: cursorEvidence(input.evidenceKey, input.request.jobId, rawToken),
          afterTime: input.request.window.afterTime,
          beforeTime: input.request.window.beforeTime,
          caseIdList: null,
          displayId: null,
          includeCommunications: false,
          includeResolvedCases: true,
          language: null,
          maxResults: 100,
        },
        response: { cases: sanitized, nextCursorEvidenceHash: cursorEvidence(input.evidenceKey, input.request.jobId, returnedToken) },
      }));
      rawToken = returnedToken;
    } while (rawToken !== null);

    if (cases.length > AWS_SUPPORT_CASES_PROVIDER_BOUNDS.maximumCases) reject("BOUND_REACHED");
    const uniqueCases = [...new Map(cases.map((item) => [item.caseId, item] as const)).values()]
      .sort((left, right) => left.caseId.localeCompare(right.caseId));
    if (uniqueCases.length !== cases.length) return reject("PROVIDER_RESPONSE_INVALID");
    const communications: unknown[] = [];
    let communicationPageCount = 0;
    let communicationCount = 0;
    for (const supportCase of uniqueCases) {
      const pages: unknown[] = [];
      let communicationToken: string | null = null;
      const seen = new Set<string>();
      do {
        if (communicationPageCount >= AWS_SUPPORT_CASES_PROVIDER_BOUNDS.maximumCommunicationPages
          || communicationCount > AWS_SUPPORT_CASES_PROVIDER_BOUNDS.maximumCommunications) {
          return reject("BOUND_REACHED");
        }
        const output = await send(new DescribeCommunicationsCommand({
          caseId: supportCase.caseId,
          afterTime: input.request.window.afterTime,
          beforeTime: input.request.window.beforeTime,
          maxResults: 100,
          ...(communicationToken === null ? {} : { nextToken: communicationToken }),
        })) as { readonly communications?: Communication[]; readonly nextToken?: string };
        if (!Array.isArray(output.communications) || output.communications.length > 100) {
          return reject("PROVIDER_RESPONSE_INVALID");
        }
        const sanitized = output.communications.map((item) =>
          sanitizeCommunication(item, supportCase.caseId, input.evidenceKey, input.request.jobId));
        communicationCount += sanitized.length;
        const returnedToken = nextToken(output.nextToken, communicationToken, seen);
        pages.push(Object.freeze({
          request: {
            pageIndex: pages.length,
            cursorEvidenceHash: cursorEvidence(input.evidenceKey, input.request.jobId, communicationToken),
            caseId: supportCase.caseId,
            afterTime: input.request.window.afterTime,
            beforeTime: input.request.window.beforeTime,
            maxResults: 100,
          },
          response: {
            communications: sanitized,
            nextCursorEvidenceHash: cursorEvidence(input.evidenceKey, input.request.jobId, returnedToken),
          },
        }));
        communicationPageCount += 1;
        communicationToken = returnedToken;
      } while (communicationToken !== null);
      communications.push(Object.freeze({
        caseId: supportCase.caseId,
        status: "SUCCEEDED" as const,
        pages,
        exhausted: true,
        failureCode: null,
      }));
    }
    const completed = input.now();
    return Object.freeze({
      accountId: input.account.accountId,
      connectionId: input.account.connectionId,
      supportPlan: "qualifying_plan_unclassified" as const,
      entitlementState: "QUALIFYING" as const,
      readPermissionsValidated: true,
      startedAt: new Date(started).toISOString(),
      completedAt: new Date(completed).toISOString(),
      observedPeakConcurrency: 1,
      observedPeakRequestsPerSecond: Math.min(
        AWS_SUPPORT_CASES_PROVIDER_BOUNDS.maximumRequestsPerSecondPerAccount,
        requestCount,
      ),
      status: "SUCCEEDED" as const,
      failureCode: null,
      casePages,
      casesExhausted: true,
      communications,
    });
  } catch (error) {
    const code = failure(error, input.signal);
    const completed = input.now();
    return Object.freeze({
      accountId: input.account.accountId,
      connectionId: input.account.connectionId,
      supportPlan: code === "SUBSCRIPTION_REQUIRED" ? "not_qualifying" as const : "unknown" as const,
      entitlementState: code === "SUBSCRIPTION_REQUIRED" ? "NOT_QUALIFYING" as const : "UNKNOWN" as const,
      readPermissionsValidated: false,
      startedAt: new Date(started).toISOString(),
      completedAt: new Date(completed).toISOString(),
      observedPeakConcurrency: 0,
      observedPeakRequestsPerSecond: 0,
      status: "FAILED" as const,
      failureCode: code,
      casePages: [] as const,
      casesExhausted: false,
      communications: [] as const,
    });
  } finally {
    client?.destroy?.();
  }
}

export async function collectAwsSupportCasesProviderEvidence(input: {
  readonly request: AwsSupportCasesProviderRequest;
  readonly evidenceKey: Uint8Array;
  readonly signal: AbortSignal;
  readonly clientForAccount: (
    account: AwsSupportCasesProviderRequest["intendedAccounts"][number],
    signal: AbortSignal,
  ) => Promise<AwsSupportCasesProviderClient>;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}) {
  if (!validRequest(input.request) || !(input.signal instanceof AbortSignal)
    || input.signal.aborted || !(input.evidenceKey instanceof Uint8Array)
    || input.evidenceKey.byteLength < 32 || input.evidenceKey.byteLength > 64) {
    return reject("INVALID_REQUEST");
  }
  const now = input.now ?? Date.now;
  const wait = input.wait ?? ((milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, rejectWait) => {
    const abort = () => {
      clearTimeout(timer);
      rejectWait(new AwsSupportCasesProviderAdapterError("ABORTED"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  }));
  const startedAtMs = now();
  const deadline = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(AWS_SUPPORT_CASES_PROVIDER_BOUNDS.maximumDurationMs),
  ]);
  const results = new Array<Awaited<ReturnType<typeof collectAccount>>>(input.request.intendedAccounts.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < input.request.intendedAccounts.length) {
      const index = cursor++;
      results[index] = await collectAccount({
        request: input.request,
        account: input.request.intendedAccounts[index]!,
        evidenceKey: input.evidenceKey,
        signal: deadline,
        clientForAccount: input.clientForAccount,
        now,
        wait,
      });
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(AWS_SUPPORT_CASES_PROVIDER_BOUNDS.maximumConcurrency, input.request.intendedAccounts.length) },
    worker,
  ));
  const completedAtMs = now();
  if (!Number.isSafeInteger(startedAtMs) || !Number.isSafeInteger(completedAtMs)
    || completedAtMs < startedAtMs
    || completedAtMs - startedAtMs > AWS_SUPPORT_CASES_PROVIDER_BOUNDS.maximumDurationMs) {
    return reject("ABORTED");
  }
  const withoutId = {
    schemaVersion: "sutra.aws-support-cases.capture.v1" as const,
    scope: {
      orgId: input.request.tenantId,
      customerId: input.request.customerId,
      connectionId: input.request.parentConnectionId,
      partition: input.request.partition,
      endpointRegion: input.request.endpointRegion,
    },
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    window: input.request.window,
    intendedAccounts: input.request.intendedAccounts,
    accounts: results,
  };
  const capture = Object.freeze({
    ...withoutId,
    captureId: `support_${createHash("sha256").update(JSON.stringify(withoutId)).digest("hex")}`,
  });
  if (Buffer.byteLength(JSON.stringify(capture), "utf8")
    > AWS_SUPPORT_CASES_PROVIDER_BOUNDS.maximumCaptureBytes) return reject("BOUND_REACHED");
  return capture;
}
