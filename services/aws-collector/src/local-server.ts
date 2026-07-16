import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildFixtureSnapshot,
  finalizePilotSnapshot,
  fixtureCallerIdentityArn,
  fixtureRoleSessionName,
  type PilotCoverageEntry,
  type PilotFinding,
  type PilotRelationship,
  type PilotResource,
  type PilotSnapshot,
} from "./fixture-inventory.js";
import {
  EncryptedFileConnectionRegistry,
  RegistryConnectionNotFoundError,
  RegistryError,
  RegistryStateError,
  type LocalAwsPartition,
  type RegisteredAwsConnection,
} from "./local-registry.js";
import { createWorkloadIdentityRoleBroker, parseIamRoleArn } from "./role-broker.js";
import {
  RequestAuthenticationError,
  RequestAuthenticator,
} from "./request-auth.js";
import {
  CollectorError,
  type AwsInventoryBatch,
  type AwsInventorySink,
  type NormalizedAwsEvidence,
  type NormalizedAwsResource,
  type OnboardingTrustVerification,
  type SafeJsonObject,
  type SafeJsonValue,
} from "./types.js";

const HOST = "127.0.0.1";
const PORT = 8788;
const BODY_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 12 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const ACCOUNT_ID = /^\d{12}$/;
const EXTERNAL_ID = /^[A-Za-z0-9_+=,.@:/-]{20,128}$/;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/;
const CONNECTION_PATH = /^\/v1\/connections\/([A-Za-z0-9][A-Za-z0-9._:@+-]{0,127})$/;
const CONNECTION_ACTION_PATH =
  /^\/v1\/connections\/([A-Za-z0-9][A-Za-z0-9._:@+-]{0,127})\/(verify|sync)$/;
const FIXTURE_PRINCIPAL = "arn:aws:iam::999988887777:role/SutraLocalCollector";

export interface LocalCollectorServerOptions {
  readonly sharedSecret: string;
  readonly registryEncryptionKey: string;
  readonly registryPath: string;
  readonly mode?: "fixture" | "live";
  readonly allowLiveAws?: boolean;
  readonly principalArn?: string;
  readonly now?: () => Date;
}

interface ServerContext {
  readonly mode: "fixture" | "live";
  readonly principalArn: string;
  readonly sourceAccountId: string;
  readonly now: () => Date;
  readonly registry: EncryptedFileConnectionRegistry;
  readonly authenticator: RequestAuthenticator;
  readonly runningSyncs: Set<string>;
}

interface ScopedJob {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly jobId: string;
}

