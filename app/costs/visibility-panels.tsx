"use client";

import { useEffect, useState } from "react";
import styles from "./costs.module.css";

type LaunchWindow = "today" | "24h" | "7d" | "30d";

interface DailyDay {
  readonly date: string;
  readonly amount: number; // micro-units of the currency
}
interface DailyResponse {
  readonly period: string | null;
  readonly series: readonly DailyDay[];
  readonly latestDay: DailyDay | null;
  readonly priorDay: DailyDay | null;
  readonly deltaAmount: number | null;
  readonly deltaPercent: number | null;
  readonly currency: string;
  readonly note: string;
}
interface RegionCostRow {
  readonly region: string;
  readonly amount: number;
  readonly percent: number;
}
interface RegionResourceRow {
  readonly region: string;
  readonly count: number;
}
interface RegionsResponse {
  readonly cost: { readonly available: boolean; readonly currency: string; readonly regions: readonly RegionCostRow[] };
  readonly resources: { readonly total: number; readonly regions: readonly RegionResourceRow[] };
}
interface LaunchedResource {
  readonly resourceKey: string;
  readonly name: string | null;
  readonly service: string;
  readonly resourceType: string;
  readonly region: string;
  readonly firstObservedAt: string;
  readonly launchedAt: string | null;
  readonly launchSource: "aws" | "first-observed";
}
interface LaunchedResponse {
  readonly window: LaunchWindow;
  readonly resources: readonly LaunchedResource[];
  readonly truncated: boolean;
  readonly note: string;
}

const WINDOWS: readonly { readonly key: LaunchWindow; readonly label: string }[] = [
  { key: "today", label: "Today" },
  { key: "24h", label: "24h" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
];

function money(value: number | null, currency: string): string {
  if (value === null || currency === "") return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}
function micros(value: number): number {
  return value / 1_000_000;
}
function dayLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(`${iso}T00:00:00.000Z`));
}
function whenLabel(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body
      ? String((body as { error: { message?: string } }).error?.message ?? "Request rejected")
      : "Request rejected";
    throw new Error(message);
  }
  return body as T;
}

/**
 * "Cost visibility" band — day-over-day CUR cost, region breakdown, and a
 * recently-launched resources tracker. Each section degrades to an honest empty
 * state (no billing file, region column absent, no new resources) rather than
 * showing a fabricated number.
 */
