import { LOCAL_RETENTION, retentionCutoff } from "../lib/retention-policy.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;

export interface RetentionSweepResult {
  readonly apiTokenUsage: number;
  readonly securityEvents: number;
  readonly idempotencyKeys: number;
  readonly immutableTablesTouched: false;
}

export class RetentionSweepRepository {
  private readonly database: D1Database;
  public constructor(database: D1Database = getRawDb()) { this.database = database; }

  public async sweep(orgId: string, now = Date.now()): Promise<RetentionSweepResult> {
    if (!IDENTIFIER.test(orgId) || !Number.isFinite(now)) {
      throw Object.assign(new Error("The retention sweep request is invalid"), { code: "INVALID_INPUT" });
    }
    await ensureRuntimeSchema(this.database);
    const usageCutoff = new Date(retentionCutoff(LOCAL_RETENTION.apiTokenUsageDays, now)).toISOString().slice(0, 16);
    const eventCutoff = retentionCutoff(LOCAL_RETENTION.securityEventsDays, now);
    const idempotencyCutoff = new Date(retentionCutoff(LOCAL_RETENTION.idempotencyKeysDays, now)).toISOString();
    const [usage, events, keys] = await this.database.batch([
      this.database.prepare(
        `DELETE FROM api_token_usage
          WHERE minute_bucket < ? AND token_id IN (SELECT id FROM api_tokens WHERE org_id = ?)`,
      ).bind(usageCutoff, orgId),
      this.database.prepare(`DELETE FROM security_events WHERE org_id = ? AND event_time < ?`).bind(orgId, eventCutoff),
      this.database.prepare(`DELETE FROM api_idempotency_keys WHERE org_id = ? AND created_at < ?`).bind(orgId, idempotencyCutoff),
    ]);
    return {
      apiTokenUsage: Number(usage.meta?.changes ?? 0),
      securityEvents: Number(events.meta?.changes ?? 0),
      idempotencyKeys: Number(keys.meta?.changes ?? 0),
      immutableTablesTouched: false,
    };
  }
}