export function createLocalCollectorServer(options: LocalCollectorServerOptions): Server {
  const mode = options.mode ?? "fixture";
  if (mode !== "fixture" && mode !== "live") {
    throw new Error("SUTRA_COLLECTOR_MODE must be fixture or live");
  }
  if (mode === "live" && options.allowLiveAws !== true) {
    throw new Error(
      "Live AWS access is disabled; an explicitly authorized sandbox requires SUTRA_ALLOW_LIVE_AWS=true",
    );
  }
  const principalArn = options.principalArn ?? (mode === "fixture" ? FIXTURE_PRINCIPAL : "");
  if (principalArn.length === 0) {
    throw new Error("SUTRA_COLLECTOR_PRINCIPAL_ARN is required in live mode");
  }
  const parsedPrincipal = parseIamRoleArn(principalArn);
  const context: ServerContext = {
    mode,
    principalArn,
    sourceAccountId: parsedPrincipal.accountId,
    now: options.now ?? (() => new Date()),
    registry: new EncryptedFileConnectionRegistry({
      filePath: options.registryPath,
      encryptionKey: options.registryEncryptionKey,
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    authenticator: new RequestAuthenticator({
      sharedSecret: options.sharedSecret,
      ...(options.now === undefined ? {} : { now: () => options.now!().getTime() }),
    }),
    runningSyncs: new Set(),
  };

  const server = createServer((request, response) => {
    void dispatch(context, request, response);
  });
  server.requestTimeout = 190_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}

export async function startLocalCollectorServer(): Promise<Server> {
  const principalArn = process.env.SUTRA_COLLECTOR_PRINCIPAL_ARN?.trim();
  const server = createLocalCollectorServer({
    sharedSecret: requiredEnvironment("SUTRA_BROKER_SHARED_SECRET"),
    registryEncryptionKey: requiredEnvironment("SUTRA_REGISTRY_ENCRYPTION_KEY"),
    registryPath:
      process.env.SUTRA_REGISTRY_PATH?.trim() ||
      resolvePath(process.cwd(), ".sutra", "connections.enc.json"),
    mode: collectorMode(process.env.SUTRA_COLLECTOR_MODE),
    allowLiveAws: exactBooleanEnvironment("SUTRA_ALLOW_LIVE_AWS", false),
    ...(principalArn === undefined || principalArn.length === 0 ? {} : { principalArn }),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function dispatch(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const rawUrl = request.url ?? "";
  const path = safePath(rawUrl);
  const nonce = responseNonce(request);
  try {
    const body = await readBody(request);
    context.authenticator.verify({
      method: request.method ?? "",
      path,
      headers: request.headers,
      body,
    });
    const result = await route(context, request.method ?? "", path, body);
    sendSigned(context, response, result.status, path, nonce, result.body);
  } catch (error: unknown) {
    const safe = safeHttpError(error);
    sendSigned(context, response, safe.status, path, nonce, {
      code: safe.code,
      message: safe.message,
    });
  }
}

async function route(
  context: ServerContext,
  method: string,
  path: string,
  body: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  if (method === "GET" && path === "/v1/health") {
    if (body.length !== 0) throw invalidRequest();
    return {
      status: 200,
      body: {
        ok: true,
        mode: context.mode,
        version: "0.2.0-pilot",
        principalArn: context.principalArn,
        sourceAccountId: context.sourceAccountId,
        message:
          context.mode === "fixture"
            ? "Fixture collector ready; no AWS API calls will be made."
            : "Live read-only AWS collector ready.",
      },
    };
  }

  const connectionMatch = CONNECTION_PATH.exec(path);
  if (method === "PUT" && connectionMatch !== null) {
    const pathConnectionId = connectionMatch[1];
    if (pathConnectionId === undefined) throw invalidRequest();
    const input = parseRegistration(body, pathConnectionId);
    await context.registry.upsert(input);
    return { status: 200, body: { registered: true } };
  }

  const actionMatch = CONNECTION_ACTION_PATH.exec(path);
  if (method === "POST" && actionMatch !== null) {
    const pathConnectionId = actionMatch[1];
    const action = actionMatch[2];
    if (pathConnectionId === undefined || action === undefined) throw invalidRequest();
    const job = parseScopedJob(body, pathConnectionId);
    if (action === "verify") {
      return { status: 200, body: await verifyConnection(context, job) };
    }
    return { status: 200, body: await syncConnection(context, job) };
  }

  throw new LocalHttpError(404, "INVALID_REQUEST", "The collector endpoint does not exist");
}

async function verifyConnection(context: ServerContext, job: ScopedJob): Promise<unknown> {
  const scope = { tenantId: job.tenantId };
  if (context.mode === "fixture") {
    const connection = await activeCandidate(context.registry, job);
    const callerIdentityArn = fixtureCallerIdentityArn(connection, job.jobId);
    const verification: OnboardingTrustVerification = {
      connectionId: connection.connectionId,
      accountId: connection.expectedAccountId,
      partition: connection.partition,
      roleArn: connection.roleArn,
      callerIdentityArn,
      roleSessionName: fixtureRoleSessionName(job.jobId),
      missingExternalIdDenied: true,
      wrongExternalIdDenied: true,
    };
    await context.registry.markOnboardingVerified(scope, job.connectionId, verification);
    return verificationResponse(verification);
  }

  const connection = await requireConnection(context.registry, job);
  const broker = createWorkloadIdentityRoleBroker({
    registry: context.registry,
    region: firstRegion(connection),
  });
  const verification = await broker.verifyOnboardingTrust(scope, job.connectionId, job.jobId);
  await context.registry.markOnboardingVerified(scope, job.connectionId, verification);
  return verificationResponse(verification);
}

async function syncConnection(context: ServerContext, job: ScopedJob): Promise<PilotSnapshot> {
  const syncKey = `${job.tenantId}\u001f${job.connectionId}`;
  if (context.runningSyncs.has(syncKey)) {
    throw new LocalHttpError(409, "INVALID_REQUEST", "A sync is already running for this connection");
  }
  context.runningSyncs.add(syncKey);
  try {
    const connection = await requireConnection(context.registry, job);
    if (connection.status !== "ACTIVE") throw new RegistryStateError();
    if (context.mode === "fixture") {
      return buildFixtureSnapshot({ jobId: job.jobId, connection, now: context.now() });
    }
    return await collectLiveSnapshot(context, connection, job);
  } finally {
    context.runningSyncs.delete(syncKey);
  }
}

async function collectLiveSnapshot(
  context: ServerContext,
  connection: RegisteredAwsConnection,
  job: ScopedJob,
): Promise<PilotSnapshot> {
  const {
    AwsSdkInventoryClientFactory,
    SingleAccountAwsInventoryRunner,
    StaticInventoryRegionSelector,
  } = await import("./inventory-runner.js");
  const broker = createWorkloadIdentityRoleBroker({
    registry: context.registry,
    region: firstRegion(connection),
  });
  const session = await broker.assumeValidatedSession(
    { tenantId: job.tenantId },
    job.connectionId,
    job.jobId,
  );
  const sink = new CapturingInventorySink();
  const runner = new SingleAccountAwsInventoryRunner({
    clients: new AwsSdkInventoryClientFactory(),
    sink,
    regionSelector: new StaticInventoryRegionSelector(connection.enabledRegions),
    globalControlRegion: firstRegion(connection),
    maxConcurrency: 4,
    now: context.now,
  });
  const result = await runner.collect({
    tenantId: job.tenantId,
    connectionId: job.connectionId,
    jobId: job.jobId,
    accountId: session.accountId,
    partition: session.partition,
    roleSessionName: session.roleSessionName,
    credentials: session.credentials,
  });
  return normalizeLiveSnapshot(
    connection,
    job.jobId,
    session.roleSessionName,
    sink.resources,
    sink.evidence,
    result.coverage,
    context.now(),
  );
}

class CapturingInventorySink implements AwsInventorySink {
  public readonly resources: NormalizedAwsResource[] = [];
  public readonly evidence: NormalizedAwsEvidence[] = [];

  public async writeBatch(batch: AwsInventoryBatch): Promise<void> {
    if (this.resources.length + batch.resources.length > 10_000) {
      throw new Error("inventory resource limit reached");
    }
    if (this.evidence.length + batch.evidence.length > 5_000) {
      throw new Error("inventory evidence limit reached");
    }
    this.resources.push(...batch.resources);
    this.evidence.push(...batch.evidence);
  }
}

function normalizeLiveSnapshot(
  connection: RegisteredAwsConnection,
  jobId: string,
  roleSessionName: string,
  normalized: readonly NormalizedAwsResource[],
  evidence: readonly NormalizedAwsEvidence[],
  coverage: "COMPLETE" | "PARTIAL",
  completedAt: Date,
): PilotSnapshot {
  const keyMap = new Map<string, string>();
  const resources = normalized.map((resource) => {
    const key = boundaryResourceKey(resource);
    keyMap.set(resource.resourceKey, key);
    return liveResource(resource, key);
  });
  const relationships = liveRelationships(normalized, keyMap);
  const findings = liveFindings(resources, normalized, evidence, keyMap, completedAt.toISOString());
  const coverageEntries = liveCoverage(connection.enabledRegions, resources, coverage);
  return finalizePilotSnapshot({
    schemaVersion: "sutra.inventory.v1",
    jobId,
    connectionId: connection.connectionId,
    accountId: connection.expectedAccountId,
    partition: connection.partition,
    roleSessionName,
    collectedAt: completedAt.toISOString(),
    coverageState: coverage === "COMPLETE" ? "complete" : "partial",
    coverage: coverageEntries,
    resources,
    relationships,
    findings,
  });
}

function liveResource(resource: NormalizedAwsResource, resourceKey: string): PilotResource {
  const rawState = scalarString(resource.configuration.state) ?? scalarString(resource.configuration.status);
  const state = rawState?.toLowerCase().replace(/[^a-z0-9._:@#+=-]+/gu, "-") || "observed";
  const rawName =
    scalarString(resource.configuration.name) ??
    scalarString(resource.configuration.groupName) ??
    resource.resourceId;
  const unsigned = {
    resourceKey,
    service: resource.service,
    resourceType: resource.resourceType,
    nativeId: resource.resourceId.slice(0, 512),
    arn: resource.arn?.slice(0, 2_048) ?? null,
    name: rawName.slice(0, 512),
    region: resource.region,
    state: state.slice(0, 64),
    tags: {},
    configuration: resource.configuration,
    source: {
      api: `${resource.service}:inventory`,
      accountId: resource.accountId,
      collectedAt: resource.observedAt,
    },
  };
  return { ...unsigned, contentSha256: sha256(JSON.stringify(unsigned)) };
}

function liveRelationships(
  normalized: readonly NormalizedAwsResource[],
  keyMap: ReadonlyMap<string, string>,
): PilotRelationship[] {
  const byNativeId = new Map<string, NormalizedAwsResource[]>();
  for (const resource of normalized) {
    const list = byNativeId.get(resource.resourceId) ?? [];
    list.push(resource);
    byNativeId.set(resource.resourceId, list);
  }
  const result: PilotRelationship[] = [];
  const dedupe = new Set<string>();
  const link = (from: NormalizedAwsResource, nativeId: string, relationType: string, property: string) => {
    const candidate = (byNativeId.get(nativeId) ?? []).find(
      (item) => item.region === from.region || item.region === "global",
    );
    const fromKey = keyMap.get(from.resourceKey);
    const toKey = candidate === undefined ? undefined : keyMap.get(candidate.resourceKey);
    if (fromKey === undefined || toKey === undefined) return;
    const edgeKey = `${fromKey}\n${toKey}\n${relationType}`;
    if (dedupe.has(edgeKey)) return;
    dedupe.add(edgeKey);
    result.push({
      fromResourceKey: fromKey,
      toResourceKey: toKey,
      relationType,
      evidence: { property },
    });
  };
  for (const resource of normalized) {
    const config = resource.configuration;
    const vpcId = scalarString(config.vpcId);
    const subnetId = scalarString(config.subnetId);
    if (vpcId !== null) link(resource, vpcId, "contained_by", "vpcId");
    if (subnetId !== null) link(resource, subnetId, "runs_in", "subnetId");
    for (const securityGroupId of stringArray(config.securityGroupIds)) {
      link(resource, securityGroupId, "protected_by", "securityGroupIds");
    }
  }
  return result.slice(0, 20_000);
}

function liveFindings(
  resources: readonly PilotResource[],
  normalized: readonly NormalizedAwsResource[],
  evidence: readonly NormalizedAwsEvidence[],
  keyMap: ReadonlyMap<string, string>,
  evaluatedAt: string,
): PilotFinding[] {
  const result: PilotFinding[] = [];
  const byKey = new Map(resources.map((resource) => [resource.resourceKey, resource]));
  const add = (
    resourceKey: string | null,
    controlKey: string,
    severity: PilotFinding["severity"],
    title: string,
    summary: string,
    remediation: string,
    details: SafeJsonObject,
  ) => {
    if (result.length >= 5_000) return;
    result.push({
      fingerprint: sha256(`${controlKey}:${resourceKey ?? "account"}`).slice(0, 48),
      resourceKey,
      controlKey,
      controlVersion: "1.0.0",
      severity,
      status: "open",
      title,
      summary,
      remediation,
      evidence: details,
      evaluatedAt,
    });
  };

  for (const source of normalized) {
    const resourceKey = keyMap.get(source.resourceKey);
    if (resourceKey === undefined || !byKey.has(resourceKey)) continue;
    const config = source.configuration;
    if (source.resourceType === "aws.ec2.instance") {
      if (typeof config.publicIpAddress === "string") {
        add(resourceKey, "SUTRA.AWS.EC2.PUBLIC_IP", "medium", "EC2 instance has a public IP",
          "This instance is directly addressable from the internet.",
          "Place the workload behind an approved entry point and remove the public IP where possible.",
          { publicIpPresent: true });
      }
      if (config.metadataHttpTokens !== "required") {
        add(resourceKey, "SUTRA.AWS.EC2.IMDSV2_REQUIRED", "high", "EC2 metadata does not require IMDSv2",
          "The instance metadata configuration permits the legacy tokenless protocol.",
          "Set HttpTokens to required after validating workload compatibility.",
          { metadataHttpTokens: scalarString(config.metadataHttpTokens) ?? "unknown" });
      }
    }
    if (source.resourceType === "aws.rds.db-instance") {
      if (config.storageEncrypted === false) {
        add(resourceKey, "SUTRA.AWS.RDS.STORAGE_ENCRYPTED", "high", "RDS storage is not encrypted",
          "StorageEncrypted is false for this database instance.",
          "Restore the database from an encrypted snapshot using an approved KMS key.",
          { storageEncrypted: false });
      }
      if (config.publiclyAccessible === true) {
        add(resourceKey, "SUTRA.AWS.RDS.PUBLIC_ACCESS", "critical", "RDS database is publicly accessible",
          "PubliclyAccessible is enabled for this database instance.",
          "Move the database to private subnets and restrict access to application security groups.",
          { publiclyAccessible: true });
      }
    }
    if (source.resourceType === "aws.ec2.security-group" && hasPublicSsh(config.ingress)) {
      add(resourceKey, "SUTRA.AWS.EC2.SSH_PUBLIC", "high", "SSH is reachable from the internet",
        "The security group permits TCP/22 from a public CIDR.",
        "Restrict SSH to managed administration paths or use Systems Manager Session Manager.",
        { port: 22, publicCidr: true });
    }
  }

  for (const item of evidence) {
    const resourceKey = evidenceResourceKey(item, normalized, keyMap);
    if (item.evidenceType === "S3_PUBLIC_ACCESS_BLOCK" && item.status !== "CONFIGURED") {
      add(resourceKey, "SUTRA.AWS.S3.PUBLIC_ACCESS_BLOCK", "high", "S3 Public Access Block is not fully configured",
        "The bucket is missing one or more public-access guardrails.",
        "Enable all four S3 Public Access Block settings and review bucket policies and ACLs.", item.data);
    }
    if (item.evidenceType === "CLOUDTRAIL_LOGGING_STATUS" && item.status !== "ENABLED") {
      add(resourceKey, "SUTRA.AWS.CLOUDTRAIL.LOGGING", "critical", "CloudTrail logging is not active",
        "The selected trail is not currently delivering management events.",
        "Start logging and monitor delivery and digest status.", item.data);
    }
    if (item.evidenceType === "GUARDDUTY_ENABLEMENT" && item.status !== "ENABLED") {
      add(resourceKey, "SUTRA.AWS.GUARDDUTY.ENABLED", "high", "GuardDuty is not enabled",
        "No enabled detector was observed in this Region.",
        "Enable GuardDuty through AWS Organizations for governed Regions.", item.data);
    }
    if (item.evidenceType === "SECURITY_HUB_ENABLEMENT" && item.status !== "ENABLED") {
      add(resourceKey, "SUTRA.AWS.SECURITYHUB.ENABLED", "medium", "Security Hub is not enabled",
        "AWS-native findings are not being aggregated in this Region.",
        "Enable Security Hub and the standards required by the customer baseline.", item.data);
    }
    if (item.evidenceType === "IAM_ACCOUNT_PASSWORD_POLICY" && item.status !== "CONFIGURED") {
      add(resourceKey, "SUTRA.AWS.IAM.PASSWORD_POLICY", "medium", "IAM password policy is not configured",
        "No account password policy was returned.",
        "Prefer federation and configure a strong policy for any remaining IAM users.", item.data);
    }
  }
  return result;
}

function liveCoverage(
  regions: readonly string[],
  resources: readonly PilotResource[],
  state: "COMPLETE" | "PARTIAL",
): PilotCoverageEntry[] {
  const status = state === "COMPLETE" ? "succeeded" as const : "partial" as const;
  const entries: PilotCoverageEntry[] = [];
  for (const [collectorKey, region] of [
    ["iam.account", "global"],
    ["iam.password-policy", "global"],
    ["s3.buckets", "global"],
  ] as const) {
    entries.push(coverageFor(collectorKey, region, resources, status));
  }
  for (const region of regions) {
    for (const collectorKey of [
      "ec2.instances", "ec2.vpcs", "ec2.subnets", "ec2.security-groups",
      "rds.db-instances", "cloudtrail.trails", "guardduty.detectors", "securityhub.hub",
    ]) {
      entries.push(coverageFor(collectorKey, region, resources, status));
    }
  }
  return entries;
}

function coverageFor(
  collectorKey: string,
  region: string,
  resources: readonly PilotResource[],
  status: "succeeded" | "partial",
): PilotCoverageEntry {
  const resourceType = collectorResourceType(collectorKey);
  return {
    collectorKey,
    region,
    status,
    itemsObserved: resources.filter(
      (resource) => resource.resourceType === resourceType && (region === "global" || resource.region === region),
    ).length,
    pagesObserved: 1,
    ...(status === "partial"
      ? { errorCode: "COLLECTION_PARTIAL", message: "One or more read-only API calls did not complete." }
      : {}),
  };
}

function collectorResourceType(collectorKey: string): string {
  const types: Readonly<Record<string, string>> = {
    "iam.account": "aws.iam.account",
    "iam.password-policy": "aws.iam.account",
    "s3.buckets": "aws.s3.bucket",
    "ec2.instances": "aws.ec2.instance",
    "ec2.vpcs": "aws.ec2.vpc",
    "ec2.subnets": "aws.ec2.subnet",
    "ec2.security-groups": "aws.ec2.security-group",
    "rds.db-instances": "aws.rds.db-instance",
    "cloudtrail.trails": "aws.cloudtrail.trail",
    "guardduty.detectors": "aws.guardduty.detector",
    "securityhub.hub": "aws.securityhub.hub",
  };
  return types[collectorKey] ?? `unknown.${collectorKey}`;
}

function parseRegistration(body: string, pathConnectionId: string) {
  const record = exactJson(body, [
    "tenantId", "connectionId", "accountId", "partition", "roleArn", "externalId", "enabledRegions",
  ]);
  if (
    typeof record.tenantId !== "string" || !IDENTIFIER.test(record.tenantId) ||
    typeof record.connectionId !== "string" || record.connectionId !== pathConnectionId ||
    !IDENTIFIER.test(record.connectionId) ||
    typeof record.accountId !== "string" || !ACCOUNT_ID.test(record.accountId) ||
    (record.partition !== "aws" && record.partition !== "aws-us-gov" && record.partition !== "aws-cn") ||
    typeof record.roleArn !== "string" ||
    typeof record.externalId !== "string" || !EXTERNAL_ID.test(record.externalId) ||
    !Array.isArray(record.enabledRegions) || record.enabledRegions.length === 0 || record.enabledRegions.length > 32 ||
    record.enabledRegions.some((region) => typeof region !== "string" || !REGION.test(region)) ||
    new Set(record.enabledRegions).size !== record.enabledRegions.length
  ) {
    throw invalidRequest();
  }
  let role;
  try {
    role = parseIamRoleArn(record.roleArn);
  } catch {
    throw invalidRequest();
  }
  if (role.accountId !== record.accountId || role.partition !== record.partition) throw invalidRequest();
  return {
    tenantId: record.tenantId,
    connectionId: record.connectionId,
    expectedAccountId: record.accountId,
    partition: record.partition as LocalAwsPartition,
    roleArn: record.roleArn,
    externalId: record.externalId,
    enabledRegions: record.enabledRegions as string[],
    sessionNamePrefix: "sutra-",
  };
}

function parseScopedJob(body: string, pathConnectionId: string): ScopedJob {
  const record = exactJson(body, ["tenantId", "connectionId", "jobId"]);
  if (
    typeof record.tenantId !== "string" || !IDENTIFIER.test(record.tenantId) ||
    typeof record.connectionId !== "string" || record.connectionId !== pathConnectionId || !IDENTIFIER.test(record.connectionId) ||
    typeof record.jobId !== "string" || !IDENTIFIER.test(record.jobId)
  ) {
    throw invalidRequest();
  }
  return { tenantId: record.tenantId, connectionId: record.connectionId, jobId: record.jobId };
}

async function activeCandidate(
  registry: EncryptedFileConnectionRegistry,
  job: ScopedJob,
): Promise<RegisteredAwsConnection> {
  const connection = await requireConnection(registry, job);
  if (connection.status !== "PENDING" && connection.status !== "DEGRADED") {
    throw new RegistryStateError();
  }
  return connection;
}

async function requireConnection(
  registry: EncryptedFileConnectionRegistry,
  job: ScopedJob,
): Promise<RegisteredAwsConnection> {
  const connection = await registry.getRegistered({ tenantId: job.tenantId }, job.connectionId);
  if (connection === null) throw new RegistryConnectionNotFoundError();
  return connection;
}

function verificationResponse(verification: OnboardingTrustVerification): unknown {
  return {
    verified: true,
    accountId: verification.accountId,
    callerIdentityArn: verification.callerIdentityArn,
    missingExternalIdDenied: true,
    wrongExternalIdDenied: true,
  };
}

function exactJson(body: string, keys: readonly string[]): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw invalidRequest();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidRequest();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw invalidRequest();
  return record;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const declared = request.headers["content-length"];
  if (typeof declared === "string") {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > BODY_LIMIT) {
      throw new LocalHttpError(413, "INVALID_REQUEST", "The collector request body is too large");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > BODY_LIMIT) {
      throw new LocalHttpError(413, "INVALID_REQUEST", "The collector request body is too large");
    }
    chunks.push(bytes);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (body.length > 0 && !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers["content-type"] ?? "")) {
    throw invalidRequest();
  }
  return body;
}

function sendSigned(
  context: ServerContext,
  response: ServerResponse,
  status: number,
  path: string,
  nonce: string,
  payload: unknown,
): void {
  let body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > RESPONSE_LIMIT) {
    status = 502;
    body = JSON.stringify({ code: "COLLECTION_FAILED", message: "The normalized inventory exceeded the pilot response limit" });
  }
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-length", Buffer.byteLength(body, "utf8"));
  response.setHeader(
    "x-sutra-response-signature",
    context.authenticator.responseSignature(status, path, nonce, body),
  );
  response.end(body);
}

class LocalHttpError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "LocalHttpError";
    this.status = status;
    this.code = code;
  }
}

function safeHttpError(error: unknown): LocalHttpError {
  if (error instanceof LocalHttpError) return error;
  if (error instanceof RequestAuthenticationError) {
    return new LocalHttpError(401, "INVALID_REQUEST", "Collector request authentication failed");
  }
  if (error instanceof RegistryConnectionNotFoundError) {
    return new LocalHttpError(404, "CONNECTION_NOT_FOUND", "The scoped connection was not found");
  }
  if (error instanceof RegistryStateError) {
    return new LocalHttpError(409, "INVALID_REQUEST", "The connection state does not allow this operation");
  }
  if (error instanceof RegistryError) {
    return new LocalHttpError(500, "COLLECTION_FAILED", "The encrypted connection registry could not complete the operation");
  }
  if (error instanceof CollectorError) {
    const mapped = new Map<string, string>([
      ["ASSUME_ROLE_FAILED", "ASSUME_ROLE_FAILED"],
      ["CALLER_IDENTITY_MISMATCH", "CALLER_IDENTITY_MISMATCH"],
      ["NEGATIVE_PROBE_INCONCLUSIVE", "NEGATIVE_PROBE_INCONCLUSIVE"],
      ["TRUST_POLICY_UNSAFE", "TRUST_POLICY_UNSAFE"],
      ["CONNECTION_NOT_FOUND", "CONNECTION_NOT_FOUND"],
    ]).get(error.code);
    return new LocalHttpError(
      error.code === "CONNECTION_NOT_FOUND" ? 404 : 400,
      mapped ?? "COLLECTION_FAILED",
      collectorMessage(mapped),
    );
  }
  const name = errorName(error);
  if (/throttl|requestlimit|toomanyrequest/iu.test(name)) {
    return new LocalHttpError(429, "THROTTLED", "AWS throttled the read-only inventory request");
  }
  if (/accessdenied|unauthorized|notauthorized/iu.test(name)) {
    return new LocalHttpError(403, "PERMISSION_DENIED", "The customer role is missing a required read-only permission");
  }
  return new LocalHttpError(502, "COLLECTION_FAILED", "The AWS inventory collection did not complete");
}

function collectorMessage(code: string | undefined): string {
  const messages: Record<string, string> = {
    ASSUME_ROLE_FAILED: "AWS rejected the customer role session",
    CALLER_IDENTITY_MISMATCH: "The assumed identity did not match the registered role and account",
    NEGATIVE_PROBE_INCONCLUSIVE: "The ExternalId trust-policy probes were inconclusive",
    TRUST_POLICY_UNSAFE: "The role trust policy did not require the registered ExternalId",
    CONNECTION_NOT_FOUND: "The scoped connection was not found",
  };
  return code === undefined ? "The AWS inventory collection did not complete" : messages[code] ?? "The AWS inventory collection did not complete";
}

function invalidRequest(): LocalHttpError {
  return new LocalHttpError(400, "INVALID_REQUEST", "The collector request is invalid");
}

function safePath(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, "http://127.0.0.1");
    if (parsed.search.length > 0 || parsed.hash.length > 0 || parsed.pathname.includes("%")) return "/invalid";
    return parsed.pathname;
  } catch {
    return "/invalid";
  }
}

