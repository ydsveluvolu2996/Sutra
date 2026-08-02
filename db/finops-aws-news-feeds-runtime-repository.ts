/** Durable, tenant-scoped execution receipts for the ADV-07 public-feed worker. */
import type {
  AwsNewsFeedsReplayClaim,
  AwsNewsFeedsReplayStore,
} from "../lib/finops-aws-news-feeds-durable-handler.ts";
import type { AwsNewsFeedsCollectionJobResult } from "../lib/finops-aws-news-feeds-job.ts";
import type { AwsNewsFeedsActiveConnection } from "../lib/finops-aws-news-feeds-runtime-binding.ts";
import type { AwsNewsTenantBoundary, AwsNewsTenantService } from "../lib/finops-aws-news-feeds.ts";
import type { AwsNewsFeedsPersistenceScope } from "./finops-aws-news-feeds-repository.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const JOB_ID = /^job_[a-f0-9]{32}$/u;
const LEASE_TOKEN = /^lease_[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T(?:00|06|12|18):00:00\.000Z$/u;
const GENERATION_ID = /^newsg_[a-f0-9]{64}$/u;
const CAPTURE_ID = /^news_[a-f0-9]{64}$/u;
const MAX_ACTIVE_CONNECTIONS = 5_000;
const MAX_KEY_BYTES = 512;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const SERVICE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/u;

interface ReceiptRow {
  idempotency_key: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  scheduled_window: string;
  state: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  job_id: string;
  lease_token: string | null;
  lease_expires_at: number | string | null;
  result_json: string | null;
  result_sha256: string | null;
  failure_code: "AWS_NEWS_FEEDS_COLLECTION_FAILED" | null;
  completed_at: number | string | null;
  created_at: number | string;
  updated_at: number | string;
}

interface LiveScopeRow {
  org_id: string;
  customer_id: string;
  connection_id: string;
}

interface ResourceServiceRow {
  resource_type: string;
  observed_at: number | string;
}

const AWS_SERVICE_NAMES: Readonly<Record<string, readonly [string, ...string[]]>> = Object.freeze({
  apigateway: ["Amazon API Gateway", "API Gateway"],
  athena: ["Amazon Athena", "Athena"],
  autoscaling: ["Amazon EC2 Auto Scaling", "Auto Scaling"],
  backup: ["AWS Backup", "Backup"],
  bedrock: ["Amazon Bedrock", "Bedrock"],
  cloudfront: ["Amazon CloudFront", "CloudFront"],
  cloudwatch: ["Amazon CloudWatch", "CloudWatch"],
  config: ["AWS Config", "Config"],
  connect: ["Amazon Connect", "Connect"],
  dynamodb: ["Amazon DynamoDB", "DynamoDB"],
  ec2: ["Amazon EC2", "EC2"],
  ecs: ["Amazon ECS", "ECS"],
  efs: ["Amazon EFS", "EFS"],
  eks: ["Amazon EKS", "EKS"],
  elasticache: ["Amazon ElastiCache", "ElastiCache"],
  elb: ["Elastic Load Balancing", "ELB"],
  elbv2: ["Elastic Load Balancing", "ELB"],
  emr: ["Amazon EMR", "EMR"],
  es: ["Amazon OpenSearch Service", "OpenSearch"],
  eventbridge: ["Amazon EventBridge", "EventBridge"],
  fsx: ["Amazon FSx", "FSx"],
  glue: ["AWS Glue", "Glue"],
  iam: ["AWS Identity and Access Management", "IAM"],
  kinesis: ["Amazon Kinesis", "Kinesis"],
  kms: ["AWS Key Management Service", "KMS"],
  lambda: ["AWS Lambda", "Lambda"],
  opensearch: ["Amazon OpenSearch Service", "OpenSearch"],
  organizations: ["AWS Organizations", "Organizations"],
  rds: ["Amazon RDS", "RDS"],
  redshift: ["Amazon Redshift", "Redshift"],
  route53: ["Amazon Route 53", "Route 53"],
  s3: ["Amazon S3", "S3"],
  sagemaker: ["Amazon SageMaker", "SageMaker"],
  secretsmanager: ["AWS Secrets Manager", "Secrets Manager"],
  sns: ["Amazon SNS", "SNS"],
  sqs: ["Amazon SQS", "SQS"],
  workspaces: ["Amazon WorkSpaces", "WorkSpaces"],
});
const AWS_RESOURCE_SERVICE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  apigatewayv2: "apigateway",
  elasticfilesystem: "efs",
  elasticloadbalancing: "elb",
  elasticloadbalancingv2: "elb",
  elasticmapreduce: "emr",
  events: "eventbridge",
  logs: "cloudwatch",
  s3objectlambda: "s3",
});

export class AwsNewsFeedsRuntimeRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "LEASE_CONFLICT"
    | "STORED_STATE_INVALID"
    | "RUNTIME_SCHEMA_UNAVAILABLE";

  public constructor(code: AwsNewsFeedsRuntimeRepositoryError["code"]) {
    super("AWS News Feeds runtime persistence operation rejected");
    this.name = "AwsNewsFeedsRuntimeRepositoryError";
    this.code = code;
  }
}

function reject(
  code: AwsNewsFeedsRuntimeRepositoryError["code"] = "INVALID_INPUT",
): never {
  throw new AwsNewsFeedsRuntimeRepositoryError(code);
}

function integer(value: number | string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) reject("STORED_STATE_INVALID");
  return parsed;
}

function isResult(value: unknown): value is AwsNewsFeedsCollectionJobResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return JSON.stringify(Object.keys(record).sort())
      === JSON.stringify(["becameActive", "captureId", "generationId", "state"])
    && typeof record.generationId === "string" && GENERATION_ID.test(record.generationId)
    && typeof record.captureId === "string" && CAPTURE_ID.test(record.captureId)
    && typeof record.state === "string"
    && ["READY", "PARTIAL", "STALE", "FAILED"].includes(record.state)
    && typeof record.becameActive === "boolean";
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function validateCommon(input: { readonly key: string; readonly jobId: string }): void {
  if (typeof input.key !== "string" || input.key.length < 1
    || new TextEncoder().encode(input.key).byteLength > MAX_KEY_BYTES
    || input.key.includes("\0") || !JOB_ID.test(input.jobId)) reject();
}

function validateTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) reject();
}

function assertScope(scope: AwsNewsFeedsPersistenceScope): void {
  if (!IDENTIFIER.test(scope.organizationId) || !IDENTIFIER.test(scope.customerId)
    || !CONNECTION_ID.test(scope.connectionId)) reject();
}

function serviceToken(resourceType: string): string | null {
  const normalized = resourceType.trim().toLowerCase();
  const candidate = normalized.startsWith("aws::")
    ? normalized.split("::")[1] ?? ""
    : normalized.startsWith("aws_")
      ? normalized.split("_")[1] ?? ""
      : normalized.split(/[_:/.-]/u).find((part) => part.length >= 2) ?? "";
  const normalizedId = candidate.replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64);
  const serviceId = AWS_RESOURCE_SERVICE_ALIASES[normalizedId] ?? normalizedId;
  return SERVICE_ID.test(serviceId) ? serviceId : null;
}

function aliasesFor(serviceId: string): readonly string[] {
  const known = AWS_SERVICE_NAMES[serviceId];
  return [...new Set(known === undefined
    ? [serviceId, `AWS ${serviceId.toUpperCase()}`]
    : [...known, serviceId])].sort((left, right) => left.localeCompare(right, "en-US"));
}

function resultJson(result: AwsNewsFeedsCollectionJobResult): string {
  if (!isResult(result)) reject();
  return JSON.stringify(result);
}

function verifyReceiptShape(row: ReceiptRow): void {
  const createdAt = integer(row.created_at);
  const updatedAt = integer(row.updated_at);
  if (!JOB_ID.test(row.job_id) || !WINDOW.test(row.scheduled_window)
    || updatedAt < createdAt || !["IN_PROGRESS", "COMPLETED", "FAILED"].includes(row.state)) {
    reject("STORED_STATE_INVALID");
  }
  if (row.state === "IN_PROGRESS") {
    if (row.lease_token === null || !LEASE_TOKEN.test(row.lease_token)
      || row.lease_expires_at === null || integer(row.lease_expires_at) < updatedAt
      || row.result_json !== null || row.result_sha256 !== null
      || row.failure_code !== null || row.completed_at !== null) reject("STORED_STATE_INVALID");
  } else if (row.state === "COMPLETED") {
    if (row.lease_token !== null || row.lease_expires_at !== null
      || row.result_json === null || row.result_sha256 === null
      || !SHA256.test(row.result_sha256) || row.failure_code !== null
      || row.completed_at === null || integer(row.completed_at) < createdAt) {
      reject("STORED_STATE_INVALID");
    }
  } else if (row.lease_token !== null || row.lease_expires_at !== null
    || row.result_json !== null || row.result_sha256 !== null
    || row.failure_code !== "AWS_NEWS_FEEDS_COLLECTION_FAILED"
    || row.completed_at === null || integer(row.completed_at) < createdAt) {
    reject("STORED_STATE_INVALID");
  }
}

