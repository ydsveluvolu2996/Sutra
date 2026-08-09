"use client";

import { useMemo, useState } from "react";
import { formatTimestamp } from "../components/use-pilot-state";
import { isAllEnabledAwsRegionSelection } from "../../lib/aws-region-selection.ts";
import { connectionHealth, evidenceSourceLabel, snapshotFreshness } from "../../lib/portfolio-presentation.ts";
import type { PortfolioConnectionSummary } from "../../lib/portfolio-types";

/**
 * The deployment operating queue.
 *
 * This replaced a static five-column table. Everything it shows still comes
 * from the same server-scoped portfolio read -- the filters narrow rows that
 * were already returned, so no filter can widen what the browser can see.
 *
 * Tabs and status filters are derived from the rows actually present rather
 * than declared up front. A tab that can never match anything is chrome that
 * teaches operators to stop reading tabs, and an empty "Access keys" tab would
 * also imply Sutra had looked and found none when the portfolio projection does
 * not carry that source kind at all.
 */

export interface DeploymentRow {
  readonly customerName: string;
  readonly connection: PortfolioConnectionSummary;
}

// Keyed by the type, so a new source kind fails the build here rather than
// silently losing its tab: a deployment whose kind has no entry is reachable
// only under "All", and selecting any other tab hides it entirely.
const KIND_LABEL: Readonly<Record<PortfolioConnectionSummary["sourceKind"], string>> = {
  aws_trust_role: "Cloud",
  aws_static_credentials: "Access keys",
  simulated_fixture: "Simulated",
};

/**
 * Filter chips are keyed on the health *label*, not the health state.
 *
 * `connectionHealth()` maps several labels onto one state: `needs_attention`
 * carries "Needs attention", "Stale" and "No baseline", and `validating` carries
 * both "Validating" and "Aging". Chips built from states therefore spoke a
 * different vocabulary than the rows -- a chip reading "Validating" selected
 * rows that all read "Aging", and "Stale" and "No baseline" had no chip at all
 * despite being the two states an operator most needs to isolate.
 *
 * Filtering on the label the row actually displays means a chip can never
 * select rows that disagree with it.
 */
const LABEL_ORDER = [
  "Healthy",
  "Aging",
  "Validating",
  "Pending",
  "Stale",
  "No baseline",
  "Needs attention",
  "Disabled",
] as const;

