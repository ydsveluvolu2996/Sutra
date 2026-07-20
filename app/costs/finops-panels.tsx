"use client";

import { useCallback, useEffect, useState } from "react";

/* FinOps workspace panels: CUR/FOCUS upload, allocation, budgets, anomaly
 * signals. Money is displayed from integer micro-units; rejected upload rows
 * and unallocated remainders are always shown — nothing is smoothed over. */

interface AllocationBucket { readonly key: string; readonly amountMicros: string; readonly lineCount: number }
interface Allocation {
  readonly currency: string;
  readonly buckets: readonly AllocationBucket[];
  readonly unallocatedMicros: string;
  readonly unallocatedLineCount: number;
  readonly totalMicros: string;
}
interface BudgetEvaluation {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly limitMicros: string;
  readonly spentMicros: string;
  readonly utilizationPercent: number | null;
  readonly state: string;
}
interface Anomaly { readonly dateIso: string; readonly service: string; readonly currency: string; readonly amountMicros: string; readonly baselineMicros: string; readonly ratio: number }
interface Optimization {
  readonly id: string;
  readonly category: "commitment" | "rightsizing" | string;
  readonly severity: "low" | "medium" | "high";
  readonly title: string;
  readonly summary: string;
  readonly currency?: string;
  readonly estimatedMonthlySavingsMicros?: string | null;
  readonly evidence: Readonly<Record<string, string | number>>;
}
interface Commitment {
  readonly recommendations: readonly Optimization[];
  readonly savingsByCurrencyMicros: Readonly<Record<string, string>>;
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}
interface RightsizingObservation {
  readonly cpuP95Percent: number | null;
  readonly memoryP95Percent: number | null;
  readonly networkP95BytesPerMinute: number | null;
  readonly sampleWindowDays: number | null;
}
interface RightsizingRec {
  readonly resourceKey: string;
  readonly region: string | null;
  readonly currentInstanceType: string | null;
  readonly state: "downsize-recommended" | "insufficient-data" | "already-optimal";
  readonly targetInstanceType: string | null;
  readonly currency: string | null;
  readonly estimatedMonthlySavingsMicros: string | null;
  readonly observed: RightsizingObservation;
  readonly memoryKnown: boolean;
  readonly reasons: readonly string[];
}
interface Rightsizing {
  readonly recommendations: readonly RightsizingRec[];
  readonly summary: {
    readonly evaluated: number;
    readonly downsizeRecommended: number;
    readonly insufficientData: number;
    readonly savingsByCurrencyMicros: Readonly<Record<string, string>>;
  };
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}
interface IdleWasteFinding {
  readonly id: string;
  readonly category: string;
  readonly severity: "low" | "medium" | "high";
  readonly resourceKey: string;
  readonly region: string | null;
  readonly title: string;
  readonly currency: string | null;
  readonly estimatedMonthlyWasteMicros: string | null;
  readonly costBasis: "cur-line-items" | "bundled-list-price" | "none";
  readonly basisReason: string;
}
interface IdleWaste {
  readonly findings: readonly IdleWasteFinding[];
  readonly summary: {
    readonly count: number;
    readonly wasteByCurrencyMicros: Readonly<Record<string, string>>;
    readonly findingsWithoutEstimate: number;
  };
  readonly disclaimer: string;
}
interface RequiredTagCoverage {
  readonly tag: string;
  readonly resourcesTotal: number;
  readonly resourcesWithTag: number;
  readonly coveragePercent: number | null;
  readonly missingResourceKeys: readonly string[];
}
interface CurrencyUntaggedSpend {
  readonly currency: string;
  readonly totalMicros: string;
  readonly untaggedMicros: string;
  readonly untaggedPercent: number | null;
  readonly unattributableMicros: string;
}
interface MissingTagResource {
  readonly resourceKey: string;
  readonly service: string | null;
  readonly region: string | null;
  readonly missingTags: readonly string[];
}
interface TagGovernance {
  readonly requiredTags: readonly string[];
  readonly resourceCoverage: readonly RequiredTagCoverage[];
  readonly spendByCurrency: readonly CurrencyUntaggedSpend[];
  readonly missingByResource: readonly MissingTagResource[];
  readonly summary: {
    readonly resourcesEvaluated: number;
    readonly resourcesMissingAnyTag: number;
    readonly fullyTaggedPercent: number | null;
  };
  readonly disclaimer: string;
}
interface CostTrendPeriod {
  readonly period: string;
  readonly totalMicros: string;
  readonly lineCount: number;
  readonly momDeltaMicros: string | null;
  readonly momDeltaPercent: number | null;
  readonly momBasis: string;
  readonly movingAverageMicros: string | null;
  readonly isCurrentPartialPeriod: boolean;
}
interface ForecastPoint {
  readonly period: string;
  readonly amountMicros: string;
  readonly bandLowMicros: string | null;
  readonly bandHighMicros: string | null;
}
type ForecastResult =
  | { readonly available: false; readonly reason: string; readonly historicalPointsUsed: number; readonly minRequired: number }
  | {
      readonly available: true;
      readonly method: string;
      readonly historicalPointsUsed: number;
      readonly points: readonly ForecastPoint[];
      readonly residualBand: { readonly method: string; readonly sigmaMicros: string } | null;
      readonly disclaimer: string;
    };
