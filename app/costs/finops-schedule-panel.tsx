"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./costs.module.css";

/* ----------------------------------------------------------------------------
 * Resource scheduling (advisory).
 *
 * The panel states a schedule — "these tagged dev instances may run 08:00–20:00
 * on weekdays, off at weekends" — shows which collected EC2/RDS instances it
 * covers and what it would save, and hands the operator the CloudFormation or
 * Terraform to APPLY IN THEIR OWN ACCOUNT.
 *
 * Sutra never starts or stops anything: the customer trust role is read-only and
 * carries no start/stop permission. Every label here says so, and no control in
 * this panel triggers an action inside the customer account. All money arrives
 * from the API already in whole units; this panel never computes spend.
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

async function sendJson<T>(path: string, method: string, payload: Json): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
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

/* -------------------------------------------------------------------------- */
/* API shapes                                                                  */
/* -------------------------------------------------------------------------- */

interface ScheduleWindow { readonly weekday: number; readonly startMinute: number; readonly endMinute: number }
interface ScheduleDefinition {
  readonly timezone: string;
  readonly utcOffsetMinutes: number;
  readonly windows: readonly ScheduleWindow[];
  readonly offAtWeekends: boolean;
}
interface ScheduleSelector { readonly tagKey: string; readonly tagValue?: string; readonly regions?: readonly string[] }
interface StoredSchedule {
  readonly id: string;
  readonly name: string;
  readonly schedule: ScheduleDefinition;
  readonly selector: ScheduleSelector;
  readonly enabled: boolean;
}
interface Candidate {
  readonly resourceKey: string;
  readonly nativeId: string;
  readonly name: string | null;
  readonly kind: string;
  readonly region: string;
  readonly rateAvailable: boolean;
  readonly rateReason: string | null;
  readonly currency: string | null;
  readonly savingsUnits: number | null;
  readonly savingsIsUpperBound: boolean;
}
interface Excluded {
  readonly nativeId: string;
  readonly name: string | null;
  readonly region: string;
  readonly reason: string;
}
interface CurrencyTotal {
  readonly currency: string;
  readonly totalSavingsUnits: number;
  readonly candidateCount: number;
}
interface Transition {
  readonly action: string;
  readonly hour: number;
  readonly minute: number;
  readonly weekdays: readonly number[];
  readonly cron: string;
}
interface SchedulePlan {
  readonly month: string;
  readonly baselineHoursPerMonth: number;
  readonly runningHoursPerMonth: number;
  readonly stoppedHoursPerMonth: number;
  readonly transitions: readonly Transition[];
  readonly candidates: readonly Candidate[];
  readonly excluded: readonly Excluded[];
  readonly totalsByCurrency: readonly CurrencyTotal[];
  readonly rateNotDerivableCount: number;
  readonly candidateCount: number;
  readonly excludedCount: number;
}
interface Artifacts {
  readonly cloudFormationYaml: string;
  readonly terraformHcl: string;
  readonly grantedActions: readonly string[];
  readonly readOnlyNotice: string;
}
interface PlannedSchedule {
  readonly schedule: StoredSchedule;
  readonly plan: SchedulePlan;
  readonly artifacts: Artifacts | null;
  readonly artifactUnavailableReason: string | null;
}
interface ScheduleResponse {
  readonly period: string | null;
  readonly resourceTagKey: string | null;
  readonly resourceCount: number;
  readonly schedules: readonly StoredSchedule[];
  readonly planned: readonly PlannedSchedule[];
  readonly readOnlyNotice: string;
}

