"use client";

import { useEffect, useState } from "react";
import styles from "./costs.module.css";

interface AiDirectionRow {
  readonly direction: string;
  readonly spendUnits: number;
  readonly tokens: number | null;
}
interface AiModelRow {
  readonly model: string;
  readonly modelIdentified: boolean;
  readonly spendUnits: number;
  readonly tokens: number | null;
  readonly tokensDerivable: boolean;
  readonly costPer1kTokensUnits: number | null;
  readonly tokensUnavailableReason: string | null;
  readonly byDirection: readonly AiDirectionRow[];
}
interface AiTrendRow {
  readonly period: string;
  readonly spendUnits: number;
  readonly tokens: number | null;
}
interface AiGpuResponse {
  readonly ai: {
    readonly available: boolean;
    readonly unavailableReason: string | null;
    readonly usageTypePresent: boolean;
    readonly currency: string | null;
    readonly spendUnits: number;
    readonly lineCount: number;
    readonly tokenLineCount: number;
    readonly tokens: number | null;
    readonly byModel: readonly AiModelRow[];
    readonly topModels: readonly AiModelRow[];
    readonly byDirection: readonly AiDirectionRow[];
    readonly trend: readonly AiTrendRow[];
  };
  readonly gpu: {
    readonly spendAvailable: boolean;
    readonly spendUnavailableReason: string | null;
    readonly currency: string | null;
    readonly spendUnits: number;
    readonly byFamily: readonly {
      readonly family: string;
      readonly accelerator: string | null;
      readonly matchedBy: string | null;
      readonly spendUnits: number;
      readonly billedHours: number | null;
      readonly instanceTypes: readonly string[];
    }[];
    readonly byRegion: readonly { readonly region: string; readonly spendUnits: number }[];
    readonly inventory: {
      readonly instanceCount: number;
      readonly notRunningCount: number;
      readonly instanceTypeUnknownCount: number;
      readonly byFamily: readonly { readonly family: string; readonly instanceCount: number }[];
    };
    readonly utilization: {
      readonly collected: boolean;
      readonly sampleCount: number;
      readonly reason: string | null;
      readonly requiredCollector: string;
    };
    readonly idleCandidates: readonly {
      readonly resourceKey: string;
      readonly gpuUtilizationP95Percent: number;
      readonly evidence: string;
    }[];
  };
}

function money(value: number | null, currency: string | null): string {
  if (value === null || !currency) return "—";
  const large = Math.abs(value) >= 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency,
    minimumFractionDigits: large ? 0 : 2, maximumFractionDigits: large ? 0 : 2,
  }).format(value);
}

/** Per-1K-token rates are fractions of a cent, so they need more precision than a total. */
function rate(value: number | null, currency: string | null): string {
  if (value === null || !currency) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency, minimumFractionDigits: 4, maximumFractionDigits: 6,
  }).format(value);
}

