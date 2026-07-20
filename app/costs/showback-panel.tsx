"use client";

import { useCallback, useEffect, useState } from "react";

/* Org/MSP-level per-customer showback. Aggregates ALREADY-persisted billing
 * lines across every AWS connection the session can read, grouped by customer.
 * Money is displayed from integer micro-units and never summed across
 * currencies; unattributed spend is always disclosed, never force-assigned.
 * Chargeback columns render only when the engine actually populated them. */

interface ShowbackCustomer {
  readonly customerId: string;
  readonly customerName: string;
  readonly directMicros: string;
  readonly attributionBases: readonly string[];
  readonly lineCount: number;
  readonly distributedSharedMicros: string | null;
  readonly upliftMicros: string | null;
  readonly chargebackTotalMicros: string | null;
}
interface ShowbackChargeback {
  readonly enabled: boolean;
  readonly distributeShared: boolean;
  readonly distributionBasis: "by-direct-spend-share" | null;
  readonly upliftPercent: number;
  readonly distributedUnattributedMicros: string | null;
  readonly undistributedRemainderMicros: string | null;
  readonly note: string | null;
}
interface ShowbackCurrencyResult {
  readonly currency: string;
  readonly customers: readonly ShowbackCustomer[];
  readonly unattributedMicros: string;
  readonly unattributedLineCount: number;
  readonly totalMicros: string;
  readonly chargeback: ShowbackChargeback;
}
interface ShowbackResponse {
  readonly period: string | null;
  readonly periods: readonly { readonly period: string; readonly lineCount: number }[];
  readonly connectionCount: number;
  readonly customerCount: number;
  readonly results: readonly ShowbackCurrencyResult[];
  readonly chargebackEnabled: boolean;
  readonly disclaimer: string;
}

// Local copy of the finops-panels money() formatter: integer micro-units as a
// decimal string -> "n,nnn.nn CUR". Kept local so this panel never imports the
// per-connection FinOps panel module.
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

export function ShowbackPanel() {
  const [showback, setShowback] = useState<ShowbackResponse | null>(null);
  const [period, setPeriod] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (period !== null) params.set("period", period);
    const query = params.toString();
    try {
      const payload = await requestJson<ShowbackResponse>(`/api/v1/finops/showback${query ? `?${query}` : ""}`);
      setShowback(payload);
      setPeriod(payload.period);
      setError(null);
    } catch (caught) {
      setShowback(null);
      setError(caught instanceof Error ? caught.message : "Showback could not be loaded");
    }
  }, [period]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">FinOps command center</p>
          <h1>Per-customer showback</h1>
          <p className="page-subtitle">Attributes already-ingested billing line items to the customer that owns each AWS connection, per currency, across the whole organization. Spend matching no customer is disclosed as unattributed — never reassigned.</p>
        </div>
      </section>

      <div className="trust-strip" role="note">
        <span className="trust-icon">✓</span>
        <span><strong>Attribution, not invoicing.</strong> Showback is computed over persisted CUR/FOCUS lines with no new AWS calls. Currencies are never summed together, and unattributed spend is always shown.</span>
      </div>

      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Showback needs attention</strong><span>{error}</span><button onClick={() => void load()} type="button">Retry</button></div> : null}

      <section className="panel" aria-label="Showback controls">
        <div className="panel-heading"><div><h2>Billing period</h2><p>Choose an ingested period. The customer breakdown below is computed only for the selected month; periods with no lines are honestly empty.</p></div></div>
        <div className="cmdbq-row">
          <select aria-label="Period" value={period ?? ""} onChange={(event) => setPeriod(event.target.value || null)} disabled={(showback?.periods.length ?? 0) === 0}>
            {(showback?.periods ?? []).map((entry) => <option key={entry.period} value={entry.period}>{entry.period} ({entry.lineCount} lines)</option>)}
          </select>
          {showback !== null ? <span className="result-count">{showback.customerCount} customer(s) · {showback.connectionCount} connection(s)</span> : null}
        </div>
      </section>

      {showback === null ? null : showback.period === null || showback.results.length === 0 ? (
        <section className="panel" aria-label="Per-customer showback">
          <div className="panel-heading"><div><h2>Per-customer breakdown</h2></div></div>
          <p className="panel-footnote">
            {showback.connectionCount === 0
              ? "No readable AWS connections in this organization yet — connect a customer account and ingest a billing period to see showback."
              : "No billing lines have been ingested for the selected period. Nothing is estimated."}
          </p>
        </section>
      ) : showback.results.map((result) => {
        const chargebackPresent = result.customers.some((customer) => customer.chargebackTotalMicros !== null);
        return (
          <section className="panel" aria-label={`Per-customer showback (${result.currency})`} key={result.currency}>
            <div className="panel-heading"><div><h2>{result.currency}</h2><p>Total {money(result.totalMicros, result.currency)} · unattributed {money(result.unattributedMicros, result.currency)} ({result.unattributedLineCount} lines). Currencies are shown separately and never summed.</p></div></div>
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Direct spend</th>
                  <th>Lines</th>
                  <th>Attribution</th>
                  {chargebackPresent ? <th>Distributed shared</th> : null}
                  {chargebackPresent ? <th>Uplift</th> : null}
                  {chargebackPresent ? <th>Chargeback total</th> : null}
                </tr>
              </thead>
              <tbody>
                {result.customers.map((customer) => (
                  <tr key={customer.customerId}>
                    <td>{customer.customerName}</td>
                    <td>{money(customer.directMicros, result.currency)}</td>
                    <td>{customer.lineCount}</td>
                    <td>{customer.attributionBases.length > 0 ? customer.attributionBases.join(", ") : "—"}</td>
                    {chargebackPresent ? <td>{customer.distributedSharedMicros === null ? "—" : money(customer.distributedSharedMicros, result.currency)}</td> : null}
                    {chargebackPresent ? <td>{customer.upliftMicros === null ? "—" : money(customer.upliftMicros, result.currency)}</td> : null}
                    {chargebackPresent ? <td>{customer.chargebackTotalMicros === null ? "—" : money(customer.chargebackTotalMicros, result.currency)}</td> : null}
                  </tr>
                ))}
                <tr>
                  <td><em>Unattributed</em></td>
                  <td>{money(result.unattributedMicros, result.currency)}</td>
                  <td>{result.unattributedLineCount}</td>
                  <td>—</td>
                  {chargebackPresent ? <td>—</td> : null}
                  {chargebackPresent ? <td>—</td> : null}
                  {chargebackPresent ? <td>—</td> : null}
                </tr>
              </tbody>
            </table>
            {chargebackPresent && result.chargeback.enabled ? (
              <p className="panel-footnote">
                Chargeback on: shared spend distributed {result.chargeback.distributionBasis ?? "n/a"}
                {result.chargeback.upliftPercent > 0 ? ` · ${result.chargeback.upliftPercent}% uplift` : ""}
                {result.chargeback.undistributedRemainderMicros !== null ? ` · ${money(result.chargeback.undistributedRemainderMicros, result.currency)} remainder left unattributed` : ""}
                {result.chargeback.note !== null ? ` · ${result.chargeback.note}` : ""}
              </p>
            ) : null}
          </section>
        );
      })}

      {showback !== null ? <p className="panel-footnote">{showback.disclaimer}</p> : null}
    </>
  );
}
