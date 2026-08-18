// Persistence for agentless snapshot scanning: the run ledger, metadata-only
// findings, and teardown debt.
//
// Two invariants this file exists to enforce:
//
// 1. Tenant scoping on EVERY read. Every statement carries both org_id AND
//    customer_id, even where the primary key alone would find the row — a run id
//    is not a capability. (The one deliberate exception is the sweeper's
//    org-wide debt listing, which is org-scoped by design and documented below.)
// 2. Teardown debt is never lost. A snapshot Sutra created and failed to delete
//    bills the customer every hour it survives, so completeRun() records it as a
//    durable row inside the same call that records the findings. If the caller
//    forgets to look at teardownFailures, the debt still exists.
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import type { AgentlessScanExecution } from "../services/aws-collector/src/scan-runner.ts";
import type { AgentlessScanPlan } from "../lib/aws-agentless-scan-plan";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const RUN_ID = /^ags_[a-f0-9]{32}$/u;
const AWS_ACCOUNT = /^\d{12}$/u;
const MAX_LIST_ROWS = 200;
const MAX_FINDINGS_PER_RUN = 5_000;
const MAX_PLAN_BYTES = 512 * 1024;

export type AgentlessRunStatus = "planned" | "running" | "completed" | "failed";

export interface AgentlessScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface StoredAgentlessRun {
  readonly id: string;
  readonly connectionId: string;
  readonly status: AgentlessRunStatus;
  readonly scanAccountId: string;
  readonly scanners: readonly string[];
  readonly kmsReencrypt: boolean;
  readonly snapshotTtlHours: number;
  readonly volumesInScope: number;
  readonly volumesSkipped: number;
  readonly volumesScanned: number;
  readonly volumesFailed: number;
  readonly findingsCount: number;
  readonly resourcesToreDown: number;
  readonly teardownFailures: number;
  readonly error: string | null;
  readonly requestedBy: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

export interface StoredAgentlessFinding {
  readonly id: string;
  readonly volumeId: string;
  readonly instanceId: string | null;
  readonly region: string;
  readonly scanner: string;
  readonly severity: string;
  readonly title: string;
  readonly cveId: string | null;
  readonly packageName: string | null;
  readonly packageVersion: string | null;
  readonly fixedVersion: string | null;
  readonly location: string | null;
}

export interface StoredTeardownDebt {
  readonly id: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly runId: string;
  readonly resourceKind: "snapshot" | "volume" | "instance";
  readonly resourceId: string;
  readonly region: string;
  readonly accountScope: "customer" | "sutra-scan-account";
  readonly attempts: number;
  readonly lastError: string | null;
  readonly firstSeenAt: string;
  readonly lastAttemptAt: string;
}

interface RunRow {
  id: string; connection_id: string; status: string; scan_account_id: string;
  scanners_json: string; kms_reencrypt: number; snapshot_ttl_hours: number;
  volumes_in_scope: number; volumes_skipped: number; volumes_scanned: number;
  volumes_failed: number; findings_count: number; resources_tore_down: number;
  teardown_failures: number; error: string | null; requested_by: string | null;
  started_at: string | number | null; finished_at: string | number | null;
  created_at: string | number;
}

export class AgentlessScanRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "RUN_NOT_FOUND" | "ILLEGAL_TRANSITION" | "PLAN_UNREADABLE";
  public constructor(code: AgentlessScanRepositoryError["code"]) {
    super("Agentless-scan operation rejected");
    this.name = "AgentlessScanRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new AgentlessScanRepositoryError("INVALID_INPUT");
}

function toIso(value: string | number | null): string | null {
  if (value === null) return null;
  if (typeof value === "number") return new Date(value).toISOString();
  return /^\d+$/u.test(value) ? new Date(Number(value)).toISOString() : value;
}

function parseScanners(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function toStoredRun(row: RunRow): StoredAgentlessRun {
  const status: AgentlessRunStatus =
    row.status === "planned" || row.status === "running" || row.status === "completed" || row.status === "failed"
      ? row.status
      : "failed";
  return {
    id: row.id,
    connectionId: row.connection_id,
    status,
    scanAccountId: row.scan_account_id,
    scanners: parseScanners(row.scanners_json),
    kmsReencrypt: Number(row.kms_reencrypt) === 1,
    snapshotTtlHours: Number(row.snapshot_ttl_hours),
    volumesInScope: Number(row.volumes_in_scope),
    volumesSkipped: Number(row.volumes_skipped),
    volumesScanned: Number(row.volumes_scanned),
    volumesFailed: Number(row.volumes_failed),
    findingsCount: Number(row.findings_count),
    resourcesToreDown: Number(row.resources_tore_down),
    teardownFailures: Number(row.teardown_failures),
    error: row.error,
    requestedBy: row.requested_by,
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    createdAt: toIso(row.created_at) as string,
  };
}

/** Severity of a raw finding, clamped to the stored vocabulary. */
function clampSeverity(value: string): string {
  const lower = value.toLowerCase();
  return lower === "critical" || lower === "high" || lower === "medium" || lower === "low" ? lower : "unknown";
}

async function findingId(
  runId: string,
  volumeId: string,
  index: number,
): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${runId}\u0000${volumeId}\u0000${index}`),
  );
  const hex = [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `agf_${hex.slice(0, 48)}`;
}

export class AgentlessScanRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  private assertScope(scope: AgentlessScope): void {
    if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) invalid();
  }

  /**
   * Record a reviewed plan as a run in `planned`. Nothing has been created in
   * AWS at this point — the row exists so that an apply is always traceable to
   * the exact plan a human approved.
   */
  public async createRun(
    scope: AgentlessScope,
    input: {
      readonly connectionId: string;
      readonly plan: AgentlessScanPlan;
      readonly requestedBy?: string | null;
    },
    now = Date.now(),
  ): Promise<StoredAgentlessRun> {
    this.assertScope(scope);
    if (!CONNECTION_ID.test(input.connectionId)) invalid();
    if (!AWS_ACCOUNT.test(input.plan.scanAccountId)) invalid();
    const planJson = JSON.stringify(input.plan);
    if (planJson.length > MAX_PLAN_BYTES) invalid();
    const db = await this.ready();

    // The connection must belong to this tenant. Taking the customer from the
    // authorized scope and re-checking ownership means a caller cannot aim a
    // scan at somebody else's account by passing its connection id.
    const owned = await db.prepare(
      `SELECT id FROM aws_connections WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(input.connectionId, scope.orgId, scope.customerId).first<{ id: string }>();
    if (owned === null || owned === undefined) throw new AgentlessScanRepositoryError("SCOPE_NOT_FOUND");

    const id = `ags_${crypto.randomUUID().replaceAll("-", "")}`;
    await db.prepare(
      `INSERT INTO agentless_scan_runs (
         id, org_id, customer_id, connection_id, status, scan_account_id, scanners_json,
         kms_reencrypt, snapshot_ttl_hours, volumes_in_scope, volumes_skipped,
         plan_json, requested_by, created_at
       ) VALUES (?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, scope.orgId, scope.customerId, input.connectionId,
      input.plan.scanAccountId, JSON.stringify(input.plan.scanners),
      input.plan.kmsReencrypt ? 1 : 0, input.plan.summary.snapshotTtlHours,
      input.plan.summary.inScope, input.plan.summary.skipped,
      planJson, input.requestedBy ?? null, now,
    ).run();

    const created = await this.getRun(scope, id);
    if (created === null) throw new AgentlessScanRepositoryError("RUN_NOT_FOUND");
    return created;
  }

  /**
   * The EXACT plan that was approved for this run.
   *
   * Applying must replay what a human reviewed, never a plan re-derived at apply time
   * from inventory that may have changed — that would silently widen scope. Scoped by
   * org AND customer like every other read: a run id is not a capability.
   */
  public async getRunPlan(scope: AgentlessScope, runId: string): Promise<AgentlessScanPlan | null> {
    this.assertScope(scope);
    if (!RUN_ID.test(runId)) invalid();
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT plan_json FROM agentless_scan_runs WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(runId, scope.orgId, scope.customerId).first<{ plan_json: string }>();
    if (row === null || row === undefined) return null;
    try {
      return JSON.parse(row.plan_json) as AgentlessScanPlan;
    } catch {
      // A stored plan that will not parse must never be silently replaced by a guess.
      throw new AgentlessScanRepositoryError("PLAN_UNREADABLE");
    }
  }

  /** planned -> running. Refuses any other source state so a completed run is never re-opened. */
  public async markRunning(scope: AgentlessScope, runId: string, now = Date.now()): Promise<void> {
    this.assertScope(scope);
    if (!RUN_ID.test(runId)) invalid();
    const db = await this.ready();
    const current = await db.prepare(
      `SELECT status FROM agentless_scan_runs WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(runId, scope.orgId, scope.customerId).first<{ status: string }>();
    if (current === null || current === undefined) throw new AgentlessScanRepositoryError("RUN_NOT_FOUND");
    if (current.status !== "planned") throw new AgentlessScanRepositoryError("ILLEGAL_TRANSITION");
    await db.prepare(
      `UPDATE agentless_scan_runs SET status = 'running', started_at = ?
         WHERE id = ? AND org_id = ? AND customer_id = ? AND status = 'planned'`,
    ).bind(now, runId, scope.orgId, scope.customerId).run();
  }

  /**
   * Terminal write for a run: counters, findings, and — critically — one durable
   * debt row per resource whose teardown failed, all from the single execution
   * object the runner returned. Findings are capped; the cap is reported in the
   * stored count so a truncated run is never mistaken for a small one.
   */
  public async completeRun(
    scope: AgentlessScope,
    runId: string,
    execution: AgentlessScanExecution,
    context: {
      readonly connectionId: string;
      readonly regionByVolumeId?: Readonly<Record<string, string>>;
      readonly instanceByVolumeId?: Readonly<Record<string, string>>;
      readonly error?: string | null;
    },
    now = Date.now(),
  ): Promise<void> {
    this.assertScope(scope);
    if (!RUN_ID.test(runId)) invalid();
    if (!CONNECTION_ID.test(context.connectionId)) invalid();
    const db = await this.ready();
    const current = await db.prepare(
      `SELECT status FROM agentless_scan_runs WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(runId, scope.orgId, scope.customerId).first<{ status: string }>();
    if (current === null || current === undefined) throw new AgentlessScanRepositoryError("RUN_NOT_FOUND");
    if (current.status === "completed" || current.status === "failed") {
      // A signed broker terminal result may be reconciled concurrently by two
      // browser sessions. Terminal state is immutable, so an already-terminal
      // row is an exact safe no-op rather than a reason to reopen it.
      return;
    }

    const regions = context.regionByVolumeId ?? {};
    const instances = context.instanceByVolumeId ?? {};

    // Findings first: if the process dies midway, an under-counted run with real
    // findings is safer than a complete-looking run with none.
    let written = 0;
    for (const result of execution.results) {
      for (const [findingIndex, finding] of result.findings.entries()) {
        if (written >= MAX_FINDINGS_PER_RUN) break;
        written += 1;
        await db.prepare(
          `INSERT INTO agentless_scan_findings (
             id, org_id, customer_id, run_id, volume_id, instance_id, region,
             scanner, severity, title, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
        ).bind(
          await findingId(runId, result.volumeId, findingIndex),
          scope.orgId, scope.customerId, runId, result.volumeId,
          instances[result.volumeId] ?? null, regions[result.volumeId] ?? "unknown",
          finding.source, clampSeverity(finding.severity), finding.title.slice(0, 500), now,
        ).run();
      }
    }

    // Then the outstanding resources. Two distinct kinds, both billable:
    //
    //  * teardownFailures — Sutra tried to delete its OWN scan-account resource
    //    and failed. The sweeper retries these.
    //  * cleanupHandoff — the customer-account source snapshot, which Sutra has
    //    no permission to delete at all. The customer's lifecycle policy reaps
    //    it. The sweeper never retries these; it only reports them until an
    //    AWS describe proves the snapshot is gone.
    //
    // Both are recorded so that "what is this scan still costing?" has one
    // answer, regardless of whose job the cleanup is.
    const outstanding: readonly {
      readonly volumeId: string;
      readonly resourceId: string;
      readonly kind: "snapshot" | "volume" | "instance";
      readonly owner: "sutra" | "customer";
      readonly region?: string;
      readonly note: string;
    }[] = execution.results.flatMap((result) => result.teardownDebt !== undefined
      ? result.teardownDebt.map((debt) => ({
        volumeId: result.volumeId,
        resourceId: debt.resourceId,
        kind: debt.resourceKind,
        owner: debt.accountScope === "customer" ? "customer" as const : "sutra" as const,
        region: debt.region,
        note: debt.error,
      }))
      : [
        ...result.teardownFailures.map((resourceId) => ({
          volumeId: result.volumeId,
          resourceId,
          kind: resourceId.startsWith("vol-") ? "volume" as const : "snapshot" as const,
          owner: "sutra" as const,
          region: regions[result.volumeId] ?? "unknown",
          note: result.error ?? "teardown failed",
        })),
        ...result.cleanupHandoff.map((resourceId) => ({
          volumeId: result.volumeId,
          resourceId,
          kind: "snapshot" as const,
          owner: "customer" as const,
          region: regions[result.volumeId] ?? "unknown",
          note: "awaiting the customer-owned lifecycle policy; Sutra cannot delete it",
        })),
      ]);
    for (const entry of outstanding) {
      {
        const result = { volumeId: entry.volumeId, error: entry.note };
        const resourceId = entry.resourceId;
        await db.prepare(
          `INSERT INTO agentless_teardown_debt (
             id, org_id, customer_id, connection_id, run_id, resource_kind, resource_id,
             region, account_scope, attempts, last_error, first_seen_at, last_attempt_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT (org_id, resource_kind, resource_id) DO UPDATE SET
             attempts = agentless_teardown_debt.attempts + 1,
             last_attempt_at = excluded.last_attempt_at,
             last_error = excluded.last_error`,
        ).bind(
          `agd_${crypto.randomUUID().replaceAll("-", "")}`,
          scope.orgId, scope.customerId, context.connectionId, runId, entry.kind, resourceId,
          entry.region ?? regions[result.volumeId] ?? "unknown",
          entry.owner === "sutra" ? "sutra-scan-account" : "customer",
          entry.note, now, now,
        ).run();
      }
    }

    const status: AgentlessRunStatus =
      context.error != null || execution.summary.scanned === 0 && execution.summary.failed > 0 ? "failed" : "completed";
    await db.prepare(
      `UPDATE agentless_scan_runs SET
         status = ?, volumes_scanned = ?, volumes_failed = ?, findings_count = ?,
         resources_tore_down = ?, teardown_failures = ?, error = ?, finished_at = ?
       WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(
      status, execution.summary.scanned, execution.summary.failed, written,
      execution.summary.resourcesToreDown, execution.summary.teardownFailures,
      context.error ?? null, now, runId, scope.orgId, scope.customerId,
    ).run();
  }

  public async listRuns(scope: AgentlessScope, connectionId?: string): Promise<readonly StoredAgentlessRun[]> {
    this.assertScope(scope);
    if (connectionId !== undefined && !CONNECTION_ID.test(connectionId)) invalid();
    const db = await this.ready();
    const columns = `id, connection_id, status, scan_account_id, scanners_json, kms_reencrypt,
      snapshot_ttl_hours, volumes_in_scope, volumes_skipped, volumes_scanned, volumes_failed,
      findings_count, resources_tore_down, teardown_failures, error, requested_by,
      started_at, finished_at, created_at`;
    const rows = connectionId === undefined
      ? await db.prepare(
          `SELECT ${columns} FROM agentless_scan_runs
             WHERE org_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT ?`,
        ).bind(scope.orgId, scope.customerId, MAX_LIST_ROWS).all<RunRow>()
      : await db.prepare(
          `SELECT ${columns} FROM agentless_scan_runs
             WHERE org_id = ? AND customer_id = ? AND connection_id = ?
             ORDER BY created_at DESC LIMIT ?`,
        ).bind(scope.orgId, scope.customerId, connectionId, MAX_LIST_ROWS).all<RunRow>();
    return (rows.results ?? []).map(toStoredRun);
  }

  public async getRun(scope: AgentlessScope, runId: string): Promise<StoredAgentlessRun | null> {
    this.assertScope(scope);
    if (!RUN_ID.test(runId)) invalid();
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT id, connection_id, status, scan_account_id, scanners_json, kms_reencrypt,
              snapshot_ttl_hours, volumes_in_scope, volumes_skipped, volumes_scanned,
              volumes_failed, findings_count, resources_tore_down, teardown_failures,
              error, requested_by, started_at, finished_at, created_at
         FROM agentless_scan_runs WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(runId, scope.orgId, scope.customerId).first<RunRow>();
    return row === null || row === undefined ? null : toStoredRun(row);
  }

  public async listFindings(scope: AgentlessScope, runId: string): Promise<readonly StoredAgentlessFinding[]> {
    this.assertScope(scope);
    if (!RUN_ID.test(runId)) invalid();
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT id, volume_id, instance_id, region, scanner, severity, title,
              cve_id, package_name, package_version, fixed_version, location
         FROM agentless_scan_findings
         WHERE org_id = ? AND customer_id = ? AND run_id = ?
         ORDER BY CASE severity
                    WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
                    WHEN 'low' THEN 3 ELSE 4 END ASC, volume_id ASC, title ASC
         LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, runId, MAX_FINDINGS_PER_RUN).all<{
      id: string; volume_id: string; instance_id: string | null; region: string;
      scanner: string; severity: string; title: string; cve_id: string | null;
      package_name: string | null; package_version: string | null;
      fixed_version: string | null; location: string | null;
    }>();
    return (rows.results ?? []).map((row) => ({
      id: row.id, volumeId: row.volume_id, instanceId: row.instance_id, region: row.region,
      scanner: row.scanner, severity: row.severity, title: row.title, cveId: row.cve_id,
      packageName: row.package_name, packageVersion: row.package_version,
      fixedVersion: row.fixed_version, location: row.location,
    }));
  }

  /**
   * Open teardown debt for the whole org. Deliberately org-scoped rather than
   * customer-scoped: the sweeper is a system actor reconciling Sutra's own
   * billable leftovers across every tenant it created them for, and a
   * per-customer sweep would strand debt for customers nobody happens to open.
   */
  public async listOpenTeardownDebt(orgId: string, limit = MAX_LIST_ROWS): Promise<readonly StoredTeardownDebt[]> {
    if (!IDENTIFIER.test(orgId)) invalid();
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT id, customer_id, connection_id, run_id, resource_kind, resource_id, region,
              account_scope, attempts, last_error, first_seen_at, last_attempt_at
         FROM agentless_teardown_debt
         WHERE org_id = ? AND resolved_at IS NULL
         ORDER BY first_seen_at ASC LIMIT ?`,
    ).bind(orgId, Math.max(1, Math.min(MAX_LIST_ROWS, limit))).all<{
      id: string; customer_id: string; connection_id: string; run_id: string;
      resource_kind: string; resource_id: string; region: string; account_scope: string;
      attempts: number; last_error: string | null;
      first_seen_at: string | number; last_attempt_at: string | number;
    }>();
    return (rows.results ?? []).map((row) => ({
      id: row.id, customerId: row.customer_id, connectionId: row.connection_id,
      runId: row.run_id,
      resourceKind:
        row.resource_kind === "volume"
          ? "volume"
          : row.resource_kind === "instance"
            ? "instance"
            : "snapshot",
      resourceId: row.resource_id,
      region: row.region,
      accountScope:
        row.account_scope === "customer" || row.account_scope === "sutra-scan-account"
          ? row.account_scope
          : invalid(),
      attempts: Number(row.attempts), lastError: row.last_error,
      firstSeenAt: toIso(row.first_seen_at) as string,
      lastAttemptAt: toIso(row.last_attempt_at) as string,
    }));
  }

