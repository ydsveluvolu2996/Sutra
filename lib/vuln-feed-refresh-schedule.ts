/**
 * Decides which CVE feeds a scheduled refresh should pull, and bounds the work so
 * it can run inside the request runtime.
 *
 * ── WHY THIS SPLITS THE FEEDS ───────────────────────────────────────────────
 * The three upstream feeds are wildly different sizes, and the runtime cannot
 * treat them alike:
 *
 *   CISA KEV  ~1.3k CVEs   — small, and the HIGHEST-signal feed: KEV membership
 *                            is the top ranking term in the vulnerability queue,
 *                            so a day's staleness here mis-ranks real risk.
 *   NVD       windowed     — bounded by a lastModified date window.
 *   EPSS      ~349k rows   — a full-file bulk load.
 *
 * `db/postgres-d1-adapter.ts` opens and closes a connection PER QUERY, because
 * workerd forbids reusing a socket across requests. At the script's CHUNK of 500
 * rows, EPSS is ~700 chunks and therefore ~700 connections in one invocation.
 * That is not a tuning problem; it is the wrong place to do a bulk load.
 *
 * So: the scheduled in-runtime job refreshes KEV and a bounded NVD window, and
 * EPSS bulk stays a host-scheduled `pnpm vuln:feeds:refresh`. This planner makes
 * that split explicit and refuses to plan work it cannot finish, rather than
 * timing out halfway and leaving a partially-updated mirror that looks fresh.
 */

export type VulnFeedId = "kev" | "nvd" | "epss";

export interface FeedState {
  readonly feed: VulnFeedId;
  /** The feed's own asOf stamp as stored, or null when never ingested. */
  readonly asOfMs: number | null;
  /** Rows currently attributed to this feed, used to bound the write. */
  readonly rowCount: number;
}

export interface FeedRefreshPolicy {
  /** A feed older than this is due. Default 24h — feeds publish daily. */
  readonly staleAfterMs?: number;
  /**
   * Hard ceiling on rows one in-runtime refresh may write. Exists because of the
   * per-query-connection adapter, not because of upstream limits.
   */
  readonly maxRowsInRuntime?: number;
  /** How far back to ask NVD for modified CVEs. */
  readonly nvdWindowDays?: number;
}

export type FeedDecision =
  | { readonly feed: VulnFeedId; readonly action: "refresh"; readonly reason: string; readonly nvdWindowDays?: number }
  | { readonly feed: VulnFeedId; readonly action: "skip"; readonly reason: string }
  | { readonly feed: VulnFeedId; readonly action: "defer-to-host"; readonly reason: string };

export interface FeedRefreshPlan {
  readonly schema: "sutra.vuln-feed-refresh-plan.v1";
  readonly decisions: readonly FeedDecision[];
  readonly summary: {
    readonly refreshing: number;
    readonly skipped: number;
    readonly deferredToHost: number;
    /** True when any feed is stale AND cannot be refreshed in-runtime. */
    readonly needsHostRun: boolean;
  };
  /** Stated so the UI/audit can repeat it verbatim rather than paraphrasing. */
  readonly disclaimer: string;
}

export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/**
 * 25k rows ≈ 50 chunks at the script's CHUNK of 500. Comfortably inside one
 * invocation, and far below EPSS's ~349k so the ceiling can never be mistaken
 * for "EPSS fits".
 */
export const DEFAULT_MAX_ROWS_IN_RUNTIME = 25_000;
export const DEFAULT_NVD_WINDOW_DAYS = 3;

/** Feeds that are small enough to refresh inside the request runtime. */
const IN_RUNTIME_FEEDS: readonly VulnFeedId[] = ["kev", "nvd"];

const DISCLAIMER =
  "Scheduled refresh covers CISA KEV and a bounded NVD modified-window only. "
  + "The EPSS full-file mirror (~349k rows) is a bulk load and stays on the host "
  + "schedule (pnpm vuln:feeds:refresh): the request runtime opens one connection "
  + "per query, so a bulk load there would exhaust the invocation and leave the "
  + "mirror partially updated while appearing fresh.";

export function planVulnFeedRefresh(
  states: readonly FeedState[],
  policy: FeedRefreshPolicy = {},
  nowMs: number = 0,
): FeedRefreshPlan {
  const staleAfter = Math.max(60_000, policy.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  const maxRows = Math.max(1, policy.maxRowsInRuntime ?? DEFAULT_MAX_ROWS_IN_RUNTIME);
  const nvdWindowDays = Math.max(1, Math.min(120, policy.nvdWindowDays ?? DEFAULT_NVD_WINDOW_DAYS));

  const byFeed = new Map<VulnFeedId, FeedState>();
  for (const state of states) byFeed.set(state.feed, state);

  const decisions: FeedDecision[] = [];
  for (const feed of ["kev", "nvd", "epss"] as const) {
    const state = byFeed.get(feed);
    // Never ingested counts as stale. A missing feed is the strongest reason to
    // run, not a reason to skip for lack of a baseline.
    const asOf = state?.asOfMs ?? null;
    const ageMs = asOf === null ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - asOf);
    const stale = ageMs >= staleAfter;

    if (!IN_RUNTIME_FEEDS.includes(feed)) {
      decisions.push({
        feed,
        action: "defer-to-host",
        reason: stale
          ? `stale (${asOf === null ? "never ingested" : `${Math.floor(ageMs / 3_600_000)}h old`}) and too large for the request runtime`
          : "fresh; bulk load belongs on the host schedule regardless",
      });
      continue;
    }

    if (!stale) {
      decisions.push({ feed, action: "skip", reason: `fresh (${Math.floor(ageMs / 3_600_000)}h old)` });
      continue;
    }

    // Bounded even for the small feeds: an upstream that suddenly grew must not
    // silently turn this into a bulk load.
    if ((state?.rowCount ?? 0) > maxRows) {
      decisions.push({
        feed,
        action: "defer-to-host",
        reason: `${state?.rowCount ?? 0} rows exceeds the ${maxRows}-row in-runtime ceiling`,
      });
      continue;
    }

    decisions.push({
      feed,
      action: "refresh",
      reason: asOf === null ? "never ingested" : `stale (${Math.floor(ageMs / 3_600_000)}h old)`,
      ...(feed === "nvd" ? { nvdWindowDays } : {}),
    });
  }

  const count = (action: FeedDecision["action"]): number => decisions.filter((entry) => entry.action === action).length;
  const deferredStale = decisions.some(
    (entry) => entry.action === "defer-to-host" && /stale|never ingested|exceeds/u.test(entry.reason),
  );

  return {
    schema: "sutra.vuln-feed-refresh-plan.v1",
    decisions,
    summary: {
      refreshing: count("refresh"),
      skipped: count("skip"),
      deferredToHost: count("defer-to-host"),
      // Surfaced so an operator learns EPSS needs a host run from the audit
      // trail, instead of discovering it when rankings look wrong.
      needsHostRun: deferredStale,
    },
    disclaimer: DISCLAIMER,
  };
}

/** Feeds this plan will actually fetch in-runtime. */
export function feedsToRefresh(plan: FeedRefreshPlan): readonly VulnFeedId[] {
  return plan.decisions.filter((entry) => entry.action === "refresh").map((entry) => entry.feed);
}