export function DeploymentsPanel({
  canOnboard,
  measuredAt,
  rows,
}: {
  readonly canOnboard: boolean;
  readonly measuredAt: string;
  readonly rows: readonly DeploymentRow[];
}) {
  const [kind, setKind] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [query, setQuery] = useState("");

  // Health is recomputed per row rather than stored, so a row's tab, chip and
  // pill can never disagree about the same connection.
  const decorated = useMemo(() => rows.map((row) => ({
    ...row,
    health: connectionHealth(row.connection, measuredAt),
    source: evidenceSourceLabel(row.connection),
    freshness: snapshotFreshness(row.connection.latestSnapshotAt, measuredAt),
  })), [measuredAt, rows]);

  const presentKinds = useMemo(
    () => (Object.keys(KIND_LABEL) as PortfolioConnectionSummary["sourceKind"][])
      .filter((candidate) => decorated.some((row) => row.connection.sourceKind === candidate)),
    [decorated],
  );
  // Any label the rows carry but LABEL_ORDER does not list is appended rather
  // than dropped, so a new health label loses its position in the escalation
  // order without becoming unselectable.
  const presentStatuses = useMemo(() => {
    const present = new Set(decorated.map((row) => row.health.label));
    const ordered = LABEL_ORDER.filter((candidate) => present.has(candidate));
    const unlisted = [...present].filter((label) => !LABEL_ORDER.includes(label as (typeof LABEL_ORDER)[number]));
    return [...ordered, ...unlisted.sort((left, right) => left.localeCompare(right, "en-US"))];
  }, [decorated]);

  const search = query.trim().toLocaleLowerCase("en-US");
  const visible = decorated.filter((row) =>
    (kind === "all" || row.connection.sourceKind === kind)
    && (status === "all" || row.health.label === status)
    && (search === ""
      || row.customerName.toLocaleLowerCase("en-US").includes(search)
      || row.connection.awsAccountId.includes(search)));

  const filtered = kind !== "all" || status !== "all" || search !== "";

  return (
    <section className="panel deployments-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Operating queue</p><h2>Deployments</h2></div>
        {canOnboard ? <a href="/onboard" className="button button-primary">Add deployment</a> : null}
      </div>

      {/* Buttons, not tabs. `role="tablist"` promises `aria-controls`, a
          matching `tabpanel`, roving tabindex and arrow-key traversal; these
          have none of that, and a screen reader announcing "tab 2 of 3" that
          does not respond to arrow keys is worse than an honest button. They
          filter rows in place, so `aria-pressed` states what they do. */}
      {presentKinds.length > 1 ? (
        <div className="deployments-tabs" role="group" aria-label="Deployment kind">
          <button aria-pressed={kind === "all"} onClick={() => setKind("all")} type="button">
            All<em>{decorated.length}</em>
          </button>
          {presentKinds.map((candidate) => (
            <button
              aria-pressed={kind === candidate}
              key={candidate}
              onClick={() => setKind(candidate)}
              type="button"
            >
              {KIND_LABEL[candidate]}
              <em>{decorated.filter((row) => row.connection.sourceKind === candidate).length}</em>
            </button>
          ))}
        </div>
      ) : null}

      <div className="deployments-toolbar" role="group" aria-label="Deployment filters">
        <label className="deployments-search">
          <span className="sr-only">Search deployments by customer or AWS account</span>
          <input
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search customer or account…"
            spellCheck={false}
            type="search"
            value={query}
          />
        </label>
        {presentStatuses.length > 1 ? (
          <div className="deployments-chips">
            {/* Same reasoning as the kind filter: the pressed state is real
                information and must be announced, not only painted. */}
            <button aria-pressed={status === "all"} data-active={status === "all" ? "true" : undefined} onClick={() => setStatus("all")} type="button">
              Any status
            </button>
            {presentStatuses.map((candidate) => (
              <button
                aria-pressed={status === candidate}
                data-active={status === candidate ? "true" : undefined}
                key={candidate}
                onClick={() => setStatus(candidate)}
                type="button"
              >
                {candidate}
              </button>
            ))}
          </div>
        ) : null}
        <span className="deployments-count">
          {visible.length} of {decorated.length} {decorated.length === 1 ? "deployment" : "deployments"}
        </span>
        {filtered ? (
          <button
            className="deployments-reset"
            onClick={() => { setKind("all"); setStatus("all"); setQuery(""); }}
            type="button"
          >
            Reset
          </button>
        ) : null}
      </div>

      <div className="data-table deployments-table" role="table" aria-label="Cloud account deployments">
        <div className="data-row data-header" role="row">
          <span>Deployment</span><span>Status</span><span>Findings</span>
          <span>Source</span><span>Coverage</span><span>Last activity</span>
        </div>
        {visible.map((row) => {
          const scope = `connectionId=${encodeURIComponent(row.connection.id)}`;
          return (
            <div className="data-row" role="row" key={row.connection.id}>
              <span className="primary-cell">
                <a className="resource-link" href={`/cmdb?${scope}`}>
                  <strong>{row.customerName}</strong>
                  <small>{row.connection.awsAccountId} · {row.connection.partition}</small>
                </a>
              </span>
              <span className="primary-cell">
                <span className={`connection-status connection-${row.health.state}`}>{row.health.label}</span>
                <small>{row.health.detail}</small>
              </span>
              <span className="primary-cell">
                <a className="text-link" href={`/findings?${scope}`}>
                  {row.connection.openFindingCount.toLocaleString()} open
                </a>
                <small>{row.connection.resourceCount.toLocaleString()} assets</small>
              </span>
              <span className="primary-cell">
                <strong>{row.source.label}</strong>
                <small>{row.source.detail}</small>
              </span>
              <span className="primary-cell">
                <strong>
                  {isAllEnabledAwsRegionSelection(row.connection.enabledRegions)
                    ? "All enabled Regions"
                    : `${row.connection.enabledRegions.length} explicit Regions`}
                </strong>
                <small>{row.connection.permissionPackVersion}</small>
              </span>
              <span className="primary-cell">
                <strong>{row.freshness.label}</strong>
                <small>{formatTimestamp(row.connection.latestSnapshotAt)}</small>
              </span>
            </div>
          );
        })}
        {visible.length === 0 ? (
          <div className="deployments-empty" role="status">
            No deployment matches these filters. {decorated.length} exist in your scope.
          </div>
        ) : null}
      </div>

      <p className="panel-footnote">
        Health is derived only from persisted connection state and complete-snapshot age. It is an
        operating signal, not a security, compliance, or risk score.
      </p>
    </section>
  );
}
