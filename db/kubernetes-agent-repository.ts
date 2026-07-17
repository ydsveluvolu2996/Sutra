import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u;
const CAPABILITY = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{7,127}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43,512}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MIN_BOOTSTRAP_TTL_MS = 5 * 60_000;
const MAX_BOOTSTRAP_TTL_MS = 30 * 60_000;
const DEFAULT_BOOTSTRAP_TTL_MS = 10 * 60_000;
const CREDENTIAL_TTL_MS = 60 * 60_000;
const PREVIOUS_CREDENTIAL_OVERLAP_MS = 5 * 60_000;
const OFFLINE_AFTER_MS = 30 * 60_000;

export interface KubernetesAgentScope {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly clusterId: string;
}

export interface KubernetesAgentIdentity {
  readonly clusterId: string;
  readonly clusterName: string;
  readonly agentVersion: string;
  readonly capabilities: readonly string[];
}

export interface AuthenticatedKubernetesAgent extends KubernetesAgentScope {
  readonly agentId: string;
  readonly clusterUid: string;
  readonly clusterName: string;
}

export interface KubernetesAgentCredential {
  readonly agentId: string;
  readonly token: string;
  readonly expiresAt: string;
}

export class KubernetesAgentRepositoryError extends Error {
  public readonly code: "AUTHENTICATION_REQUIRED" | "CONFLICT" | "INVALID_INPUT" | "NOT_FOUND";
  public readonly status: number;

  public constructor(
    code: "AUTHENTICATION_REQUIRED" | "CONFLICT" | "INVALID_INPUT" | "NOT_FOUND",
    status: 400 | 401 | 404 | 409,
  ) {
    super(
      code === "AUTHENTICATION_REQUIRED"
        ? "The Kubernetes agent credential is invalid"
        : code === "NOT_FOUND"
          ? "The Kubernetes agent scope was not found"
          : code === "CONFLICT"
            ? "The Kubernetes agent operation conflicts with existing state"
            : "The Kubernetes agent request is invalid",
    );
    this.name = "KubernetesAgentRepositoryError";
    this.code = code;
    this.status = status;
  }
}

interface AgentRow {
  id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  cluster_id: string;
  cluster_uid: string;
  cluster_name: string;
  status: string;
  current_token_digest: string;
  previous_token_digest: string | null;
  previous_token_expires_at: number | null;
  credential_expires_at: number;
}

function invalid(): never {
  throw new KubernetesAgentRepositoryError("INVALID_INPUT", 400);
}

function assertIdentifier(value: string): void {
  if (!ID.test(value)) invalid();
}

function assertScope(scope: KubernetesAgentScope): void {
  assertIdentifier(scope.orgId);
  assertIdentifier(scope.customerId);
  assertIdentifier(scope.connectionId);
  assertIdentifier(scope.clusterId);
}

function assertIdentity(identity: KubernetesAgentIdentity): void {
  assertIdentifier(identity.clusterId);
  assertIdentifier(identity.agentVersion);
  if (
    identity.clusterName.length < 1 ||
    identity.clusterName.length > 253 ||
    /[\0\r\n]/u.test(identity.clusterName) ||
    identity.capabilities.length < 1 ||
    identity.capabilities.length > 64 ||
    identity.capabilities.some((item) => !CAPABILITY.test(item)) ||
    new Set(identity.capabilities).size !== identity.capabilities.length
  ) invalid();
}

