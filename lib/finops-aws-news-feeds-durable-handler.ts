/** Registry-independent durable handler contract for the AWS News Feeds job. */
import {
  AWS_NEWS_FEEDS_JOB_KIND,
  awsNewsFeedsJobIdempotencyKey,
  runAwsNewsFeedsCollectionJob,
  type AwsNewsFeedsCollectionJob,
  type AwsNewsFeedsCollectionJobDependencies,
  type AwsNewsFeedsCollectionJobResult,
} from "./finops-aws-news-feeds-job.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const LEASE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RESULT_KEYS = ["becameActive", "captureId", "generationId", "state"];

export const AWS_NEWS_FEEDS_DURABLE_HANDLER_SCHEMA =
  "sutra.aws-news-feeds-durable-handler.v1" as const;

export interface AwsNewsFeedsDurableEnvelope {
  readonly schemaVersion: typeof AWS_NEWS_FEEDS_DURABLE_HANDLER_SCHEMA;
  readonly kind: typeof AWS_NEWS_FEEDS_JOB_KIND;
  readonly idempotencyKey: string;
  readonly job: AwsNewsFeedsCollectionJob;
}

export type AwsNewsFeedsReplayClaim =
  | { readonly state: "ACQUIRED"; readonly leaseToken: string }
  | {
    readonly state: "COMPLETED";
    readonly result: AwsNewsFeedsCollectionJobResult;
    readonly resultSha256: string;
  }
  | { readonly state: "IN_PROGRESS" };

export interface AwsNewsFeedsReplayStore {
  claim(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseDurationMs: number;
  }): Promise<AwsNewsFeedsReplayClaim>;
  complete(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseToken: string;
    readonly result: AwsNewsFeedsCollectionJobResult;
    readonly resultSha256: string;
  }): Promise<void>;
  fail(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseToken: string;
    readonly failureCode: "AWS_NEWS_FEEDS_COLLECTION_FAILED";
  }): Promise<void>;
}

export interface AwsNewsFeedsDurableHandlerDependencies
  extends AwsNewsFeedsCollectionJobDependencies {
  readonly replayStore: AwsNewsFeedsReplayStore;
}

export type AwsNewsFeedsDurableHandlerResult =
  | {
    readonly disposition: "EXECUTED" | "REPLAYED";
    readonly result: AwsNewsFeedsCollectionJobResult;
  }
  | { readonly disposition: "IN_PROGRESS"; readonly result: null };

export class AwsNewsFeedsDurableHandlerError extends Error {
  public readonly code: "INVALID_ENVELOPE" | "COLLECTION_FAILED";