function count(value: number | null): string {
  return value === null ? "—" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function humanLabel(value: string): string {
  return value.replace(/[-_]/gu, " ");
}

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
 * AI/LLM token cost and GPU/accelerator cost for the selected connection.
 *
 * Both halves gate on the API's `available` flags. Bedrock model and token
 * attribution needs a usage-type-bearing billing file; where it is absent the
 * panel says so and still shows the exact spend. Token counts and per-1K rates
 * appear only where the billing file metered them. GPU idleness is never shown
 * as a finding: the panel names the missing utilisation collector instead, since
 * CPU metrics are not a proxy for GPU utilisation.
 */
export default function FinopsAiGpuPanel({ connectionId }: { connectionId: string | null }) {
  // Keyed by connection so switching connections shows the loading state again
  // without a synchronous setState inside the effect (which would cascade).
  const [loaded, setLoaded] = useState<{ readonly id: string; readonly payload: AiGpuResponse | null } | null>(null);

  useEffect(() => {
    if (connectionId === null) return;
    let active = true;
    getJson<AiGpuResponse>(`/api/v1/finops/ai-gpu?connectionId=${encodeURIComponent(connectionId)}`)
      .then((value) => { if (active) setLoaded({ id: connectionId, payload: value }); })
      .catch(() => { if (active) setLoaded({ id: connectionId, payload: null }); });
    return () => { active = false; };
  }, [connectionId]);

  if (connectionId === null) return null;

  const current = loaded !== null && loaded.id === connectionId ? loaded : null;
  const failed = current !== null && current.payload === null;
  const data = current?.payload ?? null;
  const ai = data?.ai;
  const gpu = data?.gpu;
  const maxModelSpend = ai && ai.topModels.length > 0 ? Math.max(...ai.topModels.map((row) => row.spendUnits), 1) : 1;
  const maxFamilySpend = gpu && gpu.byFamily.length > 0 ? Math.max(...gpu.byFamily.map((row) => row.spendUnits), 1) : 1;
  const maxTrend = ai && ai.trend.length > 0 ? Math.max(...ai.trend.map((row) => row.spendUnits), 1) : 1;

  return (
    <section className={styles.overviewGrid}>
      <article className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">AI / LLM spend</p><h2>Bedrock token cost by model</h2></div>
          {ai ? (
            <span className={`status-pill ${ai.available ? "status-positive" : ""}`}>
              {ai.available ? (ai.tokens === null ? "spend only" : "tokens metered") : "not attributable"}
            </span>
          ) : null}
        </div>
        {failed ? <p className={styles.emptyNote}>AI cost could not be loaded.</p>
          : data === null ? <p className={styles.emptyNote}>Loading AI/LLM cost…</p>
          : ai === undefined || !ai.available ? (
            <>
              <p className={styles.emptyNote}>{ai?.unavailableReason ?? "No AI/LLM spend in this billing file."}</p>
              {ai !== undefined && ai.spendUnits > 0 ? (
                <section className={styles.kpis} aria-label="Bedrock spend">
                  <article className={`panel ${styles.primaryKpi}`}>
                    <small>Bedrock spend</small><strong>{money(ai.spendUnits, ai.currency)}</strong>
                    <span>exact; model split not in this file</span>
                  </article>
                </section>
              ) : null}
            </>
          ) : (
            <>
              <section className={styles.kpis} aria-label="AI spend and token volume">
                <article className={`panel ${styles.primaryKpi}`}>
                  <small>Bedrock spend</small><strong>{money(ai.spendUnits, ai.currency)}</strong>
                  <span>{ai.byModel.length} model{ai.byModel.length === 1 ? "" : "s"} across {ai.lineCount} lines</span>
                </article>
                <article className="panel">
                  <small>Tokens metered</small><strong>{count(ai.tokens)}</strong>
                  <span>{ai.tokens === null ? `${ai.tokenLineCount} of ${ai.lineCount} lines metered` : "measured, not estimated"}</span>
                </article>
                <article className="panel">
                  <small>Blended per 1K</small>
                  <strong>{rate(ai.tokens !== null && ai.tokens > 0 ? (ai.spendUnits / ai.tokens) * 1000 : null, ai.currency)}</strong>
                  <span>{ai.tokens === null ? "withheld — tokens incomplete" : "spend ÷ metered tokens"}</span>
                </article>
              </section>

              <div className={styles.aigTable} role="table" aria-label="Spend by model">
                <div className={`${styles.aigRow} ${styles.aigHead}`} role="row">
                  <span role="columnheader">Model</span>
                  <span role="columnheader">Spend</span>
                  <span role="columnheader">Tokens</span>
                  <span role="columnheader">Per 1K</span>
                </div>
                {ai.topModels.map((row) => (
                  <div className={styles.aigRow} role="row" key={row.model}>
                    <span role="cell">
                      <strong>{row.modelIdentified ? row.model : "unattributed spend"}</strong>
                      <small>{row.byDirection.map((direction) => humanLabel(direction.direction)).join(" · ") || "—"}</small>
                      <i className={styles.aigBar} aria-hidden="true">
                        <b style={{ width: `${Math.min(100, (row.spendUnits / maxModelSpend) * 100)}%` }} />
                      </i>
                    </span>
                    <span role="cell">{money(row.spendUnits, ai.currency)}</span>
                    <span role="cell">{count(row.tokens)}</span>
                    <span role="cell">
                      {rate(row.costPer1kTokensUnits, ai.currency)}
                      {row.tokensDerivable ? null : <small className={styles.aigWarn}>tokens unavailable</small>}
                    </span>
                  </div>
                ))}
              </div>

              {ai.byModel.some((row) => !row.tokensDerivable) ? (
                <p className={styles.aigNotice}>
                  Some lines carry no metered token quantity, so their token totals and per-1K rates are withheld
                  rather than estimated. Spend above is exact.
                </p>
              ) : null}

              {ai.trend.length > 1 ? (
                <div className={styles.breakdownList}>
                  {ai.trend.map((point) => (
                    <div className={styles.breakdownRow} key={point.period}>
                      <div><strong>{point.period}</strong><span>{count(point.tokens)} tokens</span></div>
                      <div className={styles.progress}><i style={{ width: `${Math.min(100, (point.spendUnits / maxTrend) * 100)}%` }} /></div>
                      <small>{money(point.spendUnits, ai.currency)}</small>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}
      </article>

      <article className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Accelerated compute</p><h2>GPU cost &amp; inventory</h2></div>
          {gpu ? (
            <span className={`status-pill ${gpu.spendAvailable ? "status-positive" : ""}`}>
              {gpu.spendAvailable ? `${gpu.byFamily.length} famil${gpu.byFamily.length === 1 ? "y" : "ies"}` : "no GPU spend"}
            </span>
          ) : null}
        </div>
        {failed ? <p className={styles.emptyNote}>GPU cost could not be loaded.</p>
          : data === null ? <p className={styles.emptyNote}>Loading GPU cost…</p>
          : gpu === undefined ? <p className={styles.emptyNote}>No GPU cost data.</p>
          : (
            <>
              <section className={styles.kpis} aria-label="GPU spend and inventory">
                <article className={`panel ${styles.primaryKpi}`}>
                  <small>Accelerated spend</small>
                  <strong>{gpu.spendAvailable ? money(gpu.spendUnits, gpu.currency) : "—"}</strong>
                  <span>{gpu.spendAvailable ? "GPU / Inferentia / Trainium" : "not derivable from this file"}</span>
                </article>
                <article className="panel">
                  <small>GPU instances</small><strong>{gpu.inventory.instanceCount}</strong>
                  <span>{gpu.inventory.notRunningCount} not running</span>
                </article>
                <article className="panel">
                  <small>Idle GPUs</small><strong>—</strong>
                  <span>requires a utilisation collector</span>
                </article>
              </section>

              {!gpu.spendAvailable ? (
                <p className={styles.emptyNote}>{gpu.spendUnavailableReason ?? "No accelerated spend in this billing file."}</p>
              ) : (
                <div className={styles.breakdownList}>
                  {gpu.byFamily.slice(0, 6).map((row) => (
                    <div className={styles.breakdownRow} key={row.family}>
                      <div>
                        <strong>{row.family}</strong>
                        <span>
                          {row.accelerator ?? "accelerated"}
                          {row.billedHours === null ? "" : ` · ${count(row.billedHours)} billed hrs`}
                          {row.matchedBy === "prefix-fallback" ? " · family matched by prefix" : ""}
                        </span>
                      </div>
                      <div className={styles.progress}><i style={{ width: `${Math.min(100, (row.spendUnits / maxFamilySpend) * 100)}%` }} /></div>
                      <small>{money(row.spendUnits, gpu.currency)}</small>
                    </div>
                  ))}
                </div>
              )}

              {gpu.spendAvailable && gpu.byRegion.length > 0 ? (
                <p className={styles.aigRegions}>
                  {gpu.byRegion.slice(0, 6).map((row) => (
                    <span key={row.region}><b>{row.region}</b>{money(row.spendUnits, gpu.currency)}</span>
                  ))}
                </p>
              ) : null}

              {gpu.utilization.collected ? (
                gpu.idleCandidates.length === 0
                  ? <p className={styles.aigNotice}>No GPU fell below the idle threshold over the observed window.</p>
                  : (
                    <div className={styles.breakdownList}>
                      {gpu.idleCandidates.slice(0, 6).map((row) => (
                        <div className={styles.breakdownRow} key={row.resourceKey}>
                          <div><strong>{row.resourceKey}</strong><span>{row.evidence}</span></div>
                          <div className={styles.progress}><i style={{ width: `${Math.min(100, row.gpuUtilizationP95Percent)}%` }} /></div>
                          <small className={styles.costUp}>idle</small>
                        </div>
                      ))
                      }
                    </div>
                  )
              ) : (
                <p className={styles.aigNotice}>
                  <b>Idle-GPU detection is unavailable.</b> {gpu.utilization.reason}{" "}
                  It needs {gpu.utilization.requiredCollector}. CPU utilisation is not used as a stand-in, so no idle
                  finding and no saving estimate is shown here.
                  {gpu.inventory.instanceTypeUnknownCount > 0
                    ? ` ${gpu.inventory.instanceTypeUnknownCount} collected instance${gpu.inventory.instanceTypeUnknownCount === 1 ? "" : "s"} had no instance type, so accelerator status is unknown for those.`
                    : ""}
                </p>
              )}
            </>
          )}
      </article>
    </section>
  );
}
