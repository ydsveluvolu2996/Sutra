import { createHash } from "node:crypto";
import {
  normalizeHubbleFlowBatch,
  type HubbleEndpointIdentity,
  type HubbleFlowBatch,
  type NormalizedHubbleFlow,
} from "../lib/hubble-flow-evidence";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const STALE_AFTER_MS = 15 * 60 * 1_000;

export interface HubbleScope { readonly orgId: string; readonly customerId: string; readonly clusterId: string }
export interface HubbleWorkspace {
  readonly coverage: "not_configured" | "stale" | "current";
  readonly hubbleVersion: string | null;
  readonly lastBatchAt: string | null;
  readonly lastFlowAt: string | null;
  readonly staleAfterSeconds: 900;
  readonly flows: readonly NormalizedHubbleFlow[];
}

interface FlowRow {
  observed_at: number; source_namespace: string | null; source_workload_kind: string | null;
  source_workload_name: string | null; source_service_name: string | null; source_world: number;
  destination_namespace: string | null; destination_workload_kind: string | null;
  destination_workload_name: string | null; destination_service_name: string | null; destination_world: number;
  direction: NormalizedHubbleFlow["direction"]; verdict: NormalizedHubbleFlow["verdict"];
  protocol: NormalizedHubbleFlow["protocol"]; destination_port: number | null;
  observations: number; evidence_sha256: string;
}

function validate(scope: HubbleScope): void {
  if (!ID.test(scope.orgId) || !ID.test(scope.customerId) || !CLUSTER_ID.test(scope.clusterId)) {
    throw Object.assign(new Error("Hubble persistence rejected"), { code: "INVALID_INPUT" });
  }
}

function endpoint(row: FlowRow, prefix: "source" | "destination"): HubbleEndpointIdentity {
  return {
    namespace: row[`${prefix}_namespace`],
    workloadKind: row[`${prefix}_workload_kind`],
    workloadName: row[`${prefix}_workload_name`],
    serviceName: row[`${prefix}_service_name`],
    world: row[`${prefix}_world`] === 1,
  };
}

function flow(row: FlowRow): NormalizedHubbleFlow {
  if (!HASH.test(row.evidence_sha256)) throw Object.assign(new Error("Hubble evidence corrupted"), { code: "EVIDENCE_MISMATCH" });
  return {
    observedAt: new Date(Number(row.observed_at)).toISOString(),
    source: endpoint(row, "source"),
    destination: endpoint(row, "destination"),
    direction: row.direction,
    verdict: row.verdict,
    protocol: row.protocol,
    destinationPort: row.destination_port === null ? null : Number(row.destination_port),
    observations: Number(row.observations),
    evidenceSha256: row.evidence_sha256,
  };
}