interface CostTrendSeries {
  readonly currency: string;
  readonly movingAverageWindow: number;
  readonly periods: readonly CostTrendPeriod[];
  readonly forecast: ForecastResult;
}
interface CostTrends {
  readonly series: readonly CostTrendSeries[];
  readonly currentPeriod: string | null;
  readonly disclaimer: string;
}
interface SavingsPeriod {
  readonly period: string;
  readonly realizedSavingsMicros: string | null;
  readonly realizedSavingsBasis: string;
  readonly coveredAmortizedMicros: string;
  readonly coveredOnDemandEquivalentMicros: string | null;
  readonly onDemandUsageMicros: string;
  readonly commitmentFeeMicros: string;
  readonly coveragePercent: number | null;
  readonly coverageBasis: string;
  readonly periodOverPeriodDeltaMicros: string | null;
  readonly cumulativeRealizedSavingsMicros: string;
  readonly isCurrentPartialPeriod: boolean;
}
interface SavingsTrackingSeries {
  readonly currency: string;
  readonly periods: readonly SavingsPeriod[];
  readonly totalRealizedSavingsMicros: string;
  readonly derivablePeriodCount: number;
  readonly notDerivablePeriodCount: number;
}
interface SavingsTracking {
  readonly series: readonly SavingsTrackingSeries[];
  readonly currentPeriod: string | null;
  readonly disclaimer: string;
}
interface K8sNamespaceAllocation {
  readonly namespace: string;
  readonly allocatedMicros: string;
  readonly sharePermille: number;
  readonly zeroRequests: boolean;
}
interface K8sCurrencyAllocation {
  readonly currency: string;
  readonly clusterCostMicros: string;
  readonly allocatedMicros: string;
  readonly unallocatedMicros: string;
  readonly unallocatedBasis: string;
  readonly namespaces: readonly K8sNamespaceAllocation[];
}
interface K8sClusterAllocation {
  readonly clusterId: string;
  readonly costAvailable: boolean;
  readonly unavailableReason: string | null;
  readonly basis: string | null;
  readonly basisReason: string;
  readonly namespacesEvaluated: number;
  readonly currencies: readonly K8sCurrencyAllocation[];
}
interface K8sAllocationCluster {
  readonly clusterName: string;
  readonly costCatalogCoverage: { readonly nodesTotal: number; readonly nodesPriced: number; readonly nodesWithUnknownType: number; readonly disclosure: string };
  readonly allocation: K8sClusterAllocation;
}
interface KubernetesAllocation {
  readonly clusters: readonly K8sAllocationCluster[];
  readonly disclaimer: string;
}
interface UnitCostPerUnit {
  readonly amountMicros: string;
  readonly count: number | null;
  readonly microsPerUnit: number | null;
  readonly ratioBasis: string;
}
interface UnitEconomicsCurrencyResult {
  readonly currency: string;
  readonly customers: readonly { readonly customerId: string; readonly costPerUnit: UnitCostPerUnit }[];
  readonly global: UnitCostPerUnit;
  readonly totalMicros: string;
}
interface UnitEconomicsEntry {
  readonly unitLabel: string;
  readonly count: number;
  readonly report: {
    readonly unitLabel: string | null;
    readonly results: readonly UnitEconomicsCurrencyResult[];
    readonly disclaimer: string;
  };
}
interface ScheduledReport {
  readonly id: string;
  readonly name: string;
  readonly connectionId: string;
  readonly cadence: string;
  readonly deliveryKind: string;
  readonly deliveryTarget: string;
  readonly enabled: boolean;
  readonly lastRunAt: string | null;
  readonly nextRunAt: string;
}
interface Insights {
  readonly periods: readonly { period: string; lineCount: number }[];
  readonly period: string | null;
  readonly lineCount?: number;
  readonly allocation: readonly Allocation[];
  readonly budgets: readonly BudgetEvaluation[];
  readonly anomalies: { readonly anomalies: readonly Anomaly[]; readonly disclaimer: string } | null;
  readonly commitment?: Commitment | null;
  readonly rightsizing?: Rightsizing | null;
  readonly idleWaste?: IdleWaste | null;
  readonly tagGovernance?: TagGovernance | null;
  readonly trends?: CostTrends | null;
  readonly savings?: SavingsTracking | null;
  readonly unitEconomics?: readonly UnitEconomicsEntry[];
  readonly unitCountsPeriod?: string | null;
  readonly kubernetesAllocation?: KubernetesAllocation | null;
}

function money(micros: string, currency: string): string {
  const negative = micros.startsWith("-");
  const digits = negative ? micros.slice(1) : micros;
  const padded = digits.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const cents = padded.slice(-6, -4);
  return `${negative ? "-" : ""}${whole}.${cents} ${currency}`;
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { cache: "no-store", credentials: "same-origin", ...init });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload
      ? String((payload as { error: { message?: string } }).error?.message ?? "Request rejected")
      : "Request rejected";
    throw new Error(message);
  }
  return payload as T;
}

