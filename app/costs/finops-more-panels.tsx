"use client";

import { useEffect, useState } from "react";
import styles from "./costs.module.css";

// ---- response shapes (from the four new /api/v1/finops endpoints) ----
interface CoverageResponse {
  readonly coverage: {
    readonly currency: string | null;
    readonly currenciesPresent: readonly string[];
    readonly allocationTagKeys: readonly string[];
    readonly overall: { readonly totalUnits: number; readonly taggedUnits: number; readonly untaggedUnits: number; readonly taggedPercent: number | null };
    readonly perTagKey: readonly { readonly key: string; readonly coveragePercent: number | null; readonly missingUnits: number }[];
    readonly biggestUnallocated: {
      readonly services: readonly { readonly key: string; readonly untaggedUnits: number }[];
      readonly accounts: readonly { readonly key: string; readonly untaggedUnits: number }[];
    };
  };
}
type BudgetStatus = "ok" | "at_risk" | "breached";
interface BudgetRow {
  readonly id: string; readonly name: string; readonly currency: string;
  readonly budgetMicros: number; readonly mtdMicros: number; readonly consumedPercent: number | null;
  readonly projectedMonthEndMicros: number | null; readonly projectedOverspendMicros: number;
  readonly daysToBreach: number | null; readonly status: BudgetStatus;
  readonly series: readonly { readonly day: number; readonly cumulative: number; readonly budgetPace: number }[];
}
interface BudgetResponse { readonly budgets: readonly BudgetRow[]; readonly note: string }
interface UnitSeriesPoint { readonly period: string; readonly costPerUnit: number | null }
interface UnitMetric {
  readonly unit: string; readonly currency: string;
  readonly series: readonly UnitSeriesPoint[];
  readonly latest: UnitSeriesPoint | null; readonly deltaPercent: number | null; readonly direction: "up" | "down" | "flat";
}
interface UnitTrendResponse { readonly metrics: readonly UnitMetric[]; readonly note: string }
interface WasteFinding {
  readonly resourceKey: string; readonly resourceType: string; readonly region: string;
  readonly wasteKind: string; readonly reason: string; readonly estimatedMonthlyUsd: number | null;
}
interface WasteResponse {
  readonly summary: readonly { readonly wasteKind: string; readonly count: number; readonly estimatedMonthlyUsd: number | null }[];
  readonly findings: readonly WasteFinding[];
  readonly totalEstimatedMonthlyUsd: number | null;
  readonly note: string;
}

function money(value: number | null, currency: string | null): string {
  if (value === null || !currency) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency,
    minimumFractionDigits: value >= 100 ? 0 : 2, maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}
function micros(value: number): number { return value / 1_000_000; }
function pct(value: number | null): string { return value === null ? "—" : `${Math.round(value)}%`; }
function humanKind(kind: string): string { return kind.replace(/[-_]/g, " "); }

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

function Spark({ values }: { values: readonly number[] }) {
  const max = Math.max(...values, 1);
  return (
    <div className={styles.miniSpark} aria-hidden="true">
      {values.map((value, index) => <i key={index} style={{ height: `${Math.max(3, (value / max) * 100)}%` }} />)}
    </div>
  );
}

/**
 * Wave-1 FinOps analytics: tag/allocation coverage, budget burn-down + breach
 * forecast, unit-cost trend, and idle/unused resource waste. Each degrades to an
 * honest empty state; cost estimates on the waste panel are list-price
 * approximations, disclosed in-panel.
 */
