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
interface Insights {
  readonly periods: readonly { period: string; lineCount: number }[];
  readonly period: string | null;
  readonly lineCount?: number;
  readonly allocation: readonly Allocation[];
  readonly budgets: readonly BudgetEvaluation[];
  readonly anomalies: { readonly anomalies: readonly Anomaly[]; readonly disclaimer: string } | null;
  readonly commitment?: Commitment | null;
  readonly rightsizing?: Rightsizing | null;
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
    </>
  );
}