function opaqueToken(): string {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const maximum = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximum; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function agentFromRow(row: AgentRow): AuthenticatedKubernetesAgent {
  return {
    agentId: row.id,
    orgId: row.org_id,
    customerId: row.customer_id,
    connectionId: row.connection_id,
    clusterId: row.cluster_id,
    clusterUid: row.cluster_uid,
    clusterName: row.cluster_name,
  };
}

export class KubernetesAgentRepository {
  private readonly database: D1Database;
  private readonly now: () => number;

  public constructor(database: D1Database = getRawDb(), now: () => number = Date.now) {
    this.database = database;
    this.now = now;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async issueBootstrap(input: {
    readonly scope: KubernetesAgentScope;
    readonly createdBy: string;
    readonly ttlMs?: number;
  }): Promise<{ readonly bootstrapId: string; readonly token: string; readonly expiresAt: string }> {
    assertScope(input.scope);
    assertIdentifier(input.createdBy);
    const ttlMs = input.ttlMs ?? DEFAULT_BOOTSTRAP_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_BOOTSTRAP_TTL_MS || ttlMs > MAX_BOOTSTRAP_TTL_MS) {
      invalid();
    }
    const token = opaqueToken();
    const tokenDigest = await sha256(token);
    const bootstrapId = `kboot_${crypto.randomUUID().replaceAll("-", "")}`;
    const now = this.now();
    const expiresAt = now + ttlMs;
    const db = await this.ready();
    const result = await db.prepare(
      `INSERT INTO kubernetes_agent_bootstraps
        (id, org_id, customer_id, connection_id, cluster_id, token_digest, expires_at, created_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM aws_connections
           WHERE id = ? AND org_id = ? AND customer_id = ? AND status = 'active'
        )
          AND EXISTS (
          SELECT 1 FROM kubernetes_clusters
           WHERE id = ? AND org_id = ? AND customer_id = ? AND status = 'active'
        )
          AND EXISTS (
          SELECT 1 FROM users WHERE id = ?
        )`,
    ).bind(
      bootstrapId, input.scope.orgId, input.scope.customerId, input.scope.connectionId,
      input.scope.clusterId, tokenDigest, expiresAt, input.createdBy, now,
      input.scope.connectionId, input.scope.orgId, input.scope.customerId,
      input.scope.clusterId, input.scope.orgId, input.scope.customerId,
      input.createdBy,
    ).run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new KubernetesAgentRepositoryError("NOT_FOUND", 404);
    }
    return { bootstrapId, token, expiresAt: new Date(expiresAt).toISOString() };
  }

  public async enroll(
    bootstrapToken: string,
    identity: KubernetesAgentIdentity,
  ): Promise<KubernetesAgentCredential> {
    if (!TOKEN.test(bootstrapToken)) {
      throw new KubernetesAgentRepositoryError("AUTHENTICATION_REQUIRED", 401);
    }
    assertIdentity(identity);
    const digest = await sha256(bootstrapToken);
    const db = await this.ready();
    const bootstrap = await db.prepare(
      `SELECT b.id, b.org_id, b.customer_id, b.connection_id, b.cluster_id, b.token_digest,
              b.expires_at, b.consumed_at, c.cluster_uid, c.name AS cluster_name
         FROM kubernetes_agent_bootstraps b
         JOIN kubernetes_clusters c
           ON c.id = b.cluster_id AND c.org_id = b.org_id AND c.customer_id = b.customer_id
        WHERE b.token_digest = ?
        LIMIT 1`,
    ).bind(digest).first<{
      id: string; org_id: string; customer_id: string; connection_id: string; cluster_id: string;
      token_digest: string; expires_at: number; consumed_at: number | null;
      cluster_uid: string; cluster_name: string;
    }>();
    const now = this.now();
    if (
      bootstrap === null ||
      !DIGEST.test(bootstrap.token_digest) ||
      !constantTimeEqual(digest, bootstrap.token_digest) ||
      bootstrap.consumed_at !== null ||
      Number(bootstrap.expires_at) <= now
    ) {
      throw new KubernetesAgentRepositoryError("AUTHENTICATION_REQUIRED", 401);
    }
    if (identity.clusterId !== bootstrap.cluster_uid || identity.clusterName !== bootstrap.cluster_name) {
      throw new KubernetesAgentRepositoryError("AUTHENTICATION_REQUIRED", 401);
    }
    const agentId = `kagent_${crypto.randomUUID().replaceAll("-", "")}`;
    const token = opaqueToken();
    const credentialDigest = await sha256(token);
    const expiresAt = now + CREDENTIAL_TTL_MS;
    try {
      await db.batch([
        db.prepare(
          `UPDATE kubernetes_agent_bootstraps
              SET consumed_at = ?, consumed_agent_id = ?
            WHERE id = ? AND token_digest = ? AND consumed_at IS NULL AND expires_at > ?`,
        ).bind(now, agentId, bootstrap.id, digest, now),
        db.prepare(
          `INSERT INTO kubernetes_agents
            (id, org_id, customer_id, connection_id, cluster_id, status,
             current_token_digest, credential_expires_at, agent_version,
             capabilities_json, enrolled_at)
           SELECT ?, org_id, customer_id, connection_id, cluster_id, 'active',
                  ?, ?, ?, ?, ?
             FROM kubernetes_agent_bootstraps
            WHERE id = ? AND consumed_agent_id = ? AND consumed_at = ?`,
        ).bind(
          agentId, credentialDigest, expiresAt, identity.agentVersion,
          JSON.stringify(identity.capabilities), now, bootstrap.id, agentId, now,
        ),
      ]);
    } catch {
      throw new KubernetesAgentRepositoryError("CONFLICT", 409);
    }
    const created = await db.prepare(
      `SELECT id FROM kubernetes_agents WHERE id = ? AND current_token_digest = ? LIMIT 1`,
    ).bind(agentId, credentialDigest).first<{ id: string }>();
    if (created === null) throw new KubernetesAgentRepositoryError("CONFLICT", 409);
    return { agentId, token, expiresAt: new Date(expiresAt).toISOString() };
  }

  public async authenticate(
    agentId: string,
    token: string,
    options: { readonly allowPrevious?: boolean } = {},
  ): Promise<AuthenticatedKubernetesAgent> {
    assertIdentifier(agentId);
    if (!TOKEN.test(token)) throw new KubernetesAgentRepositoryError("AUTHENTICATION_REQUIRED", 401);
    const candidate = await sha256(token);
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT a.id, a.org_id, a.customer_id, a.connection_id, a.cluster_id, a.status,
              a.current_token_digest, a.previous_token_digest, a.previous_token_expires_at,
              a.credential_expires_at, c.cluster_uid, c.name AS cluster_name
         FROM kubernetes_agents a
         JOIN kubernetes_clusters c
           ON c.id = a.cluster_id AND c.org_id = a.org_id AND c.customer_id = a.customer_id
        WHERE a.id = ?
        LIMIT 1`,
    ).bind(agentId).first<AgentRow>();
    const now = this.now();
    const currentValid = row !== null &&
      Number(row.credential_expires_at) > now &&
      DIGEST.test(row.current_token_digest) &&
      constantTimeEqual(candidate, row.current_token_digest);
    const previousValid = row !== null &&
      options.allowPrevious === true &&
      row.previous_token_digest !== null &&
      row.previous_token_expires_at !== null &&
      Number(row.previous_token_expires_at) > now &&
      DIGEST.test(row.previous_token_digest) &&
      constantTimeEqual(candidate, row.previous_token_digest);
    if (row === null || row.status !== "active" || (!currentValid && !previousValid)) {
      throw new KubernetesAgentRepositoryError("AUTHENTICATION_REQUIRED", 401);
    }
    return agentFromRow(row);
  }

  public async rotate(agentId: string, currentToken: string): Promise<KubernetesAgentCredential> {
    await this.authenticate(agentId, currentToken);
    const currentDigest = await sha256(currentToken);
    const token = opaqueToken();
    const nextDigest = await sha256(token);
    const now = this.now();
    const expiresAt = now + CREDENTIAL_TTL_MS;
    const db = await this.ready();
    const result = await db.prepare(
      `UPDATE kubernetes_agents
          SET previous_token_digest = current_token_digest,
              previous_token_expires_at = ?,
              current_token_digest = ?,
              credential_expires_at = ?,
              rotated_at = ?
        WHERE id = ? AND status = 'active' AND current_token_digest = ? AND credential_expires_at > ?`,
    ).bind(
      now + PREVIOUS_CREDENTIAL_OVERLAP_MS, nextDigest, expiresAt, now,
      agentId, currentDigest, now,
    ).run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new KubernetesAgentRepositoryError("CONFLICT", 409);
    }
    return { agentId, token, expiresAt: new Date(expiresAt).toISOString() };
  }

  public async recordHeartbeat(input: {
    readonly agent: AuthenticatedKubernetesAgent;
    readonly agentVersion: string;
    readonly capabilities: readonly string[];
    readonly deployment: { readonly namespace: string; readonly podName: string; readonly startedAt: string };
    readonly modules: Readonly<Record<string, string>>;
  }): Promise<void> {
    assertIdentity({
      clusterId: input.agent.clusterUid,
      clusterName: input.agent.clusterName,
      agentVersion: input.agentVersion,
      capabilities: input.capabilities,
    });
    if (
      !ID.test(input.deployment.namespace) ||
      !ID.test(input.deployment.podName) ||
      !Number.isFinite(Date.parse(input.deployment.startedAt)) ||
      Object.keys(input.modules).length > 32
    ) invalid();
    const db = await this.ready();
    const result = await db.prepare(
      `UPDATE kubernetes_agents
          SET agent_version = ?, capabilities_json = ?, deployment_namespace = ?,
              deployment_pod_name = ?, deployment_started_at = ?, module_health_json = ?,
              last_heartbeat_at = ?
        WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
          AND cluster_id = ? AND status = 'active'`,
    ).bind(
      input.agentVersion, JSON.stringify(input.capabilities), input.deployment.namespace,
      input.deployment.podName, Date.parse(input.deployment.startedAt),
      JSON.stringify(input.modules), this.now(), input.agent.agentId, input.agent.orgId,
      input.agent.customerId, input.agent.connectionId, input.agent.clusterId,
    ).run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new KubernetesAgentRepositoryError("AUTHENTICATION_REQUIRED", 401);
    }
  }

  public async health(agent: AuthenticatedKubernetesAgent): Promise<{
    readonly state: "online" | "offline" | "revoked";
    readonly lastHeartbeatAt: string | null;
  }> {
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT status, last_heartbeat_at FROM kubernetes_agents
        WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ? AND cluster_id = ?`,
    ).bind(
      agent.agentId, agent.orgId, agent.customerId, agent.connectionId, agent.clusterId,
    ).first<{ status: string; last_heartbeat_at: number | null }>();
    if (row === null) throw new KubernetesAgentRepositoryError("NOT_FOUND", 404);
    const lastHeartbeat = row.last_heartbeat_at === null ? null : Number(row.last_heartbeat_at);
    return {
      state: row.status === "revoked"
        ? "revoked"
        : lastHeartbeat === null || this.now() - lastHeartbeat > OFFLINE_AFTER_MS
          ? "offline"
          : "online",
      lastHeartbeatAt: lastHeartbeat === null ? null : new Date(lastHeartbeat).toISOString(),
    };
  }

  public async listDeploymentHealth(scope: KubernetesAgentScope): Promise<readonly {
    readonly agentId: string;
    readonly state: "online" | "offline" | "revoked";
    readonly agentVersion: string;
    readonly capabilities: readonly string[];
    readonly deployment: {
      readonly namespace: string;
      readonly podName: string;
      readonly startedAt: string;
    } | null;
    readonly modules: Readonly<Record<string, string>>;
    readonly lastHeartbeatAt: string | null;
    readonly lastScanAt: string | null;
    readonly enrolledAt: string;
  }[]> {
    assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT id, status, agent_version, capabilities_json, deployment_namespace,
              deployment_pod_name, deployment_started_at, module_health_json,
              last_heartbeat_at, last_scan_at, enrolled_at
         FROM kubernetes_agents
        WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND cluster_id = ?
        ORDER BY enrolled_at DESC
        LIMIT 16`,
    ).bind(scope.orgId, scope.customerId, scope.connectionId, scope.clusterId).all<{
      id: string;
      status: string;
      agent_version: string;
      capabilities_json: string;
      deployment_namespace: string | null;
      deployment_pod_name: string | null;
      deployment_started_at: number | null;
      module_health_json: string;
      last_heartbeat_at: number | null;
      last_scan_at: number | null;
      enrolled_at: number;
    }>();
    return (rows.results ?? []).map((row) => {
      const lastHeartbeat = row.last_heartbeat_at === null ? null : Number(row.last_heartbeat_at);
      let modules: Record<string, string> = {};
      try {
        const parsed = JSON.parse(row.module_health_json) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          modules = Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
            .filter(([, value]) => typeof value === "string")) as Record<string, string>;
        }
      } catch {
        modules = {};
      }
      let capabilities: string[] = [];
      try {
        const parsed = JSON.parse(row.capabilities_json) as unknown;
        if (Array.isArray(parsed)) capabilities = parsed.filter((value) => typeof value === "string");
      } catch {
        capabilities = [];
      }
      return {
        agentId: row.id,
        state: row.status === "revoked"
          ? "revoked" as const
          : lastHeartbeat === null || this.now() - lastHeartbeat > OFFLINE_AFTER_MS
            ? "offline" as const
            : "online" as const,
        agentVersion: row.agent_version,
        capabilities,
        deployment:
          row.deployment_namespace !== null &&
          row.deployment_pod_name !== null &&
          row.deployment_started_at !== null
            ? {
              namespace: row.deployment_namespace,
              podName: row.deployment_pod_name,
              startedAt: new Date(Number(row.deployment_started_at)).toISOString(),
            }
            : null,
        modules,
        lastHeartbeatAt: lastHeartbeat === null ? null : new Date(lastHeartbeat).toISOString(),
        lastScanAt: row.last_scan_at === null ? null : new Date(Number(row.last_scan_at)).toISOString(),
        enrolledAt: new Date(Number(row.enrolled_at)).toISOString(),
      };
    });
  }

  public async revoke(scope: KubernetesAgentScope, agentId: string): Promise<void> {
    assertScope(scope);
    assertIdentifier(agentId);
    const db = await this.ready();
    const result = await db.prepare(
      `UPDATE kubernetes_agents
          SET status = 'revoked', revoked_at = ?, current_token_digest = ?,
              previous_token_digest = NULL, previous_token_expires_at = NULL
        WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
          AND cluster_id = ? AND status = 'active'`,
    ).bind(
      this.now(), await sha256(opaqueToken()), agentId, scope.orgId, scope.customerId,
      scope.connectionId, scope.clusterId,
    ).run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new KubernetesAgentRepositoryError("NOT_FOUND", 404);
    }
  }

  public async getScanReceipt(
    agent: AuthenticatedKubernetesAgent,
    idempotencyKey: string,
  ): Promise<{ readonly payloadSha256: string; readonly scanRunId: string } | null> {
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) invalid();
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT payload_sha256, scan_run_id FROM kubernetes_agent_scan_receipts
        WHERE agent_id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
          AND cluster_id = ? AND idempotency_key = ? LIMIT 1`,
    ).bind(
      agent.agentId, agent.orgId, agent.customerId, agent.connectionId,
      agent.clusterId, idempotencyKey,
    ).first<{ payload_sha256: string; scan_run_id: string }>();
    return row === null ? null : { payloadSha256: row.payload_sha256, scanRunId: row.scan_run_id };
  }

  public async recordScanReceipt(input: {
    readonly agent: AuthenticatedKubernetesAgent;
    readonly idempotencyKey: string;
    readonly payloadSha256: string;
    readonly scanRunId: string;
  }): Promise<void> {
    if (
      !IDEMPOTENCY_KEY.test(input.idempotencyKey) ||
      !DIGEST.test(input.payloadSha256) ||
      !ID.test(input.scanRunId)
    ) invalid();
    const db = await this.ready();
    const id = `kreceipt_${(await sha256(
      `${input.agent.agentId}\0${input.idempotencyKey}`,
    )).slice(0, 48)}`;
    try {
      await db.batch([
        db.prepare(
          `INSERT INTO kubernetes_agent_scan_receipts
            (id, agent_id, org_id, customer_id, connection_id, cluster_id,
             idempotency_key, payload_sha256, scan_run_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          id, input.agent.agentId, input.agent.orgId, input.agent.customerId,
          input.agent.connectionId, input.agent.clusterId, input.idempotencyKey,
          input.payloadSha256, input.scanRunId, this.now(),
        ),
        db.prepare(
          `UPDATE kubernetes_agents SET last_scan_at = ?
            WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
              AND cluster_id = ? AND status = 'active'`,
        ).bind(
          this.now(), input.agent.agentId, input.agent.orgId, input.agent.customerId,
          input.agent.connectionId, input.agent.clusterId,
        ),
      ]);
    } catch {
      const existing = await this.getScanReceipt(input.agent, input.idempotencyKey);
      if (
        existing !== null &&
        existing.payloadSha256 === input.payloadSha256 &&
        existing.scanRunId === input.scanRunId
      ) return;
      throw new KubernetesAgentRepositoryError("CONFLICT", 409);
    }
  }
}
