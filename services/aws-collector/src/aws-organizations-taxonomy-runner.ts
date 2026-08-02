/**
 * Bounded AWS Organizations taxonomy capture for ADV-01.
 *
 * Organizations is queried only through a freshly attested customer session.
 * The normalized, credential-free bytes are then signed by a dedicated
 * asymmetric KMS key in Sutra's workload account. Caller-defined operations,
 * pagination tokens, endpoints, account labels and email addresses never cross
 * this boundary.
 */
import {
  DescribeOrganizationCommand,
  ListAccountsCommand,
  OrganizationsClient,
  type DescribeOrganizationResponse,
  type ListAccountsRequest,
  type ListAccountsResponse,
} from "@aws-sdk/client-organizations";
import {
  KMSClient,
  SignCommand,
} from "@aws-sdk/client-kms";

import { workloadIdentityAwsClientConfig } from "./role-broker.js";
import type { AwsPartition, AwsTemporaryCredentials } from "./types.js";

export const AWS_ORGANIZATIONS_TAXONOMY_OPERATIONS = Object.freeze([
  "organizations:DescribeOrganization",
  "organizations:ListAccounts",
] as const);
export const AWS_ORGANIZATIONS_TAXONOMY_REGION = "us-east-1" as const;
export const AWS_ORGANIZATIONS_TAXONOMY_ENDPOINT =
  "https://organizations.us-east-1.amazonaws.com" as const;
export const AWS_ORGANIZATIONS_TAXONOMY_MAX_ACCOUNTS = 10_000;
export const AWS_ORGANIZATIONS_TAXONOMY_MAX_PAGES = 1_024;
export const AWS_ORGANIZATIONS_TAXONOMY_MAX_OUTPUT_BYTES = 8 * 1_024 * 1_024;
export const AWS_ORGANIZATIONS_TAXONOMY_OVERALL_DEADLINE_MS = 2 * 60_000;
export const AWS_ORGANIZATIONS_TAXONOMY_COMMAND_DEADLINE_MS = 15_000;
export const AWS_ORGANIZATIONS_TAXONOMY_SIGNING_ALGORITHM =
  "AWS_KMS_RSASSA_PSS_SHA_256" as const;

const ACCOUNT_ID = /^\d{12}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const ORGANIZATION_ID = /^o-[a-z0-9]{10,32}$/u;
const KMS_KEY_ARN = /^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/u;
const TOKEN = /^[\u0020-\u007e]{1,2048}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{43,8192}$/u;
const ACCOUNT_STATES = new Set<OrganizationsTaxonomyAccountState>([
  "ACTIVE",
  "CLOSED",
  "PENDING_ACTIVATION",
  "PENDING_CLOSURE",
  "SUSPENDED",
]);

export type OrganizationsTaxonomyAccountState =
  | "ACTIVE"
  | "CLOSED"
  | "PENDING_ACTIVATION"
  | "PENDING_CLOSURE"
  | "SUSPENDED";

export interface OrganizationsTaxonomyScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface SignedOrganizationsTaxonomyCapture {
  readonly schemaVersion: "sutra.aws-organizations-taxonomy.signed.v1";
  readonly scope: OrganizationsTaxonomyScope;
  readonly partition: "aws";
  readonly managementAccountId: string;
  readonly awsOrganizationId: string;
  readonly collectedAtIso: string;
  readonly pagesExhausted: true;
  readonly operations: typeof AWS_ORGANIZATIONS_TAXONOMY_OPERATIONS;
  readonly accounts: readonly {
    readonly accountId: string;
    readonly state: OrganizationsTaxonomyAccountState;
  }[];
  readonly contentSha256: string;
  readonly signature: {
    readonly algorithm: typeof AWS_ORGANIZATIONS_TAXONOMY_SIGNING_ALGORITHM;
    readonly signerKeyId: string;
    readonly value: string;
  };
}

export interface OrganizationsTaxonomyReader {
  describeOrganization(
    abortSignal?: AbortSignal,
  ): Promise<DescribeOrganizationResponse>;
  listAccounts(
    input: ListAccountsRequest,
    abortSignal?: AbortSignal,
  ): Promise<ListAccountsResponse>;
}

