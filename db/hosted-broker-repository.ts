import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import type { HostedBrokerReplayStore } from "../lib/hosted-broker-request-security";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;

/**
 * The org scope for a hosted broker ingestion request, resolved ENTIRELY from
 * trusted server state (the persisted connection row), never from anything the
 * caller supplied. The connection id is only a lookup key; the authoritative
 * organization (tenant) and customer come from the database. This is the load
 * -bearing tenant-isolation guarantee for the ingestion endpoint: a request can
 * only ever be scoped to the org that actually owns the referenced connection.
 */
export interface HostedBrokerConnectionScope {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly customerId: string;
}

export async function resolveHostedBrokerConnectionScope(
  connectionId: string,
  db: D1Database = getRawDb(),
): Promise<HostedBrokerConnectionScope | null> {
  if (typeof connectionId !== "string" || !IDENTIFIER.test(connectionId)) return null;
  await ensureRuntimeSchema(db);
  const row = await db.prepare(
    `SELECT c.id AS connection_id, c.org_id AS org_id, c.customer_id AS customer_id
       FROM aws_connections c
       JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
       JOIN customers cu ON cu.id = c.customer_id AND cu.org_id = c.org_id
        AND cu.status IN ('active', 'trial')
      WHERE c.id = ? AND c.status = 'active'
      LIMIT 1`,
  ).bind(connectionId).first<{ connection_id: string; org_id: string; customer_id: string }>();
  if (row === null) return null;
  return { tenantId: row.org_id, connectionId: row.connection_id, customerId: row.customer_id };
}

/**
 * Durable, atomic nonce store for hosted broker replay protection. Unlike the
 * in-memory adapter (test/single-process only), this survives restarts and is
 * shared by every worker instance because the conditional INSERT is executed by
 * the database. The expired-sweep and the reservation run in one D1 batch so the
 * reserve decision is atomic.
 *
 * NOTE: the backing table `hosted_broker_replay_nonces` ships as migration files
 * (drizzle 0047 / postgres 0041) that the parent registers. Until it is
 * registered, `consume` throws and the verifier fails closed — never open.
 */
export class D1HostedBrokerReplayStore implements HostedBrokerReplayStore {
  private readonly database: D1Database;
  private readonly now: () => number;

  public constructor(database: D1Database = getRawDb(), now: () => number = Date.now) {
    this.database = database;
    this.now = now;
  }

  public async consume(key: string, expiresAt: number): Promise<boolean> {
    if (typeof key !== "string" || key.length === 0 || key.length > 256 || !Number.isSafeInteger(expiresAt)) {
      return false;
    }
    const db = this.database;
    const results = await db.batch([
      db.prepare(`DELETE FROM hosted_broker_replay_nonces WHERE expires_at <= ?`).bind(this.now()),
      db.prepare(
        `INSERT OR IGNORE INTO hosted_broker_replay_nonces (nonce_key, expires_at) VALUES (?, ?)`,
      ).bind(key, expiresAt),
    ]);
    return Number(results[1]?.meta?.changes ?? 0) === 1;
  }
}
