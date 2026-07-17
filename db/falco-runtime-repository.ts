import { createHash } from "node:crypto";
import { canonicalJson } from "../lib/canonical-json";
import type { FalcoReplayStore } from "../lib/falco-request-security";
import {
  projectFalcoTimeline,
  type FalcoInvestigationTimelineItem,
  type FalcoRuntimeCoverage,
  type NormalizedFalcoRuntimeEvent,
} from "../lib/falco-runtime-types";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;

export interface FalcoClusterScope {
  readonly orgId: string;
  readonly customerId: string;
  readonly clusterId: string;
}

export class FalcoRuntimeRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "EVIDENCE_MISMATCH";

  public constructor(code: FalcoRuntimeRepositoryError["code"]) {
    super("Falco runtime persistence operation rejected");
    this.name = "FalcoRuntimeRepositoryError";
    this.code = code;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function evidenceMaterial(event: NormalizedFalcoRuntimeEvent): object {
  return {
    schemaVersion: event.schemaVersion,
    clusterId: event.clusterId,
    occurredAt: event.occurredAt,
    rule: event.rule,
    priority: event.priority,
    source: event.source,
    nodeName: event.nodeName,
    namespace: event.namespace,
    podName: event.podName,
    podUid: event.podUid,
    containerId: event.containerId,
    containerName: event.containerName,
    containerImage: event.containerImage,
    process: event.process,
  };
}

export class FalcoRuntimeRepository implements FalcoReplayStore {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async resolveCluster(clusterId: string): Promise<FalcoClusterScope | null> {
    if (!CLUSTER_ID.test(clusterId)) throw new FalcoRuntimeRepositoryError("INVALID_INPUT");
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT org_id, customer_id, id FROM kubernetes_clusters
        WHERE id = ? AND status = 'active' LIMIT 1`,
    ).bind(clusterId).first<{ org_id: string; customer_id: string; id: string }>();
    return row === null ? null : {
      orgId: row.org_id,
      customerId: row.customer_id,
      clusterId: row.id,
    };
  }

  public async consume(input: {
    readonly clusterId: string;
    readonly keyId: string;
    readonly nonceSha256: string;
    readonly expiresAt: number;
  }): Promise<boolean> {
    if (
      !CLUSTER_ID.test(input.clusterId) ||
      !IDENTIFIER.test(input.keyId) ||
      !HASH.test(input.nonceSha256) ||
      !Number.isSafeInteger(input.expiresAt)
    ) throw new FalcoRuntimeRepositoryError("INVALID_INPUT");
    const db = await this.ready();
    const now = Date.now();
    await db.prepare(`DELETE FROM falco_ingestion_nonces WHERE expires_at < ?`).bind(now).run();
    const result = await db.prepare(
      `INSERT OR IGNORE INTO falco_ingestion_nonces
        (cluster_id, key_id, nonce_sha256, expires_at)
       SELECT id, ?, ?, ? FROM kubernetes_clusters
        WHERE id = ? AND status = 'active'`,
    ).bind(input.keyId, input.nonceSha256, input.expiresAt, input.clusterId).run();
    return Number(result.meta?.changes ?? 0) === 1;
  }

  public async publish(
    scope: FalcoClusterScope,
    events: readonly NormalizedFalcoRuntimeEvent[],
  ): Promise<{ readonly accepted: number; readonly duplicates: number }> {
    if (
      !CLUSTER_ID.test(scope.clusterId) ||
      !IDENTIFIER.test(scope.orgId) ||
      !IDENTIFIER.test(scope.customerId) ||
      events.length < 1 ||
      events.length > 100
    ) throw new FalcoRuntimeRepositoryError("INVALID_INPUT");
    const db = await this.ready();
    const statements: D1PreparedStatement[] = [];
    let latest = 0;
    for (const event of events) {
      const evidenceJson = canonicalJson(evidenceMaterial(event));
      const expectedHash = sha256(evidenceJson);
      if (
        event.clusterId !== scope.clusterId ||
        event.evidenceSha256 !== expectedHash ||
        event.eventId !== `frte_${sha256(`${scope.clusterId}\0${expectedHash}`).slice(0, 48)}`
      ) throw new FalcoRuntimeRepositoryError("EVIDENCE_MISMATCH");
      const occurredAt = Date.parse(event.occurredAt);
      if (!Number.isSafeInteger(occurredAt)) throw new FalcoRuntimeRepositoryError("INVALID_INPUT");
      latest = Math.max(latest, occurredAt);
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO falco_runtime_events
          (id, org_id, customer_id, cluster_id, occurred_at, rule_name, priority,
           source, node_name, namespace_name, pod_name, pod_uid, container_id,
           container_name, container_image, process_name, process_executable,
           process_id, parent_process_id, user_name, user_id, event_type,
           evidence_json, evidence_sha256)
         SELECT ?, c.org_id, c.customer_id, c.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM kubernetes_clusters c
          WHERE c.id = ? AND c.org_id = ? AND c.customer_id = ? AND c.status = 'active'`,
      ).bind(
        event.eventId, occurredAt, event.rule, event.priority, event.source,
        event.nodeName, event.namespace, event.podName, event.podUid,
        event.containerId, event.containerName, event.containerImage,
        event.process.name, event.process.executable, event.process.pid,
        event.process.parentPid, event.process.userName, event.process.userId,
        event.process.eventType, evidenceJson, expectedHash, scope.clusterId,
        scope.orgId, scope.customerId,
      ));
    }
    statements.push(db.prepare(
      `INSERT INTO falco_runtime_sources
        (cluster_id, org_id, customer_id, last_heartbeat_at, last_event_at, updated_at)
       SELECT id, org_id, customer_id, ?, ?, ?
         FROM kubernetes_clusters
        WHERE id = ? AND org_id = ? AND customer_id = ? AND status = 'active'
       ON CONFLICT (cluster_id) DO UPDATE SET
         last_heartbeat_at = excluded.last_heartbeat_at,
         last_event_at = CASE
           WHEN falco_runtime_sources.last_event_at IS NULL OR excluded.last_event_at > falco_runtime_sources.last_event_at
           THEN excluded.last_event_at ELSE falco_runtime_sources.last_event_at END,
         updated_at = excluded.updated_at`,
    ).bind(Date.now(), latest, Date.now(), scope.clusterId, scope.orgId, scope.customerId));
    const results = await db.batch(statements);
    const accepted = results.slice(0, -1)
      .reduce((count, result) => count + Number(result.meta?.changes ?? 0), 0);
    if (accepted === 0 && events.length > 0) {
      const cluster = await this.resolveCluster(scope.clusterId);
      if (cluster === null || cluster.orgId !== scope.orgId || cluster.customerId !== scope.customerId) {
        throw new FalcoRuntimeRepositoryError("SCOPE_NOT_FOUND");
      }
    }
    return { accepted, duplicates: events.length - accepted };
  }

  public async heartbeat(
    scope: FalcoClusterScope,
    falcoVersion: string | null,
  ): Promise<void> {
    if (
      !CLUSTER_ID.test(scope.clusterId) ||
      (falcoVersion !== null && (
        falcoVersion.length < 1 || falcoVersion.length > 64 || /[\0\r\n]/u.test(falcoVersion)
      ))
    ) throw new FalcoRuntimeRepositoryError("INVALID_INPUT");
    const db = await this.ready();
    const now = Date.now();
    const result = await db.prepare(
      `INSERT INTO falco_runtime_sources
        (cluster_id, org_id, customer_id, last_heartbeat_at, falco_version, updated_at)
       SELECT id, org_id, customer_id, ?, ?, ?
         FROM kubernetes_clusters
        WHERE id = ? AND org_id = ? AND customer_id = ? AND status = 'active'
       ON CONFLICT (cluster_id) DO UPDATE SET
         last_heartbeat_at = excluded.last_heartbeat_at,
         falco_version = excluded.falco_version,
         updated_at = excluded.updated_at`,
    ).bind(now, falcoVersion, now, scope.clusterId, scope.orgId, scope.customerId).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw new FalcoRuntimeRepositoryError("SCOPE_NOT_FOUND");
  }

  public async workspace(
    scope: FalcoClusterScope,
    limit = 100,
  ): Promise<{
    readonly coverage: FalcoRuntimeCoverage;
    readonly timeline: readonly FalcoInvestigationTimelineItem[];
    readonly events: readonly NormalizedFalcoRuntimeEvent[];
  }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new FalcoRuntimeRepositoryError("INVALID_INPUT");
    }
    const db = await this.ready();
    const cluster = await this.resolveCluster(scope.clusterId);
    if (cluster === null || cluster.orgId !== scope.orgId || cluster.customerId !== scope.customerId) {
      throw new FalcoRuntimeRepositoryError("SCOPE_NOT_FOUND");
    }
    const source = await db.prepare(
      `SELECT last_heartbeat_at, last_event_at, falco_version
         FROM falco_runtime_sources
        WHERE org_id = ? AND customer_id = ? AND cluster_id = ? LIMIT 1`,
    ).bind(scope.orgId, scope.customerId, scope.clusterId).first<{
      last_heartbeat_at: number | null;
      last_event_at: number | null;
      falco_version: string | null;
    }>();
    const rows = await db.prepare(
      `SELECT evidence_json, evidence_sha256, id
         FROM falco_runtime_events
        WHERE org_id = ? AND customer_id = ? AND cluster_id = ?
        ORDER BY occurred_at DESC, id DESC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, scope.clusterId, limit).all<{
      evidence_json: string;
      evidence_sha256: string;
      id: string;
    }>();
    const events = (rows.results ?? []).map((row) => {
      const material = JSON.parse(row.evidence_json) as Omit<NormalizedFalcoRuntimeEvent, "eventId" | "evidenceSha256">;
      return {
        ...material,
        eventId: row.id,
        evidenceSha256: row.evidence_sha256,
      };
    });
    const timeline = events.map(projectFalcoTimeline);
    const heartbeat = source?.last_heartbeat_at ?? null;
    return {
      coverage: {
        clusterId: scope.clusterId,
        status: heartbeat === null ? "not_configured" :
          Date.now() - Number(heartbeat) <= 5 * 60_000 ? "active" : "stale",
        lastHeartbeatAt: heartbeat === null ? null : new Date(Number(heartbeat)).toISOString(),
        lastEventAt: source?.last_event_at === null || source?.last_event_at === undefined
          ? null : new Date(Number(source.last_event_at)).toISOString(),
        falcoVersion: source?.falco_version ?? null,
      },
      timeline,
      events,
    };
  }
}