  /** Customer-facing debt view. Unlike the system sweeper above, this query
   * carries both tenant dimensions so one assigned customer cannot observe
   * another customer's AWS resource ids, regions, or cleanup failures. */
  public async listOpenTeardownDebtForCustomer(
    scope: AgentlessScope,
    limit = MAX_LIST_ROWS,
  ): Promise<readonly StoredTeardownDebt[]> {
    this.assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT id, customer_id, connection_id, run_id, resource_kind, resource_id, region,
              account_scope, attempts, last_error, first_seen_at, last_attempt_at
         FROM agentless_teardown_debt
         WHERE org_id = ? AND customer_id = ? AND resolved_at IS NULL
         ORDER BY first_seen_at ASC LIMIT ?`,
    ).bind(scope.orgId, scope.customerId, Math.max(1, Math.min(MAX_LIST_ROWS, limit))).all<{
      id: string; customer_id: string; connection_id: string; run_id: string;
      resource_kind: string; resource_id: string; region: string; account_scope: string;
      attempts: number; last_error: string | null;
      first_seen_at: string | number; last_attempt_at: string | number;
    }>();
    return (rows.results ?? []).map((row) => ({
      id: row.id, customerId: row.customer_id, connectionId: row.connection_id,
      runId: row.run_id,
      resourceKind:
        row.resource_kind === "volume"
          ? "volume"
          : row.resource_kind === "instance"
            ? "instance"
            : "snapshot",
      resourceId: row.resource_id,
      region: row.region,
      accountScope:
        row.account_scope === "customer" || row.account_scope === "sutra-scan-account"
          ? row.account_scope
          : invalid(),
      attempts: Number(row.attempts), lastError: row.last_error,
      firstSeenAt: toIso(row.first_seen_at) as string,
      lastAttemptAt: toIso(row.last_attempt_at) as string,
    }));
  }

  /** Mark debt settled — only ever called after the resource is proven gone. */
  public async resolveTeardownDebt(orgId: string, resourceId: string, now = Date.now()): Promise<boolean> {
    if (!IDENTIFIER.test(orgId) || !IDENTIFIER.test(resourceId)) invalid();
    const db = await this.ready();
    await db.prepare(
      `UPDATE agentless_teardown_debt SET resolved_at = ?
         WHERE org_id = ? AND resource_id = ? AND resolved_at IS NULL`,
    ).bind(now, orgId, resourceId).run();
    // D1's `meta.changes` is not portably typed across the D1/Postgres adapters,
    // so settlement is confirmed by re-reading rather than by an affected-row
    // count — a debt row must never be reported settled on a guess.
    const still = await db.prepare(
      `SELECT id FROM agentless_teardown_debt
         WHERE org_id = ? AND resource_id = ? AND resolved_at IS NULL`,
    ).bind(orgId, resourceId).first<{ id: string }>();
    return still === null || still === undefined;
  }

  /** Record a failed sweep attempt without settling the debt. */
  public async recordTeardownAttempt(orgId: string, resourceId: string, error: string, now = Date.now()): Promise<void> {
    if (!IDENTIFIER.test(orgId) || !IDENTIFIER.test(resourceId)) invalid();
    const db = await this.ready();
    await db.prepare(
      `UPDATE agentless_teardown_debt
         SET attempts = attempts + 1, last_attempt_at = ?, last_error = ?
         WHERE org_id = ? AND resource_id = ? AND resolved_at IS NULL`,
    ).bind(now, error.slice(0, 500), orgId, resourceId).run();
  }
}
