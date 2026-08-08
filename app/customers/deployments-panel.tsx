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

// Exactly the states connectionHealth() derives, in escalation order. It
// previously omitted `validating` and `needs_attention` and carried an `error`
// state that is never produced -- so aging, stale, failed-validation and
// in-progress rows could not be selected at all, and a queue holding only
// healthy plus needs-attention rows showed no status controls, because just one
// listed state counted as present.
const STATUS_ORDER = ["active", "validating", "pending", "needs_attention", "disabled"] as const;

const STATUS_LABEL: Readonly<Record<(typeof STATUS_ORDER)[number], string>> = {
  active: "Active",
  validating: "Validating",
  pending: "Pending",
  needs_attention: "Needs attention",
  disabled: "Disabled",
};

function statusLabel(state: string): string {
  return STATUS_LABEL[state as (typeof STATUS_ORDER)[number]]
    // A state outside the map is shown as-is rather than capitalised into a
    // plausible-looking label that hides the fact it was never expected.
    ?? state.replace(/_/gu, " ");
}

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
  const presentStatuses = useMemo(
    () => STATUS_ORDER.filter((candidate) => decorated.some((row) => row.health.state === candidate)),
    [decorated],
  );

  const search = query.trim().toLocaleLowerCase("en-US");
  const visible = decorated.filter((row) =>
    (kind === "all" || row.connection.sourceKind === kind)
    && (status === "all" || row.health.state === status)
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

      {presentKinds.length > 1 ? (
        <div className="deployments-tabs" role="tablist" aria-label="Deployment kind">
          <button aria-selected={kind === "all"} onClick={() => setKind("all")} role="tab" type="button">
            All<em>{decorated.length}</em>
          </button>
          {presentKinds.map((candidate) => (
            <button
              aria-selected={kind === candidate}
              key={candidate}
              onClick={() => setKind(candidate)}
              role="tab"
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
            <button data-active={status === "all" ? "true" : undefined} onClick={() => setStatus("all")} type="button">
              Any status
            </button>
            {presentStatuses.map((candidate) => (
              <button
                data-active={status === candidate ? "true" : undefined}
                key={candidate}
                onClick={() => setStatus(candidate)}
                type="button"
              >
                {statusLabel(candidate)}
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
