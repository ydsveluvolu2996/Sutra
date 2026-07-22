// Durable store for platform health probe samples (`uptime_samples`). This is
// SYSTEM/platform health, NOT tenant data — rows carry no org_id and are never
// tenant-scoped. The system-scoped platform ticker writes one sample per
// component per slot via recordSamples(); the /status route reads them back with
// listRecent()/summarize() and the pure engine (lib/uptime-status.ts) derives
// current status + uptime % strictly from what was recorded.
//
// The dual D1/Postgres access mirrors the other repositories: one D1Database
// interface, `?` placeholders, and SQL that both dialects accept (see
// db/finops-unit-count-repository.ts for the same pattern). observed_at is
// stored as an ISO-8601 UTC string so lexicographic ordering equals
// chronological ordering.
import {
  buildStatusReport,
  UPTIME_COMPONENT_KEYS,
  type StatusReport,
  type UptimeSample,
  type UptimeSampleInput,
} from "../lib/uptime-status.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

// A ten-minute probe cadence records at most 17,856 rows across four components
// over the 31-day lookback, leaving bounded headroom for the complete 30-day
// window without allowing an unbounded public-status read.
const MAX_READ_ROWS = 20_000;
// Reads for the status page never need more than the widest window plus slack.
const DEFAULT_LOOKBACK_MS = 31 * 24 * 60 * 60 * 1000;

interface UptimeSampleRow {
  id: string;
  component: string;
  observed_at: string;
  healthy: number;
  detail: string | null;
  created_at: string;
}

export class UptimeRepositoryError extends Error {
  public readonly code: "INVALID_INPUT";

  public constructor() {
    super("Uptime sample operation rejected");
    this.name = "UptimeRepositoryError";
    this.code = "INVALID_INPUT";
  }
}

function invalid(): never {
  throw new UptimeRepositoryError();
}

function toSample(row: UptimeSampleRow): UptimeSample {
  return {
    component: row.component,
    observedAt: row.observed_at,
    healthy: Number(row.healthy) === 1,
    detail: row.detail,
  };
}

function assertKnownComponent(component: string): void {
  if (!UPTIME_COMPONENT_KEYS.includes(component)) invalid();
}

function sampleId(component: string, timestamp: string): string {
  const compactTimestamp = timestamp.replaceAll(/[-:.TZ]/gu, "");
  return `usmp_${component.replaceAll("-", "_")}_${compactTimestamp}`;
}

export class UptimeRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  /** Persist a single probe observation. Rejects an unknown component key. */
  public async recordSample(input: UptimeSampleInput, now = Date.now()): Promise<void> {
    await this.recordSamples([input], now);
  }

  /**
   * Persist a batch of probe observations in one round trip. All samples share
   * the same observed_at/created_at so a probe run is one coherent snapshot.
   * The optional idempotency slot produces deterministic primary keys while
   * preserving the truthful observation timestamp. An unknown or repeated
   * component rejects the whole batch before any write.
   */
  public async recordSamples(
    inputs: readonly UptimeSampleInput[],
    now = Date.now(),
    idempotencySlotMs = now,
  ): Promise<number> {
    if (!Number.isFinite(now) || !Number.isFinite(idempotencySlotMs)) invalid();
    if (inputs.length === 0) return 0;
    const components = new Set<string>();
    for (const input of inputs) {
      assertKnownComponent(input.component);
      if (components.has(input.component)) invalid();
      components.add(input.component);
    }
    const db = await this.ready();
    const timestamp = new Date(now).toISOString();
    const idempotencyTimestamp = new Date(idempotencySlotMs).toISOString();
    const statements = inputs.map((input) =>
      db.prepare(
        `INSERT OR IGNORE INTO uptime_samples (id, component, observed_at, healthy, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        // The deterministic primary key makes one component/time bucket
        // idempotent across overlapping runner ticks and multiple replicas.
        sampleId(input.component, idempotencyTimestamp),
        input.component,
        timestamp,
        input.healthy ? 1 : 0,
        input.detail,
        timestamp,
      ),
    );
    const results = await db.batch(statements);
    return results.reduce((total, result) => total + Number(result.meta?.changes ?? 0), 0);
  }

  /** Whether all canonical component ids exist for one idempotency slot. */
  public async hasCompleteProbeSlot(slotMs: number): Promise<boolean> {
    if (!Number.isFinite(slotMs)) invalid();
    const db = await this.ready();
    const slotTimestamp = new Date(slotMs).toISOString();
    const ids = UPTIME_COMPONENT_KEYS.map((component) => sampleId(component, slotTimestamp));
    const placeholders = ids.map(() => "?").join(", ");
    const row = await db.prepare(
      `SELECT COUNT(*) AS total FROM uptime_samples WHERE id IN (${placeholders})`,
    ).bind(...ids).first<{ total: number }>();
    return Number(row?.total ?? 0) === UPTIME_COMPONENT_KEYS.length;
  }

  /** Delete samples older than the bounded history retained by the status page. */
  public async pruneBefore(cutoffMs: number): Promise<number> {
    if (!Number.isFinite(cutoffMs)) invalid();
    const db = await this.ready();
    const cutoff = new Date(cutoffMs).toISOString();
    const results = await db.batch(UPTIME_COMPONENT_KEYS.map((component) =>
      // Keep `component` first so the existing compound lookup index can bound
      // each retention delete efficiently in both D1 and PostgreSQL.
      db.prepare(
        `DELETE FROM uptime_samples WHERE component = ? AND observed_at < ?`,
      ).bind(component, cutoff),
    ));
    return results.reduce((total, result) => total + Number(result.meta?.changes ?? 0), 0);
  }

  /**
   * List recorded samples, newest first. Optionally filtered to one component
   * and/or to samples observed at or after `sinceMs` (defaults to the last 31
   * days so the 30d window is always covered).
   */
  public async listRecent(
    options: { readonly component?: string; readonly sinceMs?: number; readonly limit?: number } = {},
    now = Date.now(),
  ): Promise<readonly UptimeSample[]> {
    if (!Number.isFinite(now)) invalid();
    if (options.component !== undefined) assertKnownComponent(options.component);
    const limit = options.limit ?? MAX_READ_ROWS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_ROWS) invalid();
    const sinceMs = options.sinceMs ?? now - DEFAULT_LOOKBACK_MS;
    if (!Number.isFinite(sinceMs)) invalid();
    const since = new Date(sinceMs).toISOString();
    const db = await this.ready();
    const rows = options.component === undefined
      ? await db.prepare(
        `SELECT id, component, observed_at, healthy, detail, created_at
           FROM uptime_samples
          WHERE observed_at >= ?
          ORDER BY observed_at DESC LIMIT ?`,
      ).bind(since, limit).all<UptimeSampleRow>()
      : await db.prepare(
        `SELECT id, component, observed_at, healthy, detail, created_at
           FROM uptime_samples
          WHERE component = ? AND observed_at >= ?
          ORDER BY observed_at DESC LIMIT ?`,
      ).bind(options.component, since, limit).all<UptimeSampleRow>();
    return (rows.results ?? []).map(toSample);
  }

  /**
   * Read the recent samples and hand them to the pure engine to produce the
   * full status report (current status + uptime % per window). Honest by
   * construction: components with no recorded sample come back "unknown".
   */
  public async summarize(now = Date.now()): Promise<StatusReport> {
    const recorded = await this.listRecent({}, now);
    return buildStatusReport({ recorded, now });
  }
}