/* -------------------------------------------------------------------------- */
/* Presentation helpers                                                        */
/* -------------------------------------------------------------------------- */

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
// Standard-time offsets. The saved schedule carries the IANA name, so AWS
// applies daylight saving when it runs; the offset only drives the hour math.
const ZONES: readonly { readonly zone: string; readonly offset: number }[] = [
  { zone: "UTC", offset: 0 },
  { zone: "Europe/London", offset: 0 },
  { zone: "Europe/Berlin", offset: 60 },
  { zone: "Europe/Athens", offset: 120 },
  { zone: "Asia/Kolkata", offset: 330 },
  { zone: "Asia/Singapore", offset: 480 },
  { zone: "Australia/Sydney", offset: 600 },
  { zone: "America/Sao_Paulo", offset: -180 },
  { zone: "America/New_York", offset: -300 },
  { zone: "America/Chicago", offset: -360 },
  { zone: "America/Denver", offset: -420 },
  { zone: "America/Los_Angeles", offset: -480 },
];

const RATE_REASONS: Readonly<Record<string, string>> = {
  "cur-not-ingested": "no billing file ingested for this month",
  "cur-resource-join-key-not-configured": "no resource-id cost-allocation tag on the billing lines",
  "resource-cost-not-attributed-in-cur": "the billing file does not attribute cost to this resource",
  "resource-cost-in-multiple-currencies": "billed in more than one currency — not summed",
};

const EXCLUSION_REASONS: Readonly<Record<string, string>> = {
  "unsupported-kind": "not an EC2 or RDS instance",
  "already-not-running": "already not running — nothing to save",
  "production-environment-tag": "tagged as production",
  "schedule-exempt-tag": "tagged do-not-stop",
  "autoscaling-managed": "managed by an Auto Scaling group",
  "kubernetes-cluster-node": "a Kubernetes/EKS cluster node",
  "spot-instance-not-stoppable": "Spot instance — cannot be stopped",
  "instance-store-root-not-stoppable": "instance-store root — stopping destroys its data",
  "rds-read-replica-not-stoppable": "RDS read replica — cannot be stopped",
  "rds-aurora-not-individually-stoppable": "Aurora — stopped at cluster level, not per instance",
};