export function VisibilityPanels({ connectionId }: { connectionId: string | null }) {
  const [daily, setDaily] = useState<DailyResponse | null>(null);
  const [regions, setRegions] = useState<RegionsResponse | null>(null);
  const [launched, setLaunched] = useState<LaunchedResponse | null>(null);
  const [windowKey, setWindowKey] = useState<LaunchWindow>("7d");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (connectionId === null) return;
    let active = true;
    const suffix = `?connectionId=${encodeURIComponent(connectionId)}`;
    Promise.all([
      getJson<DailyResponse>(`/api/v1/finops/daily${suffix}`),
      getJson<RegionsResponse>(`/api/v1/finops/regions${suffix}`),
    ]).then(([dailyPayload, regionsPayload]) => {
      if (!active) return;
      setDaily(dailyPayload);
      setRegions(regionsPayload);
      setError(null);
    }).catch((caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : "Sutra could not load cost visibility");
    });
    return () => { active = false; };
  }, [connectionId]);

  useEffect(() => {
    if (connectionId === null) return;
    let active = true;
    getJson<LaunchedResponse>(`/api/v1/finops/launched?connectionId=${encodeURIComponent(connectionId)}&window=${windowKey}`)
      .then((payload) => { if (active) setLaunched(payload); })
      .catch(() => { /* the launched tracker is non-fatal; keep prior view */ });
    return () => { active = false; };
  }, [connectionId, windowKey]);

  if (connectionId === null) return null;

  const maxDay = daily && daily.series.length > 0 ? Math.max(...daily.series.map((day) => day.amount), 1) : 1;
  const deltaUp = (daily?.deltaAmount ?? 0) > 0;

  return (
    <>
      <section className="panel" aria-label="Day-over-day cost">
        <div className="panel-heading">
          <div><p className="eyebrow">Granular spend visibility</p><h2>Day-over-day cost</h2></div>
          <span className="status-pill status-positive">CUR / FOCUS evidence</span>
        </div>
        {error ? <p className={styles.emptyNote} role="alert">{error}</p> : null}
        {daily === null ? <p className={styles.emptyNote}>Loading day-over-day cost…</p>
          : daily.series.length === 0 ? <p className={styles.emptyNote}>Upload a CUR or FOCUS billing file below to see day-over-day cost.</p>
          : (
            <>
              <section className={styles.kpis} aria-label="Latest vs prior day">
                <article className={`panel ${styles.primaryKpi}`}>
                  <small>Latest usage day{daily.latestDay ? ` · ${dayLabel(daily.latestDay.date)}` : ""}</small>
                  <strong>{money(daily.latestDay ? micros(daily.latestDay.amount) : null, daily.currency)}</strong>
                  <span>most recent day in the billing file</span>
                </article>
                <article className="panel">
                  <small>Prior day{daily.priorDay ? ` · ${dayLabel(daily.priorDay.date)}` : ""}</small>
                  <strong>{money(daily.priorDay ? micros(daily.priorDay.amount) : null, daily.currency)}</strong>
                  <span>the day before</span>
                </article>
                <article className="panel">
                  <small>Day over day</small>
                  <strong className={deltaUp ? styles.costUp : styles.costDown}>
                    {daily.deltaPercent === null ? "—" : `${daily.deltaPercent > 0 ? "+" : ""}${daily.deltaPercent.toFixed(1)}%`}
                  </strong>
                  <span>{daily.deltaAmount === null ? "no prior day yet" : `${daily.deltaAmount > 0 ? "+" : ""}${money(micros(daily.deltaAmount), daily.currency)}`}</span>
                </article>
              </section>
              <div className={styles.trendChart} role="img" aria-label="Daily cost bar chart">
                {daily.series.slice(-14).map((day) => (
                  <div className={styles.trendColumn} key={day.date} title={`${dayLabel(day.date)}: ${money(micros(day.amount), daily.currency)}`}>
                    <span>{money(micros(day.amount), daily.currency)}</span>
                    <i style={{ height: `${Math.max(4, (day.amount / maxDay) * 100)}%` }} />
                    <small>{dayLabel(day.date)}</small>
                  </div>
                ))}
              </div>
              <p className={styles.emptyNote}>{daily.note}</p>
            </>
          )}
      </section>

      <section className={styles.overviewGrid}>
        <article className="panel">
          <div className="panel-heading">
            <div><p className="eyebrow">Where the spend lives</p><h2>Cost by region</h2></div>
            {regions?.cost.available ? <span className="result-count">{regions.cost.regions.length} regions</span> : <span className="status-pill">not in billing file</span>}
          </div>
          {regions === null ? <p className={styles.emptyNote}>Loading region cost…</p>
            : !regions.cost.available ? <p className={styles.emptyNote}>Region cost appears once you upload a CUR/FOCUS file that includes the region column. Resource distribution by region is shown alongside.</p>
            : regions.cost.regions.length === 0 ? <p className={styles.emptyNote}>No positive region cost in this billing period.</p>
            : (
              <div className={styles.breakdownList}>
                {regions.cost.regions.map((row) => (
                  <div className={styles.breakdownRow} key={`cost-${row.region}`}>
                    <div><strong>{row.region}</strong><span>{money(row.amount, regions.cost.currency)}</span></div>
                    <div className={styles.progress}><i style={{ width: `${Math.min(100, row.percent)}%` }} /></div>
                    <small>{row.percent}%</small>
                  </div>
                ))}
              </div>
            )}
        </article>
        <article className="panel">
          <div className="panel-heading">
            <div><p className="eyebrow">Footprint</p><h2>Resources by region</h2></div>
            <span className="result-count">{regions?.resources.total ?? 0} resources</span>
          </div>
          {regions === null ? <p className={styles.emptyNote}>Loading region footprint…</p>
            : regions.resources.regions.length === 0 ? <p className={styles.emptyNote}>No regioned resources in the current snapshot.</p>
            : (
              <div className={styles.breakdownList}>
                {regions.resources.regions.slice(0, 10).map((row) => {
                  const share = regions.resources.total > 0 ? Math.round((row.count / regions.resources.total) * 100) : 0;
                  return (
                    <div className={styles.breakdownRow} key={`res-${row.region}`}>
                      <div><strong>{row.region}</strong><span>{row.count} resource{row.count === 1 ? "" : "s"}</span></div>
                      <div className={styles.progress}><i style={{ width: `${Math.min(100, share)}%` }} /></div>
                      <small>{share}%</small>
                    </div>
                  );
                })}
              </div>
            )}
        </article>
      </section>

      <section className="panel" aria-label="Recently launched resources">
        <div className="panel-heading">
          <div><p className="eyebrow">Change tracking</p><h2>Recently launched resources</h2></div>
          <div className={styles.windowTabs} role="tablist" aria-label="Time window">
            {WINDOWS.map((option) => (
              <button
                key={option.key}
                type="button"
                role="tab"
                aria-selected={windowKey === option.key}
                className={windowKey === option.key ? styles.windowActive : undefined}
                onClick={() => setWindowKey(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        {launched === null ? <p className={styles.emptyNote}>Loading recently launched resources…</p>
          : launched.resources.length === 0 ? <p className={styles.emptyNote}>No new resources were first observed in the selected window.</p>
          : (
            <>
              <div className={styles.launchedList}>
                <div className={`${styles.launchedRow} ${styles.launchedHead}`}>
                  <span>Resource</span><span>Service</span><span>Region</span><span>Launched</span><span>Source</span>
                </div>
                {launched.resources.map((resource) => (
                  <div className={styles.launchedRow} key={resource.resourceKey}>
                    <span title={resource.resourceKey}>
                      <strong>{resource.name ?? resource.resourceType}</strong>
                      <small>{resource.resourceType}</small>
                    </span>
                    <span>{resource.service}</span>
                    <span>{resource.region || "—"}</span>
                    <span>{whenLabel(resource.launchedAt ?? resource.firstObservedAt)}</span>
                    <span>
                      <em className={resource.launchSource === "aws" ? styles.srcAws : styles.srcObserved}>
                        {resource.launchSource === "aws" ? "AWS launch" : "first seen"}
                      </em>
                    </span>
                  </div>
                ))}
              </div>
              {launched.truncated ? <p className={styles.emptyNote}>Showing the most recent 500. Narrow the window to see fewer.</p> : null}
              <p className={styles.emptyNote}>{launched.note}</p>
            </>
          )}
      </section>
    </>
  );
}