export interface OrganizationsTaxonomySigner {
  signSha256Digest(
    digest: Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<{
    readonly keyId: string;
    readonly signature: Uint8Array;
  }>;
}

export interface OrganizationsTaxonomyCollectionOptions {
  readonly scope: OrganizationsTaxonomyScope;
  readonly managementAccountId: string;
  readonly partition: AwsPartition;
  readonly credentials: AwsTemporaryCredentials;
  readonly signerKeyId: string;
  /** Tests only. Production uses the fixed commercial Organizations endpoint. */
  readonly reader?: OrganizationsTaxonomyReader;
  /** Tests only. Production signs with the configured workload-account KMS key. */
  readonly signer?: OrganizationsTaxonomySigner;
  readonly now?: () => Date;
  readonly maximumAccounts?: number;
  readonly maximumPages?: number;
  readonly maximumOutputBytes?: number;
  readonly overallDeadlineMs?: number;
  readonly commandDeadlineMs?: number;
}

export class OrganizationsTaxonomyCollectionError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "UNSUPPORTED_PARTITION"
    | "PROVIDER_REQUEST_FAILED"
    | "PROVIDER_RESPONSE_INVALID"
    | "PAGINATION_REPLAYED"
    | "PAGE_LIMIT_REACHED"
    | "ACCOUNT_LIMIT_REACHED"
    | "COLLECTION_TIMEOUT"
    | "SIGNING_FAILED"
    | "OUTPUT_SIZE_LIMIT_REACHED";

  public constructor(code: OrganizationsTaxonomyCollectionError["code"]) {
    super("AWS Organizations taxonomy collection did not complete");
    this.name = "OrganizationsTaxonomyCollectionError";
    this.code = code;
  }
}

interface UnsignedOrganizationsTaxonomyCapture {
  readonly schemaVersion: "sutra.aws-organizations-taxonomy.signed.v1";
  readonly scope: OrganizationsTaxonomyScope;
  readonly partition: "aws";
  readonly managementAccountId: string;
  readonly awsOrganizationId: string;
  readonly collectedAtIso: string;
  readonly pagesExhausted: true;
  readonly operations: typeof AWS_ORGANIZATIONS_TAXONOMY_OPERATIONS;
  readonly accounts: SignedOrganizationsTaxonomyCapture["accounts"];
}