export class HubbleFlowRepository {
  private readonly database: D1Database;
  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }
  private async ready() {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async publish(scope: HubbleScope, batch: HubbleFlowBatch): Promise<{ accepted: number; duplicates: number }> {
    validate(scope);
    if (batch.clusterId !== scope.clusterId || !HASH.test(batch.evidenceSha256) || batch.flows.length > 5_000) {
      throw Object.assign(new Error("Hubble evidence mismatch"), { code: "EVIDENCE_MISMATCH" });
    }
    const verified = await normalizeHubbleFlowBatch({
      clusterId: scope.clusterId,
      value: {
        collectedAt: batch.collectedAt,
        hubbleVersion: batch.hubbleVersion,
        flows: batch.flows.map((item) => ({
          observedAt: item.observedAt,
          source: item.source,
          destination: item.destination,
          direction: item.direction,
          verdict: item.verdict,
          protocol: item.protocol,
          destinationPort: item.destinationPort,
          observations: item.observations,
        })),
      },
    }).catch(() => {
      throw Object.assign(new Error("Hubble evidence mismatch"), { code: "EVIDENCE_MISMATCH" });
    });
    if (verified.evidenceSha256 !== batch.evidenceSha256) {
      throw Object.assign(new Error("Hubble evidence mismatch"), { code: "EVIDENCE_MISMATCH" });
    }
    const db = await this.ready();
    const statements = batch.flows.map((item) => db.prepare(
      `INSERT OR IGNORE INTO hubble_flow_evidence
        (id, org_id, customer_id, cluster_id, observed_at, source_namespace,
         source_workload_kind, source_workload_name, source_service_name, source_world,
         destination_namespace, destination_workload_kind, destination_workload_name,
         destination_service_name, destination_world, direction, verdict, protocol,
         destination_port, observations, evidence_sha256)
       SELECT ?, c.org_id, c.customer_id, c.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM kubernetes_clusters c
        WHERE c.id = ? AND c.org_id = ? AND c.customer_id = ? AND c.status = 'active'`,
    ).bind(
      `hflow_${createHash("sha256").update(`${scope.clusterId}\0${item.evidenceSha256}`).digest("hex").slice(0, 48)}`,
      Date.parse(item.observedAt), item.source.namespace, item.source.workloadKind,
      item.source.workloadName, item.source.serviceName, item.source.world ? 1 : 0,
      item.destination.namespace, item.destination.workloadKind, item.destination.workloadName,
      item.destination.serviceName, item.destination.world ? 1 : 0, item.direction, item.verdict,
      item.protocol, item.destinationPort, item.observations, item.evidenceSha256,
      scope.clusterId, scope.orgId, scope.customerId,
    ));
    const lastFlowAt = batch.flows.reduce((latest, item) => Math.max(latest, Date.parse(item.observedAt)), 0);
    statements.push(db.prepare(
      `INSERT INTO hubble_flow_sources
        (cluster_id, org_id, customer_id, hubble_version, last_batch_at, last_flow_at, last_batch_sha256, updated_at)
       SELECT id, org_id, customer_id, ?, ?, ?, ?, ?
         FROM kubernetes_clusters WHERE id = ? AND org_id = ? AND customer_id = ? AND status = 'active'
       ON CONFLICT (cluster_id) DO UPDATE SET hubble_version = excluded.hubble_version,
         last_batch_at = excluded.last_batch_at, last_flow_at = excluded.last_flow_at,
         last_batch_sha256 = excluded.last_batch_sha256, updated_at = excluded.updated_at`,
    ).bind(batch.hubbleVersion, Date.parse(batch.collectedAt), lastFlowAt || null, batch.evidenceSha256,
      Date.now(), scope.clusterId, scope.orgId, scope.customerId));
    const results = await db.batch(statements);
    const accepted = results.slice(0, -1).reduce((sum, result) => sum + Number(result.meta?.changes ?? 0), 0);
    const sourceChanges = Number(results.at(-1)?.meta?.changes ?? 0);
    if (sourceChanges === 0) throw Object.assign(new Error("Hubble cluster scope not found"), { code: "SCOPE_NOT_FOUND" });
    return { accepted, duplicates: batch.flows.length - accepted };
  }

  public async workspace(scope: HubbleScope, limit = 500): Promise<HubbleWorkspace> {
    validate(scope);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw Object.assign(new Error("Hubble query rejected"), { code: "INVALID_INPUT" });
    const db = await this.ready();
    const source = await db.prepare(
      `SELECT hubble_version, last_batch_at, last_flow_at FROM hubble_flow_sources
        WHERE org_id = ? AND customer_id = ? AND cluster_id = ? LIMIT 1`,
    ).bind(scope.orgId, scope.customerId, scope.clusterId).first<{
      hubble_version: string; last_batch_at: number; last_flow_at: number | null;
    }>();
    if (source === null) return {
      coverage: "not_configured", hubbleVersion: null, lastBatchAt: null, lastFlowAt: null,
      staleAfterSeconds: 900, flows: [],
    };
    const rows = await db.prepare(
      `SELECT observed_at, source_namespace, source_workload_kind, source_workload_name,
        source_service_name, source_world, destination_namespace, destination_workload_kind,
        destination_workload_name, destination_service_name, destination_world, direction,
        verdict, protocol, destination_port, observations, evidence_sha256
       FROM hubble_flow_evidence WHERE org_id = ? AND customer_id = ? AND cluster_id = ?
       ORDER BY observed_at DESC, id DESC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, scope.clusterId, limit).all<FlowRow>();
    return {
      coverage: Date.now() - Number(source.last_batch_at) > STALE_AFTER_MS ? "stale" : "current",
      hubbleVersion: source.hubble_version,
      lastBatchAt: new Date(Number(source.last_batch_at)).toISOString(),
      lastFlowAt: source.last_flow_at === null ? null : new Date(Number(source.last_flow_at)).toISOString(),
      staleAfterSeconds: 900,
      flows: (rows.results ?? []).map(flow),
    };
  }
}
