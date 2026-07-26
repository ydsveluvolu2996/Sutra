"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./costs.module.css";

/* ----------------------------------------------------------------------------
 * External cost sources: bring the spend that is NOT in the CUR — licence
 * invoices, support contracts, third-party SaaS, the MSP's own managed-service
 * fee — into the cost picture, so showback and MSP margin can describe the total
 * bill a customer receives rather than only its AWS component.
 *
 * The upload follows the CUR precedent (paste the export, name the period) with
 * one addition that matters: an EXPLICIT column mapping. Header names are never
 * guessed, because guessing which column is "the amount" is how you silently
 * mis-bill someone. Rejected rows come back with their row number and reason and
 * are shown here in full; nothing malformed is stored, and nothing is repaired.
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

async function sendJson<T>(path: string, method: string, payload: Json | null): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    ...(payload === null ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
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

interface SourceTotal {
  readonly source: string;
  readonly period: string;
  readonly currency: string;
  readonly amountUnits: number;
  readonly recordCount: number;
}
interface CurrencyTotal {
  readonly currency: string;
  readonly amountUnits: number;
  readonly recordCount: number;
}
interface ExternalCostResponse {
  readonly sources: readonly SourceTotal[];
  readonly periods: readonly string[];
  readonly totalsByCurrency: readonly CurrencyTotal[];
  readonly permissions: { readonly canManage: boolean };
  readonly disclaimer: string;
}
interface RejectedRow {
  readonly rowNumber: number;
  readonly reason: string;
}
interface IngestResponse {
  readonly accepted: number;
  readonly totalRows: number;
  readonly summaries: readonly { source: string; period: string; inserted: number; replaced: number }[];
  readonly rejected: readonly RejectedRow[];
  readonly rejectedCount: number;
  readonly currencies: readonly string[];
}

const BLANK_FORM = {
  format: "csv",
  payload: "",
  defaultSource: "",
  defaultCurrency: "USD",
  mapPeriod: "",
  mapAmount: "",
  mapCurrency: "",
  mapSource: "",
  mapCustomerId: "",
  mapCategory: "",
  mapVendor: "",
  mapTags: "",
};

export default function FinopsExternalCostPanel({ connectionId }: { connectionId: string }) {
  const [data, setData] = useState<ExternalCostResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(BLANK_FORM);
  const [result, setResult] = useState<IngestResponse | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const path = `/api/v1/finops/external-costs?connectionId=${encodeURIComponent(connectionId)}`;

  const reload = useCallback(async () => {
    try {
      setData(await getJson<ExternalCostResponse>(path));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load external cost sources");
    }
  }, [path]);

  useEffect(() => {
    let active = true;
    getJson<ExternalCostResponse>(path)
      .then((value) => { if (active) { setData(value); setError(null); } })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "Could not load external cost sources"); });
    return () => { active = false; };
  }, [path]);

  async function upload(): Promise<void> {
    if (form.payload.trim().length === 0) { setError("Paste the export first"); return; }
    if (form.mapPeriod.trim().length === 0 || form.mapAmount.trim().length === 0) {
      setError("Name the period and amount columns in your file — they are never guessed");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const mapping: Json = { period: form.mapPeriod.trim(), amount: form.mapAmount.trim() };
      for (const [key, value] of [
        ["currency", form.mapCurrency], ["source", form.mapSource], ["customerId", form.mapCustomerId],
        ["category", form.mapCategory], ["vendor", form.mapVendor], ["tags", form.mapTags],
      ] as const) {
        if (value.trim().length > 0) mapping[key] = value.trim();
      }
      const body: Json = { connectionId, format: form.format, mapping };
      if (form.format === "csv") body.csv = form.payload;
      else {
        let records: unknown;
        try {
          records = JSON.parse(form.payload);
        } catch {
          throw new Error("The JSON payload is not valid JSON — nothing was uploaded");
        }
        body.records = records;
      }
      if (form.mapCurrency.trim().length === 0 && form.defaultCurrency.trim().length > 0) body.defaultCurrency = form.defaultCurrency.trim();
      if (form.mapSource.trim().length === 0 && form.defaultSource.trim().length > 0) body.defaultSource = form.defaultSource.trim();
      const ingested = await sendJson<IngestResponse>("/api/v1/finops/external-costs", "POST", body);
      setResult(ingested);
      setForm({ ...form, payload: "" });
      setError(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The upload was rejected");
    } finally {
      setBusy(false);
    }
  }

  async function remove(source: string, period: string): Promise<void> {
    setBusy(true);
    try {
      await sendJson(
        `/api/v1/finops/external-costs?connectionId=${encodeURIComponent(connectionId)}&source=${encodeURIComponent(source)}&period=${encodeURIComponent(period)}`,
        "DELETE",
        null,
      );
      setPendingDelete(null);
      setError(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the source");
    } finally {
      setBusy(false);
    }
  }

  const sources = data?.sources ?? [];
  const canManage = data?.permissions.canManage ?? false;

  return (
    <article className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Total spend, not just AWS</p>
          <h2>External cost sources</h2>
        </div>
        <span className="status-pill status-low">{sources.length} source{sources.length === 1 ? "" : "s"}</span>
      </div>

      {error ? <p className={styles.emptyNote} role="alert">{error}</p> : null}

      {data === null ? <p className={styles.emptyNote}>Loading external cost sources…</p> : (
        <>
          {data.totalsByCurrency.length > 0 ? (
            <div className={styles.xcTotals}>
              {data.totalsByCurrency.map((total) => (
                <span key={total.currency}>
                  <strong>{money(total.amountUnits, total.currency)}</strong>
                  <small>{total.currency} · {total.recordCount} record{total.recordCount === 1 ? "" : "s"}</small>
                </span>
              ))}
            </div>
          ) : null}

          {sources.length === 0 ? (
            <p className={styles.emptyNote}>
              No external cost records ingested yet. Nothing outside the AWS billing file is counted until you upload it — margin
              and showback currently describe cloud spend only.
            </p>
          ) : (
            <div className={styles.xcList}>
              <div className={`${styles.xcRow} ${styles.xcHead}`}>
                <span>Source</span><span>Period</span><span>Records</span><span>Amount</span><span />
              </div>
              {sources.map((source) => {
                const key = `${source.source}|${source.period}|${source.currency}`;
                return (
                  <div className={styles.xcRow} key={key}>
                    <span><strong>{source.source}</strong></span>
                    <span>{source.period}</span>
                    <span>{source.recordCount}</span>
                    <span>{money(source.amountUnits, source.currency)}</span>
                    <span className={styles.w3RowActions}>
                      {!canManage ? null : pendingDelete === key ? (
                        <>
                          <button className="button button-ghost" type="button" disabled={busy} onClick={() => void remove(source.source, source.period)}>Confirm</button>
                          <button className="button button-ghost" type="button" disabled={busy} onClick={() => setPendingDelete(null)}>Keep</button>
                        </>
                      ) : (
                        <button className="button button-ghost" type="button" disabled={busy} onClick={() => setPendingDelete(key)} aria-label={`Remove ${source.source} ${source.period}`}>Remove</button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {canManage ? (
            <div className={styles.w3Form}>
              <p className={styles.w3Hint}>
                Paste an invoice or billing export and say which of ITS columns hold the period, amount, currency and source. The
                header is never guessed. Re-uploading a source and month REPLACES that month for that source, so a corrected
                invoice never double-counts.
              </p>
              <div className={styles.w3Grid}>
                <select className={styles.w3Input} value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })} aria-label="Export format">
                  <option value="csv">CSV export</option>
                  <option value="json">JSON records</option>
                </select>
                <input className={styles.w3Input} placeholder="source label (e.g. Microsoft 365)" value={form.defaultSource} onChange={(e) => setForm({ ...form, defaultSource: e.target.value })} aria-label="Source label for the whole file" />
                <input className={styles.w3Input} placeholder="currency (e.g. USD)" value={form.defaultCurrency} onChange={(e) => setForm({ ...form, defaultCurrency: e.target.value })} aria-label="Currency asserted for the whole file" />
              </div>
              <div className={styles.w3Grid}>
                <input className={styles.w3Input} placeholder="period column *" value={form.mapPeriod} onChange={(e) => setForm({ ...form, mapPeriod: e.target.value })} aria-label="Column holding the billing period" />
                <input className={styles.w3Input} placeholder="amount column *" value={form.mapAmount} onChange={(e) => setForm({ ...form, mapAmount: e.target.value })} aria-label="Column holding the amount" />
                <input className={styles.w3Input} placeholder="currency column" value={form.mapCurrency} onChange={(e) => setForm({ ...form, mapCurrency: e.target.value })} aria-label="Column holding the currency" />
                <input className={styles.w3Input} placeholder="source column" value={form.mapSource} onChange={(e) => setForm({ ...form, mapSource: e.target.value })} aria-label="Column holding the source label" />
              </div>
              <div className={styles.w3Grid}>
                <input className={styles.w3Input} placeholder="customer column" value={form.mapCustomerId} onChange={(e) => setForm({ ...form, mapCustomerId: e.target.value })} aria-label="Column holding the customer attribution" />
                <input className={styles.w3Input} placeholder="category column" value={form.mapCategory} onChange={(e) => setForm({ ...form, mapCategory: e.target.value })} aria-label="Column holding the cost category" />
                <input className={styles.w3Input} placeholder="vendor column" value={form.mapVendor} onChange={(e) => setForm({ ...form, mapVendor: e.target.value })} aria-label="Column holding the vendor" />
                <input className={styles.w3Input} placeholder="tags column" value={form.mapTags} onChange={(e) => setForm({ ...form, mapTags: e.target.value })} aria-label="Column holding tags" />
              </div>
              <textarea
                className={styles.xcPayload}
                aria-label="External cost export"
                rows={5}
                placeholder={form.format === "csv" ? "Paste the CSV export here (header row required)" : 'Paste JSON records here, e.g. [{ "Month": "2026-07", "Total": "1200.00" }]'}
                value={form.payload}
                onChange={(e) => setForm({ ...form, payload: e.target.value })}
              />
              <div className={styles.w3Grid}>
                <button className="button button-primary" type="button" disabled={busy || form.payload.trim().length === 0} onClick={() => void upload()}>
                  {busy ? "Uploading…" : "Ingest external costs"}
                </button>
              </div>

              {result ? (
                <div className={styles.xcResult}>
                  <p>
                    Accepted {result.accepted} of {result.totalRows} row{result.totalRows === 1 ? "" : "s"}
                    {result.currencies.length > 0 ? ` in ${result.currencies.join(", ")}` : ""}.
                    {result.summaries.map((summary) => ` ${summary.source} ${summary.period}: stored ${summary.inserted}, replaced ${summary.replaced}.`).join("")}
                  </p>
                  {result.rejectedCount > 0 ? (
                    <>
                      <p className={styles.xcRejectHead}>
                        {result.rejectedCount} row{result.rejectedCount === 1 ? " was" : "s were"} rejected and NOT stored — no amount was
                        estimated or repaired{result.rejected.length < result.rejectedCount ? `; the first ${result.rejected.length} are listed` : ""}:
                      </p>
                      <ul className={styles.xcRejects}>
                        {result.rejected.map((row) => <li key={row.rowNumber}>Row {row.rowNumber}: {row.reason}</li>)}
                      </ul>
                    </>
                  ) : <p className={styles.xcRejectHead}>No rows were rejected.</p>}
                </div>
              ) : null}
            </div>
          ) : (
            <p className={styles.w3Hint}>Uploading external costs needs connection management permission on this customer.</p>
          )}

          <p className={styles.w3Hint}>{data.disclaimer}</p>
        </>
      )}
    </article>
  );
}
