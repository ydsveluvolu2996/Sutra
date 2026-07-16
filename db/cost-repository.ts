import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import { canonicalJson } from "../lib/canonical-json";
import { parseAwsCostSnapshot } from "../lib/cost-boundary";
import type { AwsCostSnapshot, StoredCostSnapshot } from "../lib/cost-types";

interface CostSnapshotRow {
  id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  aws_account_id: string;
  payload_json: string;
  payload_sha256: string;
  collected_at: number;
  created_at: number;
}

export async function persistCostSnapshot(input: {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly payload: AwsCostSnapshot;
}): Promise<StoredCostSnapshot> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  const payloadJson = canonicalJson(input.payload);
  if (payloadJson.length > 512 * 1024) throw new Error("The normalized cost snapshot exceeds its persistence limit");
  const payloadSha256 = await sha256Hex(payloadJson);
  const id = `cost_${crypto.randomUUID().replaceAll("-", "")}`;
  const status = input.payload.status.toLocaleLowerCase("en-US");
  const collectedAt = Date.parse(input.payload.collectedAt);
  await db.prepare(
    `INSERT INTO cost_snapshots
      (id, org_id, customer_id, connection_id, source, status, currency,
       period_start, period_end, collected_at, payload_json, payload_sha256)
     SELECT ?, ?, ?, ?, 'aws_cost_explorer', ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM aws_connections
         WHERE id = ? AND org_id = ? AND customer_id = ?
           AND aws_account_id = ? AND source_kind = 'aws_trust_role'
      )`,
  ).bind(
    id,
    input.orgId,
    input.customerId,
    input.connectionId,
    status,
    input.payload.currency,
    input.payload.periodStart,
    input.payload.periodEnd,
    collectedAt,
    payloadJson,
    payloadSha256,
    input.connectionId,
    input.orgId,
    input.customerId,
    input.payload.accountId,
  ).run();
  const stored = await getCostSnapshotById(input.orgId, input.customerId, input.connectionId, id);
  if (stored === null) throw new Error("The scoped cost snapshot could not be persisted");
  return stored;
}

export async function getLatestCostSnapshot(input: {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
}): Promise<StoredCostSnapshot | null> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  const row = await db.prepare(
    `SELECT s.id, s.org_id, s.customer_id, s.connection_id, c.aws_account_id,
            s.payload_json, s.payload_sha256, s.collected_at, s.created_at
       FROM cost_snapshots s
       JOIN aws_connections c ON c.id = s.connection_id AND c.org_id = s.org_id
        AND c.customer_id = s.customer_id
      WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ?
      ORDER BY s.collected_at DESC, s.id DESC
      LIMIT 1`,
  ).bind(input.orgId, input.customerId, input.connectionId).first<CostSnapshotRow>();
  return row === null ? null : toStoredSnapshot(row);
}

async function getCostSnapshotById(
  orgId: string,
  customerId: string,
  connectionId: string,
  id: string,
): Promise<StoredCostSnapshot | null> {
  const db = getRawDb();
  const row = await db.prepare(
    `SELECT s.id, s.org_id, s.customer_id, s.connection_id, c.aws_account_id,
            s.payload_json, s.payload_sha256, s.collected_at, s.created_at
       FROM cost_snapshots s
       JOIN aws_connections c ON c.id = s.connection_id AND c.org_id = s.org_id
        AND c.customer_id = s.customer_id
      WHERE s.org_id = ? AND s.customer_id = ? AND s.connection_id = ? AND s.id = ?
      LIMIT 1`,
  ).bind(orgId, customerId, connectionId, id).first<CostSnapshotRow>();
  return row === null ? null : toStoredSnapshot(row);
}

function toStoredSnapshot(row: CostSnapshotRow): StoredCostSnapshot {
  const parsed = JSON.parse(row.payload_json) as unknown;
  return {
    id: row.id,
    orgId: row.org_id,
    customerId: row.customer_id,
    connectionId: row.connection_id,
    payload: parseAwsCostSnapshot(parsed, row.aws_account_id),
    payloadSha256: row.payload_sha256,
    collectedAt: new Date(Number(row.collected_at)).toISOString(),
    createdAt: new Date(Number(row.created_at)).toISOString(),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}