export function FinopsMorePanels({ connectionId }: { connectionId: string | null }) {
  const [coverage, setCoverage] = useState<CoverageResponse | null>(null);
  const [budget, setBudget] = useState<BudgetResponse | null>(null);
  const [unit, setUnit] = useState<UnitTrendResponse | null>(null);
  const [waste, setWaste] = useState<WasteResponse | null>(null);

  useEffect(() => {
    if (connectionId === null) return;
    let active = true;
    const suffix = `?connectionId=${encodeURIComponent(connectionId)}`;
    const load = <T,>(path: string, set: (value: T) => void) =>
      getJson<T>(path).then((value) => { if (active) set(value); }).catch(() => { /* per-panel failure is non-fatal */ });
    void load<CoverageResponse>(`/api/v1/finops/coverage${suffix}`, setCoverage);
    void load<BudgetResponse>(`/api/v1/finops/budget-burndown${suffix}`, setBudget);
    void load<UnitTrendResponse>(`/api/v1/finops/unit-trend${suffix}`, setUnit);
    void load<WasteResponse>(`/api/v1/finops/waste${suffix}`, setWaste);
    return () => { active = false; };
  }, [connectionId]);

  if (connectionId === null) return null;

  const cov = coverage?.coverage;
  const statusClass: Record<BudgetStatus, string> = { ok: styles.bOk, at_risk: styles.bRisk, breached: styles.bBreached };
  const statusLabel: Record<BudgetStatus, string> = { ok: "On track", at_risk: "At risk", breached: "Over budget" };

  return (
    <>
      <section className={styles.overviewGrid}>
        <article className="panel">
          <div className="panel-heading">
            <div><p className="eyebrow">Allocation hygiene</p><h2>Tag &amp; allocation coverage</h2></div>
            {cov ? <span className={`status-pill ${(cov.overall.taggedPercent ?? 0) >= 90 ? "status-positive" : "status-risk"}`}>{pct(cov.overall.taggedPercent)} tagged</span> : null}
          </div>
          {coverage === null ? <p className={styles.emptyNote}>Loading coverage…</p>
            : cov && cov.overall.totalUnits > 0 ? (
              <>
                <div className={styles.breakdownList}>
                  {cov.perTagKey.map((row) => (
                    <div className={styles.breakdownRow} key={row.key}>
                      <div><strong>{row.key}</strong><span>{pct(row.coveragePercent)} covered</span></div>
                      <div className={styles.progress}><i style={{ width: `${Math.min(100, row.coveragePercent ?? 0)}%` }} /></div>
                      <small>{money(row.missingUnits, cov.currency)} untagged</small>
                    </div>
                  ))}
                </div>
                {cov.biggestUnallocated.services.length > 0 ? (
                  <p className={styles.emptyNote}>
                    Biggest unallocated: {cov.biggestUnallocated.services.slice(0, 3).map((s) => `${s.key} (${money(s.untaggedUnits, cov.currency)})`).join(" · ")}
                    {cov.currenciesPresent.length > 1 ? ` · analysed ${cov.currency}, other currencies present` : ""}
                  </p>
                ) : null}
              </>
            ) : <p className={styles.emptyNote}>Upload a CUR/FOCUS billing file to measure tag &amp; allocation coverage.</p>}
        </article>

        <article className="panel">
          <div className="panel-heading">
            <div><p className="eyebrow">Efficiency</p><h2>Unit-cost trend</h2></div>
            <span className="result-count">{unit?.metrics.length ?? 0} metric{(unit?.metrics.length ?? 0) === 1 ? "" : "s"}</span>
          </div>
          {unit === null ? <p className={styles.emptyNote}>Loading unit-cost trend…</p>
            : unit.metrics.length === 0 ? <p className={styles.emptyNote}>Add unit counts (customers, transactions…) and cost data to trend cost-per-unit over time.</p>
            : (
              <div>
                {unit.metrics.map((metric) => (
                  <div className={styles.metricRow} key={metric.unit}>
                    <div style={{ minWidth: 0 }}>
                      <strong>{metric.unit}</strong>
                      <div className={styles.budgetMeta}>
                        <span>cost/unit <b>{money(metric.latest ? micros(metric.latest.costPerUnit ?? 0) : null, metric.currency)}</b></span>
                        <span className={metric.direction === "up" ? styles.costUp : metric.direction === "down" ? styles.costDown : undefined}>
                          {metric.deltaPercent === null ? "—" : `${metric.deltaPercent > 0 ? "▲ +" : metric.direction === "down" ? "▼ " : ""}${metric.deltaPercent.toFixed(1)}%`}
                        </span>
                      </div>
                    </div>
                    <Spark values={metric.series.map((point) => point.costPerUnit ?? 0)} />
                  </div>
                ))}
              </div>
            )}
        </article>
      </section>

      <section className="panel" aria-label="Budget burn-down">
        <div className="panel-heading">
          <div><p className="eyebrow">Guardrails</p><h2>Budget burn-down &amp; breach forecast</h2></div>
          {budget ? <span className="result-count">{budget.budgets.length} budget{budget.budgets.length === 1 ? "" : "s"}</span> : null}
        </div>
        {budget === null ? <p className={styles.emptyNote}>Loading budgets…</p>
          : budget.budgets.length === 0 ? <p className={styles.emptyNote}>No budgets configured yet. Add a budget below to get burn-down and breach forecasting.</p>
          : (
            <>
              {budget.budgets.map((row) => (
                <div className={styles.budgetRow} key={row.id}>
                  <div className={styles.budgetTop}>
                    <strong>{row.name}</strong>
                    <span className={`${styles.bStatus} ${statusClass[row.status]}`}>{statusLabel[row.status]}</span>
                  </div>
                  <div className={styles.progress}><i style={{ width: `${Math.min(100, row.consumedPercent ?? 0)}%` }} /></div>
                  <div className={styles.budgetMeta}>
                    <span>Spent <b>{money(micros(row.mtdMicros), row.currency)}</b> of {money(micros(row.budgetMicros), row.currency)} ({pct(row.consumedPercent)})</span>
                    <span>Projected month-end <b>{money(row.projectedMonthEndMicros === null ? null : micros(row.projectedMonthEndMicros), row.currency)}</b></span>
                    {row.projectedOverspendMicros > 0 ? <span className={styles.costUp}>Projected overspend <b>{money(micros(row.projectedOverspendMicros), row.currency)}</b></span> : null}
                    {row.daysToBreach !== null ? <span className={styles.costUp}>Breaches in <b>{row.daysToBreach} day{row.daysToBreach === 1 ? "" : "s"}</b></span> : null}
                  </div>
                </div>
              ))}
              <p className={styles.emptyNote}>{budget.note}</p>
            </>
          )}
      </section>

      <section className="panel" aria-label="Idle and unused resources">
        <div className="panel-heading">
          <div><p className="eyebrow">Cleanup opportunities</p><h2>Idle &amp; unused resources</h2></div>
          {waste ? <span className={`status-pill ${(waste.totalEstimatedMonthlyUsd ?? 0) > 0 ? "status-risk" : "status-positive"}`}>~{money(waste.totalEstimatedMonthlyUsd, "USD")}/mo identifiable</span> : null}
        </div>
        {waste === null ? <p className={styles.emptyNote}>Scanning for idle &amp; unused resources…</p>
          : waste.findings.length === 0 ? <p className={styles.emptyNote}>No unattached storage, unused addresses, empty load balancers, or aged snapshots detected in the current snapshot.</p>
          : (
            <>
              <section className={styles.kpis} aria-label="Waste by kind">
                {waste.summary.slice(0, 4).map((row) => (
                  <article className="panel" key={row.wasteKind}>
                    <small>{humanKind(row.wasteKind)}</small>
                    <strong>{row.count}</strong>
                    <span>{row.estimatedMonthlyUsd !== null ? `~${money(row.estimatedMonthlyUsd, "USD")}/mo` : "cost not derivable"}</span>
                  </article>
                ))}
              </section>
              <div className={styles.breakdownList}>
                {waste.findings.slice(0, 12).map((finding) => (
                  <div className={styles.breakdownRow} key={finding.resourceKey}>
                    <div>
                      <strong title={finding.resourceKey}>{finding.resourceType} · {finding.region || "—"}</strong>
                      <span>{finding.estimatedMonthlyUsd !== null ? `~${money(finding.estimatedMonthlyUsd, "USD")}/mo` : "—"}</span>
                    </div>
                    <small style={{ gridColumn: "1 / -1", textAlign: "left", whiteSpace: "normal" }}>{finding.reason}</small>
                  </div>
                ))}
              </div>
              <p className={styles.emptyNote}>{waste.note}</p>
            </>
          )}
      </section>
    </>
  );
}
