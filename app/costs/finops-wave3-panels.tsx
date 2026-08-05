"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CostAnomalyProviderAnalysis } from "../../lib/finops-aws-cost-anomaly";
import type { CostAnomalyOfficialDefinition } from "../../lib/finops-cost-anomaly-official-definition";
import styles from "./costs.module.css";

/* ----------------------------------------------------------------------------
 * Wave 3 FinOps panels: allocation rules ("virtual tags"), MSP margin, and
 * cost/budget alerts. Each panel reads its live engine result and — for the two
 * operator-configured features — offers a compact management control. All money
 * comes back from the API already in whole units; these panels never compute
 * spend, only display it.
 * ------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body
      ? String((body as { error: { message?: string } }).error?.message ?? "Request rejected") : "Request rejected";
    throw new Error(message);
  }
  return body as T;
}

async function sendJson<T>(path: string, method: string, payload: Json): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body
      ? String((body as { error: { message?: string } }).error?.message ?? "Request rejected") : "Request rejected";
    throw new Error(message);
  }
  return body as T;
}

function money(value: number, currency: string | null): string {
  if (!currency) return value.toFixed(2);
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency,
    minimumFractionDigits: Math.abs(value) >= 100 ? 0 : 2, maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2,
  }).format(value);
}

type CostAnomalyState = "complete" | "partial" | "stale" | "failed" | "waiting";

interface CostAnomalyResponse {
  readonly state: CostAnomalyState;
  readonly officialDefinition: CostAnomalyOfficialDefinition;
  readonly latestAttemptStatus: string | null;
  readonly collectedAt: string | null;
  readonly dataThroughAt: string | null;
  readonly freshness: { readonly ageHours: number | null; readonly staleAfterHours: number };
  readonly sutraInput: { readonly periods: readonly string[]; readonly lineCount: number; readonly capped: boolean };
  readonly dashboard: null | {
    readonly aws: {
      readonly status: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
      readonly windowStartDate: string;
      readonly windowEndDate: string;
      readonly coverage: readonly {
        readonly operation: string;
        readonly status: "SUCCEEDED" | "PARTIAL" | "FAILED";
        readonly pagesObserved: number;
        readonly recordsObserved: number;
        readonly recordsAccepted: number;
        readonly recordsRejected: number;
        readonly recordsOmitted: number;
        readonly errorCode: string | null;
      }[];
      readonly anomalies: readonly {
        readonly anomalyId: string;
        readonly startDate: string | null;
        readonly endDate: string | null;
        readonly feedback: string | null;
        readonly score: { readonly current: number; readonly maximum: number };
        readonly impact: {
          readonly maximum: number;
          readonly total: number | null;
          readonly actualSpend: number | null;
          readonly expectedSpend: number | null;
          readonly percentage: number | null;
        };
        readonly rootCauses: readonly {
          readonly service: string | null;
          readonly region: string | null;
          readonly linkedAccountId: string | null;
          readonly usageType: string | null;
          readonly contribution: number | null;
        }[];
        readonly rootCausesOmitted: number;
        readonly monitorType: "CUSTOM" | "DIMENSIONAL" | null;
        readonly monitorDimension: "SERVICE" | "LINKED_ACCOUNT" | "TAG" | "COST_CATEGORY" | null;
      }[];
      readonly monitors: readonly {
        readonly type: "CUSTOM" | "DIMENSIONAL";
        readonly dimension: "SERVICE" | "LINKED_ACCOUNT" | "TAG" | "COST_CATEGORY" | null;
        readonly specificationPresent: boolean;
        readonly dimensionalValueCount: number | null;
        readonly lastEvaluatedAt: string | null;
      }[];
      readonly subscriptions: readonly {
        readonly frequency: "IMMEDIATE" | "DAILY" | "WEEKLY";
        readonly threshold: number | null;
        readonly monitorCount: number;
        readonly monitorArnsOmitted: number;
        readonly thresholdExpressionPresent: boolean;
        readonly subscriberCounts: {
          readonly emailConfirmed: number;
          readonly emailDeclined: number;
          readonly snsConfirmed: number;
          readonly snsDeclined: number;
          readonly unknown: number;
        };
      }[];
      readonly disclaimer: string;
    };
    readonly sutra: {
      readonly anomalies: readonly {
        readonly dateIso: string;
        readonly service: string;
        readonly currency: string;
        readonly amountMicros: string;
        readonly baselineMicros: string;
        readonly ratio: number;
      }[];
      readonly evaluatedDays: number;
      readonly disclaimer: string;
    };
    readonly analysis: CostAnomalyProviderAnalysis;
    readonly disclaimer: string;
  };
}

function formatCostAnomalyTime(value: string | null): string {
  if (value === null) return "Not available";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function csvCell(value: string | number | null): string {
  const raw = value === null ? "" : String(value);
  const safe = /^[=+\-@]/u.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function anomalyLifecycle(endDate: string | null, today: string): "Open window" | "Window ended" {
  return endDate === null || endDate >= today ? "Open window" : "Window ended";
}

function anomalyAssessment(value: string | null): string {
  if (value === "YES") return "Accurate anomaly";
  if (value === "NO") return "Not an issue";
  if (value === "PLANNED_ACTIVITY") return "Planned activity";
  return "Not submitted";
}

export function AwsCostAnomalyPanel({ connectionId, initialData = null }: {
  connectionId: string;
  initialData?: CostAnomalyResponse | null;
}) {
  const [data, setData] = useState<CostAnomalyResponse | null>(initialData);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [minimumImpact, setMinimumImpact] = useState("0");
  const [minimumScore, setMinimumScore] = useState("0");
  const [serviceFilter, setServiceFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [regionFilter, setRegionFilter] = useState("all");
  const [usageTypeFilter, setUsageTypeFilter] = useState("all");
  const [assessmentFilter, setAssessmentFilter] = useState("all");
  const [monitorTypeFilter, setMonitorTypeFilter] = useState("all");
  const [lifecycleFilter, setLifecycleFilter] = useState("all");
  const [anomalySearch, setAnomalySearch] = useState("");
  const [sortBy, setSortBy] = useState("impact-desc");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await getJson<CostAnomalyResponse>(
        `/api/v1/finops/cost-anomaly?connectionId=${encodeURIComponent(connectionId)}`,
      );
      setData(response);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load AWS anomaly evidence");
    }
  }, [connectionId]);

  useEffect(() => {
    let active = true;
    getJson<CostAnomalyResponse>(
      `/api/v1/finops/cost-anomaly?connectionId=${encodeURIComponent(connectionId)}`,
    ).then((response) => {
      if (active) {
        setData(response);
        setError(null);
      }
    }).catch((caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : "Could not load AWS anomaly evidence");
    });
    return () => { active = false; };
  }, [connectionId]);

  async function refresh(): Promise<void> {
    setRefreshing(true);
    setError(null);
    try {
      await sendJson<{ ok: true; jobId: string }>(
        "/api/v1/finops/cost-anomaly",
        "POST",
        { connectionId },
      );
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not queue AWS anomaly collection");
    } finally {
      setRefreshing(false);
    }
  }

  const dashboard = data?.dashboard ?? null;
  const state = data?.state ?? null;
  const ageHours = data?.freshness.ageHours ?? null;
  const stateLabel = state === null ? "Loading" : state.replaceAll("_", " ");
  const today = data?.collectedAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const filterOptions = useMemo(() => {
    const anomalies = dashboard?.aws.anomalies ?? [];
    const values = (selector: (anomaly: (typeof anomalies)[number]) => string | null) =>
      [...new Set(anomalies.flatMap((anomaly) => {
        const value = selector(anomaly);
        return value === null ? [] : [value];
      }))].sort((left, right) => left.localeCompare(right));
    return {
      services: [...new Set(anomalies.flatMap((anomaly) =>
        anomaly.rootCauses.flatMap((cause) => cause.service === null ? [] : [cause.service])))].sort(),
      accounts: [...new Set(anomalies.flatMap((anomaly) =>
        anomaly.rootCauses.flatMap((cause) => cause.linkedAccountId === null ? [] : [cause.linkedAccountId])))].sort(),
      regions: [...new Set(anomalies.flatMap((anomaly) =>
        anomaly.rootCauses.flatMap((cause) => cause.region === null ? [] : [cause.region])))].sort(),
      usageTypes: [...new Set(anomalies.flatMap((anomaly) =>
        anomaly.rootCauses.flatMap((cause) => cause.usageType === null ? [] : [cause.usageType])))].sort(),
      monitorTypes: values((anomaly) => anomaly.monitorType ?? null),
    };
  }, [dashboard]);
  const filteredAnomalies = useMemo(() => {
    const threshold = Number(minimumImpact);
    const safeThreshold = Number.isFinite(threshold) && threshold >= 0 ? threshold : 0;
    const score = Number(minimumScore);
    const safeScore = Number.isFinite(score) && score >= 0 && score <= 100 ? score : 0;
    const search = anomalySearch.trim().toLocaleLowerCase("en-US");
    const selected = (dashboard?.aws.anomalies ?? []).filter((anomaly) => {
      const lifecycle = anomalyLifecycle(anomaly.endDate, today);
      const overlapsStart = startDate.length === 0
        || (anomaly.endDate ?? today) >= startDate;
      const overlapsEnd = endDate.length === 0
        || (anomaly.startDate !== null && anomaly.startDate <= endDate);
      return (safeThreshold === 0
          || (anomaly.impact.total !== null && anomaly.impact.total >= safeThreshold))
        && anomaly.score.current >= safeScore
        && (serviceFilter === "all" || anomaly.rootCauses.some((cause) => cause.service === serviceFilter))
        && (accountFilter === "all" || anomaly.rootCauses.some((cause) => cause.linkedAccountId === accountFilter))
        && (regionFilter === "all" || anomaly.rootCauses.some((cause) => cause.region === regionFilter))
        && (usageTypeFilter === "all" || anomaly.rootCauses.some((cause) => cause.usageType === usageTypeFilter))
        && (assessmentFilter === "all" || (anomaly.feedback ?? "NOT_SUBMITTED") === assessmentFilter)
        && (monitorTypeFilter === "all" || anomaly.monitorType === monitorTypeFilter)
        && (lifecycleFilter === "all" || lifecycle === lifecycleFilter)
        && (search.length === 0 || anomaly.anomalyId.toLocaleLowerCase("en-US").includes(search))
        && overlapsStart
        && overlapsEnd;
    });
    return selected.sort((left, right) => {
      if (sortBy === "start-desc") return (right.startDate ?? "").localeCompare(left.startDate ?? "");
      if (sortBy === "score-desc") return right.score.current - left.score.current;
      if (sortBy === "impact-percent-desc") return (right.impact.percentage ?? -Infinity) - (left.impact.percentage ?? -Infinity);
      return (right.impact.total ?? -Infinity) - (left.impact.total ?? -Infinity);
    });
  }, [accountFilter, anomalySearch, assessmentFilter, dashboard, endDate, lifecycleFilter,
    minimumImpact, minimumScore, monitorTypeFilter, regionFilter, serviceFilter, sortBy,
    startDate, today, usageTypeFilter]);
  const impactByMonth = useMemo(() => {
    const totals = new Map<string, { total: number; observed: number; unavailable: number }>();
    for (const anomaly of filteredAnomalies) {
      const month = anomaly.startDate?.slice(0, 7) ?? "Unknown";
      const group = totals.get(month) ?? { total: 0, observed: 0, unavailable: 0 };
      if (anomaly.impact.total === null) group.unavailable += 1;
      else {
        group.total += anomaly.impact.total;
        group.observed += 1;
      }
      totals.set(month, group);
    }
    return [...totals].sort(([left], [right]) => left.localeCompare(right));
  }, [filteredAnomalies]);

  const spendByMonth = useMemo(() => {
    const totals = new Map<string, { actual: number; expected: number; actualCount: number; expectedCount: number }>();
    for (const anomaly of filteredAnomalies) {
      if (anomaly.startDate === null) continue;
      const month = anomaly.startDate.slice(0, 7);
      const group = totals.get(month) ?? { actual: 0, expected: 0, actualCount: 0, expectedCount: 0 };
      if (anomaly.impact.actualSpend !== null) {
        group.actual += anomaly.impact.actualSpend;
        group.actualCount += 1;
      }
      if (anomaly.impact.expectedSpend !== null) {
        group.expected += anomaly.impact.expectedSpend;
        group.expectedCount += 1;
      }
      totals.set(month, group);
    }
    return [...totals].sort(([left], [right]) => left.localeCompare(right));
  }, [filteredAnomalies]);

  const rootCauseMovers = useMemo(() => {
    const summarize = (select: (cause: (typeof filteredAnomalies)[number]["rootCauses"][number]) => string | null) => {
      const totals = new Map<string, { contribution: number; observed: number; unavailable: number }>();
      for (const anomaly of filteredAnomalies) {
        for (const cause of anomaly.rootCauses) {
          const value = select(cause);
          if (value === null) continue;
          const group = totals.get(value) ?? { contribution: 0, observed: 0, unavailable: 0 };
          if (cause.contribution === null) group.unavailable += 1;
          else {
            group.contribution += cause.contribution;
            group.observed += 1;
          }
          totals.set(value, group);
        }
      }
      return [...totals].sort((left, right) => right[1].contribution - left[1].contribution
        || left[0].localeCompare(right[0])).slice(0, 10);
    };
    return {
      services: summarize((cause) => cause.service),
      accounts: summarize((cause) => cause.linkedAccountId),
      regions: summarize((cause) => cause.region),
      usageTypes: summarize((cause) => cause.usageType),
    };
  }, [filteredAnomalies]);

  function exportFindings(): void {
    const heading = [
      "Anomaly ID", "Start date", "End date", "Window state", "Service",
      "Account ID", "Region", "Usage type", "Total impact (billing currency units)",
      "Maximum impact (billing currency units)", "Current anomaly score", "Maximum anomaly score",
      "Monitor type", "Monitor dimension",
      "Actual spend", "Expected spend", "Impact percent", "Feedback",
    ];
    const rows = filteredAnomalies.map((anomaly) => {
      const cause = anomaly.rootCauses[0];
      return [
        anomaly.anomalyId, anomaly.startDate, anomaly.endDate,
        anomalyLifecycle(anomaly.endDate, today), cause?.service ?? null,
        cause?.linkedAccountId ?? null, cause?.region ?? null,
        cause?.usageType ?? null, anomaly.impact.total, anomaly.impact.maximum,
        anomaly.score.current, anomaly.score.maximum,
        anomaly.monitorType, anomaly.monitorDimension,
        anomaly.impact.actualSpend, anomaly.impact.expectedSpend,
        anomaly.impact.percentage, anomaly.feedback,
      ].map(csvCell).join(",");
    });
    const blob = new Blob([[heading.map(csvCell).join(","), ...rows].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `aws-cost-anomalies-${dashboard?.aws.windowStartDate ?? "export"}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className={`panel ${styles.costAnomalyPanel}`} aria-labelledby="aws-cost-anomaly-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Authoritative AWS provider findings</p>
          <h2 id="aws-cost-anomaly-heading">AWS Cost Anomaly Detection</h2>
          <p>Normalized findings from Cost Explorer monitors and subscriptions. This source is independent from Sutra statistical alerts below.</p>
        </div>
        <div className={styles.costAnomalyActions}>
          <span className={`status-pill ${state === "complete" ? "status-positive" : state === "failed" ? "status-risk" : "status-warning"}`}>{stateLabel}</span>
          <button className="button button-secondary" disabled={refreshing} onClick={() => void refresh()} type="button">
            {refreshing ? "Collection queued…" : "Refresh AWS findings"}
          </button>
        </div>
      </div>

      {error ? <p className={styles.emptyNote} role="alert">{error}</p> : null}
      {data === null && error === null ? <p className={styles.emptyNote} role="status">Loading persisted AWS Cost Anomaly evidence…</p> : null}
      {state === "waiting" ? (
        <div className={styles.costAnomalyState} role="status">
          <strong>{dashboard === null ? "Waiting for the first persisted AWS collection" : "A new collection is in progress"}</strong>
          <span>{dashboard === null ? "Run the read-only collection. Until AWS returns evidence, Sutra shows no provider anomaly count and never substitutes sample findings or zero spend." : "The last accepted generation remains visible below with its original timestamp while the new run completes."}</span>
        </div>
      ) : null}
      {state === "failed" ? (
        <div className={`${styles.costAnomalyState} ${styles.costAnomalyFailed}`} role="alert">
          <strong>The latest AWS collection failed</strong>
          <span>{dashboard === null ? "No verified provider evidence is available." : "The last verified provider evidence remains visible below and is not presented as current."} Review the connection permission pack and source health before retrying.</span>
        </div>
      ) : null}
      {state === "partial" ? (
        <div className={styles.costAnomalyState} role="status"><strong>Partial AWS coverage</strong><span>At least one bounded AWS operation did not complete. Counts and findings below include only accepted records.</span></div>
      ) : null}
      {state === "stale" ? (
        <div className={styles.costAnomalyState} role="status"><strong>Provider evidence is stale</strong><span>AWS data is older than {data?.freshness.staleAfterHours} hours. Findings remain visible with their provider evaluation timestamp.</span></div>
      ) : null}

      {data !== null ? (
        <details className={styles.costAnomalyEvidence}>
          <summary>Official AWS definition coverage · {data.officialDefinition.totals.visuals} visuals across {data.officialDefinition.totals.sheets} sheets</summary>
          <div>
            <p>
              <strong>Frozen source:</strong>{" "}
              <a href={`${data.officialDefinition.source.repository}/blob/${data.officialDefinition.source.commit}/${data.officialDefinition.source.manifestPath}`} rel="noreferrer" target="_blank">
                AWS CID Cost Anomaly manifest
              </a>{" "}
              at commit <code>{data.officialDefinition.source.commit}</code>.
            </p>
            <p><strong>Verified definition:</strong> manifest SHA-256 <code>{data.officialDefinition.source.manifestSha256}</code>; embedded QuickSight definition SHA-256 <code>{data.officialDefinition.source.embeddedDefinitionSha256}</code>.</p>
            <p><strong>Exact structural inventory:</strong> {data.officialDefinition.totals.visuals} visuals, {data.officialDefinition.totals.parameterControls} parameter controls, {data.officialDefinition.totals.filterControls} filter-control placements, {data.officialDefinition.totals.parameterDeclarations} parameter declarations, {data.officialDefinition.totals.calculatedFields} calculated fields, and {data.officialDefinition.totals.filterGroups} filter groups.</p>
            <div className={styles.costAnomalyTableWrap}>
              <table>
                <caption>Native coverage of every visual in the pinned AWS definition</caption>
                <thead><tr><th scope="col">Official visual</th><th scope="col">Type</th><th scope="col">Coverage</th><th scope="col">Native evidence</th><th scope="col">Remaining gap</th></tr></thead>
                <tbody>{data.officialDefinition.sheets.flatMap((sheet) => sheet.visuals.map((visual) => <tr key={visual.id}><th scope="row">{visual.name}</th><td>{visual.type}</td><td>{visual.coverage.replaceAll("_", " ")}</td><td>{visual.nativeEvidence}</td><td>{visual.remainingGap}</td></tr>))}</tbody>
              </table>
            </div>
            <p><strong>Controls:</strong> {data.officialDefinition.sheets[0].parameterControls.join(", ")}. Cross-sheet filters cover {data.officialDefinition.sheets[0].filterControls.join(", ")}.</p>
            <p><strong>Preserved gaps:</strong> The pinned repository publishes no standalone SQL/query artifact for <code>{data.officialDefinition.source.datasetIdentifier}</code>. Native coverage does not claim QuickSight pixel, geometry, interaction-tree, or query parity. AWS CID Active/Past status also differs from Sutra&apos;s provider-window lifecycle.</p>
          </div>
        </details>
      ) : null}

      {dashboard !== null ? (
        <>
          <div className={styles.costAnomalyKpis} aria-label="AWS Cost Anomaly summary">
            <article><small>AWS findings</small><strong>{dashboard.aws.anomalies.length}</strong><span>{dashboard.aws.windowStartDate} – {dashboard.aws.windowEndDate}</span></article>
            <article><small>Monitors</small><strong>{dashboard.aws.monitors.length}</strong><span>{dashboard.aws.monitors.filter((item) => item.type === "DIMENSIONAL").length} dimensional</span></article>
            <article><small>Subscriptions</small><strong>{dashboard.aws.subscriptions.length}</strong><span>{dashboard.aws.subscriptions.filter((item) => item.frequency === "IMMEDIATE").length} immediate</span></article>
            <article><small>Data through</small><strong>{formatCostAnomalyTime(data?.dataThroughAt ?? null)}</strong><span>{ageHours === null ? "Freshness unavailable" : `${ageHours} hours old`}</span></article>
            <article><small>Open anomaly windows</small><strong>{dashboard.analysis.summary.openWindowCount}</strong><span>{dashboard.analysis.summary.endedWindowCount} windows ended relative to collection day</span></article>
            <article><small>Observed total impact</small><strong>{dashboard.analysis.summary.totalImpact.total === null ? "Not available" : money(dashboard.analysis.summary.totalImpact.total, null)}</strong><span>{dashboard.analysis.summary.totalImpact.observedValueCount}/{dashboard.analysis.summary.findingCount} findings report total impact</span></article>
          </div>

          <div className={styles.costAnomalyControls} aria-label="AWS Cost Anomaly filters">
            <label>Minimum impact
              <input min="0" step="0.01" type="number" value={minimumImpact} onChange={(event) => setMinimumImpact(event.target.value)} />
            </label>
            <label>Minimum current score
              <input max="100" min="0" step="1" type="number" value={minimumScore} onChange={(event) => setMinimumScore(event.target.value)} />
            </label>
            <label>Anomaly ID
              <input type="search" value={anomalySearch} onChange={(event) => setAnomalySearch(event.target.value)} placeholder="Find anomaly ID" />
            </label>
            <label>Service
              <select value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value)}>
                <option value="all">All services</option>
                {filterOptions.services.map((service) => <option key={service} value={service}>{service}</option>)}
              </select>
            </label>
            <label>Linked account
              <select value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}>
                <option value="all">All accounts</option>
                {filterOptions.accounts.map((account) => <option key={account} value={account}>{account}</option>)}
              </select>
            </label>
            <label>Region
              <select value={regionFilter} onChange={(event) => setRegionFilter(event.target.value)}>
                <option value="all">All regions</option>
                {filterOptions.regions.map((region) => <option key={region} value={region}>{region}</option>)}
              </select>
            </label>
            <label>Usage type
              <select value={usageTypeFilter} onChange={(event) => setUsageTypeFilter(event.target.value)}>
                <option value="all">All usage types</option>
                {filterOptions.usageTypes.map((usageType) => <option key={usageType} value={usageType}>{usageType}</option>)}
              </select>
            </label>
            <label>Assessment
              <select value={assessmentFilter} onChange={(event) => setAssessmentFilter(event.target.value)}>
                <option value="all">All assessments</option>
                <option value="NOT_SUBMITTED">Not submitted</option>
                <option value="YES">Accurate anomaly</option>
                <option value="NO">Not an issue</option>
                <option value="PLANNED_ACTIVITY">Planned activity</option>
              </select>
            </label>
            <label>Monitor type
              <select value={monitorTypeFilter} onChange={(event) => setMonitorTypeFilter(event.target.value)}>
                <option value="all">All monitor types</option>
                {filterOptions.monitorTypes.map((monitorType) => <option key={monitorType} value={monitorType}>{monitorType}</option>)}
              </select>
            </label>
            <label>Window state
              <select value={lifecycleFilter} onChange={(event) => setLifecycleFilter(event.target.value)}>
                <option value="all">All windows</option>
                <option value="Open window">Open window</option>
                <option value="Window ended">Window ended</option>
              </select>
            </label>
            <label>Start date
              <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
            </label>
            <label>End date
              <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
            </label>
            <label>Sort findings
              <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                <option value="impact-desc">Total impact</option>
                <option value="score-desc">Current score</option>
                <option value="impact-percent-desc">Impact percent</option>
                <option value="start-desc">Start date</option>
              </select>
            </label>
            <button className="button button-secondary" disabled={filteredAnomalies.length === 0} onClick={exportFindings} type="button">Export filtered CSV</button>
          </div>

          <div className={styles.costAnomalyVisuals} aria-label="AWS Cost Anomaly visual analysis">
            <article>
              <div className="panel-heading"><div><p className="eyebrow">Trend analysis</p><h3>Impact by anomaly month</h3></div><span className="result-count">{filteredAnomalies.length}</span></div>
              {impactByMonth.length === 0 ? <p className={styles.emptyNote}>No accepted finding matches the current filters.</p> : (
                <div className={styles.costAnomalyBars}>{impactByMonth.map(([month, impact]) => (
                  <div key={month}><span>{month}</span><progress max={Math.max(...impactByMonth.map((item) => item[1].total), 1)} value={impact.total} aria-label={`${month}: ${impact.observed === 0 ? "total impact unavailable" : `${impact.total.toFixed(2)} billing currency units`}`} /><strong>{impact.observed === 0 ? "N/A" : impact.total.toFixed(2)}</strong>{impact.unavailable > 0 ? <small>{impact.unavailable} unavailable</small> : null}</div>
                ))}</div>
              )}
            </article>
            <article>
              <div className="panel-heading"><div><p className="eyebrow">Provider expectation</p><h3>Actual versus expected spend</h3></div></div>
              {spendByMonth.length === 0 ? <p className={styles.emptyNote}>No dated actual or expected provider values match this selection.</p> : (
                <div className={styles.costAnomalyTableWrap}><table><caption>Monthly actual and ML-expected spend in billing currency units</caption><thead><tr><th>Month</th><th>Actual</th><th>Expected</th><th>Coverage</th></tr></thead><tbody>{spendByMonth.map(([month, spend]) => <tr key={month}><th scope="row">{month}</th><td>{spend.actualCount === 0 ? "Not available" : spend.actual.toFixed(2)}</td><td>{spend.expectedCount === 0 ? "Not available" : spend.expected.toFixed(2)}</td><td>{spend.actualCount}/{filteredAnomalies.filter((anomaly) => anomaly.startDate?.slice(0, 7) === month).length} actual · {spend.expectedCount} expected</td></tr>)}</tbody></table></div>
              )}
            </article>
            {([
              ["Service", rootCauseMovers.services],
              ["Linked account", rootCauseMovers.accounts],
              ["Region", rootCauseMovers.regions],
              ["Usage type", rootCauseMovers.usageTypes],
            ] as const).map(([label, movers]) => <article key={label}>
              <div className="panel-heading"><div><p className="eyebrow">Ranked provider root causes</p><h3>{label} contribution</h3></div></div>
              {movers.length === 0 ? <p className={styles.emptyNote}>No provider-reported {label.toLocaleLowerCase("en-US")} contribution is available for this selection.</p> : (
                <div className={styles.costAnomalyBars}>{movers.map(([value, contribution]) => (
                  <div key={value}><span title={value}>{value}</span><progress max={Math.max(...movers.map((item) => item[1].contribution), 1)} value={contribution.contribution} aria-label={`${value}: ${contribution.observed === 0 ? "contribution unavailable" : `${contribution.contribution.toFixed(2)} provider contribution units`}`} /><strong>{contribution.observed === 0 ? "N/A" : contribution.contribution.toFixed(2)}</strong>{contribution.unavailable > 0 ? <small>{contribution.unavailable} unavailable</small> : null}</div>
                ))}</div>
              )}
            </article>)}
          </div>

          <div className={styles.costAnomalySources}>
            <article className={styles.costAnomalySourceCard} aria-label="AWS provider anomaly findings">
              <div className="panel-heading"><div><p className="eyebrow">AWS provider engine</p><h3>Detected cost impact</h3></div><span className="result-count">{filteredAnomalies.length}</span></div>
              {dashboard.aws.anomalies.length === 0 ? (
                <div className={styles.goodState}><b>✓</b><span><strong>AWS returned no anomaly finding in this window</strong><small>This is not proof that spend is correct or optimized.</small></span></div>
              ) : filteredAnomalies.length === 0 ? (
                <p className={styles.emptyNote}>Provider findings exist, but none match the current filters.</p>
              ) : (
                <div className={styles.signalList}>
                  {filteredAnomalies.slice(0, 20).map((anomaly) => {
                    const primaryCause = anomaly.rootCauses[0];
                    return (
                      <article key={anomaly.anomalyId}>
                        <span className={`${styles.severity} ${anomaly.score.current >= 75 ? styles.high : anomaly.score.current >= 50 ? styles.medium : styles.low}`}>{Math.round(anomaly.score.current)}</span>
                        <div>
                          <h3>{primaryCause?.service ?? "AWS cost anomaly"}</h3>
                          <p>{anomaly.impact.total === null ? "Total impact unavailable" : `${money(anomaly.impact.total, null)} billing currency units total impact`}{anomaly.impact.percentage === null ? "" : ` · ${anomaly.impact.percentage.toFixed(1)}% above expected`}</p>
                          <small>Maximum impact {money(anomaly.impact.maximum, null)} · actual {anomaly.impact.actualSpend === null ? "not available" : money(anomaly.impact.actualSpend, null)} · expected {anomaly.impact.expectedSpend === null ? "not available" : money(anomaly.impact.expectedSpend, null)}</small>
                          <small>{anomaly.startDate ?? "Start unavailable"}{anomaly.endDate ? ` – ${anomaly.endDate}` : ""} · {anomalyLifecycle(anomaly.endDate, today)} · assessment {anomalyAssessment(anomaly.feedback)} · score {anomaly.score.current.toFixed(1)}/{anomaly.score.maximum.toFixed(1)}{anomaly.monitorType ? ` · ${anomaly.monitorType.toLocaleLowerCase("en-US")} ${anomaly.monitorDimension?.replaceAll("_", " ").toLocaleLowerCase("en-US") ?? "monitor"}` : " · monitor metadata unavailable"}{primaryCause?.region ? ` · ${primaryCause.region}` : ""}{primaryCause?.linkedAccountId ? ` · account ${primaryCause.linkedAccountId}` : ""}</small>
                          <details className={styles.costAnomalyDrilldown}>
                            <summary>Root-cause drilldown</summary>
                            {anomaly.rootCauses.length === 0 ? <p>No provider root cause was accepted for this finding.</p> : (
                              <ul>{anomaly.rootCauses.map((cause, index) => <li key={`${anomaly.anomalyId}:${index}`}>{cause.service ?? "Service unavailable"}{cause.linkedAccountId ? ` · account ${cause.linkedAccountId}` : ""}{cause.region ? ` · ${cause.region}` : ""}{cause.usageType ? ` · ${cause.usageType}` : ""}{cause.contribution === null ? " · contribution unavailable" : ` · ${cause.contribution.toFixed(2)} provider contribution units`}</li>)}</ul>
                            )}
                            {anomaly.rootCausesOmitted > 0 ? <p>{anomaly.rootCausesOmitted} additional root causes were omitted by the bounded collector.</p> : null}
                          </details>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              <p className={styles.emptyNote}>{dashboard.aws.disclaimer}</p>
            </article>

            <article className={styles.costAnomalySourceCard} aria-label="Sutra statistical anomaly signals">
              <div className="panel-heading"><div><p className="eyebrow">Sutra statistical engine</p><h3>Independent billing-line signals</h3></div><span className="result-count">{dashboard.sutra.anomalies.length}</span></div>
              {dashboard.sutra.anomalies.length === 0 ? (
                <p className={styles.emptyNote}>No Sutra statistical signal met the threshold across {dashboard.sutra.evaluatedDays} evaluated service-days{data?.sutraInput.lineCount === 0 ? "; no billing lines were available" : ""}.</p>
              ) : (
                <div className={styles.signalList}>{dashboard.sutra.anomalies.slice(0, 20).map((anomaly, index) => (
                  <article key={`${anomaly.service}:${anomaly.dateIso}:${index}`}>
                    <span className={`${styles.severity} ${styles.medium}`}>{anomaly.ratio.toFixed(1)}×</span>
                    <div><h3>{anomaly.service}</h3><p>{money(Number(BigInt(anomaly.amountMicros)) / 1_000_000, anomaly.currency)} vs {money(Number(BigInt(anomaly.baselineMicros)) / 1_000_000, anomaly.currency)} trailing baseline</p><small>{anomaly.dateIso}</small></div>
                  </article>
                ))}</div>
              )}
              <p className={styles.emptyNote}>{dashboard.sutra.disclaimer}{data?.sutraInput.capped ? " Statistical input reached the disclosed 50,000-line / three-period display bound." : ""}</p>
            </article>
          </div>
          <details className={styles.costAnomalyEvidence}>
            <summary>Evidence, collection coverage, and limitations</summary>
            <div>
              <p><strong>Provider source:</strong> AWS Cost Explorer Cost Anomaly Detection</p>
              <p><strong>Accepted generation:</strong> collected {formatCostAnomalyTime(data?.collectedAt ?? null)}; provider data through {formatCostAnomalyTime(data?.dataThroughAt ?? null)}.</p>
              <p><strong>Window:</strong> {dashboard.aws.windowStartDate} through {dashboard.aws.windowEndDate}. Currency metadata is not returned by this source contract, so provider amounts are labelled as billing currency units and are not converted.</p>
              <div className={styles.costAnomalyTableWrap}>
                <table>
                  <caption>Read-only provider operation coverage</caption>
                  <thead><tr><th scope="col">Operation</th><th scope="col">Status</th><th scope="col">Pages</th><th scope="col">Observed</th><th scope="col">Accepted</th><th scope="col">Rejected</th><th scope="col">Omitted</th><th scope="col">Error</th></tr></thead>
                  <tbody>{dashboard.aws.coverage.map((coverage) => <tr key={coverage.operation}><th scope="row">{coverage.operation.replaceAll("_", " ")}</th><td>{coverage.status}</td><td>{coverage.pagesObserved}</td><td>{coverage.recordsObserved}</td><td>{coverage.recordsAccepted}</td><td>{coverage.recordsRejected}</td><td>{coverage.recordsOmitted}</td><td>{coverage.errorCode ?? "None"}</td></tr>)}</tbody>
                </table>
              </div>
              <div className={styles.costAnomalyTableWrap}>
                <table>
                  <caption>Provider monitor coverage by method and dimension</caption>
                  <thead><tr><th>Method</th><th>Dimension</th><th>Monitors</th><th>Evaluated timestamp available</th></tr></thead>
                  <tbody>{dashboard.analysis.monitorCoverage.length === 0 ? <tr><td colSpan={4}>No accepted monitor evidence.</td></tr> : dashboard.analysis.monitorCoverage.map((coverage) => <tr key={`${coverage.type}:${coverage.dimension}`}><th scope="row">{coverage.type}</th><td>{coverage.dimension?.replaceAll("_", " ") ?? "Not reported"}</td><td>{coverage.monitorCount}</td><td>{coverage.evaluatedMonitorCount}/{coverage.monitorCount}</td></tr>)}</tbody>
                </table>
              </div>
              <div className={styles.costAnomalyTableWrap}>
                <table>
                  <caption>Provider alert subscription coverage; recipient addresses remain redacted</caption>
                  <thead><tr><th>Frequency</th><th>Subscriptions</th><th>Threshold evidence</th><th>Confirmed channels</th><th>Declined / unknown</th></tr></thead>
                  <tbody>{dashboard.analysis.subscriptionCoverage.length === 0 ? <tr><td colSpan={5}>No accepted subscription evidence.</td></tr> : dashboard.analysis.subscriptionCoverage.map((coverage) => <tr key={coverage.frequency}><th scope="row">{coverage.frequency}</th><td>{coverage.subscriptionCount}</td><td>{coverage.numericThresholdCount} numeric · {coverage.expressionThresholdCount} expression</td><td>{coverage.confirmedEmailSubscriberCount} email · {coverage.confirmedSnsSubscriberCount} SNS</td><td>{coverage.declinedSubscriberCount} declined · {coverage.unknownSubscriberCount} unknown</td></tr>)}</tbody>
                </table>
              </div>
              <p><strong>Assessment coverage:</strong> {dashboard.analysis.summary.assessmentCounts.accurateAnomaly} accurate anomaly, {dashboard.analysis.summary.assessmentCounts.notAnIssue} not an issue, {dashboard.analysis.summary.assessmentCounts.plannedActivity} planned activity, and {dashboard.analysis.summary.assessmentCounts.notSubmitted} not submitted.</p>
              <p><strong>Unavailable provider values:</strong> {dashboard.analysis.summary.totalImpact.unavailableValueCount} total-impact, {dashboard.analysis.summary.actualSpend.unavailableValueCount} actual-spend, {dashboard.analysis.summary.expectedSpend.unavailableValueCount} expected-spend, {dashboard.analysis.summary.missingRootCauseCount} root-cause, and {dashboard.analysis.summary.missingStartDateCount} start-date records remain unavailable and are not inferred.</p>
              <p>{dashboard.aws.disclaimer}</p>
              <p>{dashboard.disclaimer}</p>
            </div>
          </details>
          <p className={styles.costAnomalyDisclaimer}>{dashboard.disclaimer}</p>
        </>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Allocation rules                                                            */