function responseNonce(request: IncomingMessage): string {
  const nonce = request.headers["x-sutra-nonce"];
  return typeof nonce === "string" && nonce.length <= 128 ? nonce : "unauthenticated";
}

function boundaryResourceKey(resource: NormalizedAwsResource): string {
  if (resource.resourceKey.length <= 180 && /^[A-Za-z0-9][A-Za-z0-9._:@/#+=-]*$/u.test(resource.resourceKey)) {
    return resource.resourceKey;
  }
  return `${resource.provider}:${resource.accountId}:${resource.region}:${resource.service}:${sha256(resource.resourceKey).slice(0, 40)}`;
}

function evidenceResourceKey(
  evidence: NormalizedAwsEvidence,
  normalized: readonly NormalizedAwsResource[],
  keyMap: ReadonlyMap<string, string>,
): string | null {
  const match = normalized.find(
    (resource) =>
      resource.accountId === evidence.accountId &&
      resource.service === evidence.service &&
      (resource.region === evidence.region || evidence.region === "global") &&
      (resource.resourceId === evidence.subjectId || resource.resourceType === "aws.iam.account"),
  );
  return match === undefined ? null : keyMap.get(match.resourceKey) ?? null;
}

function hasPublicSsh(value: SafeJsonValue | undefined): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    if (!isJsonObject(item)) return false;
    const from = item.fromPort;
    const to = item.toPort;
    const cidrs = stringArray(item.ipv4Cidrs);
    return typeof from === "number" && typeof to === "number" && from <= 22 && to >= 22 && cidrs.includes("0.0.0.0/0");
  });
}

function scalarString(value: SafeJsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: SafeJsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isJsonObject(value: SafeJsonValue): value is SafeJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
    ? error.name
    : "UnknownError";
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function exactBooleanEnvironment(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function firstRegion(connection: RegisteredAwsConnection): string {
  const region = connection.enabledRegions[0];
  if (region === undefined) throw new RegistryStateError();
  return region;
}

function collectorMode(value: string | undefined): "fixture" | "live" {
  const normalized = value?.trim() || "fixture";
  if (normalized !== "fixture" && normalized !== "live") {
    throw new Error("SUTRA_COLLECTOR_MODE must be fixture or live");
  }
  return normalized;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startLocalCollectorServer()
    .then((server) => {
      process.stdout.write(`Sutra AWS collector listening on http://${HOST}:${PORT}\n`);
      const shutdown = () => server.close(() => process.exit(0));
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch(() => {
      process.stderr.write("Sutra AWS collector could not start. Check the local pilot configuration.\n");
      process.exitCode = 1;
    });
}
