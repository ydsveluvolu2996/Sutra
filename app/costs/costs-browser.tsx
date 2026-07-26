"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FinopsPanels } from "./finops-panels";
import { VisibilityPanels } from "./visibility-panels";
import { FinopsMorePanels } from "./finops-more-panels";
import { FinopsCommitmentsPanels } from "./finops-commitments-panels";
import type { StoredCostSnapshot } from "../../lib/cost-types";
import { buildCostOptimizations } from "../../lib/aws-cost-optimization";
import { compactIdentifier, formatTimestamp, usePilotState } from "../components/use-pilot-state";
import styles from "./costs.module.css";

interface CostApiResponse {
  readonly snapshot: StoredCostSnapshot | null;
  readonly error?: { readonly message?: string };
}

function money(value: number | null, currency = "USD"): string {
  if (value === null) return "Not available";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

function monthLabel(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit", timeZone: "UTC" })
    .format(new Date(`${value}T00:00:00.000Z`));
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Sutra could not load AWS cost evidence";
}

async function readJson(response: Response): Promise<CostApiResponse> {
  const body = await response.json().catch(() => null) as CostApiResponse | null;
  if (!response.ok || body === null) {
    throw new Error(body?.error?.message ?? "Sutra could not load AWS cost evidence");
  }
  return body;
}

export function CostsBrowser() {
  const { state, loading: stateLoading, error: stateError } = usePilotState();
  const [snapshot, setSnapshot] = useState<StoredCostSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connection = state?.connection ?? null;
  const connectionId = connection?.id ?? null;

  const load = useCallback(async () => {
    if (connectionId === null) {
      setSnapshot(null);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`/api/v1/costs?connectionId=${encodeURIComponent(connectionId)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const body = await readJson(response);
      setSnapshot(body.snapshot);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    if (connectionId === null) return;
    let current = true;
    void fetch(`/api/v1/costs?connectionId=${encodeURIComponent(connectionId)}`, {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(readJson)
      .then((body) => {
        if (!current) return;
        setSnapshot(body.snapshot);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (current) setError(errorMessage(caught));
      });
    return () => {
      current = false;
    };
  }, [connectionId]);

  async function collect(): Promise<void> {
    if (connectionId === null) return;
    setCollecting(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/costs", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
      const body = await readJson(response);
      setSnapshot(body.snapshot);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setCollecting(false);
    }
  }

  const payload = snapshot?.payload ?? null;
  const optimizations = useMemo(
    () => buildCostOptimizations({ snapshot: payload, resources: state?.resources ?? [] }),
    [payload, state?.resources],
  );
  const maximumTrend = useMemo(
    () => Math.max(1, ...(payload?.monthlyTrend.map((point) => point.amount) ?? [1])),
    [payload?.monthlyTrend],
  );
  const overallError = stateError ?? error;

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">FinOps command center</p>
          <h1>AWS cost intelligence</h1>
          <p className="page-subtitle">Actual Cost Explorer evidence, spend concentration, explainable signals, and forecast provenance for the selected customer account.</p>
        </div>
        <div className="heading-actions">
          <button
            className="button button-primary"
            disabled={connection?.sourceKind !== "aws_trust_role" || connection.status !== "active" || collecting}
            onClick={() => void collect()}
            type="button"
          >
            {collecting ? "Collecting AWS costs…" : snapshot === null ? "Collect AWS costs" : "Refresh from AWS"}
          </button>
        </div>
      </section>

      <div className="trust-strip" role="note">
        <span className="trust-icon">✓</span>
        <span><strong>Read-only billing evidence.</strong> Sutra requests only Cost Explorer usage and forecast APIs through the customer trust role. It never creates budgets, commitments, or AWS resources.</span>
        <a href="/onboard">Review role</a>
      </div>

      {overallError ? <div className="page-alert page-alert-error" role="alert"><strong>Cost evidence needs attention</strong><span>{overallError}</span><button onClick={() => void load()} type="button">Retry</button></div> : null}
      {stateLoading || loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading persisted Cost Explorer evidence…</div> : null}

      {!stateLoading && connection === null ? (
        <section className="panel empty-workspace">
          <span className="empty-workspace-icon">$</span><h2>No AWS account is connected</h2>
          <p>Onboard a customer-owned AWS role before collecting billing evidence.</p>
          <a className="button button-primary" href="/onboard">Connect AWS account</a>
        </section>
      ) : null}

      {!stateLoading && connection !== null && connection.sourceKind !== "aws_trust_role" ? (
        <section className="panel empty-workspace">
          <span className="empty-workspace-icon">AWS</span><h2>Live AWS evidence is required</h2>
          <p>Cost results are never generated from the simulated CMDB fixture. Connect a customer-owned trust role to use FinOps.</p>
          <a className="button button-primary" href="/onboard">Connect live account</a>
        </section>
      ) : null}

      {!loading && connection?.sourceKind === "aws_trust_role" && snapshot === null ? (
        <section className={`panel ${styles.firstRun}`}>
          <div className={styles.firstRunIcon}>CE</div>
          <div><p className="eyebrow">No persisted cost snapshot</p><h2>Collect the first six-month AWS cost view</h2><p>Sutra will query Cost Explorer through the existing trusted role and persist only normalized billing totals—never credentials or invoice documents.</p></div>
          <button className="button button-primary" disabled={collecting || connection.status !== "active"} onClick={() => void collect()} type="button">{collecting ? "Collecting…" : "Start collection"}</button>
        </section>
      ) : null}

      {payload?.status === "UNAVAILABLE" ? (
        <section className={`panel ${styles.unavailable}`}>
          <div><p className="eyebrow">AWS returned no usable billing evidence</p><h2>Cost Explorer is unavailable for this connection</h2><p>Sutra preserved this attempt as an unavailable snapshot instead of displaying estimated or sample spend.</p></div>
          <span className="status-pill status-risk">{payload.unavailableReason?.replaceAll("_", " ") ?? "Unavailable"}</span>
          <ol>
            <li>Update the customer CloudFormation stack with the current Sutra role template.</li>
            <li>Confirm Cost Explorer is enabled and billing history is visible in the customer account.</li>
            <li>Wait for AWS billing data propagation if the account was newly enabled, then retry.</li>
          </ol>
          <button className="button button-primary" disabled={collecting} onClick={() => void collect()} type="button">Retry AWS collection</button>
        </section>
      ) : null}

      {payload !== null && snapshot !== null && payload.status !== "UNAVAILABLE" ? (
        <>
          {payload.status === "PARTIAL" ? <div className="page-alert page-alert-warning" role="status"><strong>Partial AWS cost evidence</strong><span>Core spend is available. {payload.limitations.map((item) => item.replaceAll("_", " ")).join(" · ")}</span></div> : null}

          <section className={styles.kpis} aria-label="AWS cost summary">
            <article className={`panel ${styles.primaryKpi}`}><small>Month to date</small><strong>{money(payload.monthToDateCost, payload.currency)}</strong><span>through {payload.periodEnd}</span></article>
            <article className="panel"><small>Projected month</small><strong>{money(payload.forecast.amount, payload.currency)}</strong><span>{payload.forecast.source === "AWS_COST_EXPLORER" ? "AWS Cost Explorer forecast" : payload.forecast.source === "SUTRA_LINEAR_PROJECTION" ? "Labelled linear fallback" : "Forecast unavailable"}</span></article>
            <article className="panel"><small>Previous month</small><strong>{money(payload.previousMonthCost, payload.currency)}</strong><span>closed billing period</span></article>
            <article className="panel"><small>MTD vs previous</small><strong className={(payload.trendPercent ?? 0) > 0 ? styles.costUp : styles.costDown}>{payload.trendPercent === null ? "—" : `${payload.trendPercent > 0 ? "+" : ""}${payload.trendPercent}%`}</strong><span>not pace adjusted</span></article>
          </section>

          <section className={styles.overviewGrid}>
            <article className="panel">
              <div className="panel-heading"><div><p className="eyebrow">Six-month view</p><h2>Monthly spend trend</h2></div><span className="status-pill status-positive">AWS evidence</span></div>
              <div className={styles.trendChart} role="img" aria-label="Monthly AWS spend bar chart">
                {payload.monthlyTrend.map((point) => (
                  <div className={styles.trendColumn} key={point.start} title={`${monthLabel(point.start)}: ${money(point.amount, payload.currency)}`}>
                    <span>{money(point.amount, payload.currency)}</span>
                    <i style={{ height: `${Math.max(4, (point.amount / maximumTrend) * 100)}%` }} />
                    <small>{monthLabel(point.start)}</small>
                  </div>
                ))}
              </div>
            </article>

            <article className="panel">
              <div className="panel-heading"><div><p className="eyebrow">Spend concentration</p><h2>Top AWS services</h2></div><span className="result-count">{payload.serviceBreakdown.length} services</span></div>
              {payload.serviceBreakdown.length === 0 ? <p className={styles.emptyNote}>AWS returned no positive current-month service cost.</p> : (
                <div className={styles.breakdownList}>
                  {payload.serviceBreakdown.slice(0, 8).map((item) => (
                    <div className={styles.breakdownRow} key={item.key}>
                      <div><strong>{item.label}</strong><span>{money(item.amount, payload.currency)}</span></div>
                      <div className={styles.progress}><i style={{ width: `${Math.min(100, item.sharePercent)}%` }} /></div>
                      <small>{item.sharePercent}%</small>
                    </div>
                  ))}
                </div>
              )}
            </article>
          </section>

          <section className={styles.signalGrid}>
            <article className="panel">
              <div className="panel-heading"><div><p className="eyebrow">Explainable detection</p><h2>Cost signals</h2></div><span className={`status-pill ${payload.anomalies.length > 0 ? "status-risk" : "status-positive"}`}>{payload.anomalies.length} detected</span></div>
              {payload.anomalies.length === 0 ? <div className={styles.goodState}><b>✓</b><span><strong>No evidence-backed service spike detected</strong><small>Requires two closed months and a material increase; this does not claim that AWS spend is optimal.</small></span></div> : (
                <div className={styles.signalList}>{payload.anomalies.map((signal) => <article key={signal.id}><span className={`${styles.severity} ${styles[signal.severity]}`}>{signal.severity}</span><div><h3>{signal.title}</h3><p>{signal.summary}</p><small>Evidence delta {money(Number(signal.evidence.delta), payload.currency)}</small></div></article>)}</div>
              )}
            </article>
            <article className="panel">
              <div className="panel-heading"><div><p className="eyebrow">Prioritized review</p><h2>FinOps recommendations</h2></div><span className="result-count">{payload.recommendations.length}</span></div>
              {payload.recommendations.length === 0 ? <p className={styles.emptyNote}>No recommendation met Sutra’s evidence threshold. Rightsizing is not inferred without utilization data.</p> : (
                <div className={styles.recommendations}>{payload.recommendations.map((item, index) => <article key={item.id}><b>{String(index + 1).padStart(2, "0")}</b><div><h3>{item.title}</h3><p>{item.summary}</p><span>Evidence-backed · no automatic purchase</span></div></article>)}</div>
              )}
            </article>
          </section>

          {optimizations.recommendations.length > 0 ? (
            <section className="panel">
              <div className="panel-heading"><div><p className="eyebrow">Resource-level optimization</p><h2>Cost optimization opportunities</h2></div><span className="result-count">{optimizations.summary.estimatedMonthlySavings !== null ? `~${money(optimizations.summary.estimatedMonthlySavings, payload.currency)}/mo identifiable` : `${optimizations.recommendations.length} opportunities`}</span></div>
              <div className={styles.recommendations}>{optimizations.recommendations.map((rec) => <article key={rec.id}><b>{rec.severity === "high" ? "!!" : rec.severity === "medium" ? "!" : "·"}</b><div><h3>{rec.title}</h3><p>{rec.summary}</p><span>{rec.estimatedMonthlySavings !== null ? `~${money(rec.estimatedMonthlySavings, payload.currency)}/mo identifiable` : "savings not derivable without utilization data"}</span></div></article>)}</div>
              <p className={styles.emptyNote}>{optimizations.disclaimer}</p>
            </section>
          ) : null}

          <section className={`panel ${styles.provenance}`}>
            <div><p className="eyebrow">Evidence provenance</p><h2>Immutable normalized AWS cost snapshot</h2><p>Account {payload.accountId} · collected {formatTimestamp(payload.collectedAt)} · period {payload.periodStart} to {payload.periodEnd}</p></div>
            <dl><div><dt>Snapshot</dt><dd title={snapshot.id}>{compactIdentifier(snapshot.id, 22)}</dd></div><div><dt>SHA-256</dt><dd title={snapshot.payloadSha256}>{compactIdentifier(snapshot.payloadSha256, 22)}</dd></div><div><dt>State</dt><dd>{payload.status}</dd></div></dl>
          </section>
        </>
      ) : null}
      <VisibilityPanels connectionId={connectionId} />
      <FinopsMorePanels connectionId={connectionId} />
      <FinopsCommitmentsPanels connectionId={connectionId} />
      <FinopsPanels connectionId={connectionId} />
    </>
  );
}
