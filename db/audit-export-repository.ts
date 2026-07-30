import type { AuditExportEvent } from "../lib/audit-export.ts";
import { getRawDb } from "./index.ts";
import { ensureRuntimeSchema } from "./runtime-migrations.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;

export async function listAuditEventsForOrg(
  orgId: string,
  database: D1Database = getRawDb(),
): Promise<readonly AuditExportEvent[]> {
  if (!IDENTIFIER.test(orgId)) throw new Error("Invalid audit organization scope");
  await ensureRuntimeSchema(database);
  const rows = await database.prepare(
    `SELECT id, org_id, customer_id, occurred_at, actor_type, actor_id, action,
            target_type, target_id, outcome, request_id, metadata_json,
            previous_event_hash, event_hash, hash_version
       FROM audit_events
      WHERE org_id = ?
      ORDER BY occurred_at ASC, id ASC`,
  ).bind(orgId).all<{
    id: string;
    org_id: string;
    customer_id: string | null;
    occurred_at: number;
    actor_type: "user" | "service" | "system";
    actor_id: string;
    action: string;
    target_type: string;
    target_id: string | null;
    outcome: "allowed" | "denied" | "failed";
    request_id: string;
    metadata_json: string;
    previous_event_hash: string | null;
    event_hash: string;
    hash_version: number;
  }>();
  return (rows.results ?? []).map((row) => ({
    eventId: row.id,
    orgId: row.org_id,
    customerId: row.customer_id,
    occurredAt: Number(row.occurred_at),
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    outcome: row.outcome,
    requestId: row.request_id,
    metadataJson: row.metadata_json,
    previousEventHash: row.previous_event_hash,
    eventHash: row.event_hash,
    hashVersion: row.hash_version === 2 ? 2 : 1,
  }));
}