  public constructor(code: AwsNewsFeedsDurableHandlerError["code"]) {
    super(code === "INVALID_ENVELOPE"
      ? "AWS News Feeds durable envelope was rejected"
      : "AWS News Feeds collection failed");
    this.name = "AwsNewsFeedsDurableHandlerError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

async function sha(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

function validResult(value: unknown): value is AwsNewsFeedsCollectionJobResult {
  return isRecord(value)
    && hasExactKeys(value, RESULT_KEYS)
    && typeof value.generationId === "string"
    && /^newsg_[a-f0-9]{64}$/u.test(value.generationId)
    && typeof value.captureId === "string"
    && /^news_[a-f0-9]{64}$/u.test(value.captureId)
    && typeof value.state === "string"
    && ["READY", "PARTIAL", "STALE", "FAILED"].includes(value.state)
    && typeof value.becameActive === "boolean";
}

function validClaim(value: unknown): value is AwsNewsFeedsReplayClaim {
  if (!isRecord(value) || typeof value.state !== "string") return false;
  if (value.state === "IN_PROGRESS") return hasExactKeys(value, ["state"]);
  if (value.state === "ACQUIRED") {
    return hasExactKeys(value, ["leaseToken", "state"])
      && typeof value.leaseToken === "string"
      && LEASE_TOKEN.test(value.leaseToken);
  }
  return value.state === "COMPLETED"
    && hasExactKeys(value, ["result", "resultSha256", "state"])
    && validResult(value.result)
    && typeof value.resultSha256 === "string"
    && SHA256.test(value.resultSha256);
}

function invalidEnvelope(): never {
  throw new AwsNewsFeedsDurableHandlerError("INVALID_ENVELOPE");
}

function collectionFailed(): never {
  throw new AwsNewsFeedsDurableHandlerError("COLLECTION_FAILED");
}

export async function handleAwsNewsFeedsDurableJob(
  envelope: AwsNewsFeedsDurableEnvelope,
  dependencies: AwsNewsFeedsDurableHandlerDependencies,
): Promise<AwsNewsFeedsDurableHandlerResult> {
  const envelopeRecord: unknown = envelope;
  if (!isRecord(envelopeRecord)
    || !hasExactKeys(envelopeRecord, ["idempotencyKey", "job", "kind", "schemaVersion"])
    || envelopeRecord.schemaVersion !== AWS_NEWS_FEEDS_DURABLE_HANDLER_SCHEMA
    || envelopeRecord.kind !== AWS_NEWS_FEEDS_JOB_KIND
    || typeof envelopeRecord.idempotencyKey !== "string"
    || !isRecord(envelopeRecord.job)
    || !hasExactKeys(envelopeRecord.job, ["connectionId", "customerId", "id", "orgId", "payload"])) {
    invalidEnvelope();
  }

  const job = envelopeRecord.job;
  if (typeof job.id !== "string" || !IDENTIFIER.test(job.id)
    || typeof job.orgId !== "string" || !IDENTIFIER.test(job.orgId)
    || typeof job.customerId !== "string" || !IDENTIFIER.test(job.customerId)
    || typeof job.connectionId !== "string" || !CONNECTION_ID.test(job.connectionId)
    || !isRecord(job.payload)
    || !hasExactKeys(job.payload, ["scheduledWindow"])
    || typeof job.payload.scheduledWindow !== "string") {
    invalidEnvelope();
  }

  const typedJob = job as unknown as AwsNewsFeedsCollectionJob;
  const scope = {
    organizationId: job.orgId,
    customerId: job.customerId,
    connectionId: job.connectionId,
  };
  let expected: string;
  try {
    expected = awsNewsFeedsJobIdempotencyKey(scope, job.payload.scheduledWindow);
  } catch {
    invalidEnvelope();
  }
  if (envelopeRecord.idempotencyKey !== expected) invalidEnvelope();

  let claim: AwsNewsFeedsReplayClaim;
  try {
    const received: unknown = await dependencies.replayStore.claim({
      key: expected,
      jobId: job.id,
      leaseDurationMs: 60_000,
    });
    if (!validClaim(received)) collectionFailed();
    claim = received;
  } catch {
    collectionFailed();
  }

  if (claim.state === "COMPLETED") {
    if (await sha(claim.result) !== claim.resultSha256) collectionFailed();
    return { disposition: "REPLAYED", result: claim.result };
  }
  if (claim.state === "IN_PROGRESS") {
    return { disposition: "IN_PROGRESS", result: null };
  }

  try {
    const result = await runAwsNewsFeedsCollectionJob(typedJob, dependencies);
    if (!validResult(result)) collectionFailed();
    await dependencies.replayStore.complete({
      key: expected,
      jobId: job.id,
      leaseToken: claim.leaseToken,
      result,
      resultSha256: await sha(result),
    });
    return { disposition: "EXECUTED", result };
  } catch {
    try {
      await dependencies.replayStore.fail({
        key: expected,
        jobId: job.id,
        leaseToken: claim.leaseToken,
        failureCode: "AWS_NEWS_FEEDS_COLLECTION_FAILED",
      });
    } catch {
      // The primary sanitized failure must not be replaced by adapter detail.
    }
    collectionFailed();
  }
}