/** Collects, canonicalizes and signs one complete organization account set. */
export async function collectSignedOrganizationsTaxonomy(
  options: OrganizationsTaxonomyCollectionOptions,
): Promise<SignedOrganizationsTaxonomyCapture> {
  const now = options.now?.() ?? new Date();
  assertInput(options, now);
  if (options.partition !== "aws") fail("UNSUPPORTED_PARTITION");
  const limits = {
    accounts: boundedLimit(
      options.maximumAccounts,
      AWS_ORGANIZATIONS_TAXONOMY_MAX_ACCOUNTS,
    ),
    pages: boundedLimit(options.maximumPages, AWS_ORGANIZATIONS_TAXONOMY_MAX_PAGES),
    outputBytes: boundedLimit(
      options.maximumOutputBytes,
      AWS_ORGANIZATIONS_TAXONOMY_MAX_OUTPUT_BYTES,
    ),
    overallDeadlineMs: boundedLimit(
      options.overallDeadlineMs,
      AWS_ORGANIZATIONS_TAXONOMY_OVERALL_DEADLINE_MS,
    ),
    commandDeadlineMs: boundedLimit(
      options.commandDeadlineMs,
      AWS_ORGANIZATIONS_TAXONOMY_COMMAND_DEADLINE_MS,
    ),
  };
  const reader = options.reader ?? createOrganizationsReader(options.credentials);
  const signer = options.signer ?? createKmsSigner(options.signerKeyId);
  const overall = new AbortController();
  const timer = setTimeout(
    () => overall.abort(new Error("Organizations taxonomy deadline exceeded")),
    limits.overallDeadlineMs,
  );
  timer.unref?.();
  try {
    let organization: DescribeOrganizationResponse;
    try {
      organization = await withCommandDeadline(
        (signal) => reader.describeOrganization(signal),
        overall.signal,
        limits.commandDeadlineMs,
      );
    } catch (error) {
      requestFailure(error, overall.signal);
    }
    const organizationId = organization.Organization?.Id;
    const managementAccountId = organization.Organization?.MasterAccountId;
    if (
      typeof organizationId !== "string" || !ORGANIZATION_ID.test(organizationId)
      || managementAccountId !== options.managementAccountId
    ) fail("PROVIDER_RESPONSE_INVALID");

    const accounts: Array<SignedOrganizationsTaxonomyCapture["accounts"][number]> = [];
    const seenAccounts = new Set<string>();
    const seenTokens = new Set<string>();
    let token: string | undefined;
    let pageCount = 0;
    do {
      if (pageCount >= limits.pages) fail("PAGE_LIMIT_REACHED");
      let page: ListAccountsResponse;
      try {
        page = await withCommandDeadline(
          (signal) => reader.listAccounts(
            token === undefined ? { MaxResults: 20 } : { MaxResults: 20, NextToken: token },
            signal,
          ),
          overall.signal,
          limits.commandDeadlineMs,
        );
      } catch (error) {
        requestFailure(error, overall.signal);
      }
      pageCount += 1;
      if (!Array.isArray(page.Accounts)) fail("PROVIDER_RESPONSE_INVALID");
      for (const account of page.Accounts) {
        if (
          typeof account.Id !== "string" || !ACCOUNT_ID.test(account.Id)
          || typeof account.State !== "string"
          || !ACCOUNT_STATES.has(account.State as OrganizationsTaxonomyAccountState)
          || seenAccounts.has(account.Id)
        ) fail("PROVIDER_RESPONSE_INVALID");
        if (accounts.length >= limits.accounts) fail("ACCOUNT_LIMIT_REACHED");
        seenAccounts.add(account.Id);
        accounts.push({
          accountId: account.Id,
          state: account.State as OrganizationsTaxonomyAccountState,
        });
      }
      const next = page.NextToken;
      if (next === undefined) {
        token = undefined;
      } else {
        if (!TOKEN.test(next)) fail("PROVIDER_RESPONSE_INVALID");
        if (seenTokens.has(next)) fail("PAGINATION_REPLAYED");
        seenTokens.add(next);
        token = next;
      }
    } while (token !== undefined);

    accounts.sort((left, right) => left.accountId.localeCompare(right.accountId));
    if (
      accounts.length === 0
      || !accounts.some((account) =>
        account.accountId === options.managementAccountId && account.state === "ACTIVE")
    ) fail("PROVIDER_RESPONSE_INVALID");
    const unsigned: UnsignedOrganizationsTaxonomyCapture = {
      schemaVersion: "sutra.aws-organizations-taxonomy.signed.v1",
      scope: { ...options.scope },
      partition: "aws",
      managementAccountId: options.managementAccountId,
      awsOrganizationId: organizationId,
      collectedAtIso: now.toISOString(),
      pagesExhausted: true,
      operations: AWS_ORGANIZATIONS_TAXONOMY_OPERATIONS,
      accounts,
    };
    const content = new TextEncoder().encode(canonicalJson(unsigned));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", content));
    let signed: Awaited<ReturnType<OrganizationsTaxonomySigner["signSha256Digest"]>>;
    try {
      signed = await withCommandDeadline(
        (signal) => signer.signSha256Digest(digest, signal),
        overall.signal,
        limits.commandDeadlineMs,
      );
    } catch (error) {
      if (overall.signal.aborted || named(error) === "CommandTimeout") {
        fail("COLLECTION_TIMEOUT");
      }
      fail("SIGNING_FAILED");
    }
    const signature = base64Url(signed.signature);
    if (signed.keyId !== options.signerKeyId || !SIGNATURE.test(signature)) {
      fail("SIGNING_FAILED");
    }
    const capture: SignedOrganizationsTaxonomyCapture = {
      ...unsigned,
      contentSha256: hex(digest),
      signature: {
        algorithm: AWS_ORGANIZATIONS_TAXONOMY_SIGNING_ALGORITHM,
        signerKeyId: options.signerKeyId,
        value: signature,
      },
    };
    if (Buffer.byteLength(JSON.stringify(capture), "utf8") > limits.outputBytes) {
      fail("OUTPUT_SIZE_LIMIT_REACHED");
    }
    return capture;
  } finally {
    clearTimeout(timer);
  }
}

