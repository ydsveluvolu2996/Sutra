"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./costs.module.css";

/* ----------------------------------------------------------------------------
 * Wave 3 FinOps panels: allocation rules ("virtual tags"), MSP margin, and
 * cost/budget alerts. Each panel reads its live engine result and — for the two
 * operator-configured features — offers a compact management control. All money
 * comes back from the API already in whole units; these panels never compute
 * spend, only display it.
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
/* Allocation rules                                                            */
/* -------------------------------------------------------------------------- */

interface AllocationBucket {
  readonly targetKind: string;
  readonly targetValue: string;
  readonly ruleName: string | null;
  readonly amountUnits: number;
  readonly lineCount: number;
}
interface AllocationResponse {
  readonly period: string | null;
  readonly allocation: {
    readonly allocated: readonly AllocationBucket[];
    readonly unallocated: { readonly amountUnits: number; readonly lineCount: number };
    readonly currency: string | null;
    readonly totalUnits: number;
    readonly ruleCount: number;
  };
}
interface StoredRule {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly match: { account?: string; service?: string; tagKey?: string; tagValue?: string };
  readonly targetKind: string;
  readonly targetValue: string;
  readonly enabled: boolean;
}

function AllocationPanel({ connectionId }: { connectionId: string }) {
  const [data, setData] = useState<AllocationResponse | null>(null);
  const [rules, setRules] = useState<readonly StoredRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", dimension: "service", value: "", tagValue: "", targetKind: "customer", targetValue: "" });
  const [priorityDraft, setPriorityDraft] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    try {
      const [alloc, ruleList] = await Promise.all([
        getJson<AllocationResponse>(`/api/v1/finops/allocation?connectionId=${encodeURIComponent(connectionId)}`),
        getJson<{ rules: readonly StoredRule[] }>(`/api/v1/finops/allocation-rules`),
      ]);
      setData(alloc);
      setRules(ruleList.rules);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load allocation");
    }
  }, [connectionId]);

  useEffect(() => {
    let active = true;
    Promise.all([
      getJson<AllocationResponse>(`/api/v1/finops/allocation?connectionId=${encodeURIComponent(connectionId)}`),
      getJson<{ rules: readonly StoredRule[] }>(`/api/v1/finops/allocation-rules`),
    ])
      .then(([alloc, ruleList]) => { if (active) { setData(alloc); setRules(ruleList.rules); setError(null); } })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "Could not load allocation"); });
    return () => { active = false; };
  }, [connectionId]);

  async function addRule(): Promise<void> {
    if (form.name.trim().length === 0 || form.value.trim().length === 0 || form.targetValue.trim().length === 0) {
      setError("Rule name, match value, and target are required");
      return;
    }
    setBusy(true);
    try {
      const match: Json = {};
      if (form.dimension === "tag") { match.tagKey = form.value; if (form.tagValue.trim().length > 0) match.tagValue = form.tagValue; }
      else match[form.dimension] = form.value;
      await sendJson(`/api/v1/finops/allocation-rules`, "POST", {
        name: form.name, match, targetKind: form.targetKind, targetValue: form.targetValue,
      });
      setForm({ name: "", dimension: "service", value: "", tagValue: "", targetKind: "customer", targetValue: "" });
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add rule");
    } finally {
      setBusy(false);
    }
  }

  async function patchRule(rule: StoredRule, patch: Json, failure: string): Promise<boolean> {
    setBusy(true);
    try {
      await sendJson(`/api/v1/finops/allocation-rules?id=${encodeURIComponent(rule.id)}`, "PATCH", patch);
      await reload();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : failure);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function setRuleEnabled(rule: StoredRule, enabled: boolean): Promise<void> {
    await patchRule(rule, { enabled }, enabled ? "Could not enable rule" : "Could not disable rule");
  }

  async function savePriority(rule: StoredRule): Promise<void> {
    const raw = (priorityDraft[rule.id] ?? String(rule.priority)).trim();
    if (!/^\d{1,6}$/u.test(raw)) {
      setError("Priority must be a whole number — lower priority is matched first");
      return;
    }
    const saved = await patchRule(rule, { priority: Number(raw) }, "Could not change priority");
    if (saved) {
      setPriorityDraft((prev) => {
        const next = { ...prev };
        delete next[rule.id];
        return next;
      });
    }
  }

  async function removeRule(id: string): Promise<void> {
    setBusy(true);
    try {
      await sendJson(`/api/v1/finops/allocation-rules?id=${encodeURIComponent(id)}`, "DELETE", {});
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete rule");
    } finally {
      setBusy(false);
    }
  }

  const alloc = data?.allocation ?? null;
  const maxBucket = alloc && alloc.allocated.length > 0 ? Math.max(...alloc.allocated.map((b) => b.amountUnits), 1) : 1;
  const activeRuleCount = rules.length > 0 ? rules.filter((rule) => rule.enabled).length : alloc?.ruleCount ?? 0;

  return (
    <article className="panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Virtual tags</p><h2>Allocation rules</h2></div>
        <span className="result-count">{activeRuleCount} active{rules.length > activeRuleCount ? ` · ${rules.length - activeRuleCount} disabled` : ""}</span>
      </div>
      {error ? <p className={styles.emptyNote} role="alert">{error}</p> : null}
      {alloc === null ? <p className={styles.emptyNote}>Loading allocation…</p> : (
        <>
          {alloc.allocated.length === 0 ? (
            <p className={styles.emptyNote}>No spend is allocated yet. Add a rule below to assign account / service / tag spend to a customer, product, or cost-center. Unmatched spend is disclosed as unallocated, never force-assigned.</p>
          ) : (
            <div className={styles.breakdownList}>
              {alloc.allocated.slice(0, 8).map((bucket) => (
                <div className={styles.breakdownRow} key={`${bucket.targetKind}:${bucket.targetValue}`}>
                  <div><strong>{bucket.targetValue}</strong><span>{bucket.targetKind.replace("_", " ")} · {bucket.lineCount} lines</span></div>
                  <div className={styles.progress}><i style={{ width: `${Math.min(100, (bucket.amountUnits / maxBucket) * 100)}%` }} /></div>
                  <small>{money(bucket.amountUnits, alloc.currency)}</small>
                </div>
              ))}
              <div className={styles.breakdownRow}>
                <div><strong>Unallocated</strong><span>{alloc.unallocated.lineCount} lines · no rule matched</span></div>
                <div className={styles.progress}><i style={{ width: `${Math.min(100, (alloc.unallocated.amountUnits / maxBucket) * 100)}%`, background: "#f59e0b" }} /></div>
                <small>{money(alloc.unallocated.amountUnits, alloc.currency)}</small>
              </div>
            </div>
          )}

          <div className={styles.w3Form}>
            <div className={styles.w3Grid}>
              <input className={styles.w3Input} placeholder="Rule name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <select className={styles.w3Input} value={form.dimension} onChange={(e) => setForm({ ...form, dimension: e.target.value })} aria-label="Match dimension">
                <option value="service">Service is</option>
                <option value="account">Account is</option>
                <option value="tag">Tag key</option>
              </select>
              <input className={styles.w3Input} placeholder={form.dimension === "tag" ? "tag key" : "value"} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
              {form.dimension === "tag" ? <input className={styles.w3Input} placeholder="tag value (optional)" value={form.tagValue} onChange={(e) => setForm({ ...form, tagValue: e.target.value })} /> : null}
              <select className={styles.w3Input} value={form.targetKind} onChange={(e) => setForm({ ...form, targetKind: e.target.value })} aria-label="Target kind">
                <option value="customer">→ customer</option>
                <option value="product">→ product</option>
                <option value="cost_center">→ cost center</option>
              </select>
              <input className={styles.w3Input} placeholder="target value" value={form.targetValue} onChange={(e) => setForm({ ...form, targetValue: e.target.value })} />
              <button className="button button-secondary" type="button" disabled={busy} onClick={() => void addRule()}>Add rule</button>
            </div>
          </div>

          {rules.length > 0 ? (
            <ul className={styles.w3RuleList}>
              {rules.map((rule) => {
                const priorityValue = priorityDraft[rule.id] ?? String(rule.priority);
                const priorityChanged = priorityValue.trim() !== String(rule.priority);
                return (
                  <li key={rule.id} className={rule.enabled ? undefined : styles.w3RuleOff}>
                    <span><strong>{rule.name}</strong> — {rule.match.service ?? rule.match.account ?? (rule.match.tagKey ? `${rule.match.tagKey}${rule.match.tagValue ? `=${rule.match.tagValue}` : ""}` : "?")} → {rule.targetKind.replace("_", " ")} {rule.targetValue}{rule.enabled ? "" : " · not applied"}</span>
                    <span className={styles.w3RuleControls}>
                      <label className={styles.w3Switch}>
                        <input
                          type="checkbox"
                          role="switch"
                          checked={rule.enabled}
                          aria-checked={rule.enabled}
                          disabled={busy}
                          onChange={(e) => void setRuleEnabled(rule, e.target.checked)}
                          aria-label={`${rule.enabled ? "Disable" : "Enable"} rule ${rule.name}`}
                        />
                        <span>{rule.enabled ? "Active" : "Disabled"}</span>
                      </label>
                      <input
                        className={styles.w3Mini}
                        inputMode="numeric"
                        value={priorityValue}
                        disabled={busy}
                        onChange={(e) => setPriorityDraft({ ...priorityDraft, [rule.id]: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter" && priorityChanged) void savePriority(rule); }}
                        aria-label={`Match priority for rule ${rule.name} (lower is matched first)`}
                      />
                      {priorityChanged ? (
                        <button className="button button-ghost" type="button" disabled={busy} onClick={() => void savePriority(rule)} aria-label={`Save priority for rule ${rule.name}`}>Save</button>
                      ) : null}
                      <button className="button button-ghost" type="button" disabled={busy} onClick={() => void removeRule(rule.id)} aria-label={`Delete ${rule.name}`}>Remove</button>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {rules.length > 0 ? (
            <p className={styles.w3Hint}>The number on each row is its match priority — lower is matched first. A disabled rule is kept but not applied, so its spend falls back to unallocated.</p>
          ) : null}
        </>
      )}
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* MSP margin                                                                  */
/* -------------------------------------------------------------------------- */

interface MarginRow {
  readonly customerId: string;
  readonly customerName: string;
  readonly currency: string;
  readonly costUnits: number;
  readonly markupPercent: number;
  readonly billedUnits: number;
  readonly marginUnits: number;
  readonly marginPercent: number | null;
  readonly hasRate: boolean;
}
interface MarginResponse {
  readonly rows: readonly MarginRow[];
  readonly totalsByCurrency: readonly { currency: string; totalCostUnits: number; totalBilledUnits: number; totalMarginUnits: number; blendedMarginPercent: number | null }[];
}

function MarginPanel() {
  const [data, setData] = useState<MarginResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<string, { markup: string; fee: string }>>({});
  /* Clearing a rate wipes a customer's markup and monthly fee — billing
   * configuration with no undo — so it is a two-step confirm, the same inline
   * pattern budget delete uses. A single customerId holds the pending row, so
   * only one row can be awaiting confirmation at a time. */
  const [pendingClear, setPendingClear] = useState<string | null>(null);
  const [clearing, setClearing] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await getJson<MarginResponse>(`/api/v1/finops/margin`));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load margin");
    }
  }, []);
  useEffect(() => {
    let active = true;
    getJson<MarginResponse>(`/api/v1/finops/margin`)
      .then((value) => { if (active) { setData(value); setError(null); } })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "Could not load margin"); });
    return () => { active = false; };
  }, []);

  async function saveRate(row: MarginRow): Promise<void> {
    const edit = draft[row.customerId];
    const markup = Number(edit?.markup ?? row.markupPercent);
    const feeUnits = Number(edit?.fee ?? "0");
    if (!Number.isFinite(markup) || markup < 0 || !Number.isFinite(feeUnits) || feeUnits < 0) {
      setError("Markup and fee must be non-negative numbers");
      return;
    }
    setBusy(true);
    try {
      await sendJson(`/api/v1/finops/margin`, "PUT", {
        customerId: row.customerId,
        markupPercent: markup,
        monthlyFeeMicros: String(Math.round(feeUnits * 1_000_000)),
        currency: row.currency,
      });
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save rate");
    } finally {
      setBusy(false);
    }
  }

  async function clearRate(row: MarginRow): Promise<void> {
    setError(null);
    setBusy(true);
    setClearing(row.customerId);
    try {
      await sendJson(`/api/v1/finops/margin?customerId=${encodeURIComponent(row.customerId)}`, "DELETE", {});
      setDraft((prev) => {
        const next = { ...prev };
        delete next[row.customerId];
        return next;
      });
      setPendingClear(null);
      await reload();
    } catch (caught) {
      // The confirm stays open on failure so the operator can retry; the real
      // API message is surfaced in the panel's alert.
      setError(caught instanceof Error ? caught.message : "Could not clear rate");
    } finally {
      setClearing(null);
      setBusy(false);
    }
  }

  return (
    <article className="panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Resale economics</p><h2>MSP margin per customer</h2></div>
        {data && data.totalsByCurrency[0] ? <span className="result-count">{data.totalsByCurrency[0].blendedMarginPercent === null ? "—" : `${Math.round(data.totalsByCurrency[0].blendedMarginPercent)}% blended`}</span> : null}
      </div>
      {error ? <p className={styles.emptyNote} role="alert">{error}</p> : null}
      {data === null ? <p className={styles.emptyNote}>Loading margin…</p>
        : data.rows.length === 0 ? <p className={styles.emptyNote}>No per-customer cloud cost is attributed for the latest billing period yet. Upload CUR/FOCUS billing files per connection to populate this view.</p>
        : (
          <div className={styles.marginTable} role="table" aria-label="Per-customer margin">
            <div className={`${styles.marginRow} ${styles.marginHead}`} role="row">
              <span>Customer</span><span>Cloud cost</span><span>Markup %</span><span>Fee</span><span>Billed</span><span>Margin</span><span aria-hidden="true" />
            </div>
            {data.rows.map((row) => {
              const edit = draft[row.customerId] ?? { markup: String(row.markupPercent), fee: "" };
              return (
                <div className={styles.marginRow} key={`${row.customerId}:${row.currency}`} role="row">
                  <span className={styles.marginName} data-label="Customer" title={row.customerId}>{row.customerName}</span>
                  <span data-label="Cloud cost">{money(row.costUnits, row.currency)}</span>
                  <span data-label="Markup %"><input className={styles.w3Mini} inputMode="decimal" value={edit.markup} onChange={(e) => setDraft({ ...draft, [row.customerId]: { ...edit, markup: e.target.value } })} aria-label={`Markup for ${row.customerName}`} /></span>
                  <span data-label="Monthly fee"><input className={styles.w3Mini} inputMode="decimal" placeholder="0" value={edit.fee} onChange={(e) => setDraft({ ...draft, [row.customerId]: { ...edit, fee: e.target.value } })} aria-label={`Monthly fee for ${row.customerName}`} /></span>
                  <span data-label="Billed">{money(row.billedUnits, row.currency)}</span>
                  <span className={row.marginUnits >= 0 ? styles.costDown : styles.costUp} data-label="Margin">{money(row.marginUnits, row.currency)}{row.marginPercent === null ? "" : ` (${Math.round(row.marginPercent)}%)`}</span>
                  <span className={styles.w3RowActions}>
                    <button className="button button-ghost" type="button" disabled={busy} onClick={() => void saveRate(row)} aria-label={`Save rate for ${row.customerName}`}>Save</button>
                    {row.hasRate ? (
                      pendingClear === row.customerId ? (
                        <span className={styles.w3ClearConfirm}>
                          <span className={styles.w3ClearPrompt} role="alert">
                            {clearing === row.customerId
                              ? `Clearing the rate for ${row.customerName}…`
                              : `Clear the markup and monthly fee for ${row.customerName}?`}
                          </span>
                          <button className="button button-ghost" type="button" disabled={busy} onClick={() => void clearRate(row)} aria-label={`Confirm clearing the configured rate for ${row.customerName}`}>{clearing === row.customerId ? "Clearing…" : "Confirm"}</button>
                          <button className="button button-ghost" type="button" disabled={busy} onClick={() => setPendingClear(null)} aria-label={`Keep the configured rate for ${row.customerName}`}>Cancel</button>
                        </span>
                      ) : (
                        <button className="button button-ghost" type="button" disabled={busy} onClick={() => { setError(null); setPendingClear(row.customerId); }} aria-label={`Clear configured rate for ${row.customerName}`}>Clear</button>
                      )
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      <p className={styles.emptyNote}>Billed = cloud cost × (1 + markup%) + fixed monthly fee. Currencies are never summed; a fee applies only in its own currency. Clear removes the stored rate for that customer — the row stays visible with billed = cloud cost and no margin, so an un-rated customer is disclosed rather than hidden.</p>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* Cost & budget alerts                                                        */
/* -------------------------------------------------------------------------- */

interface AlertItem {
  readonly id: string;
  readonly kind: string;
  readonly severity: "critical" | "high" | "medium" | "low";
  readonly title: string;
  readonly summary: string;
}
interface AlertDestination { readonly id: string; readonly channel: string; readonly displayName: string; }
interface AlertsResponse {
  readonly alerts: readonly AlertItem[];
  readonly counts: { readonly critical: number; readonly high: number; readonly medium: number; readonly low: number };
  readonly destinations: readonly AlertDestination[];
}

function AlertsPanel({ connectionId }: { connectionId: string }) {
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [destinationId, setDestinationId] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getJson<AlertsResponse>(`/api/v1/finops/alerts?connectionId=${encodeURIComponent(connectionId)}`)
      .then((value) => { if (active) { setData(value); setError(null); if (value.destinations[0]) setDestinationId((prev) => prev || value.destinations[0].id); } })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "Could not load alerts"); });
    return () => { active = false; };
  }, [connectionId]);

  async function send(): Promise<void> {
    if (destinationId.length === 0) return;
    setSending(true);
    setSent(null);
    try {
      const result = await sendJson<{ queued: number; queueFailures: number }>(`/api/v1/finops/alerts`, "POST", { connectionId, destinationId });
      setSent(`Queued ${result.queued} alert${result.queued === 1 ? "" : "s"}${result.queueFailures > 0 ? ` (${result.queueFailures} failed)` : ""} to the destination.`);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send alerts");
    } finally {
      setSending(false);
    }
  }

  const total = data ? data.alerts.length : 0;
  const destinations = data?.destinations ?? [];

  return (
    <article className="panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Spend spikes &amp; budget breaches</p><h2>Cost &amp; budget alerts</h2></div>
        <span className={`status-pill ${total > 0 ? "status-risk" : "status-positive"}`}>{total} active</span>
      </div>
      {error ? <p className={styles.emptyNote} role="alert">{error}</p> : null}
      {data === null ? <p className={styles.emptyNote}>Loading alerts…</p>
        : total === 0 ? <div className={styles.goodState}><b>✓</b><span><strong>No spend anomaly or budget breach detected</strong><small>Alerts fire when a service day exceeds 3× its trailing median, or a budget is projected to breach. Configured destinations are also swept automatically in the background.</small></span></div>
        : (
          <>
            <div className={styles.signalList}>
              {data.alerts.map((alert) => (
                <article key={alert.id}>
                  <span className={`${styles.severity} ${styles[alert.severity]}`}>{alert.severity}</span>
                  <div><h3>{alert.title}</h3><p>{alert.summary}</p><small>{alert.kind.replace(/_/g, " ")}</small></div>
                </article>
              ))}
            </div>
            <div className={styles.w3Form}>
              {destinations.length === 0 ? (
                <p className={styles.emptyNote}>Configure a notification destination in Settings → Notifications to send these alerts to Slack, PagerDuty, Teams, a webhook, or email.</p>
              ) : (
                <div className={styles.w3Grid}>
                  <select className={styles.w3Input} value={destinationId} onChange={(e) => setDestinationId(e.target.value)} aria-label="Notification destination">
                    {destinations.map((destination) => (
                      <option key={destination.id} value={destination.id}>{destination.displayName} ({destination.channel.replace(/_/g, " ")})</option>
                    ))}
                  </select>
                  <button className="button button-secondary" type="button" disabled={sending || destinationId.length === 0} onClick={() => void send()}>{sending ? "Sending…" : "Send now"}</button>
                </div>
              )}
              {sent ? <p className={styles.emptyNote}>{sent}</p> : null}
            </div>
          </>
        )}
    </article>
  );
}

/* -------------------------------------------------------------------------- */

export function FinopsWave3Panels({ connectionId }: { connectionId: string | null }) {
  if (connectionId === null) return null;
  return (
    <>
      <section className={styles.overviewGrid}>
        <AllocationPanel connectionId={connectionId} />
        <AlertsPanel connectionId={connectionId} />
      </section>
      <MarginPanel />
    </>
  );
}
