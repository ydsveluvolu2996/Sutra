"use client";

import { useEffect, useState } from "react";

import type { ComponentStatus, StatusReport, WindowUptime } from "../../lib/uptime-status";

/* ------------------------------------------------------------------ *
 * Live status client for the public /status page. Fetches the derived
 * report from /api/status and renders current component status + the
 * uptime % table, honestly showing "unknown" for anything unobserved.
 * The state-colour variants (.warn/.down/.unknown) are scoped here so
 * the page reuses the shared .lx-status-* structure without touching
 * globals.css.
 * ------------------------------------------------------------------ */

const STATUS_LABEL: Record<ComponentStatus, string> = {
  operational: "Operational",
  degraded: "Degraded",
  down: "Down",
  unknown: "Unknown",
};

const STATUS_CLASS: Record<ComponentStatus, string> = {
  operational: "ok",
  degraded: "warn",
  down: "down",
  unknown: "unknown",
};

const BANNER_TITLE: Record<ComponentStatus, string> = {
  operational: "All systems operational",
  degraded: "Degraded performance",
  down: "Active incident",
  unknown: "Status partially unknown",
};

const BANNER_LEAD: Record<ComponentStatus, string> = {
  operational: "Every monitored component reported healthy on its most recent probe.",
  degraded: "At least one component recovered from a recent failure or is running degraded.",
  down: "At least one monitored component is currently reporting unhealthy.",
  unknown: "At least one component has no recent probe, so an all-clear cannot be confirmed.",
};

function formatObserved(iso: string | null): string {
  if (iso === null) return "never probed";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  const ageMs = Date.now() - ms;
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function uptimeCell(window: WindowUptime | undefined) {
  if (window === undefined || window.uptimePercent === null) {
    return <span className="up-cell up-cell-unknown" title="No samples recorded in this window.">No data</span>;
  }
  const title = `${window.healthyCount}/${window.sampleCount} healthy samples since ${window.windowStartAt}`;
  return (
    <span className="up-cell" title={title}>
      {window.uptimePercent}%
      <em className="up-cell-count">{window.sampleCount} samples</em>
    </span>
  );
}

export default function StatusClient() {
  const [report, setReport] = useState<StatusReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/status", { cache: "no-store", headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`status ${response.status}`);
        return (await response.json()) as StatusReport;
      })
      .then((data) => { if (active) setReport(data); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "unavailable"); });
    return () => { active = false; };
  }, []);

  const overall: ComponentStatus = report?.overall ?? "unknown";

  return (
    <>
      <style>{`
        .lz .lx-status-banner.warn { border-color: rgba(251,191,36,.34); background: rgba(251,191,36,.09); }
        .lz .lx-status-banner.down { border-color: rgba(248,113,113,.38); background: rgba(248,113,113,.10); }
        .lz .lx-status-banner.unknown { border-color: var(--line-2); background: var(--glass-2); }
        .lz .lx-status-banner.warn .lx-status-dot { background: #fbbf24; box-shadow: 0 0 0 4px rgba(251,191,36,.18); }
        .lz .lx-status-banner.down .lx-status-dot { background: #f87171; box-shadow: 0 0 0 4px rgba(248,113,113,.18); }
        .lz .lx-status-banner.unknown .lx-status-dot { background: var(--body-2); box-shadow: none; animation: none; }
        .lz .lx-status-pill.warn { color: #b8860b; border: 1px solid rgba(251,191,36,.40); background: rgba(251,191,36,.10); }
        .lz .lx-status-pill.down { color: #dc2626; border: 1px solid rgba(248,113,113,.42); background: rgba(248,113,113,.10); }
        .lz .lx-status-pill.unknown { color: var(--body-2); border: 1px dashed var(--line-2); background: var(--glass-2); }
        .lz .lx-status-pill.warn .lx-status-dot { background: #fbbf24; }
        .lz .lx-status-pill.down .lx-status-dot { background: #f87171; }
        .lz .lx-status-pill.unknown .lx-status-dot { background: var(--body-2); }
        .lz .up-table { width: 100%; border-collapse: collapse; overflow-x: auto; display: block; }
        .lz .up-table thead th { text-align: right; font-family: var(--mono); font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--body-2); padding: 8px 10px; }
        .lz .up-table thead th:first-child { text-align: left; }
        .lz .up-table tbody td { padding: 12px 10px; border-top: 1px solid var(--line-2); font-size: 13.5px; text-align: right; }
        .lz .up-table tbody td:first-child { text-align: left; color: var(--title); font-weight: 600; }
        .lz .up-cell { display: inline-flex; flex-direction: column; align-items: flex-end; color: var(--title); }
        .lz .up-cell-count { font-style: normal; font-size: 10.5px; color: var(--body-2); }
        .lz .up-cell-unknown { color: var(--body-2); font-style: italic; }
        .lz .up-reason { display: block; margin-top: 4px; font-style: normal; font-size: 11.5px; color: var(--body-2); }
        .lz .up-meta { font-family: var(--mono); font-size: 11px; color: var(--body-2); }
      `}</style>

      <div className={`lx-status-banner ${STATUS_CLASS[overall]}`} role="status">
        <span className="lx-status-dot" aria-hidden="true" />
        <div>
          <b>{error === null ? BANNER_TITLE[overall] : "Status unavailable"}</b>
          <em>{error === null ? BANNER_LEAD[overall] : "The status feed could not be reached. This is an honest failure to report, not an all-clear."}</em>
        </div>
      </div>

      <section className="lx-legal-section">
        <h2>Components</h2>
        <div className="lx-status-list">
          {(report?.components ?? []).map((health) => (
            <div key={health.component.key} className="lx-status-row">
              <div className="lx-status-name">
                <b>{health.component.name}</b>
                <em>{health.component.detail}</em>
                <em className="up-reason">{health.statusReason}</em>
              </div>
              <span className={`lx-status-pill ${STATUS_CLASS[health.status]}`}>
                <span className="lx-status-dot" aria-hidden="true" /> {STATUS_LABEL[health.status]}
              </span>
            </div>
          ))}
          {report === null && error === null ? <div className="lx-status-empty">Loading live status…</div> : null}
          {error !== null ? <div className="lx-status-empty">Live status could not be loaded.</div> : null}
        </div>
      </section>

      {report !== null ? (
        <section className="lx-legal-section">
          <h2>Uptime</h2>
          <table className="up-table">
            <thead>
              <tr>
                <th>Component</th>
                {report.windows.map((window) => <th key={window}>{window}</th>)}
              </tr>
            </thead>
            <tbody>
              {report.components.map((health) => (
                <tr key={health.component.key}>
                  <td>
                    {health.component.name}
                    <em className="up-reason">last observed {formatObserved(health.latestObservedAt)}</em>
                  </td>
                  {report.windows.map((window) => (
                    <td key={window}>{uptimeCell(health.windows.find((entry) => entry.window === window))}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {report !== null ? (
        <p className="up-meta">
          Computed {report.generatedAt}. Current status uses a {Math.round(report.freshWindowMs / 60_000)}-minute freshness window.
        </p>
      ) : null}

      <p className="lx-legal-note">
        <em>{report?.disclaimer ?? "Status and uptime are derived only from recorded health probes; a component with no recent sample is shown as unknown, never assumed operational."} For incident-specific questions, reach us through the <a href="/contact">contact page</a>.</em>
      </p>
    </>
  );
}
