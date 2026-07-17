import {
  normalizeKubernetesSupplyChainEvidence,
  type KubernetesSupplyChainEvidence,
} from "../lib/kubernetes-supply-chain";
import { canonicalJson } from "../lib/canonical-json";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u;
const HASH = /^[a-f0-9]{64}$/u;

export interface KubernetesSupplyChainScope {
  readonly orgId: string;
  readonly customerId: string;
  readonly clusterId: string;
}

interface EvidenceRow {
  id: string;
  cluster_id: string;
  evidence_json: string;
  evidence_sha256: string;
}

export class KubernetesSupplyChainRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "EVIDENCE_MISMATCH";

  public constructor(code: KubernetesSupplyChainRepositoryError["code"]) {
    super("Kubernetes supply-chain persistence operation rejected");
    this.name = "KubernetesSupplyChainRepositoryError";
    this.code = code;
  }
}

function assertScope(scope: KubernetesSupplyChainScope): void {
  if (
    !IDENTIFIER.test(scope.orgId) ||
    !IDENTIFIER.test(scope.customerId) ||
    !CLUSTER_ID.test(scope.clusterId)
  ) throw new KubernetesSupplyChainRepositoryError("INVALID_INPUT");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deterministicId(clusterId: string, evidenceSha256: string): Promise<string> {
  return `ksce_${(await sha256(`${clusterId}\0${evidenceSha256}`)).slice(0, 48)}`;
}

async function storedEvidence(row: EvidenceRow): Promise<KubernetesSupplyChainEvidence> {
  if (!CLUSTER_ID.test(row.cluster_id) || !HASH.test(row.evidence_sha256)) {
    throw new KubernetesSupplyChainRepositoryError("EVIDENCE_MISMATCH");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.evidence_json);
  } catch {
    throw new KubernetesSupplyChainRepositoryError("EVIDENCE_MISMATCH");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new KubernetesSupplyChainRepositoryError("EVIDENCE_MISMATCH");
  }
  const value = parsed as Record<string, unknown>;
  const normalized = await normalizeKubernetesSupplyChainEvidence({
    clusterId: row.cluster_id,
    collectedAt: typeof value.collectedAt === "string" ? value.collectedAt : "",
    evidence: value,
  }).catch(() => {
    throw new KubernetesSupplyChainRepositoryError("EVIDENCE_MISMATCH");
  });
  if (
    normalized.evidenceSha256 !== row.evidence_sha256 ||
    value.evidenceSha256 !== row.evidence_sha256 ||
    canonicalJson(normalized) !== row.evidence_json
  ) throw new KubernetesSupplyChainRepositoryError("EVIDENCE_MISMATCH");
  return normalized;
}

export class KubernetesSupplyChainRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async publish(
    scope: KubernetesSupplyChainScope,
    evidence: KubernetesSupplyChainEvidence,
  ): Promise<KubernetesSupplyChainEvidence> {
    assertScope(scope);
    if (evidence.clusterId !== scope.clusterId || !HASH.test(evidence.evidenceSha256)) {
      throw new KubernetesSupplyChainRepositoryError("INVALID_INPUT");
    }
    const normalized = await normalizeKubernetesSupplyChainEvidence({
      clusterId: scope.clusterId,
      collectedAt: evidence.collectedAt,
      evidence,
    }).catch(() => {
      throw new KubernetesSupplyChainRepositoryError("INVALID_INPUT");
    });
    if (normalized.evidenceSha256 !== evidence.evidenceSha256) {
      throw new KubernetesSupplyChainRepositoryError("EVIDENCE_MISMATCH");
    }
    const id = await deterministicId(scope.clusterId, normalized.evidenceSha256);
    const collectedAt = Date.parse(normalized.collectedAt);
    if (!Number.isSafeInteger(collectedAt)) {
      throw new KubernetesSupplyChainRepositoryError("INVALID_INPUT");
    }
    const db = await this.ready();
    await db.prepare(
      `INSERT OR IGNORE INTO kubernetes_supply_chain_evidence
        (id, org_id, customer_id, cluster_id, image_repository, image_digest,
         collected_at, priority_score, priority_rating, evidence_json, evidence_sha256)
       SELECT ?, c.org_id, c.customer_id, c.id, ?, ?, ?, ?, ?, ?, ?
         FROM kubernetes_clusters c
        WHERE c.id = ? AND c.org_id = ? AND c.customer_id = ? AND c.status = 'active'`,
    ).bind(
      id,
      normalized.image.repository,
      normalized.image.digest,
      collectedAt,
      normalized.priority.score,
      normalized.priority.rating,
      canonicalJson(normalized),
      normalized.evidenceSha256,
      scope.clusterId,
      scope.orgId,
      scope.customerId,
    ).run();
    const stored = await db.prepare(
      `SELECT id, cluster_id, evidence_json, evidence_sha256
         FROM kubernetes_supply_chain_evidence
        WHERE id = ? AND org_id = ? AND customer_id = ? AND cluster_id = ?
        LIMIT 1`,
    ).bind(id, scope.orgId, scope.customerId, scope.clusterId).first<EvidenceRow>();
    if (stored === null) throw new KubernetesSupplyChainRepositoryError("SCOPE_NOT_FOUND");
    return storedEvidence(stored);
  }

  public async list(
    scope: KubernetesSupplyChainScope,
    limit = 100,
  ): Promise<readonly KubernetesSupplyChainEvidence[]> {
    assertScope(scope);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new KubernetesSupplyChainRepositoryError("INVALID_INPUT");
    }
    const db = await this.ready();
    const cluster = await db.prepare(
      `SELECT id FROM kubernetes_clusters
        WHERE id = ? AND org_id = ? AND customer_id = ? AND status = 'active'
        LIMIT 1`,
    ).bind(scope.clusterId, scope.orgId, scope.customerId).first<{ id: string }>();
    if (cluster === null) return [];
    const rows = await db.prepare(
      `SELECT id, cluster_id, evidence_json, evidence_sha256
         FROM kubernetes_supply_chain_evidence
        WHERE org_id = ? AND customer_id = ? AND cluster_id = ?
        ORDER BY collected_at DESC, id DESC
        LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, scope.clusterId, limit).all<EvidenceRow>();
    return Promise.all((rows.results ?? []).map(storedEvidence));
  }
}