export interface AwsNewsFeedsRuntimeRepositoryOptions {
  readonly now?: () => number;
  readonly leaseToken?: () => string;
  /** Tests may bootstrap the isolated migration manually before using the repository. */
  readonly skipRuntimeSchema?: boolean;
}

export class AwsNewsFeedsRuntimeRepository implements AwsNewsFeedsReplayStore {
  private readonly database: D1Database;
  private readonly now: () => number;
  private readonly token: () => string;
  private readonly skipRuntimeSchema: boolean;

  public constructor(
    database: D1Database = getRawDb(),
    options: AwsNewsFeedsRuntimeRepositoryOptions = {},
  ) {
    this.database = database;
    this.now = options.now ?? Date.now;
    this.token = options.leaseToken
      ?? (() => `lease_${crypto.randomUUID().replaceAll("-", "")}`);
    this.skipRuntimeSchema = options.skipRuntimeSchema ?? false;
  }

  private async ready(): Promise<D1Database> {
    if (!this.skipRuntimeSchema) await ensureRuntimeSchema(this.database);
    return this.database;
  }

  private async liveScope(key: string): Promise<LiveScopeRow> {
    const database = await this.ready();
    const row = await database.prepare(
      `SELECT c.org_id, c.customer_id, c.id AS connection_id
         FROM aws_connections c
         JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
         JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
           AND cu.status IN ('active','trial')
        WHERE c.source_kind = 'aws_trust_role' AND c.status = 'active'
          AND ('aws-news-feeds:' || c.org_id || ':' || c.customer_id || ':' || c.id || ':'
            || substr(?, length(?) - 23, 24)) = ?
        LIMIT 2`,
    ).bind(key, key, key).all<LiveScopeRow>();
    const rows = row.results ?? [];
    if (rows.length !== 1) reject("SCOPE_NOT_FOUND");
    return rows[0]!;
  }

  private async requireLiveScope(scope: AwsNewsFeedsPersistenceScope): Promise<D1Database> {
    assertScope(scope);
    const database = await this.ready();
    const row = await database.prepare(
      `SELECT c.id FROM aws_connections c
       JOIN organizations o ON o.id=c.org_id AND o.status='active'
       JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id
         AND cu.status IN ('active','trial')
       WHERE c.org_id=? AND c.customer_id=? AND c.id=?
         AND c.source_kind='aws_trust_role' AND c.status='active' LIMIT 1`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).first<{ id: string }>();
    if (row === null) reject("SCOPE_NOT_FOUND");
    return database;
  }

  /** Builds a bounded server-owned relevance catalog from current resource inventory. */
  public async loadTenantBoundary(
    scope: AwsNewsFeedsPersistenceScope,
    signal: AbortSignal,
  ): Promise<AwsNewsTenantBoundary> {
    if (!(signal instanceof AbortSignal) || signal.aborted) reject();
    const database = await this.requireLiveScope(scope);
    const now = this.now();
    validateTime(now);
    const rows = await database.prepare(
      `SELECT resource_type,MAX(last_seen_at) AS observed_at
         FROM resources
        WHERE org_id=? AND customer_id=? AND connection_id=?
          AND provider_key='aws' AND lifecycle_state='active' AND deleted_at IS NULL
        GROUP BY resource_type ORDER BY resource_type ASC LIMIT 501`,
    ).bind(scope.organizationId, scope.customerId, scope.connectionId).all<ResourceServiceRow>();
    if (signal.aborted) reject();
    const received = rows.results ?? [];
    if (received.length > 500) reject();
    const grouped = new Map<string, { observedAtMs: number; resourceTypes: string[] }>();
    for (const row of received) {
      if (typeof row.resource_type !== "string" || row.resource_type.length < 1
        || row.resource_type.length > 256 || row.resource_type.includes("\0")) {
        reject("STORED_STATE_INVALID");
      }
      const serviceId = serviceToken(row.resource_type);
      if (serviceId === null) continue;
      const observedAtMs = integer(row.observed_at);
      if (observedAtMs > now) reject("STORED_STATE_INVALID");
      const current = grouped.get(serviceId) ?? { observedAtMs, resourceTypes: [] };
      current.observedAtMs = Math.max(current.observedAtMs, observedAtMs);
      current.resourceTypes.push(row.resource_type);
      grouped.set(serviceId, current);
    }
    const services: AwsNewsTenantService[] = [];
    for (const [serviceId, value] of [...grouped.entries()].sort(([left], [right]) =>
      left.localeCompare(right, "en-US"))) {
      if (signal.aborted) reject();
      const evidenceSha = await sha256(JSON.stringify({
        schemaVersion: "sutra.aws-news-inventory-service.v1",
        scope,
        serviceId,
        observedAtMs: value.observedAtMs,
        resourceTypes: [...new Set(value.resourceTypes)].sort(),
      }));
      const aliases = aliasesFor(serviceId);
      services.push(Object.freeze({
        serviceId,
        displayName: AWS_SERVICE_NAMES[serviceId]?.[0] ?? `AWS ${serviceId.toUpperCase()}`,
        aliases,
        enabled: false,
        observation: {
          basis: "RESOURCE_INVENTORY" as const,
          observedAt: new Date(value.observedAtMs).toISOString(),
          evidenceId: `inventory:${evidenceSha}`,
        },
      }));
    }
    if (signal.aborted) reject();
    const catalogCapturedAtMs = services.reduce((latest, service) =>
      Math.max(latest, Date.parse(service.observation!.observedAt)), 0) || now;
    const catalogSha = await sha256(JSON.stringify({
      schemaVersion: "sutra.aws-news-tenant-catalog.v1",
      scope,
      catalogCapturedAtMs,
      services,
    }));
    if (signal.aborted) reject();
    return Object.freeze({
      scope: {
        orgId: scope.organizationId,
        customerId: scope.customerId,
        connectionId: scope.connectionId,
      },
      binding: "SERVER_RESOLVED_CONNECTION",
      catalogId: `catalog_${catalogSha}`,
      catalogCapturedAt: new Date(catalogCapturedAtMs).toISOString(),
      services: Object.freeze(services),
    });
  }

