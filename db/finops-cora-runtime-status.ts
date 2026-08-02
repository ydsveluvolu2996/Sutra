/** Read-only CORA collection status derived from the durable queue and immutable export attempts. */
import { getRawDb } from "./index.ts";
import { ensureRuntimeSchema } from "./runtime-migrations.ts";
import { CORA_EXPORT_MATERIALIZATION_JOB_KIND } from "../lib/finops-cora-export-orchestration.ts";
import type { CoraExportObjectScope } from "./finops-cora-export-object-repository.ts";

export type CoraRuntimeStatus = { readonly state: "unavailable" | "collecting" | "failed" | "ready"; readonly reason: string; readonly lastAttemptAt: string | null };
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u; const CONNECTION = /^conn_[a-f0-9]{32}$/u;
interface Row { readonly status: "queued" | "leased" | "succeeded" | "failed" | "dead_letter"; readonly updated_at: number | string; readonly last_error: string | null; }
export class CoraRuntimeStatusRepository {
  public constructor(private readonly database: D1Database = getRawDb()) {}
  public async getStatus(scope: CoraExportObjectScope): Promise<CoraRuntimeStatus> {
    if (!SAFE.test(scope.organizationId) || !SAFE.test(scope.customerId) || !CONNECTION.test(scope.connectionId)) throw new Error("CORA_RUNTIME_STATUS_INVALID"); await ensureRuntimeSchema(this.database);
    const row = await this.database.prepare(`SELECT j.status,j.updated_at,j.last_error FROM background_jobs j JOIN aws_connections c ON c.id=j.connection_id AND c.org_id=j.org_id AND c.customer_id=j.customer_id JOIN organizations o ON o.id=c.org_id AND o.status='active' JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status IN ('active','trial') WHERE j.org_id=? AND j.customer_id=? AND j.connection_id=? AND j.kind=? AND c.source_kind='aws_trust_role' AND c.status='active' ORDER BY j.updated_at DESC,j.id DESC LIMIT 1`).bind(scope.organizationId, scope.customerId, scope.connectionId, CORA_EXPORT_MATERIALIZATION_JOB_KIND).first<Row>();
    if (row === null) return { state: "unavailable", reason: "CORA_COLLECTION_NOT_STARTED", lastAttemptAt: null }; const at = Number(row.updated_at); if (!Number.isSafeInteger(at) || at < 0) throw new Error("CORA_RUNTIME_STATUS_INVALID"); const lastAttemptAt = new Date(at).toISOString();
    if (row.status === "queued" || row.status === "leased") return { state: "collecting", reason: row.status === "queued" ? "CORA_COLLECTION_QUEUED" : "CORA_COLLECTION_IN_PROGRESS", lastAttemptAt };
    if (row.status === "failed" || row.status === "dead_letter") return { state: "failed", reason: row.status === "dead_letter" ? "CORA_COLLECTION_RETRIES_EXHAUSTED" : "CORA_COLLECTION_FAILED_RETRY_PENDING", lastAttemptAt };
    const accepted = await this.database.prepare(`SELECT complete,source_state FROM finops_cora_export_object_generations WHERE org_id=? AND customer_id=? AND connection_id=? ORDER BY created_at DESC,generation_id DESC LIMIT 1`).bind(scope.organizationId, scope.customerId, scope.connectionId).first<{ readonly complete: number | string; readonly source_state: string }>();
    return accepted !== null && Number(accepted.complete) === 1 ? { state: "ready", reason: "CORA_COLLECTION_READY", lastAttemptAt }
      : { state: "unavailable", reason: accepted?.source_state === "WAITING_DELIVERY" ? "CORA_EXPORT_WAITING_DELIVERY" : "CORA_COMPLETE_EXPORT_NOT_ACCEPTED", lastAttemptAt };
  }
}