export function FinopsPanels({ connectionId }: { connectionId: string | null }) {
  const [insights, setInsights] = useState<Insights | null>(null);
  const [dimension, setDimension] = useState<"service" | "account" | "tag">("service");
  const [tagKey, setTagKey] = useState("env");
  const [period, setPeriod] = useState<string | null>(null);
  const [uploadPeriod, setUploadPeriod] = useState("");
  const [csv, setCsv] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [budgetDraft, setBudgetDraft] = useState({ name: "", currency: "USD", limit: "" });
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [unitDraft, setUnitDraft] = useState({ unitLabel: "transactions", count: "" });
  const [unitError, setUnitError] = useState<string | null>(null);
  const [reports, setReports] = useState<readonly ScheduledReport[]>([]);
  const [reportDraft, setReportDraft] = useState({ name: "", cadence: "monthly", deliveryKind: "email", deliveryTarget: "" });
  const [reportError, setReportError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!connectionId) return;
    const params = new URLSearchParams({ connectionId, dimension });
    if (dimension === "tag") params.set("tagKey", tagKey || "env");
    if (period !== null) params.set("period", period);
    try {
      const payload = await requestJson<Insights>(`/api/v1/finops/insights?${params.toString()}`);
      setInsights(payload);
      setPeriod(payload.period);
    } catch {
      setInsights(null);
    }
  }, [connectionId, dimension, tagKey, period]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function upload() {
    if (!connectionId || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(uploadPeriod) || csv.trim().length === 0) return;
    setUploading(true);
    setUploadError(null);
    setUploadResult(null);
    try {
      const payload = await requestJson<{ summary: { inserted: number; replaced: number }; rejectedCount: number; dialect: string }>(
        "/api/v1/finops/cur",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId, billingPeriod: uploadPeriod, csv }) },
      );
      setUploadResult(`Accepted ${payload.summary.inserted} lines (${payload.dialect}); replaced ${payload.summary.replaced}; rejected ${payload.rejectedCount} rows.`);
      setCsv("");
      setPeriod(uploadPeriod);
      await load();
    } catch (caught) {
      setUploadError(caught instanceof Error ? caught.message : "Upload rejected");
    } finally {
      setUploading(false);
    }
  }

  async function saveBudget() {
    setBudgetError(null);
    try {
      const limitMicros = budgetDraft.limit.trim().length > 0 && /^\d+(\.\d{1,6})?$/u.test(budgetDraft.limit.trim())
        ? String(Math.round(Number(budgetDraft.limit.trim()) * 1_000_000))
        : null;
      if (limitMicros === null) throw new Error("Limit must be a positive amount, e.g. 1500 or 1500.50");
      await requestJson("/api/v1/finops/budgets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: budgetDraft.name.trim(), currency: budgetDraft.currency.trim().toUpperCase(), limitMicros }),
      });
      setBudgetDraft({ name: "", currency: "USD", limit: "" });
      await load();
    } catch (caught) {
      setBudgetError(caught instanceof Error ? caught.message : "Budget rejected");
    }
  }

  async function saveUnitCount() {
    setUnitError(null);
    try {
      const effectivePeriod = period ?? insights?.period ?? null;
      if (effectivePeriod === null) throw new Error("Select or upload a billing period first.");
      const count = Number(unitDraft.count.trim());
      if (!Number.isInteger(count) || count < 0) throw new Error("Count must be a whole number (0 or more).");
      await requestJson("/api/v1/finops/unit-counts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ period: effectivePeriod, unitLabel: unitDraft.unitLabel.trim(), count }),
      });
      setUnitDraft((draft) => ({ ...draft, count: "" }));
      await load();
    } catch (caught) {
      setUnitError(caught instanceof Error ? caught.message : "Unit count rejected");
    }
  }

  const loadReports = useCallback(async () => {
    if (!connectionId) return;
    try {
      const payload = await requestJson<{ reports: readonly ScheduledReport[] }>("/api/v1/finops/reports");
      setReports(payload.reports);
    } catch {
      setReports([]);
    }
  }, [connectionId]);

  useEffect(() => {
    void (async () => {
      await loadReports();
    })();
  }, [loadReports]);

  async function saveReport() {
    setReportError(null);
    try {
      if (!connectionId) throw new Error("No connection selected.");
      if (reportDraft.name.trim().length === 0) throw new Error("Give the report a name.");
      if (reportDraft.deliveryTarget.trim().length === 0) {
        throw new Error(reportDraft.deliveryKind === "email" ? "Enter a recipient email." : "Enter an HTTPS webhook URL.");
      }
      await requestJson("/api/v1/finops/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: reportDraft.name.trim(),
          connectionId,
          cadence: reportDraft.cadence,
          deliveryKind: reportDraft.deliveryKind,
          deliveryTarget: reportDraft.deliveryTarget.trim(),
        }),
      });
      setReportDraft({ name: "", cadence: "monthly", deliveryKind: "email", deliveryTarget: "" });
      await loadReports();
    } catch (caught) {
      setReportError(caught instanceof Error ? caught.message : "Schedule rejected");
    }
  }

  async function toggleReport(id: string, enabled: boolean) {
    setReportError(null);
    try {
      await requestJson("/api/v1/finops/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "setEnabled", id, enabled }),
      });
      await loadReports();
    } catch (caught) {
      setReportError(caught instanceof Error ? caught.message : "Update rejected");
    }
  }

  async function deleteReport(id: string) {
    setReportError(null);
    try {
      await requestJson(`/api/v1/finops/reports?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadReports();
    } catch (caught) {
      setReportError(caught instanceof Error ? caught.message : "Delete rejected");
    }
  }

  if (!connectionId) return null;

  return (
    <>
      <section className="panel" aria-label="Billing data upload">
        <div className="panel-heading"><div><h2>Billing data (CUR 2.0 / FOCUS 1.0)</h2><p>Paste a CSV export for one billing period. A re-upload replaces that period — it never double-counts. Rejected rows are reported, never estimated.</p></div></div>
        <div className="cmdbq-row">
          <input aria-label="Billing period" placeholder="billing period (YYYY-MM)" value={uploadPeriod} onChange={(event) => setUploadPeriod(event.target.value)} />
          <button type="button" className="button button-primary" disabled={uploading || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(uploadPeriod) || csv.trim().length === 0} onClick={() => void upload()}>{uploading ? "Uploading…" : "Upload period"}</button>
        </div>
        <textarea className="cmpw-controls" aria-label="CUR CSV" rows={5} placeholder="Paste the CSV export here (header row required)" value={csv} onChange={(event) => setCsv(event.target.value)} />
        {uploadResult ? <p className="panel-footnote">{uploadResult}</p> : null}
        {uploadError ? <p className="cmdbq-error" role="alert">{uploadError}</p> : null}
      </section>

      <section className="panel" aria-label="Cost allocation">
        <div className="panel-heading"><div><h2>Allocation</h2><p>Grouped per currency — currencies are never summed together. Lines without the chosen dimension stay disclosed as unallocated.</p></div></div>
        <div className="cmdbq-row">
          <select aria-label="Period" value={period ?? ""} onChange={(event) => setPeriod(event.target.value || null)}>
            {(insights?.periods ?? []).map((entry) => <option key={entry.period} value={entry.period}>{entry.period} ({entry.lineCount} lines)</option>)}
          </select>
          <select aria-label="Dimension" value={dimension} onChange={(event) => setDimension(event.target.value as "service")}>
            <option value="service">By service</option><option value="account">By account</option><option value="tag">By tag</option>
          </select>
          {dimension === "tag" ? <input aria-label="Tag key" placeholder="tag key" value={tagKey} onChange={(event) => setTagKey(event.target.value)} /> : null}
        </div>
        {insights === null || insights.period === null ? <p className="panel-footnote">No billing data ingested yet.</p> : insights.allocation.map((allocation) => (
          <div key={allocation.currency} className="cmdbq-results">
            <p className="cmdbq-summary">{allocation.currency}: total {money(allocation.totalMicros, allocation.currency)} · unallocated {money(allocation.unallocatedMicros, allocation.currency)} ({allocation.unallocatedLineCount} lines)</p>
            <table><thead><tr><th>Bucket</th><th>Amount</th><th>Lines</th></tr></thead>
              <tbody>{allocation.buckets.slice(0, 20).map((bucket) => (
                <tr key={bucket.key}><td>{bucket.key}</td><td>{money(bucket.amountMicros, allocation.currency)}</td><td>{bucket.lineCount}</td></tr>
              ))}</tbody></table>
          </div>
        ))}
      </section>

      <section className="panel" aria-label="Budgets">
        <div className="panel-heading"><div><h2>Budgets</h2><p>Evaluated against ingested lines in the selected period. A budget with no matching lines reports no-data — never a silent zero.</p></div></div>
        <div className="cmdbq-row">
          <input aria-label="Budget name" placeholder="name" value={budgetDraft.name} onChange={(event) => setBudgetDraft((draft) => ({ ...draft, name: event.target.value }))} />
          <input aria-label="Currency" placeholder="USD" value={budgetDraft.currency} onChange={(event) => setBudgetDraft((draft) => ({ ...draft, currency: event.target.value }))} />
          <input aria-label="Limit" placeholder="limit (e.g. 1500.00)" value={budgetDraft.limit} onChange={(event) => setBudgetDraft((draft) => ({ ...draft, limit: event.target.value }))} />
          <button type="button" className="button button-primary" disabled={budgetDraft.name.trim().length === 0} onClick={() => void saveBudget()}>Save budget</button>
        </div>
        {budgetError ? <p className="cmdbq-error" role="alert">{budgetError}</p> : null}
        {(insights?.budgets ?? []).length > 0 ? (
          <table><thead><tr><th>Budget</th><th>Spent</th><th>Limit</th><th>Utilization</th><th>State</th></tr></thead>
            <tbody>{insights!.budgets.map((budget) => (
              <tr key={budget.id}>
                <td>{budget.name}</td>
                <td>{money(budget.spentMicros, budget.currency)}</td>
                <td>{money(budget.limitMicros, budget.currency)}</td>
                <td>{budget.utilizationPercent === null ? "—" : `${budget.utilizationPercent.toFixed(1)}%`}</td>
                <td><span className={`cmdbq-chip ${budget.state === "breached" ? "cmdbq-removed" : budget.state === "warning" ? "cmdbq-changed" : "cmdbq-added"}`}>{budget.state}</span></td>
              </tr>
            ))}</tbody></table>
        ) : <p className="panel-footnote">No budgets defined yet.</p>}
      </section>

      <section className="panel" aria-label="Anomaly signals">
        <div className="panel-heading"><div><h2>Anomaly signals</h2><p>Days at least 3× the trailing median for a service — statistical signals over ingested lines, not billing truth.</p></div></div>
        {insights?.anomalies == null || insights.anomalies.anomalies.length === 0 ? (
          <p className="panel-footnote">No anomalies flagged in the selected period{insights?.anomalies ? "" : " (no data)"}.</p>
        ) : (
          <>
            <table><thead><tr><th>Date</th><th>Service</th><th>Spend</th><th>Baseline</th><th>Ratio</th></tr></thead>
              <tbody>{insights.anomalies.anomalies.slice(0, 20).map((anomaly, index) => (
                <tr key={`${anomaly.service}-${anomaly.dateIso}-${index}`}>
                  <td>{anomaly.dateIso}</td><td>{anomaly.service}</td>
                  <td>{money(anomaly.amountMicros, anomaly.currency)}</td>
                  <td>{money(anomaly.baselineMicros, anomaly.currency)}</td>
                  <td>{anomaly.ratio.toFixed(2)}×</td>
                </tr>
              ))}</tbody></table>
            <p className="panel-footnote">{insights.anomalies.disclaimer}</p>
          </>
        )}
      </section>

      <section className="panel" aria-label="Commitment and rightsizing">
        <div className="panel-heading"><div><h2>Commitment &amp; rightsizing</h2><p>Derived from ingested billing lines, per currency. Commitment savings apply a disclosed assumed discount to observed sustained on-demand spend — a planning input, not a quote. Rightsizing carries no savings figure: per-resource utilization is not collected.</p></div></div>
        {insights?.commitment == null || insights.commitment.recommendations.length === 0 ? (
          <p className="panel-footnote">No commitment or rightsizing candidates in the selected period{insights?.commitment ? "" : " (no data)"}.</p>
        ) : (
          <>
            <table><thead><tr><th>Category</th><th>Candidate</th><th>Est. monthly savings</th><th>Severity</th></tr></thead>
              <tbody>{insights.commitment.recommendations.map((rec) => (
                <tr key={rec.id}>
                  <td><span className="cmdbq-chip">{rec.category}</span></td>
                  <td>{rec.title}</td>
                  <td>{rec.estimatedMonthlySavingsMicros != null && rec.currency
                    ? `${money(rec.estimatedMonthlySavingsMicros, rec.currency)} (assumes ${rec.evidence.assumedDiscountPercent ?? ""}% discount)`
                    : `No savings estimated — ${String(rec.evidence.noSavingsReason ?? "not derivable")}`}</td>
                  <td><span className={`cmdbq-chip ${rec.severity === "high" ? "cmdbq-removed" : rec.severity === "medium" ? "cmdbq-changed" : "cmdbq-added"}`}>{rec.severity}</span></td>
                </tr>
              ))}</tbody></table>
            <p className="panel-footnote">{insights.commitment.disclaimer}</p>
          </>
        )}
      </section>

      <section className="panel" aria-label="Rightsizing (utilization-based)">
        <div className="panel-heading"><div><h2>Rightsizing (utilization-based)</h2><p>Derived from collected CloudWatch utilization over the observed window. A smaller same-family instance is suggested only when utilization is confidently low; the saving is an estimate, not a quote. Where memory was not collected the recommendation is CPU/network-based — verify the workload is not memory-bound. Resources without enough data are shown as insufficient-data, never as a fabricated saving.</p></div></div>
        {insights?.rightsizing == null || insights.rightsizing.recommendations.length === 0 ? (
          <p className="panel-footnote">No utilization-based rightsizing recommendations for the selected period{insights?.rightsizing ? " (run a utilization collection to populate this)" : " (no data)"}.</p>
        ) : (
          <>
            <table><thead><tr><th>Resource</th><th>Current → target</th><th>Observed p95 (CPU / mem)</th><th>Est. monthly saving</th><th>State</th></tr></thead>
              <tbody>{insights.rightsizing.recommendations.map((rec) => (
                <tr key={rec.resourceKey}>
                  <td>{rec.resourceKey}{rec.region ? ` (${rec.region})` : ""}</td>
                  <td>{rec.currentInstanceType ?? "—"}{rec.targetInstanceType ? ` → ${rec.targetInstanceType}` : ""}</td>
                  <td>
                    {rec.observed.cpuP95Percent === null ? "CPU —" : `CPU ${rec.observed.cpuP95Percent.toFixed(0)}%`}
                    {" / "}
                    {rec.memoryKnown && rec.observed.memoryP95Percent !== null ? `mem ${rec.observed.memoryP95Percent.toFixed(0)}%` : "mem not collected"}
                  </td>
                  <td>{rec.estimatedMonthlySavingsMicros != null && rec.currency
                    ? money(rec.estimatedMonthlySavingsMicros, rec.currency)
                    : `No saving — ${String(rec.reasons[0] ?? "not derivable")}`}</td>
                  <td><span className={`cmdbq-chip ${rec.state === "downsize-recommended" ? "cmdbq-added" : rec.state === "insufficient-data" ? "cmdbq-changed" : ""}`}>{rec.state}</span></td>
                </tr>
              ))}</tbody></table>
            <p className="panel-footnote">{insights.rightsizing.disclaimer}</p>
          </>
        )}
      </section>

      <section className="panel" aria-label="Idle and waste">
        <div className="panel-heading"><div><h2>Idle &amp; waste</h2><p>Unattached volumes, empty load balancers, unused Elastic IPs, stopped-but-billing instances, and orphaned snapshots. A monthly cost appears only when derivable — from per-resource CUR lines or a bundled conservative USD list price — otherwise the reason is shown, never a fabricated figure.</p></div></div>
        {insights?.idleWaste == null || insights.idleWaste.findings.length === 0 ? (
          <p className="panel-footnote">No idle or wasted resources detected{insights?.idleWaste ? "" : " (no data)"}.</p>
        ) : (
          <>
            {Object.keys(insights.idleWaste.summary.wasteByCurrencyMicros).length > 0 ? (
              <p className="cmdbq-summary">Estimated monthly waste: {Object.entries(insights.idleWaste.summary.wasteByCurrencyMicros).map(([currency, micros]) => money(micros, currency)).join(" · ")}{insights.idleWaste.summary.findingsWithoutEstimate > 0 ? ` · ${insights.idleWaste.summary.findingsWithoutEstimate} finding(s) with no derivable estimate` : ""}</p>
            ) : null}
            <table><thead><tr><th>Category</th><th>Resource</th><th>Est. monthly waste</th><th>Severity</th></tr></thead>
              <tbody>{insights.idleWaste.findings.map((finding) => (
                <tr key={finding.id}>
                  <td><span className="cmdbq-chip">{finding.category}</span></td>
                  <td>{finding.title}{finding.region ? ` (${finding.region})` : ""}</td>
                  <td>{finding.estimatedMonthlyWasteMicros != null && finding.currency
                    ? `${money(finding.estimatedMonthlyWasteMicros, finding.currency)} (${finding.costBasis})`
                    : `No estimate — ${finding.basisReason}`}</td>
                  <td><span className={`cmdbq-chip ${finding.severity === "high" ? "cmdbq-removed" : finding.severity === "medium" ? "cmdbq-changed" : "cmdbq-added"}`}>{finding.severity}</span></td>
                </tr>
              ))}</tbody></table>
            <p className="panel-footnote">{insights.idleWaste.disclaimer}</p>
          </>
        )}
      </section>

      <section className="panel" aria-label="Tag governance">
        <div className="panel-heading"><div><h2>Tag governance</h2><p>Cost-allocation tag coverage over billable resources and untagged-spend share from CUR lines, per currency. &quot;Untagged&quot; means a required tag is missing in collected metadata — a coverage statement, not proof of untracked cost.</p></div></div>
        {insights?.tagGovernance == null ? (
          <p className="panel-footnote">No tag governance data (no data).</p>
        ) : (
          <>
            <p className="cmdbq-summary">Required tags: {insights.tagGovernance.requiredTags.join(", ")} · {insights.tagGovernance.summary.resourcesMissingAnyTag} of {insights.tagGovernance.summary.resourcesEvaluated} resources missing a required tag{insights.tagGovernance.summary.fullyTaggedPercent === null ? "" : ` · ${insights.tagGovernance.summary.fullyTaggedPercent.toFixed(1)}% fully tagged`}</p>
            {insights.tagGovernance.spendByCurrency.length > 0 ? (
              <table><thead><tr><th>Currency</th><th>Total spend</th><th>Untagged spend</th><th>Untagged %</th></tr></thead>
                <tbody>{insights.tagGovernance.spendByCurrency.map((row) => (
                  <tr key={row.currency}>
                    <td>{row.currency}</td>
                    <td>{money(row.totalMicros, row.currency)}</td>
                    <td>{money(row.untaggedMicros, row.currency)}</td>
                    <td>{row.untaggedPercent === null ? "—" : `${row.untaggedPercent.toFixed(1)}%`}</td>
                  </tr>
                ))}</tbody></table>
            ) : <p className="panel-footnote">No CUR spend ingested for the selected period — coverage is shown from CMDB metadata only.</p>}
            <table><thead><tr><th>Required tag</th><th>Coverage</th><th>Resources with tag</th></tr></thead>
              <tbody>{insights.tagGovernance.resourceCoverage.map((coverage) => (
                <tr key={coverage.tag}>
                  <td>{coverage.tag}</td>
                  <td>
                    <span aria-hidden="true" style={{ display: "inline-block", width: "80px", height: "7px", borderRadius: "20px", background: "var(--surface-soft)", verticalAlign: "middle", overflow: "hidden" }}>
                      <span style={{ display: "block", height: "100%", width: `${coverage.coveragePercent ?? 0}%`, background: "var(--forest, #2fae74)" }} />
                    </span>
                    {coverage.coveragePercent === null ? " —" : ` ${coverage.coveragePercent.toFixed(1)}%`}
                  </td>
                  <td>{coverage.resourcesWithTag} / {coverage.resourcesTotal}</td>
                </tr>
              ))}</tbody></table>
            {insights.tagGovernance.missingByResource.length > 0 ? (
              <table><thead><tr><th>Resource</th><th>Service</th><th>Missing tags</th></tr></thead>
                <tbody>{insights.tagGovernance.missingByResource.slice(0, 20).map((resource) => (
                  <tr key={resource.resourceKey}>
                    <td>{resource.resourceKey}{resource.region ? ` (${resource.region})` : ""}</td>
                    <td>{resource.service ?? "—"}</td>
                    <td>{resource.missingTags.join(", ")}</td>
                  </tr>
                ))}</tbody></table>
            ) : <p className="panel-footnote">Every evaluated resource carries all required tags.</p>}
            <p className="panel-footnote">{insights.tagGovernance.disclaimer}</p>
          </>
        )}
      </section>

      <section className="panel" aria-label="Cost trends and forecast">
        <div className="panel-heading"><div><h2>Cost trends &amp; forecast</h2><p>Month-over-month spend per currency across every ingested period, with a trailing moving average and a linear-regression forecast. Currencies are never summed. The forecast is an estimate over historical totals — shown only with at least three months of history, never fabricated.</p></div></div>
        {insights?.trends == null || insights.trends.series.length === 0 ? (
          <p className="panel-footnote">No trend data yet — ingest at least one billing period{insights?.trends ? "" : " (no data)"}.</p>
        ) : insights.trends.series.map((series) => {
          const forecast = series.forecast;
          return (
            <div key={series.currency} className="cmdbq-results">
              <p className="cmdbq-summary">{series.currency} · {series.periods.length} period(s) · {series.movingAverageWindow}-month moving average</p>
              <table><thead><tr><th>Period</th><th>Spend</th><th>MoM</th><th>Moving avg</th></tr></thead>
                <tbody>{series.periods.map((point) => (
                  <tr key={point.period}>
                    <td>{point.period}{point.isCurrentPartialPeriod ? " (partial)" : ""}</td>
                    <td>{money(point.totalMicros, series.currency)}</td>
                    <td>{point.momDeltaPercent === null ? (point.momBasis === "prior-period-zero" ? "n/a (prior 0)" : "—") : `${point.momDeltaPercent > 0 ? "+" : ""}${point.momDeltaPercent.toFixed(1)}%`}</td>
                    <td>{point.movingAverageMicros === null ? "—" : money(point.movingAverageMicros, series.currency)}</td>
                  </tr>
                ))}</tbody></table>
              {forecast.available ? (
                <>
                  <p className="cmdbq-summary">Forecast ({forecast.method}, estimate over {forecast.historicalPointsUsed} months):</p>
                  <table><thead><tr><th>Period</th><th>Projected spend</th>{forecast.residualBand ? <th>±1σ band</th> : null}</tr></thead>
                    <tbody>{forecast.points.map((pt) => (
                      <tr key={pt.period}>
                        <td>{pt.period}</td>
                        <td>{money(pt.amountMicros, series.currency)}</td>
                        {forecast.residualBand ? <td>{pt.bandLowMicros && pt.bandHighMicros ? `${money(pt.bandLowMicros, series.currency)} – ${money(pt.bandHighMicros, series.currency)}` : "—"}</td> : null}
                      </tr>
                    ))}</tbody></table>
                </>
              ) : (
                <p className="panel-footnote">Forecast not shown — {forecast.reason} ({forecast.historicalPointsUsed}/{forecast.minRequired} months of history).</p>
              )}
            </div>
          );
        })}
        {insights?.trends ? <p className="panel-footnote">{insights.trends.disclaimer}</p> : null}
      </section>

      <section className="panel" aria-label="Realized savings">
        <div className="panel-heading"><div><h2>Realized savings (look-back)</h2><p>What Reserved-Instance / Savings-Plan commitments actually saved per period — the public on-demand-equivalent of covered usage minus the amortized cost billed. Per currency, never summed. Periods where the on-demand-equivalent is absent are shown as not-derivable, never estimated.</p></div></div>
        {insights?.savings == null || insights.savings.series.length === 0 ? (
          <p className="panel-footnote">No realized-savings data yet — this needs billing lines carrying commitment coverage{insights?.savings ? "" : " (no data)"}.</p>
        ) : insights.savings.series.map((series) => (
          <div key={series.currency} className="cmdbq-results">
            <p className="cmdbq-summary">{series.currency} · total realized {money(series.totalRealizedSavingsMicros, series.currency)} · {series.derivablePeriodCount} derivable / {series.notDerivablePeriodCount} not-derivable period(s)</p>
            <table><thead><tr><th>Period</th><th>Realized saving</th><th>Coverage</th><th>Cumulative</th></tr></thead>
              <tbody>{series.periods.map((point) => (
                <tr key={point.period}>
                  <td>{point.period}{point.isCurrentPartialPeriod ? " (partial)" : ""}</td>
                  <td>{point.realizedSavingsMicros === null
                    ? `not derivable — ${point.realizedSavingsBasis}`
                    : `${money(point.realizedSavingsMicros, series.currency)}${point.realizedSavingsBasis === "no-commitment-usage" ? " (no commitment usage)" : ""}`}</td>
                  <td>{point.coveragePercent === null ? "—" : `${point.coveragePercent.toFixed(1)}%`}</td>
                  <td>{money(point.cumulativeRealizedSavingsMicros, series.currency)}</td>
                </tr>
              ))}</tbody></table>
          </div>
        ))}
        {insights?.savings ? <p className="panel-footnote">{insights.savings.disclaimer}</p> : null}
      </section>

      <section className="panel" aria-label="Kubernetes cost allocation">
        <div className="panel-heading"><div><h2>Kubernetes cost allocation</h2><p>Splits each cluster&apos;s node cost across namespaces by collected pod CPU/memory requests (reserved capacity, not live usage). Node cost is a disclosed bundled instance-type list-price estimate; idle/unallocated capacity is shown explicitly. Currencies are never summed.</p></div></div>
        {(insights?.kubernetesAllocation?.clusters ?? []).length === 0 ? (
          <p className="panel-footnote">No Kubernetes scans for this customer yet{insights?.kubernetesAllocation ? " — deploy the Sutra agent to a cluster to populate this" : " (no data)"}.</p>
        ) : (insights?.kubernetesAllocation?.clusters ?? []).map((entry) => (
          <div key={entry.clusterName} className="cmdbq-results">
            <p className="cmdbq-summary">{entry.clusterName} · {entry.allocation.namespacesEvaluated} namespace(s) · nodes priced {entry.costCatalogCoverage.nodesPriced}/{entry.costCatalogCoverage.nodesTotal}{entry.allocation.basis ? ` · basis: ${entry.allocation.basis}` : ""}</p>
            {!entry.allocation.costAvailable ? (
              <p className="panel-footnote">Node cost not derivable — {entry.allocation.unavailableReason ?? "no priced nodes"}. Namespace request shares are still collected.</p>
            ) : entry.allocation.currencies.map((cur) => (
              <div key={cur.currency}>
                <p className="cmdbq-summary">{cur.currency}: cluster cost {money(cur.clusterCostMicros, cur.currency)} · allocated {money(cur.allocatedMicros, cur.currency)} · idle {money(cur.unallocatedMicros, cur.currency)} ({cur.unallocatedBasis})</p>
                <table><thead><tr><th>Namespace</th><th>Allocated</th><th>Share</th></tr></thead>
                  <tbody>{cur.namespaces.map((ns) => (
                    <tr key={ns.namespace}>
                      <td>{ns.namespace}{ns.zeroRequests ? " (no requests)" : ""}</td>
                      <td>{money(ns.allocatedMicros, cur.currency)}</td>
                      <td>{(ns.sharePermille / 10).toFixed(1)}%</td>
                    </tr>
                  ))}</tbody></table>
              </div>
            ))}
          </div>
        ))}
        {insights?.kubernetesAllocation ? <p className="panel-footnote">{insights.kubernetesAllocation.disclaimer}</p> : null}
      </section>

      <section className="panel" aria-label="Unit economics">
        <div className="panel-heading"><div><h2>Unit economics</h2><p>Cost per business unit for {insights?.unitCountsPeriod ?? "the selected period"} — spend divided by a unit count you provide (transactions, seats, and so on). Counts are business metrics not present in billing data and are never assumed: with no count the ratio is shown as not-derivable, never a divide-by-zero.</p></div></div>
        <div className="cmdbq-row">
          <input aria-label="Unit label" placeholder="unit label (e.g. transactions)" value={unitDraft.unitLabel} onChange={(event) => setUnitDraft((draft) => ({ ...draft, unitLabel: event.target.value }))} />
          <input aria-label="Unit count" placeholder="count for this period" value={unitDraft.count} onChange={(event) => setUnitDraft((draft) => ({ ...draft, count: event.target.value }))} />
          <button type="button" className="button button-primary" disabled={!period && !insights?.period} onClick={() => void saveUnitCount()}>Save count</button>
        </div>
        {unitError ? <p className="cmdbq-error" role="alert">{unitError}</p> : null}
        {(insights?.unitEconomics ?? []).length === 0 ? (
          <p className="panel-footnote">No unit counts recorded for this period yet — add one above to see cost per unit.</p>
        ) : (insights?.unitEconomics ?? []).map((entry) => (
          <div key={entry.unitLabel} className="cmdbq-results">
            <p className="cmdbq-summary">{entry.unitLabel}: {entry.count.toLocaleString()} units</p>
            <table><thead><tr><th>Currency</th><th>Spend</th><th>Cost per {entry.unitLabel}</th></tr></thead>
              <tbody>{entry.report.results.map((res) => {
                const cpu = res.customers[0]?.costPerUnit ?? res.global;
                return (
                  <tr key={res.currency}>
                    <td>{res.currency}</td>
                    <td>{money(res.totalMicros, res.currency)}</td>
                    <td>{cpu.microsPerUnit === null
                      ? `not derivable (${cpu.ratioBasis})`
                      : `${money(String(Math.round(cpu.microsPerUnit)), res.currency)} / ${entry.unitLabel}`}</td>
                  </tr>
                );
              })}</tbody></table>
          </div>
        ))}
        {(insights?.unitEconomics ?? []).length > 0 ? <p className="panel-footnote">{insights!.unitEconomics![0].report.disclaimer}</p> : null}
      </section>

      <section className="panel" aria-label="Scheduled cost reports">
        <div className="panel-heading"><div><h2>Scheduled cost reports</h2><p>Email or webhook a cost summary for this connection on a weekly or monthly cadence. Delivery uses your configured transport; a report is marked delivered only on a 2xx response — never faked.</p></div></div>
        <div className="cmdbq-row">
          <input aria-label="Report name" placeholder="report name" value={reportDraft.name} onChange={(event) => setReportDraft((draft) => ({ ...draft, name: event.target.value }))} />
          <select aria-label="Cadence" value={reportDraft.cadence} onChange={(event) => setReportDraft((draft) => ({ ...draft, cadence: event.target.value }))}>
            <option value="monthly">Monthly</option><option value="weekly">Weekly</option>
          </select>
          <select aria-label="Delivery kind" value={reportDraft.deliveryKind} onChange={(event) => setReportDraft((draft) => ({ ...draft, deliveryKind: event.target.value }))}>
            <option value="email">Email</option><option value="webhook">Webhook</option>
          </select>
          <input aria-label="Delivery target" placeholder={reportDraft.deliveryKind === "email" ? "recipient email" : "https://webhook-url"} value={reportDraft.deliveryTarget} onChange={(event) => setReportDraft((draft) => ({ ...draft, deliveryTarget: event.target.value }))} />
          <button type="button" className="button button-primary" onClick={() => void saveReport()}>Add schedule</button>
        </div>
        {reportError ? <p className="cmdbq-error" role="alert">{reportError}</p> : null}
        {reports.length === 0 ? (
          <p className="panel-footnote">No scheduled reports yet.</p>
        ) : (
          <table><thead><tr><th>Name</th><th>Cadence</th><th>Delivery</th><th>Next run</th><th>State</th><th>Actions</th></tr></thead>
            <tbody>{reports.map((report) => (
              <tr key={report.id}>
                <td>{report.name}</td>
                <td>{report.cadence}</td>
                <td>{report.deliveryKind}: {report.deliveryTarget}</td>
                <td>{report.nextRunAt ? report.nextRunAt.slice(0, 10) : "—"}</td>
                <td><span className={`cmdbq-chip ${report.enabled ? "cmdbq-added" : "cmdbq-removed"}`}>{report.enabled ? "enabled" : "disabled"}</span></td>
                <td>
                  <button type="button" className="button" onClick={() => void toggleReport(report.id, !report.enabled)}>{report.enabled ? "Disable" : "Enable"}</button>{" "}
                  <button type="button" className="button" onClick={() => void deleteReport(report.id)}>Delete</button>
                </td>
              </tr>
            ))}</tbody></table>
        )}
      </section>
    </>
  );
}
