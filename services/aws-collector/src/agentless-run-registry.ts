/**
 * In-memory state for agentless scans running inside this collector process.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 * A scan takes minutes: snapshot copy, instance boot, Trivy database download, scan,
 * teardown. The collector server sets `requestTimeout = 190_000`, so a synchronous
 * execute would time out mid-scan — with a snapshot AND an instance already created
 * and billing, and no caller left to reap them. That is the worst failure available
 * here, so execution is started and polled instead.
 *
 * ── WHY NOT A DURABLE QUEUE ─────────────────────────────────────────────────
 * The collector's DurableLocalJobQueue exists only in fixture mode (`localJobs` is
 * null when live), and the collector cannot reach Postgres — the Worker owns the run
 * rows. So this process tracks execution and the Worker polls, then persists.
 *
 * ── THE HONEST LIMITATION ───────────────────────────────────────────────────
 * This state is memory-only. If the collector restarts mid-scan the entry is gone,
 * and a poll reports UNKNOWN rather than inventing an outcome — because the AWS
 * resources may well still exist. UNKNOWN means "check AWS", not "it failed" and
 * certainly not "it finished clean". The instance's own shutdown trap and the
 * snapshot TTL are what stop an orphan billing forever; this registry is not a
 * substitute for either.
 */

export type AgentlessRunPhase = "running" | "completed" | "failed";

export interface AgentlessRunState {
  readonly runId: string;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly phase: AgentlessRunPhase;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** Present only when phase is "completed". */
  readonly execution: unknown | null;
  /** Present only when phase is "failed". */
  readonly error: { readonly code: string; readonly message: string } | null;
}

export class AgentlessRunRegistry {
  private readonly runs = new Map<string, AgentlessRunState>();

  private readonly now: () => Date;

  public constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /**
   * Claims a run id for execution. Refuses a second claim while one is running, so a
   * retried POST cannot start a second scan of the same run — which would double the
   * snapshots, the instances and the bill.
   */
  public claim(input: {
    readonly runId: string;
    readonly tenantId: string;
    readonly connectionId: string;
  }): AgentlessRunState {
    const existing = this.runs.get(input.runId);
    if (existing !== undefined && existing.phase === "running") {
      throw new AgentlessRunAlreadyRunningError(input.runId);
    }
    const state: AgentlessRunState = {
      runId: input.runId,
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      phase: "running",
      startedAt: this.now().toISOString(),
      finishedAt: null,
      execution: null,
      error: null,
    };
    this.runs.set(input.runId, state);
    return state;
  }

  public complete(runId: string, execution: unknown): void {
    const existing = this.runs.get(runId);
    if (existing === undefined) return;
    this.runs.set(runId, {
      ...existing,
      phase: "completed",
      finishedAt: this.now().toISOString(),
      execution,
    });
  }

  public fail(runId: string, error: { readonly code: string; readonly message: string }): void {
    const existing = this.runs.get(runId);
    if (existing === undefined) return;
    this.runs.set(runId, {
      ...existing,
      phase: "failed",
      finishedAt: this.now().toISOString(),
      error,
    });
  }

  /**
   * Reads state for a run the caller is entitled to. Scope is checked HERE rather
   * than by the caller: a run id is not a capability, and a poll from the wrong
   * tenant must be indistinguishable from a run that does not exist.
   */
  public read(
    runId: string,
    scope: { readonly tenantId: string; readonly connectionId: string },
  ): AgentlessRunState | null {
    const state = this.runs.get(runId);
    if (state === undefined) return null;
    if (state.tenantId !== scope.tenantId || state.connectionId !== scope.connectionId) return null;
    return state;
  }

  /** Only for tests and shutdown accounting. */
  public runningCount(): number {
    let count = 0;
    for (const state of this.runs.values()) if (state.phase === "running") count += 1;
    return count;
  }
}

export class AgentlessRunAlreadyRunningError extends Error {
  public readonly runId: string;

  public constructor(runId: string) {
    super(
      `agentless run ${runId} is already executing in this collector; refusing to start a second `
      + "scan of the same run, which would double the snapshots and the bill",
    );
    this.name = "AgentlessRunAlreadyRunningError";
    this.runId = runId;
  }
}
