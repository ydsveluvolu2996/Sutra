"use client";

import { useEffect, useState } from "react";
import styles from "./costs.module.css";

interface AmortizedServiceRow {
  readonly service: string;
  readonly billedUnits: number;
  readonly amortizedUnits: number;
  readonly deltaUnits: number;
}
interface AmortizedResponse {
  readonly amortized: {
    readonly available: boolean;
    readonly currency: string | null;
    readonly billedUnits: number;
    readonly amortizedUnits: number;
    readonly deltaUnits: number;
    readonly byService: readonly AmortizedServiceRow[];
  };
}
interface ExpiryRow {
  readonly commitmentId: string;
  readonly commitmentType: string;
  readonly expiry: string;
  readonly daysToExpiry: number | null;
  readonly expired: boolean;
}
interface CommitTypeRow {
  readonly commitmentType: string;
  readonly class: "committed" | "on_demand" | "spot" | "unclassified";
  readonly spendUnits: number;
}
interface CommitmentsResponse {
  readonly commitments: {
    readonly available: boolean;
    readonly currency: string | null;
    readonly coveragePercent: number | null;
    readonly committedUnits: number;
    readonly onDemandUnits: number;
    readonly spotUnits: number;
    readonly byCommitmentType: readonly CommitTypeRow[];
    readonly effectiveSavingsRate: { readonly percent: number | null; readonly derivable: boolean; readonly note: string | null };
    readonly expirations: readonly ExpiryRow[];
  };
}

function money(value: number | null, currency: string | null): string {
  if (value === null || !currency) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency,
    minimumFractionDigits: Math.abs(value) >= 100 ? 0 : 2, maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2,
  }).format(value);
}
function pct(value: number | null): string { return value === null ? "—" : `${Math.round(value)}%`; }
function humanType(value: string): string { return value.replace(/[-_]/g, " "); }

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

/**
 * Amortized-vs-unblended cost and RI/SP commitment coverage. Both gate on an
 * `available` flag: if the ingested CUR/FOCUS file lacks amortized-cost or
 * commitment columns, the panel says so rather than inventing figures.
 */
export function FinopsCommitmentsPanels({ connectionId }: { connectionId: string | null }) {
  const [amortized, setAmortized] = useState<AmortizedResponse | null>(null);
  const [commitments, setCommitments] = useState<CommitmentsResponse | null>(null);

  useEffect(() => {
    if (connectionId === null) return;
    let active = true;
    const suffix = `?connectionId=${encodeURIComponent(connectionId)}`;
    getJson<AmortizedResponse>(`/api/v1/finops/amortized${suffix}`).then((value) => { if (active) setAmortized(value); }).catch(() => { /* non-fatal */ });
    getJson<CommitmentsResponse>(`/api/v1/finops/commitments${suffix}`).then((value) => { if (active) setCommitments(value); }).catch(() => { /* non-fatal */ });
    return () => { active = false; };
  }, [connectionId]);

  if (connectionId === null) return null;

  const amt = amortized?.amortized;
  const com = commitments?.commitments;
  const maxService = amt && amt.byService.length > 0 ? Math.max(...amt.byService.map((row) => row.billedUnits), 1) : 1;

  return (
    <section className={styles.overviewGrid}>
      <article className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">True cost of ownership</p><h2>Amortized vs unblended</h2></div>
          {amt ? <span className={`status-pill ${amt.available ? "status-positive" : ""}`}>{amt.available ? "amortized" : "billed only"}</span> : null}
        </div>
        {amortized === null ? <p className={styles.emptyNote}>Loading amortized cost…</p>
          : !amt?.available ? <p className={styles.emptyNote}>Amortized cost appears once you upload a CUR/FOCUS file that includes effective/amortized cost columns. Billed (unblended) totals are shown in the other panels.</p>
          : (
            <>
              <section className={styles.kpis} aria-label="Billed vs amortized">
                <article className={`panel ${styles.primaryKpi}`}><small>Amortized (effective)</small><strong>{money(amt.amortizedUnits, amt.currency)}</strong><span>RI/SP upfront spread across usage</span></article>
                <article className="panel"><small>Billed (unblended)</small><strong>{money(amt.billedUnits, amt.currency)}</strong><span>as invoiced this period</span></article>
                <article className="panel"><small>Difference</small><strong className={amt.deltaUnits > 0 ? styles.costUp : styles.costDown}>{amt.deltaUnits > 0 ? "+" : ""}{money(amt.deltaUnits, amt.currency)}</strong><span>amortized − billed</span></article>
              </section>
              <div className={styles.breakdownList}>
                {amt.byService.slice(0, 6).map((row) => (
                  <div className={styles.breakdownRow} key={row.service}>
                    <div><strong>{row.service}</strong><span>amort {money(row.amortizedUnits, amt.currency)}</span></div>
                    <div className={styles.progress}><i style={{ width: `${Math.min(100, (row.billedUnits / maxService) * 100)}%` }} /></div>
                    <small>billed {money(row.billedUnits, amt.currency)}</small>
                  </div>
                ))}
              </div>
            </>
          )}
      </article>

      <article className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Commitment efficiency</p><h2>RI / Savings Plan coverage</h2></div>
          {com ? <span className={`status-pill ${com.available ? "status-positive" : ""}`}>{com.available ? `${pct(com.coveragePercent)} covered` : "no commitments"}</span> : null}
        </div>
        {commitments === null ? <p className={styles.emptyNote}>Loading commitment coverage…</p>
          : !com?.available ? <p className={styles.emptyNote}>RI/Savings Plan coverage appears once your CUR/FOCUS file carries commitment line items (reserved / savings-plan charges).</p>
          : (
            <>
              <section className={styles.kpis} aria-label="Coverage and savings rate">
                <article className={`panel ${styles.primaryKpi}`}><small>Coverage</small><strong>{pct(com.coveragePercent)}</strong><span>committed ÷ eligible compute</span></article>
                <article className="panel"><small>Effective savings rate</small><strong>{com.effectiveSavingsRate.percent === null ? "—" : pct(com.effectiveSavingsRate.percent)}</strong><span>{com.effectiveSavingsRate.derivable ? "vs on-demand equivalent" : "not derivable from this file"}</span></article>
                <article className="panel"><small>On-demand spend</small><strong>{money(com.onDemandUnits, com.currency)}</strong><span>candidate for commitment</span></article>
              </section>
              {com.expirations.length > 0 ? (
                <div className={styles.breakdownList}>
                  {com.expirations.slice(0, 6).map((row) => {
                    const soon = row.expired || (row.daysToExpiry !== null && row.daysToExpiry <= 30);
                    return (
                      <div className={styles.breakdownRow} key={`${row.commitmentId}-${row.expiry}`}>
                        <div><strong>{humanType(row.commitmentType)}</strong><span>{new Date(row.expiry).toLocaleDateString("en-US", { dateStyle: "medium" })}</span></div>
                        <div className={styles.progress}><i style={{ width: soon ? "100%" : "40%", background: row.expired ? "#ef4444" : soon ? "#f59e0b" : undefined }} /></div>
                        <small className={soon ? styles.costUp : undefined}>{row.expired ? "expired" : row.daysToExpiry === null ? "—" : `${row.daysToExpiry}d`}</small>
                      </div>
                    );
                  })}
                </div>
              ) : <p className={styles.emptyNote}>No commitment expiry dates in this billing file.</p>}
            </>
          )}
      </article>
    </section>
  );
}