function hhmm(minutes: number): string {
  const clamped = Math.max(0, Math.min(1_440, minutes));
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

function minutesFromHhmm(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(value.trim());
  if (match === null) return value.trim() === "24:00" ? 1_440 : null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function windowSummary(schedule: ScheduleDefinition): string {
  const days = [...new Set(schedule.windows.map((window) => window.weekday))].sort((a, b) => a - b);
  const times = [...new Set(schedule.windows.map((window) => `${hhmm(window.startMinute)}–${hhmm(window.endMinute)}`))];
  const dayLabel = days.map((day) => DAY_LABELS[day]).join(", ");
  return `${dayLabel} ${times.join(", ")} ${schedule.timezone}${schedule.offAtWeekends ? " · off all weekend" : ""}`;
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function fileStem(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  return cleaned.length === 0 ? "sutra-schedule" : cleaned;
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                       */
/* -------------------------------------------------------------------------- */

const ENDPOINT = "/api/v1/finops/resource-schedules";

export default function FinopsSchedulePanel({ connectionId }: { connectionId: string }) {
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    tagKey: "Environment",
    tagValue: "development",
    start: "08:00",
    end: "20:00",
    zone: "UTC",
    offAtWeekends: true,
  });

  const query = `${ENDPOINT}?connectionId=${encodeURIComponent(connectionId)}`;

  const reload = useCallback(async () => {
    try {
      setData(await getJson<ScheduleResponse>(query));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load schedules");
    }
  }, [query]);

  useEffect(() => {
    let active = true;
    getJson<ScheduleResponse>(query)
      .then((loaded) => { if (active) { setData(loaded); setError(null); } })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Could not load schedules");
      });
    return () => { active = false; };
  }, [query]);

  async function addSchedule(): Promise<void> {
    const startMinute = minutesFromHhmm(form.start);
    const endMinute = minutesFromHhmm(form.end);
    if (form.name.trim().length === 0 || form.tagKey.trim().length === 0) {
      setError("A schedule needs a name and the tag that selects its resources");
      return;
    }
    if (startMinute === null || endMinute === null || endMinute <= startMinute) {
      setError("Use 24-hour times, with the running window ending after it starts (for example 08:00 to 20:00)");
      return;
    }
    const zone = ZONES.find((entry) => entry.zone === form.zone) ?? ZONES[0];
    setBusy(true);
    try {
      await sendJson(ENDPOINT, "POST", {
        name: form.name.trim(),
        selector: form.tagValue.trim().length > 0
          ? { tagKey: form.tagKey.trim(), tagValue: form.tagValue.trim() }
          : { tagKey: form.tagKey.trim() },
        schedule: {
          timezone: zone.zone,
          utcOffsetMinutes: zone.offset,
          offAtWeekends: form.offAtWeekends,
          windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute, endMinute })),
        },
      });
      setForm({ ...form, name: "" });
      setNotice(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the schedule");
    } finally {
      setBusy(false);
    }
  }

  async function setEnabled(schedule: StoredSchedule, enabled: boolean): Promise<void> {
    setBusy(true);
    try {
      await sendJson(`${ENDPOINT}?id=${encodeURIComponent(schedule.id)}`, "PATCH", { enabled });
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change the schedule");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    setBusy(true);
    try {
      await sendJson(`${ENDPOINT}?id=${encodeURIComponent(id)}`, "DELETE", {});
      if (openId === id) setOpenId(null);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the schedule");
    } finally {
      setBusy(false);
    }
  }

  async function downloadArtifact(schedule: StoredSchedule, format: "cloudformation" | "terraform"): Promise<void> {
    setBusy(true);
    try {
      const detail = await getJson<ScheduleResponse>(
        `${query}&id=${encodeURIComponent(schedule.id)}`,
      );
      const entry = detail.planned[0];
      if (entry === undefined || entry.artifacts === null) {
        setError(entry?.artifactUnavailableReason ?? "This schedule has no template to download");
        return;
      }
      if (format === "cloudformation") {
        download(`${fileStem(schedule.name)}-schedule.cfn.yaml`, entry.artifacts.cloudFormationYaml);
      } else {
        download(`${fileStem(schedule.name)}-schedule.tf`, entry.artifacts.terraformHcl);
      }
      setNotice(
        `Downloaded the ${format === "cloudformation" ? "CloudFormation template" : "Terraform configuration"} for ` +
        `“${schedule.name}”. Deploy it in your own AWS account — Sutra does not apply it and cannot start or stop your resources.`,
      );
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not build the template");
    } finally {
      setBusy(false);
    }
  }

  const planned = data?.planned ?? [];
  const totals = new Map<string, number>();
  for (const entry of planned) {
    if (!entry.schedule.enabled) continue;
    for (const total of entry.plan.totalsByCurrency) {
      totals.set(total.currency, (totals.get(total.currency) ?? 0) + total.totalSavingsUnits);
    }
  }
  const totalRows = [...totals.entries()].sort((left, right) => left[0].localeCompare(right[0]));
  const activeCount = planned.filter((entry) => entry.schedule.enabled).length;

  return (
    <article className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Advisory · you apply it</p>
          <h2>Resource scheduling</h2>
        </div>
        <span className="result-count">
          {activeCount} active{planned.length > activeCount ? ` · ${planned.length - activeCount} paused` : ""}
        </span>
      </div>

      <p className={styles.schedNotice} role="note">
        <b>Sutra does not stop anything.</b> Your connection role is read-only and has no start/stop
        permission, so this panel only states the schedule and computes what it would save. Download
        the template and deploy it in your own account to make it happen.
      </p>

      {error ? <p className={styles.emptyNote} role="alert">{error}</p> : null}
      {notice ? <p className={styles.emptyNote} role="status">{notice}</p> : null}

      {data === null ? <p className={styles.emptyNote}>Loading schedules…</p> : (
        <>
          {totalRows.length > 0 ? (
            <div className={styles.schedTotals}>
              {totalRows.map(([currency, units]) => (
                <span key={currency}>
                  <small>Would save / month</small>
                  <strong>{money(units, currency)}</strong>
                </span>
              ))}
            </div>
          ) : null}

          {planned.length === 0 ? (
            <p className={styles.emptyNote}>
              No schedule is defined yet. Add one below to see which of the {data.resourceCount} collected
              resources it would cover and what stopping them outside the window would save. Nothing is
              stopped by Sutra — you get a template to apply yourself.
            </p>
          ) : (
            <ul className={styles.schedList}>
              {planned.map((entry) => {
                const { schedule, plan } = entry;
                const open = openId === schedule.id;
                return (
                  <li key={schedule.id} className={schedule.enabled ? undefined : styles.w3RuleOff}>
                    <div className={styles.schedRow}>
                      <span className={styles.schedName} data-label="Schedule">
                        <strong>{schedule.name}</strong>
                        <small>
                          {schedule.selector.tagKey}
                          {schedule.selector.tagValue === undefined ? " (any value)" : `=${schedule.selector.tagValue}`}
                          {" · "}{windowSummary(schedule.schedule)}
                        </small>
                      </span>
                      <span data-label="Off / month">
                        <strong>{Math.round(plan.stoppedHoursPerMonth)} h</strong>
                        <small>of {Math.round(plan.baselineHoursPerMonth)} h in {plan.month}</small>
                      </span>
                      <span data-label="Would save">
                        {plan.totalsByCurrency.length === 0 ? (
                          <small>not derivable</small>
                        ) : plan.totalsByCurrency.map((total) => (
                          <strong key={total.currency}>{money(total.totalSavingsUnits, total.currency)}</strong>
                        ))}
                        <small>{plan.candidateCount} candidate{plan.candidateCount === 1 ? "" : "s"}</small>
                      </span>
                      <span className={styles.schedActions} data-label="Actions">
                        <label className={styles.w3Switch}>
                          <input
                            type="checkbox"
                            role="switch"
                            checked={schedule.enabled}
                            aria-checked={schedule.enabled}
                            disabled={busy}
                            onChange={(event) => void setEnabled(schedule, event.target.checked)}
                            aria-label={`${schedule.enabled ? "Pause" : "Resume"} schedule ${schedule.name}`}
                          />
                          <span>{schedule.enabled ? "Active" : "Paused"}</span>
                        </label>
                        <button
                          className="button button-ghost"
                          type="button"
                          onClick={() => setOpenId(open ? null : schedule.id)}
                          aria-expanded={open}
                        >
                          {open ? "Hide detail" : "Detail"}
                        </button>
                        <button
                          className="button button-secondary"
                          type="button"
                          disabled={busy}
                          onClick={() => void downloadArtifact(schedule, "cloudformation")}
                        >
                          CloudFormation
                        </button>
                        <button
                          className="button button-ghost"
                          type="button"
                          disabled={busy}
                          onClick={() => void downloadArtifact(schedule, "terraform")}
                        >
                          Terraform
                        </button>
                        <button
                          className="button button-ghost"
                          type="button"
                          disabled={busy}
                          onClick={() => void remove(schedule.id)}
                          aria-label={`Delete schedule ${schedule.name}`}
                        >
                          Remove
                        </button>
                      </span>
                    </div>

                    {open ? (
                      <div className={styles.schedDetail}>
                        <p className={styles.w3Hint}>
                          Transitions the downloaded template would create:{" "}
                          {plan.transitions.length === 0 ? "none — this schedule never changes state." : plan.transitions
                            .map((transition) => `${transition.action} ${hhmm(transition.hour * 60 + transition.minute)} ${transition.weekdays.map((day) => DAY_LABELS[day]).join("/")}`)
                            .join(" · ")}
                        </p>
                        {plan.candidates.length === 0 ? (
                          <p className={styles.emptyNote}>
                            No collected EC2 or RDS instance carries this tag, so there is nothing to schedule yet.
                          </p>
                        ) : (
                          <ul className={styles.schedCandidates}>
                            {plan.candidates.slice(0, 12).map((candidate) => (
                              <li key={candidate.resourceKey}>
                                <span>
                                  <strong>{candidate.name ?? candidate.nativeId}</strong>
                                  <small>{candidate.kind === "rds-db-instance" ? "RDS" : "EC2"} · {candidate.region} · {candidate.nativeId}</small>
                                </span>
                                <span>
                                  {candidate.rateAvailable && candidate.savingsUnits !== null ? (
                                    <>
                                      <strong>{money(candidate.savingsUnits, candidate.currency)}</strong>
                                      <small>
                                        {candidate.savingsIsUpperBound
                                          ? "ceiling — RDS storage keeps billing while stopped"
                                          : "per month, attached storage billed separately"}
                                      </small>
                                    </>
                                  ) : (
                                    <small>
                                      Savings not derivable — {RATE_REASONS[candidate.rateReason ?? ""] ?? "cost not attributed"}
                                    </small>
                                  )}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {plan.rateNotDerivableCount > 0 ? (
                          <p className={styles.w3Hint}>
                            {plan.rateNotDerivableCount} candidate{plan.rateNotDerivableCount === 1 ? "" : "s"} report no
                            savings figure because the ingested billing file does not attribute cost to
                            {plan.rateNotDerivableCount === 1 ? " it" : " them"}. Turn on a resource-id cost-allocation tag in
                            AWS Billing and re-upload the CUR to get a number — nothing is estimated in the meantime.
                          </p>
                        ) : null}
                        {plan.excluded.length > 0 ? (
                          <p className={styles.w3Hint}>
                            Excluded ({plan.excludedCount}):{" "}
                            {plan.excluded.slice(0, 8).map((excluded) => (
                              `${excluded.name ?? excluded.nativeId} — ${EXCLUSION_REASONS[excluded.reason] ?? excluded.reason}`
                            )).join(" · ")}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          <div className={styles.w3Form}>
            <div className={styles.w3Grid}>
              <input
                className={styles.w3Input}
                placeholder="Schedule name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                aria-label="Schedule name"
              />
              <input
                className={styles.w3Input}
                placeholder="tag key"
                value={form.tagKey}
                onChange={(event) => setForm({ ...form, tagKey: event.target.value })}
                aria-label="Tag key that selects the resources"
              />
              <input
                className={styles.w3Input}
                placeholder="tag value (optional)"
                value={form.tagValue}
                onChange={(event) => setForm({ ...form, tagValue: event.target.value })}
                aria-label="Tag value"
              />
              <input
                className={styles.w3Input}
                value={form.start}
                onChange={(event) => setForm({ ...form, start: event.target.value })}
                aria-label="Weekday start time, 24-hour"
                placeholder="08:00"
              />
              <input
                className={styles.w3Input}
                value={form.end}
                onChange={(event) => setForm({ ...form, end: event.target.value })}
                aria-label="Weekday stop time, 24-hour"
                placeholder="20:00"
              />
              <select
                className={styles.w3Input}
                value={form.zone}
                onChange={(event) => setForm({ ...form, zone: event.target.value })}
                aria-label="Timezone"
              >
                {ZONES.map((entry) => <option key={entry.zone} value={entry.zone}>{entry.zone}</option>)}
              </select>
              <label className={styles.w3Switch}>
                <input
                  type="checkbox"
                  checked={form.offAtWeekends}
                  onChange={(event) => setForm({ ...form, offAtWeekends: event.target.checked })}
                />
                <span>Off at weekends</span>
              </label>
              <button className="button button-secondary" type="button" disabled={busy} onClick={() => void addSchedule()}>
                Add schedule
              </button>
            </div>
            <p className={styles.w3Hint}>
              Savings are the resource&apos;s own billed cost for {data.period ?? "the latest ingested month"} scaled by
              the hours the schedule leaves it off — never a list price. Production-tagged, Auto Scaling, Spot,
              instance-store, Aurora, and read-replica instances are excluded on purpose, with the reason shown.
              Hour math uses each zone&apos;s standard offset; the downloaded template carries the zone name, so AWS
              applies daylight saving when it runs.
            </p>
          </div>
        </>
      )}
    </article>
  );
}
