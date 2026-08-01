import {
  normalizeDcfCapture,
  type DcfCapture,
  type DcfScope,
  type DcfSnapshot,
} from "../lib/finops-dcf-execution-history.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

export interface DcfPersistenceScope {
  organizationId: string;
  customerId: string;
  connectionId: string;
}

interface DcfRow {
  generation_id: string;
  content_sha256: string;
  snapshot_json: string;
}

async function hash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class DcfRepository {
  constructor(private readonly db: D1Database = getRawDb()) {}

  private async live(scope: DcfPersistenceScope) {
    await ensureRuntimeSchema(this.db);
    const row = await this.db
      .prepare(
        "SELECT id FROM aws_connections WHERE org_id=? AND customer_id=? AND id=? AND status='active'",
      )
      .bind(scope.organizationId, scope.customerId, scope.connectionId)
      .first();
    if (!row) throw new Error("dcf-repository-rejected");
    return this.db;
  }

  async recordCapture(
    scope: DcfPersistenceScope,
    trusted: DcfScope,
    capture: DcfCapture,
    nowMs = Date.now(),
  ) {
    const snapshot = normalizeDcfCapture(capture, trusted, nowMs);
    if (
      trusted.orgId !== scope.organizationId ||
      trusted.customerId !== scope.customerId ||
      trusted.connectionId !== scope.connectionId
    ) {
      throw new Error("dcf-repository-rejected");
    }
    const json = JSON.stringify(snapshot);
    const sha = await hash(json);
    const id = `dcg_${sha}`;
    const db = await this.live(scope);
    const before = await this.getActive(scope);
    const statements = [
      db
        .prepare(
          "INSERT INTO finops_dcf_snapshots(generation_id,org_id,customer_id,connection_id,capture_id,complete,provider_access,content_sha256,snapshot_json,completed_at,module_count,execution_count,created_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)ON CONFLICT DO NOTHING",
        )
        .bind(
          id,
          scope.organizationId,
          scope.customerId,
          scope.connectionId,
          snapshot.captureId,
          snapshot.complete ? 1 : 0,
          snapshot.providerAccess,
          sha,
          json,
          snapshot.completedAt,
          snapshot.modules.length,
          snapshot.modules.reduce(
            (total, moduleEntry) => total + moduleEntry.executions.length,
            0,
          ),
          nowMs,
        ),
    ];
    if (snapshot.complete) {
      statements.push(
        db
          .prepare(
            "INSERT INTO finops_dcf_heads(org_id,customer_id,connection_id,active_generation_id,advanced_at)VALUES(?,?,?,?,?)ON CONFLICT(org_id,customer_id,connection_id)DO UPDATE SET active_generation_id=excluded.active_generation_id,advanced_at=excluded.advanced_at WHERE EXISTS(SELECT 1 FROM finops_dcf_snapshots c JOIN finops_dcf_snapshots a ON a.generation_id=finops_dcf_heads.active_generation_id WHERE c.generation_id=excluded.active_generation_id AND c.completed_at>a.completed_at)",
          )
          .bind(
            scope.organizationId,
            scope.customerId,
            scope.connectionId,
            id,
            nowMs,
          ),
      );
    }
    await db.batch(statements);
    const active = await this.getActive(scope);
    return {
      generationId: id,
      contentSha256: sha,
      snapshot,
      becameActive:
        active?.generationId === id && before?.generationId !== id,
    };
  }

  async getActive(scope: DcfPersistenceScope) {
    const db = await this.live(scope);
    const row = await db
      .prepare(
        "SELECT s.* FROM finops_dcf_heads h JOIN finops_dcf_snapshots s ON s.generation_id=h.active_generation_id WHERE h.org_id=? AND h.customer_id=? AND h.connection_id=?",
      )
      .bind(scope.organizationId, scope.customerId, scope.connectionId)
      .first<DcfRow>();
    return row
      ? {
          generationId: row.generation_id,
          contentSha256: row.content_sha256,
          snapshot: JSON.parse(row.snapshot_json) as DcfSnapshot,
        }
      : null;
  }

  async listAcceptedHistory(scope: DcfPersistenceScope) {
    const db = await this.live(scope);
    const rows = await db
      .prepare(
        "SELECT * FROM finops_dcf_snapshots WHERE org_id=? AND customer_id=? AND connection_id=? AND complete=1 ORDER BY completed_at",
      )
      .bind(scope.organizationId, scope.customerId, scope.connectionId)
      .all<DcfRow>();
    return (rows.results ?? []).map((row) => ({
      generationId: row.generation_id,
      contentSha256: row.content_sha256,
      snapshot: JSON.parse(row.snapshot_json) as DcfSnapshot,
    }));
  }
}