/** Canonical bytes are shared with the app-side signature verifier. */
export function canonicalOrganizationsTaxonomyJson(value: unknown): string {
  return canonicalJson(value);
}

function createOrganizationsReader(
  credentials: AwsTemporaryCredentials,
): OrganizationsTaxonomyReader {
  const client = new OrganizationsClient({
    ...workloadIdentityAwsClientConfig(AWS_ORGANIZATIONS_TAXONOMY_REGION, 3),
    endpoint: AWS_ORGANIZATIONS_TAXONOMY_ENDPOINT,
    credentials,
  });
  return {
    describeOrganization: (abortSignal) => client.send(
      new DescribeOrganizationCommand({}),
      abortSignal === undefined ? undefined : { abortSignal },
    ),
    listAccounts: (input, abortSignal) => client.send(
      new ListAccountsCommand(input),
      abortSignal === undefined ? undefined : { abortSignal },
    ),
  };
}

function createKmsSigner(signerKeyId: string): OrganizationsTaxonomySigner {
  const region = /^arn:aws:kms:([a-z0-9-]+):/u.exec(signerKeyId)?.[1];
  if (region === undefined) fail("INVALID_INPUT");
  const client = new KMSClient(workloadIdentityAwsClientConfig(region, 3));
  return {
    signSha256Digest: async (digest, abortSignal) => {
      const result = await client.send(new SignCommand({
        KeyId: signerKeyId,
        Message: digest,
        MessageType: "DIGEST",
        SigningAlgorithm: "RSASSA_PSS_SHA_256",
      }), abortSignal === undefined ? undefined : { abortSignal });
      if (typeof result.KeyId !== "string" || result.Signature === undefined) {
        fail("SIGNING_FAILED");
      }
      return { keyId: result.KeyId, signature: result.Signature };
    },
  };
}

function assertInput(options: OrganizationsTaxonomyCollectionOptions, now: Date): void {
  if (
    !Number.isFinite(now.getTime())
    || !IDENTIFIER.test(options.scope.organizationId)
    || !IDENTIFIER.test(options.scope.customerId)
    || !CONNECTION_ID.test(options.scope.connectionId)
    || !ACCOUNT_ID.test(options.managementAccountId)
    || !KMS_KEY_ARN.test(options.signerKeyId)
  ) fail("INVALID_INPUT");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

async function withCommandDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  overallSignal: AbortSignal,
  deadlineMs: number,
): Promise<T> {
  if (overallSignal.aborted) throw Object.assign(new Error("Stopped"), { name: "OverallTimeout" });
  const command = new AbortController();
  let timedOut = false;
  const forward = (): void => command.abort(overallSignal.reason);
  overallSignal.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    command.abort(new Error("Organizations taxonomy command deadline exceeded"));
  }, deadlineMs);
  timer.unref?.();
  try {
    return await run(command.signal);
  } catch (error) {
    if (timedOut) throw Object.assign(new Error("Stopped"), { name: "CommandTimeout" });
    if (overallSignal.aborted) {
      throw Object.assign(new Error("Stopped"), { name: "OverallTimeout" });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    overallSignal.removeEventListener("abort", forward);
  }
}

function requestFailure(error: unknown, signal: AbortSignal): never {
  if (
    signal.aborted
    || named(error) === "CommandTimeout"
    || named(error) === "OverallTimeout"
  ) fail("COLLECTION_TIMEOUT");
  fail("PROVIDER_REQUEST_FAILED");
}

function named(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { readonly name: unknown }).name)
    : "";
}

function boundedLimit(value: number | undefined, maximum: number): number {
  const result = value ?? maximum;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    fail("INVALID_INPUT");
  }
  return result;
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function fail(code: OrganizationsTaxonomyCollectionError["code"]): never {
  throw new OrganizationsTaxonomyCollectionError(code);
}