  public async listActiveConnections(): Promise<readonly AwsNewsFeedsActiveConnection[]> {
    const database = await this.ready();
    const result = await database.prepare(
      `SELECT c.org_id, c.customer_id, c.id AS connection_id
         FROM aws_connections c
         JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
         JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
           AND cu.status IN ('active','trial')
        WHERE c.source_kind = 'aws_trust_role' AND c.status = 'active'
        ORDER BY c.org_id ASC, c.customer_id ASC, c.id ASC LIMIT ?`,
    ).bind(MAX_ACTIVE_CONNECTIONS + 1).all<LiveScopeRow>();
    const rows = result.results ?? [];
    if (rows.length > MAX_ACTIVE_CONNECTIONS) reject();
    return rows.map((row) => Object.freeze({
      organizationId: row.org_id,
      customerId: row.customer_id,
      connectionId: row.connection_id,
      sourceKind: "aws_trust_role" as const,
      status: "active" as const,
    }));
  }

  public async claim(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseDurationMs: number;
  }): Promise<AwsNewsFeedsReplayClaim> {
    validateCommon(input);
    if (!Number.isSafeInteger(input.leaseDurationMs)
      || input.leaseDurationMs < 1_000 || input.leaseDurationMs > 120_000) reject();
    const now = this.now();
    validateTime(now);
    const leaseToken = this.token();
    if (!LEASE_TOKEN.test(leaseToken)) reject();
    const scope = await this.liveScope(input.key);
    const scheduledWindow = input.key.slice(-24);
    if (!WINDOW.test(scheduledWindow)) reject();
    const database = await this.ready();
    await database.prepare(
      `INSERT INTO finops_aws_news_feed_replay_receipts (
        idempotency_key,org_id,customer_id,connection_id,scheduled_window,state,
        job_id,lease_token,lease_expires_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,'IN_PROGRESS',?,?,?,?,?) ON CONFLICT DO NOTHING`,
    ).bind(input.key, scope.org_id, scope.customer_id, scope.connection_id,
      scheduledWindow, input.jobId, leaseToken, now + input.leaseDurationMs, now, now).run();
    await database.prepare(
      `UPDATE finops_aws_news_feed_replay_receipts
          SET state='IN_PROGRESS',job_id=?,lease_token=?,lease_expires_at=?,
              result_json=NULL,result_sha256=NULL,failure_code=NULL,completed_at=NULL,updated_at=?
        WHERE idempotency_key=? AND org_id=? AND customer_id=? AND connection_id=?
          AND ((state='FAILED') OR (state='IN_PROGRESS' AND lease_expires_at<=?))`,
    ).bind(input.jobId, leaseToken, now + input.leaseDurationMs, now, input.key,
      scope.org_id, scope.customer_id, scope.connection_id, now).run();
    const row = await database.prepare(
      `SELECT * FROM finops_aws_news_feed_replay_receipts
        WHERE idempotency_key=? AND org_id=? AND customer_id=? AND connection_id=? LIMIT 1`,
    ).bind(input.key, scope.org_id, scope.customer_id, scope.connection_id).first<ReceiptRow>();
    if (row === null) reject("SCOPE_NOT_FOUND");
    if (row.idempotency_key !== input.key || row.org_id !== scope.org_id
      || row.customer_id !== scope.customer_id || row.connection_id !== scope.connection_id
      || row.scheduled_window !== scheduledWindow) reject("STORED_STATE_INVALID");
    verifyReceiptShape(row);
    if (row.state === "COMPLETED") {
      let result: unknown;
      try { result = JSON.parse(row.result_json!); } catch { reject("STORED_STATE_INVALID"); }
      if (!isResult(result) || await sha256(row.result_json!) !== row.result_sha256) {
        reject("STORED_STATE_INVALID");
      }
      return { state: "COMPLETED", result, resultSha256: row.result_sha256! };
    }
    return row.lease_token === leaseToken && row.job_id === input.jobId
      ? { state: "ACQUIRED", leaseToken }
      : { state: "IN_PROGRESS" };
  }

  public async complete(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseToken: string;
    readonly result: AwsNewsFeedsCollectionJobResult;
    readonly resultSha256: string;
  }): Promise<void> {
    validateCommon(input);
    if (!LEASE_TOKEN.test(input.leaseToken) || !SHA256.test(input.resultSha256)) reject();
    const json = resultJson(input.result);
    if (await sha256(json) !== input.resultSha256) reject();
    const now = this.now();
    validateTime(now);
    const scope = await this.liveScope(input.key);
    const database = await this.ready();
    const updated = await database.prepare(
      `UPDATE finops_aws_news_feed_replay_receipts
          SET state='COMPLETED',lease_token=NULL,lease_expires_at=NULL,result_json=?,
              result_sha256=?,failure_code=NULL,completed_at=?,updated_at=?
        WHERE idempotency_key=? AND org_id=? AND customer_id=? AND connection_id=?
          AND state='IN_PROGRESS' AND job_id=? AND lease_token=? AND lease_expires_at>?`,
    ).bind(json, input.resultSha256, now, now, input.key, scope.org_id,
      scope.customer_id, scope.connection_id, input.jobId, input.leaseToken, now).run();
    if (Number(updated.meta?.changes ?? 0) !== 1) reject("LEASE_CONFLICT");
  }

  public async fail(input: {
    readonly key: string;
    readonly jobId: string;
    readonly leaseToken: string;
    readonly failureCode: "AWS_NEWS_FEEDS_COLLECTION_FAILED";
  }): Promise<void> {
    validateCommon(input);
    if (!LEASE_TOKEN.test(input.leaseToken)
      || input.failureCode !== "AWS_NEWS_FEEDS_COLLECTION_FAILED") reject();
    const now = this.now();
    validateTime(now);
    const scope = await this.liveScope(input.key);
    const failureJson = JSON.stringify({
      schemaVersion: "sutra.aws-news-feeds-replay-failure.v1",
      key: input.key,
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      failureCode: input.failureCode,
      failedAtMs: now,
    });
    const contentSha256 = await sha256(failureJson);
    const database = await this.ready();
    const [updated] = await database.batch([
      database.prepare(
        `UPDATE finops_aws_news_feed_replay_receipts
          SET state='FAILED',lease_token=NULL,lease_expires_at=NULL,result_json=NULL,
              result_sha256=NULL,failure_code=?,completed_at=?,updated_at=?
        WHERE idempotency_key=? AND org_id=? AND customer_id=? AND connection_id=?
          AND state='IN_PROGRESS' AND job_id=? AND lease_token=? AND lease_expires_at>?`,
      ).bind(input.failureCode, now, now, input.key, scope.org_id, scope.customer_id,
        scope.connection_id, input.jobId, input.leaseToken, now),
      database.prepare(
        `INSERT INTO finops_aws_news_feed_replay_failures (
          failure_id,idempotency_key,org_id,customer_id,connection_id,job_id,
          failure_code,content_sha256,failed_at
        ) SELECT ?,idempotency_key,org_id,customer_id,connection_id,job_id,
            failure_code,?,completed_at
          FROM finops_aws_news_feed_replay_receipts
         WHERE idempotency_key=? AND org_id=? AND customer_id=? AND connection_id=?
           AND state='FAILED' AND job_id=? AND completed_at=?
        ON CONFLICT DO NOTHING`,
      ).bind(`newsf_${contentSha256}`, contentSha256, input.key, scope.org_id,
        scope.customer_id, scope.connection_id, input.jobId, now),
    ]);
    if (Number(updated.meta?.changes ?? 0) !== 1) reject("LEASE_CONFLICT");
  }
}
