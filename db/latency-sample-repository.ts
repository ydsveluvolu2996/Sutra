// Repository for tenant-scoped endpoint latency samples. Any external source —
// a CloudWatch metric exporter, an APM agent, a synthetic monitor — POSTs
// observed latencies (response / application / database) per endpoint; the
// reachability-latency engine then aggregates them into status bands. Samples
// are facts, never fabricated: an endpoint with no samples stays UNKNOWN. Every
// write is gated to a customer the acting organization owns, and reads are
// scope-filtered and bounded so one tenant never sees another's timings.
import type { LatencyKind, LatencySample } from "../lib/reachability-latency.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ENDPOINT_REF = /^[A-Za-z0-9][A-Za-z0-9 ._:@/#+-]{0,255}$/u;
const KINDS = new Set<LatencyKind>(["response", "application", "database"]);
const MAX_BATCH = 1_000;
const MAX_MILLISECONDS = 3_600_000; // one hour — a latency beyond this is not a real observation
const DEFAULT_READ_LIMIT = 20_000;

export interface LatencyTenantScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface LatencySampleInput {
  readonly endpointRef: string;
  readonly kind: LatencyKind;
  readonly milliseconds: number;
  readonly observedAtMs?: number;
}

interface SampleRow {
  endpoint_ref: string;
  kind: string;
  milliseconds: number;
}

export class LatencySampleRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND";

  public constructor(code: LatencySampleRepositoryError["code"]) {
    super("Latency sample operation rejected");
    this.name = "LatencySampleRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new LatencySampleRepositoryError("INVALID_INPUT");
}

function assertScope(scope: LatencyTenantScope, connectionId: string): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId) || !CONNECTION_ID.test(connectionId)) invalid();
}

function normalize(sample: LatencySampleInput, now: number): { endpointRef: string; kind: LatencyKind; milliseconds: number; observedAt: number } {
  if (
    typeof sample.endpointRef !== "string" || !ENDPOINT_REF.test(sample.endpointRef) ||
    !KINDS.has(sample.kind) ||
    typeof sample.milliseconds !== "number" || !Number.isFinite(sample.milliseconds) ||
    sample.milliseconds < 0 || sample.milliseconds > MAX_MILLISECONDS
  ) invalid();
  let observedAt = now;
  if (sample.observedAtMs !== undefined) {
    if (!Number.isSafeInteger(sample.observedAtMs) || sample.observedAtMs < 0 || sample.observedAtMs > now + 300_000) invalid();
    observedAt = sample.observedAtMs;
  }
  // Store to millisecond precision as an integer; sub-millisecond noise is not signal.
  return { endpointRef: sample.endpointRef, kind: sample.kind, milliseconds: Math.round(sample.milliseconds), observedAt };
}

export class LatencySampleRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async ingest(
    scope: LatencyTenantScope,
    connectionId: string,
    samples: readonly LatencySampleInput[],
    now = Date.now(),
  ): Promise<number> {
    assertScope(scope, connectionId);
    if (!Array.isArray(samples) || samples.length === 0 || samples.length > MAX_BATCH) invalid();
    const normalized = samples.map((sample) => normalize(sample, now));
    const db = await this.ready();
    const statement = db.prepare(
      `INSERT INTO latency_samples
         (id, org_id, customer_id, connection_id, endpoint_ref, kind, milliseconds, observed_at)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?
         FROM customers c
        WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')`,
    );
    const batch = normalized.map((sample) => statement.bind(
      `lat_${crypto.randomUUID().replaceAll("-", "")}`,
      connectionId,
      sample.endpointRef,
      sample.kind,
      sample.milliseconds,
      sample.observedAt,
      scope.customerId,
      scope.orgId,
    ));
    const results = await db.batch(batch);
    const written = results.reduce((total, result) => total + Number(result.meta?.changes ?? 0), 0);
    // If the scope customer is not owned by the org, every insert's gating SELECT
    // matches nothing and no row is written — surface that rather than lying.
    if (written === 0) throw new LatencySampleRepositoryError("SCOPE_NOT_FOUND");
    return written;
  }

  public async recentForConnection(
    scope: LatencyTenantScope,
    connectionId: string,
    limit = DEFAULT_READ_LIMIT,
  ): Promise<readonly LatencySample[]> {
    assertScope(scope, connectionId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_READ_LIMIT) invalid();
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT endpoint_ref, kind, milliseconds FROM latency_samples
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
        ORDER BY observed_at DESC, id DESC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, connectionId, limit).all<SampleRow>();
    return (rows.results ?? []).flatMap((row) =>
      KINDS.has(row.kind as LatencyKind)
        ? [{ endpointRef: row.endpoint_ref, kind: row.kind as LatencyKind, milliseconds: Number(row.milliseconds) }]
        : []);
  }
}
