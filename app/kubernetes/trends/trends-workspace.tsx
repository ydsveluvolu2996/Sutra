"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { MspScorecard, ScoredTrendPoint, TrendDirection } from "../../../lib/kubernetes-posture-trend";
import { formatTimestamp, usePilotState } from "../../components/use-pilot-state";

function directionMark(direction: TrendDirection): { readonly glyph: string; readonly klass: string } {
  if (direction === "improving") return { glyph: "▲", klass: "trend-up" };
  if (direction === "regressing") return { glyph: "▼", klass: "trend-down" };
  return { glyph: "▬", klass: "trend-flat" };
}

function scoreBand(score: number | null): string {
  if (score === null) return "trend-flat";
  return score >= 80 ? "trend-up" : score >= 55 ? "trend-warn" : "trend-down";
}

// Sparkline over the collected scan scores; endpoint emphasized. No dependency.
function Sparkline({ series }: { readonly series: readonly ScoredTrendPoint[] }) {
  if (series.length === 0) return <span className="panel-footnote">No scans</span>;
  const width = 132;
  const height = 34;
  const scores = series.map((point) => point.score);
  const min = Math.min(...scores, 0);
  const max = Math.max(...scores, 100);
  const span = max - min || 1;
  const step = series.length > 1 ? width / (series.length - 1) : 0;
  const point = (score: number, index: number) => {
    const x = series.length > 1 ? index * step : width / 2;
    const y = height - 3 - ((score - min) / span) * (height - 6);
    return [x, y] as const;
  };
  const path = series.map((p, i) => { const [x, y] = point(p.score, i); return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`; }).join(" ");
  const [lastX, lastY] = point(scores[scores.length - 1] ?? 0, series.length - 1);
  return (
    <svg className="trend-sparkline" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="Score trend">
      {series.length > 1 ? <path d={path} fill="none" strokeWidth="1.6" /> : null}
      <circle cx={lastX} cy={lastY} r="2.6" />
    </svg>
  );
}

export function TrendsWorkspace() {
  const { state, loading, error, refresh } = usePilotState();
  const connectionId = state?.connection?.id ?? null;
  const [scorecard, setScorecard] = useState<MspScorecard | null>(null);
  const [scoreError, setScoreError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (connectionId === null) { setScorecard(null); setScoreError(null); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/kubernetes/posture-trend?connectionId=${encodeURIComponent(connectionId)}`, { cache: "no-store", credentials: "same-origin" });
      const body = await response.json() as MspScorecard & { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Posture trend is unavailable");
      setScorecard(body);
      setScoreError(null);
    } catch (caught) {
      setScorecard(null);
      setScoreError(caught instanceof Error ? caught.message : "Posture trend is unavailable");
    } finally {
      setBusy(false);
    }
  }, [connectionId]);
  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const exportCsv = useCallback(() => {
    if (scorecard === null) return;
    const body = ["cluster,score,delta,direction,open_findings,critical_high,scans,last_scan",
      ...scorecard.clusters.map((row) => [
        row.clusterName, row.score ?? "", row.delta ?? "", row.direction, row.openFindings, row.criticalHigh, row.scanCount, row.lastScanAt ?? "",
      ].map((cell) => { const t = String(cell); return /[",\r\n]/u.test(t) ? `"${t.replaceAll('"', '""')}"` : t; }).join(","))].join("\r\n");
    const blob = new Blob([body], { type: "text/csv" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href; anchor.download = "sutra-kubernetes-posture-scorecard.csv";
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(href);
  }, [scorecard]);

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Kubernetes · MSP reporting</p><h1>Posture trends &amp; scorecard</h1><p className="page-subtitle">Security score over time per cluster, with improvement and regression detection — the report you resell to each customer. Scores use the same formula as the dashboard and are computed only from the scans actually collected.</p></div>
        <div className="heading-actions"><button className="button button-secondary" disabled={scorecard === null || scorecard.clusters.length === 0} onClick={exportCsv} type="button">Export CSV</button><button className="button button-primary" disabled={busy} onClick={() => { void refresh(); void load(); }} type="button">{busy ? "Refreshing…" : "Refresh"}</button></div>
      </section>

      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Workspace unavailable</strong><span>{error}</span><button onClick={() => void refresh()} type="button">Retry</button></div> : null}
      {scoreError ? <div className="page-alert page-alert-error" role="alert"><strong>Posture trend unavailable</strong><span>{scoreError}</span><button onClick={() => void load()} type="button">Retry</button></div> : null}
      {loading || busy ? <div className="loading-state" role="status"><span className="loading-spinner" />Reading scan history…</div> : null}

      {scorecard !== null && !busy ? <>
        <section className="inventory-stats">
          <article><small>Fleet average score</small><strong>{scorecard.fleet.averageScore ?? "—"}</strong><span>Across scored clusters</span></article>
          <article><small>Improving</small><strong>{scorecard.fleet.improving}</strong><span>Score up since last scan</span></article>
          <article><small>Regressing</small><strong>{scorecard.fleet.regressing}</strong><span>Score down since last scan</span></article>
          <article><small>Awaiting a scan</small><strong>{scorecard.fleet.unscored}</strong><span>No history yet</span></article>
        </section>

        <section className="panel">
          <div className="panel-heading"><div><p className="eyebrow">Worst posture first</p><h2>Per-cluster scorecard</h2></div><span className="result-count">{scorecard.clusters.length} cluster{scorecard.clusters.length === 1 ? "" : "s"}</span></div>
          {scorecard.clusters.length > 0 ? <div className="scorecard-list">
            {scorecard.clusters.map((row) => {
              const mark = directionMark(row.direction);
              return <article className="scorecard-row" key={row.clusterId}>
                <div className="scorecard-score"><strong className={scoreBand(row.score)}>{row.score ?? "—"}</strong><small>score</small></div>
                <div className="scorecard-name">
                  <strong>{row.clusterName}</strong>
                  <small>{row.openFindings} open · {row.criticalHigh} critical/high · {row.scanCount} scan{row.scanCount === 1 ? "" : "s"}{row.lastScanAt ? ` · ${formatTimestamp(row.lastScanAt)}` : ""}</small>
                </div>
                <Sparkline series={row.trend.series} />
                <div className={`scorecard-delta ${mark.klass}`}>
                  <span aria-hidden="true">{mark.glyph}</span>
                  <small>{row.delta === null ? "no prior scan" : `${row.delta > 0 ? "+" : ""}${row.delta}`}</small>
                  {row.regression ? <b className="scorecard-regression">Regression</b> : null}
                </div>
              </article>;
            })}
          </div> : <section className="empty-workspace compact-empty"><span className="empty-workspace-icon">TR</span><h2>No scan history yet</h2><p>Publish Kubernetes collector scans over time and the score trend, regressions, and per-customer scorecard build automatically. A single scan shows a score with no trend; two or more show direction.</p><Link className="button button-secondary" href="/kubernetes/onboard">Onboard a cluster</Link></section>}
        </section>
        <p className="panel-footnote">{scorecard.disclaimer}</p>
      </> : null}
    </>
  );
}