/* -------------------------------------------------------------------------- */

interface AllocationBucket {
  readonly targetKind: string;
  readonly targetValue: string;
  readonly ruleName: string | null;
  readonly amountUnits: number;
  readonly lineCount: number;
}
interface AllocationResponse {
  readonly period: string | null;
  readonly allocation: {
    readonly allocated: readonly AllocationBucket[];
    readonly unallocated: { readonly amountUnits: number; readonly lineCount: number };
    readonly currency: string | null;
    readonly totalUnits: number;
    readonly ruleCount: number;
  };
}
interface StoredRule {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly match: { account?: string; service?: string; tagKey?: string; tagValue?: string };
  readonly targetKind: string;
  readonly targetValue: string;
  readonly enabled: boolean;
}

function AllocationPanel({ connectionId }: { connectionId: string }) {
  const [data, setData] = useState<AllocationResponse | null>(null);
  const [rules, setRules] = useState<readonly StoredRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", dimension: "service", value: "", tagValue: "", targetKind: "customer", targetValue: "" });
  const [priorityDraft, setPriorityDraft] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    try {
      const [alloc, ruleList] = await Promise.all([
        getJson<AllocationResponse>(`/api/v1/finops/allocation?connectionId=${encodeURIComponent(connectionId)}`),
        getJson<{ rules: readonly StoredRule[] }>(`/api/v1/finops/allocation-rules?connectionId=${encodeURIComponent(connectionId)}`),
      ]);
      setData(alloc);
      setRules(ruleList.rules);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load allocation");
    }
  }, [connectionId]);

  useEffect(() => {
    let active = true;
    Promise.all([
      getJson<AllocationResponse>(`/api/v1/finops/allocation?connectionId=${encodeURIComponent(connectionId)}`),
      getJson<{ rules: readonly StoredRule[] }>(`/api/v1/finops/allocation-rules?connectionId=${encodeURIComponent(connectionId)}`),
    ])
      .then(([alloc, ruleList]) => { if (active) { setData(alloc); setRules(ruleList.rules); setError(null); } })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "Could not load allocation"); });
    return () => { active = false; };
  }, [connectionId]);

  async function addRule(): Promise<void> {
    if (form.name.trim().length === 0 || form.value.trim().length === 0 || form.targetValue.trim().length === 0) {
      setError("Rule name, match value, and target are required");
      return;
    }
    setBusy(true);
    try {
      const match: Json = {};
      if (form.dimension === "tag") { match.tagKey = form.value; if (form.tagValue.trim().length > 0) match.tagValue = form.tagValue; }
      else match[form.dimension] = form.value;
      await sendJson(`/api/v1/finops/allocation-rules?connectionId=${encodeURIComponent(connectionId)}`, "POST", {
        name: form.name, match, targetKind: form.targetKind, targetValue: form.targetValue,
      });
      setForm({ name: "", dimension: "service", value: "", tagValue: "", targetKind: "customer", targetValue: "" });
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add rule");
    } finally {
      setBusy(false);
    }
  }

  async function patchRule(rule: StoredRule, patch: Json, failure: string): Promise<boolean> {
    setBusy(true);
    try {
      await sendJson(
        `/api/v1/finops/allocation-rules?connectionId=${encodeURIComponent(connectionId)}&id=${encodeURIComponent(rule.id)}`,
        "PATCH",
        patch,
      );
      await reload();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : failure);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function setRuleEnabled(rule: StoredRule, enabled: boolean): Promise<void> {
    await patchRule(rule, { enabled }, enabled ? "Could not enable rule" : "Could not disable rule");
  }

  async function savePriority(rule: StoredRule): Promise<void> {
    const raw = (priorityDraft[rule.id] ?? String(rule.priority)).trim();
    if (!/^\d{1,6}$/u.test(raw)) {
      setError("Priority must be a whole number — lower priority is matched first");
      return;
    }
    const saved = await patchRule(rule, { priority: Number(raw) }, "Could not change priority");
    if (saved) {
      setPriorityDraft((prev) => {
        const next = { ...prev };
        delete next[rule.id];
        return next;
      });
    }
  }

  async function removeRule(id: string): Promise<void> {
    setBusy(true);
    try {
      await sendJson(
        `/api/v1/finops/allocation-rules?connectionId=${encodeURIComponent(connectionId)}&id=${encodeURIComponent(id)}`,
        "DELETE",
        {},
      );
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete rule");
    } finally {
      setBusy(false);
    }
  }

  const alloc = data?.allocation ?? null;
  const maxBucket = alloc && alloc.allocated.length > 0 ? Math.max(...alloc.allocated.map((b) => b.amountUnits), 1) : 1;
  const activeRuleCount = rules.length > 0 ? rules.filter((rule) => rule.enabled).length : alloc?.ruleCount ?? 0;

  return (
    <article className="panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Virtual tags</p><h2>Allocation rules</h2></div>
        <span className="result-count">{activeRuleCount} active{rules.length > activeRuleCount ? ` · ${rules.length - activeRuleCount} disabled` : ""}</span>
      </div>
      {error ? <p className={styles.emptyNote} role="alert">{error}</p> : null}
      {alloc === null ? <p className={styles.emptyNote}>Loading allocation…</p> : (
        <>
          {alloc.allocated.length === 0 ? (
            <p className={styles.emptyNote}>No spend is allocated yet. Add a rule below to assign account / service / tag spend to a customer, product, or cost-center. Unmatched spend is disclosed as unallocated, never force-assigned.</p>
          ) : (
            <div className={styles.breakdownList}>
              {alloc.allocated.slice(0, 8).map((bucket) => (
                <div className={styles.breakdownRow} key={`${bucket.targetKind}:${bucket.targetValue}`}>
                  <div><strong>{bucket.targetValue}</strong><span>{bucket.targetKind.replace("_", " ")} · {bucket.lineCount} lines</span></div>
                  <div className={styles.progress}><i style={{ width: `${Math.min(100, (bucket.amountUnits / maxBucket) * 100)}%` }} /></div>
                  <small>{money(bucket.amountUnits, alloc.currency)}</small>
                </div>
              ))}
              <div className={styles.breakdownRow}>
                <div><strong>Unallocated</strong><span>{alloc.unallocated.lineCount} lines · no rule matched</span></div>
                <div className={styles.progress}><i style={{ width: `${Math.min(100, (alloc.unallocated.amountUnits / maxBucket) * 100)}%`, background: "#f59e0b" }} /></div>
                <small>{money(alloc.unallocated.amountUnits, alloc.currency)}</small>
              </div>
            </div>
          )}

          <div className={styles.w3Form}>
            <div className={styles.w3Grid}>
              <input className={styles.w3Input} placeholder="Rule name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <select className={styles.w3Input} value={form.dimension} onChange={(e) => setForm({ ...form, dimension: e.target.value })} aria-label="Match dimension">
                <option value="service">Service is</option>
                <option value="account">Account is</option>
                <option value="tag">Tag key</option>
              </select>
              <input className={styles.w3Input} placeholder={form.dimension === "tag" ? "tag key" : "value"} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
              {form.dimension === "tag" ? <input className={styles.w3Input} placeholder="tag value (optional)" value={form.tagValue} onChange={(e) => setForm({ ...form, tagValue: e.target.value })} /> : null}
              <select className={styles.w3Input} value={form.targetKind} onChange={(e) => setForm({ ...form, targetKind: e.target.value })} aria-label="Target kind">
                <option value="customer">→ customer</option>
                <option value="product">→ product</option>
                <option value="cost_center">→ cost center</option>
              </select>
              <input className={styles.w3Input} placeholder="target value" value={form.targetValue} onChange={(e) => setForm({ ...form, targetValue: e.target.value })} />
              <button className="button button-secondary" type="button" disabled={busy} onClick={() => void addRule()}>Add rule</button>
            </div>
          </div>

          {rules.length > 0 ? (
            <ul className={styles.w3RuleList}>
              {rules.map((rule) => {
                const priorityValue = priorityDraft[rule.id] ?? String(rule.priority);
                const priorityChanged = priorityValue.trim() !== String(rule.priority);
                return (
                  <li key={rule.id} className={rule.enabled ? undefined : styles.w3RuleOff}>
                    <span><strong>{rule.name}</strong> — {rule.match.service ?? rule.match.account ?? (rule.match.tagKey ? `${rule.match.tagKey}${rule.match.tagValue ? `=${rule.match.tagValue}` : ""}` : "?")} → {rule.targetKind.replace("_", " ")} {rule.targetValue}{rule.enabled ? "" : " · not applied"}</span>
                    <span className={styles.w3RuleControls}>
                      <label className={styles.w3Switch}>
                        <input
                          type="checkbox"
                          role="switch"
                          checked={rule.enabled}
                          aria-checked={rule.enabled}
                          disabled={busy}
                          onChange={(e) => void setRuleEnabled(rule, e.target.checked)}
                          aria-label={`${rule.enabled ? "Disable" : "Enable"} rule ${rule.name}`}
                        />
                        <span>{rule.enabled ? "Active" : "Disabled"}</span>
                      </label>
                      <input
                        className={styles.w3Mini}
                        inputMode="numeric"
                        value={priorityValue}
                        disabled={busy}
                        onChange={(e) => setPriorityDraft({ ...priorityDraft, [rule.id]: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter" && priorityChanged) void savePriority(rule); }}
                        aria-label={`Match priority for rule ${rule.name} (lower is matched first)`}
                      />
                      {priorityChanged ? (
                        <button className="button button-ghost" type="button" disabled={busy} onClick={() => void savePriority(rule)} aria-label={`Save priority for rule ${rule.name}`}>Save</button>
                      ) : null}
                      <button className="button button-ghost" type="button" disabled={busy} onClick={() => void removeRule(rule.id)} aria-label={`Delete ${rule.name}`}>Remove</button>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {rules.length > 0 ? (
            <p className={styles.w3Hint}>The number on each row is its match priority — lower is matched first. A disabled rule is kept but not applied, so its spend falls back to unallocated.</p>
          ) : null}
        </>
      )}
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* MSP margin                                                                  */
/* -------------------------------------------------------------------------- */

interface MarginRow {
  readonly customerId: string;
  readonly customerName: string;
  readonly currency: string;
  readonly costUnits: number;
  readonly markupPercent: number;
  readonly billedUnits: number;
  readonly marginUnits: number;
  readonly marginPercent: number | null;
  readonly hasRate: boolean;
}
interface MarginResponse {
  readonly rows: readonly MarginRow[];
  readonly totalsByCurrency: readonly { currency: string; totalCostUnits: number; totalBilledUnits: number; totalMarginUnits: number; blendedMarginPercent: number | null }[];
}

function MarginPanel() {
  const [data, setData] = useState<MarginResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<string, { markup: string; fee: string }>>({});
  /* Clearing a rate wipes a customer's markup and monthly fee — billing
   * configuration with no undo — so it is a two-step confirm, the same inline
   * pattern budget delete uses. A single customerId holds the pending row, so
   * only one row can be awaiting confirmation at a time. */
  const [pendingClear, setPendingClear] = useState<string | null>(null);
  const [clearing, setClearing] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await getJson<MarginResponse>(`/api/v1/finops/margin`));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load margin");
    }
  }, []);
  useEffect(() => {
    let active = true;
    getJson<MarginResponse>(`/api/v1/finops/margin`)
      .then((value) => { if (active) { setData(value); setError(null); } })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "Could not load margin"); });
    return () => { active = false; };
  }, []);

  async function saveRate(row: MarginRow): Promise<void> {
    const edit = draft[row.customerId];
    const markup = Number(edit?.markup ?? row.markupPercent);
    const feeUnits = Number(edit?.fee ?? "0");
    if (!Number.isFinite(markup) || markup < 0 || !Number.isFinite(feeUnits) || feeUnits < 0) {
      setError("Markup and fee must be non-negative numbers");
      return;
    }
    setBusy(true);
    try {
      await sendJson(`/api/v1/finops/margin`, "PUT", {
        customerId: row.customerId,
        markupPercent: markup,
        monthlyFeeMicros: String(Math.round(feeUnits * 1_000_000)),
        currency: row.currency,
      });
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save rate");
    } finally {
      setBusy(false);
    }
  }

  async function clearRate(row: MarginRow): Promise<void> {
    setError(null);
    setBusy(true);
    setClearing(row.customerId);
    try {
      await sendJson(`/api/v1/finops/margin?customerId=${encodeURIComponent(row.customerId)}`, "DELETE", {});
      setDraft((prev) => {
        const next = { ...prev };
        delete next[row.customerId];
        return next;
      });
      setPendingClear(null);
      await reload();
    } catch (caught) {
      // The confirm stays open on failure so the operator can retry; the real
      // API message is surfaced in the panel's alert.
      setError(caught instanceof Error ? caught.message : "Could not clear rate");
    } finally {
      setClearing(null);
      setBusy(false);
    }
  }

  return (
    <article className="panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Resale economics</p><h2>MSP margin per customer</h2></div>
        {data && data.totalsByCurrency[0] ? <span className="result-count">{data.totalsByCurrency[0].blendedMarginPercent === null ? "—" : `${Math.round(data.totalsByCurrency[0].blendedMarginPercent)}% blended`}</span> : null}
      </div>
      {error ? <p className={styles.emptyNote} role="alert">{error}</p> : null}
      {data === null ? <p className={styles.emptyNote}>Loading margin…</p>
        : data.rows.length === 0 ? <p className={styles.emptyNote}>No per-customer cloud cost is attributed for the latest billing period yet. Upload CUR/FOCUS billing files per connection to populate this view.</p>
        : (
          <div className={styles.marginTable} role="table" aria-label="Per-customer margin">
            <div className={`${styles.marginRow} ${styles.marginHead}`} role="row">
              <span>Customer</span><span>Cloud cost</span><span>Markup %</span><span>Fee</span><span>Billed</span><span>Margin</span><span aria-hidden="true" />
            </div>
            {data.rows.map((row) => {
              const edit = draft[row.customerId] ?? { markup: String(row.markupPercent), fee: "" };
              return (
                <div className={styles.marginRow} key={`${row.customerId}:${row.currency}`} role="row">
                  <span className={styles.marginName} data-label="Customer" title={row.customerId}>{row.customerName}</span>
                  <span data-label="Cloud cost">{money(row.costUnits, row.currency)}</span>
                  <span data-label="Markup %"><input className={styles.w3Mini} inputMode="decimal" value={edit.markup} onChange={(e) => setDraft({ ...draft, [row.customerId]: { ...edit, markup: e.target.value } })} aria-label={`Markup for ${row.customerName}`} /></span>
                  <span data-label="Monthly fee"><input className={styles.w3Mini} inputMode="decimal" placeholder="0" value={edit.fee} onChange={(e) => setDraft({ ...draft, [row.customerId]: { ...edit, fee: e.target.value } })} aria-label={`Monthly fee for ${row.customerName}`} /></span>
                  <span data-label="Billed">{money(row.billedUnits, row.currency)}</span>
                  <span className={row.marginUnits >= 0 ? styles.costDown : styles.costUp} data-label="Margin">{money(row.marginUnits, row.currency)}{row.marginPercent === null ? "" : ` (${Math.round(row.marginPercent)}%)`}</span>
                  <span className={styles.w3RowActions}>
                    <button className="button button-ghost" type="button" disabled={busy} onClick={() => void saveRate(row)} aria-label={`Save rate for ${row.customerName}`}>Save</button>
                    {row.hasRate ? (
                      pendingClear === row.customerId ? (
                        <span className={styles.w3ClearConfirm}>
                          <span className={styles.w3ClearPrompt} role="alert">
                            {clearing === row.customerId
                              ? `Clearing the rate for ${row.customerName}…`
                              : `Clear the markup and monthly fee for ${row.customerName}?`}
                          </span>
                          <button className="button button-ghost" type="button" disabled={busy} onClick={() => void clearRate(row)} aria-label={`Confirm clearing the configured rate for ${row.customerName}`}>{clearing === row.customerId ? "Clearing…" : "Confirm"}</button>
                          <button className="button button-ghost" type="button" disabled={busy} onClick={() => setPendingClear(null)} aria-label={`Keep the configured rate for ${row.customerName}`}>Cancel</button>
                        </span>
                      ) : (
                        <button className="button button-ghost" type="button" disabled={busy} onClick={() => { setError(null); setPendingClear(row.customerId); }} aria-label={`Clear configured rate for ${row.customerName}`}>Clear</button>
                      )
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      <p className={styles.emptyNote}>Billed = cloud cost × (1 + markup%) + fixed monthly fee. Currencies are never summed; a fee applies only in its own currency. Clear removes the stored rate for that customer — the row stays visible with billed = cloud cost and no margin, so an un-rated customer is disclosed rather than hidden.</p>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* Cost & budget alerts                                                        */
/* -------------------------------------------------------------------------- */

interface AlertItem {
  readonly id: string;
  readonly kind: string;
  readonly severity: "critical" | "high" | "medium" | "low";
  readonly title: string;
  readonly summary: string;
}
interface AlertDestination { readonly id: string; readonly channel: string; readonly displayName: string; }
interface AlertsResponse {
  readonly alerts: readonly AlertItem[];
  readonly counts: { readonly critical: number; readonly high: number; readonly medium: number; readonly low: number };
  readonly destinations: readonly AlertDestination[];
}

function AlertsPanel({ connectionId }: { connectionId: string }) {
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [destinationId, setDestinationId] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getJson<AlertsResponse>(`/api/v1/finops/alerts?connectionId=${encodeURIComponent(connectionId)}`)
      .then((value) => { if (active) { setData(value); setError(null); if (value.destinations[0]) setDestinationId((prev) => prev || value.destinations[0].id); } })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "Could not load alerts"); });
    return () => { active = false; };
  }, [connectionId]);

  async function send(): Promise<void> {
    if (destinationId.length === 0) return;
    setSending(true);
    setSent(null);
    try {
      const result = await sendJson<{ queued: number; queueFailures: number }>(`/api/v1/finops/alerts`, "POST", { connectionId, destinationId });
      setSent(`Queued ${result.queued} alert${result.queued === 1 ? "" : "s"}${result.queueFailures > 0 ? ` (${result.queueFailures} failed)` : ""} to the destination.`);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send alerts");
    } finally {
      setSending(false);
    }
  }

  const total = data ? data.alerts.length : 0;
  const destinations = data?.destinations ?? [];

  return (
    <article className="panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Spend spikes &amp; budget breaches</p><h2>Cost &amp; budget alerts</h2></div>
        <span className={`status-pill ${total > 0 ? "status-risk" : "status-positive"}`}>{total} active</span>
      </div>
      {error ? <p className={styles.emptyNote} role="alert">{error}</p> : null}
      {data === null ? <p className={styles.emptyNote}>Loading alerts…</p>
        : total === 0 ? <div className={styles.goodState}><b>✓</b><span><strong>No spend anomaly or budget breach detected</strong><small>Alerts fire when a service day exceeds 3× its trailing median, or a budget is projected to breach. Configured destinations are also swept automatically in the background.</small></span></div>
        : (
          <>
            <div className={styles.signalList}>
              {data.alerts.map((alert) => (
                <article key={alert.id}>
                  <span className={`${styles.severity} ${styles[alert.severity]}`}>{alert.severity}</span>
                  <div><h3>{alert.title}</h3><p>{alert.summary}</p><small>{alert.kind.replace(/_/g, " ")}</small></div>
                </article>
              ))}
            </div>
            <div className={styles.w3Form}>
              {destinations.length === 0 ? (
                <p className={styles.emptyNote}>Configure a notification destination in Settings → Notifications to send these alerts to Slack, PagerDuty, Teams, a webhook, or email.</p>
              ) : (
                <div className={styles.w3Grid}>
                  <select className={styles.w3Input} value={destinationId} onChange={(e) => setDestinationId(e.target.value)} aria-label="Notification destination">
                    {destinations.map((destination) => (
                      <option key={destination.id} value={destination.id}>{destination.displayName} ({destination.channel.replace(/_/g, " ")})</option>
                    ))}
                  </select>
                  <button className="button button-secondary" type="button" disabled={sending || destinationId.length === 0} onClick={() => void send()}>{sending ? "Sending…" : "Send now"}</button>
                </div>
              )}
              {sent ? <p className={styles.emptyNote}>{sent}</p> : null}
            </div>
          </>
        )}
    </article>
  );
}

/* -------------------------------------------------------------------------- */

export function FinopsWave3Panels({ connectionId }: { connectionId: string | null }) {
  if (connectionId === null) {
    return (
      <section className={`panel ${styles.costAnomalyPanel}`} aria-labelledby="aws-cost-anomaly-heading">
        <div className="panel-heading"><div><p className="eyebrow">Configuration required</p><h2 id="aws-cost-anomaly-heading">AWS Cost Anomaly Detection</h2><p>Connect an active AWS trust role with the current read-only permission pack to collect provider findings, monitor coverage, and subscription evidence.</p></div><span className="status-pill status-warning">configuration required</span></div>
        <div className={styles.costAnomalyState} role="status"><strong>No active AWS connection is selected</strong><span>No anomaly count or spend value is shown until a tenant-scoped provider collection is accepted.</span></div>
      </section>
    );
  }
  return (
    <>
      <AwsCostAnomalyPanel connectionId={connectionId} />
      <section className={styles.overviewGrid}>
        <AllocationPanel connectionId={connectionId} />
        <AlertsPanel connectionId={connectionId} />
      </section>
      <MarginPanel />
    </>
  );
}
