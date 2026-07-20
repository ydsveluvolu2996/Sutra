"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePortfolio } from "../components/use-portfolio";
import { readAuthResponse } from "../components/use-session";
import {
  ALERT_COMPARATORS,
  ALERT_METRIC_DESCRIPTORS,
  ALERT_SEVERITIES,
  type AlertComparator,
  type AlertMetricDescriptor,
  type AlertMetricKey,
  type AlertRule,
  type AlertSeverity,
} from "../../lib/alert-rules";

interface AlertEventView {
  readonly id: string;
  readonly ruleId: string;
  readonly firedAt: string;
  readonly observedValue: number;
  readonly message: string;
  readonly deliveryState: "queued" | "no_destination";
  readonly destinationCount: number;
}

interface AlertsWorkspace {
  readonly rules: readonly AlertRule[];
  readonly events: readonly AlertEventView[];
  readonly metrics: readonly AlertMetricDescriptor[];
}

const COMPARATOR_LABEL: Readonly<Record<AlertComparator, string>> = {
  gt: "greater than (>)",
  gte: "at least (>=)",
  lt: "less than (<)",
  lte: "at most (<=)",
  eq: "equal to (==)",
};

function metricLabel(metric: string): string {
  return ALERT_METRIC_DESCRIPTORS.find((entry) => entry.key === metric)?.label ?? metric;
}

export function AlertsPanel() {
  const { portfolio, loading: portfolioLoading, error: portfolioError } = usePortfolio();
  const [customerId, setCustomerId] = useState("");
  const [workspace, setWorkspace] = useState<AlertsWorkspace | null>(null);
  const [name, setName] = useState("");
  const [metric, setMetric] = useState<AlertMetricKey>("budget-breach-count");
  const [comparator, setComparator] = useState<AlertComparator>("gte");
  const [threshold, setThreshold] = useState("1");
  const [severity, setSeverity] = useState<AlertSeverity>("high");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedCustomerId = customerId || portfolio?.customers[0]?.id || "";

  const load = useCallback(async () => {
    if (selectedCustomerId === "") return;
    const query = new URLSearchParams({ customerId: selectedCustomerId });
    const response = await fetch(`/api/v1/alerts?${query}`, { cache: "no-store", credentials: "same-origin" });
    setWorkspace(await readAuthResponse<AlertsWorkspace>(response));
  }, [selectedCustomerId]);

  useEffect(() => {
    let active = true;
    if (selectedCustomerId === "") return;
    void (async () => {
      try {
        const query = new URLSearchParams({ customerId: selectedCustomerId });
        const response = await fetch(`/api/v1/alerts?${query}`, { cache: "no-store", credentials: "same-origin" });
        const loaded = await readAuthResponse<AlertsWorkspace>(response);
        if (active) setWorkspace(loaded);
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "Sutra could not load alert rules");
      }
    })();
    return () => { active = false; };
  }, [selectedCustomerId]);

  const ruleNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const rule of workspace?.rules ?? []) map.set(rule.id, rule.name);
    return map;
  }, [workspace]);

  const activeDescriptor = ALERT_METRIC_DESCRIPTORS.find((entry) => entry.key === metric);

  async function save(): Promise<void> {
    if (selectedCustomerId === "") return;
    const parsedThreshold = Number(threshold);
    if (!Number.isFinite(parsedThreshold)) {
      setError("Enter a numeric threshold.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/v1/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          operation: "save",
          customerId: selectedCustomerId,
          rule: {
            name: name.trim(),
            metric,
            comparator,
            threshold: parsedThreshold,
            severity,
            enabled: true,
            destinationRef: null,
          },
        }),
      });
      await readAuthResponse(response);
      setName("");
      setNotice("Rule saved.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The alert rule was rejected");
    } finally {
      setBusy(false);
    }
  }

  async function setEnabled(id: string, enabled: boolean): Promise<void> {
    try {
      const response = await fetch("/api/v1/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ operation: "setEnabled", customerId: selectedCustomerId, id, enabled }),
      });
      await readAuthResponse(response);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The rule could not be updated");
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      const query = new URLSearchParams({ customerId: selectedCustomerId, id });
      const response = await fetch(`/api/v1/alerts?${query}`, { method: "DELETE", credentials: "same-origin" });
      await readAuthResponse(response);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The rule could not be deleted");
    }
  }

  return (
    <div className="page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Alerting</p>
          <h1>Metric alerts</h1>
          <p>Fire notifications when a signal Sutra already computes crosses a threshold. A rule is evaluated on the background tick and dispatched through your existing notification destinations. A metric that is unavailable is disclosed and never fires.</p>
        </div>
      </header>

      {(error ?? portfolioError) ? (
        <div className="page-alert page-alert-error" role="alert"><strong>Problem</strong><span>{error ?? portfolioError}</span></div>
      ) : null}
      {notice ? <div className="page-alert" role="status"><strong>Saved</strong><span>{notice}</span></div> : null}

      <section className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Scope</p><h2>Select a managed customer</h2></div>
          <span className="status-pill">{portfolio?.customers.length ?? 0} accessible</span>
        </div>
        <label className="auth-form">
          <span>Customer</span>
          <select disabled={portfolioLoading} value={selectedCustomerId} onChange={(event) => setCustomerId(event.target.value)}>
            {(portfolio?.customers ?? []).map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.name}</option>
            ))}
          </select>
        </label>
      </section>

      <section className="panel" aria-label="Create alert rule">
        <div className="panel-heading">
          <div><p className="eyebrow">New rule</p><h2>Create or update a rule</h2></div>
        </div>
        <div className="cmdbq-row">
          <input aria-label="Rule name" placeholder="rule name" value={name} onChange={(event) => setName(event.target.value)} />
          <select aria-label="Metric" value={metric} onChange={(event) => setMetric(event.target.value as AlertMetricKey)}>
            {ALERT_METRIC_DESCRIPTORS.map((entry) => (
              <option key={entry.key} value={entry.key}>{entry.label}</option>
            ))}
          </select>
          <select aria-label="Comparator" value={comparator} onChange={(event) => setComparator(event.target.value as AlertComparator)}>
            {ALERT_COMPARATORS.map((value) => (
              <option key={value} value={value}>{COMPARATOR_LABEL[value]}</option>
            ))}
          </select>
          <input aria-label="Threshold" type="number" step="any" placeholder="threshold" value={threshold} onChange={(event) => setThreshold(event.target.value)} />
          <select aria-label="Severity" value={severity} onChange={(event) => setSeverity(event.target.value as AlertSeverity)}>
            {ALERT_SEVERITIES.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
          <button type="button" className="button button-primary" disabled={busy || name.trim().length === 0 || selectedCustomerId === ""} onClick={() => void save()}>
            {busy ? "Saving…" : "Save rule"}
          </button>
        </div>
        {activeDescriptor ? <p className="panel-footnote">{activeDescriptor.description}</p> : null}
        <p className="panel-footnote">A fired rule dispatches to every enabled notification destination for this customer. With no destination configured the firing is recorded but marked not delivered.</p>
      </section>

      <section className="panel" aria-label="Alert rules">
        <div className="panel-heading">
          <div><p className="eyebrow">Rules</p><h2>Configured alert rules</h2></div>
        </div>
        {(workspace?.rules.length ?? 0) === 0 ? (
          <p className="panel-footnote">No alert rules are configured for this customer yet.</p>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Metric</th><th>Condition</th><th>Severity</th><th>Status</th><th /></tr></thead>
            <tbody>{(workspace?.rules ?? []).map((rule) => (
              <tr key={rule.id}>
                <td>{rule.name}</td>
                <td>{metricLabel(rule.metric)}</td>
                <td><code>{COMPARATOR_LABEL[rule.comparator]} {rule.threshold}</code></td>
                <td>{rule.severity}</td>
                <td>{rule.enabled ? "Enabled" : "Disabled"}</td>
                <td className="cmdbq-actions">
                  <button type="button" className="button button-secondary" onClick={() => void setEnabled(rule.id, !rule.enabled)}>
                    {rule.enabled ? "Disable" : "Enable"}
                  </button>
                  <button type="button" className="button button-secondary" onClick={() => void remove(rule.id)}>Delete</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section className="panel" aria-label="Recent firings">
        <div className="panel-heading">
          <div><p className="eyebrow">Activity</p><h2>Recent firings</h2></div>
        </div>
        {(workspace?.events.length ?? 0) === 0 ? (
          <p className="panel-footnote">No alerts have fired for this customer yet.</p>
        ) : (
          <table>
            <thead><tr><th>Fired at</th><th>Rule</th><th>Observed</th><th>Delivery</th><th>Detail</th></tr></thead>
            <tbody>{(workspace?.events ?? []).map((event) => (
              <tr key={event.id}>
                <td>{new Date(event.firedAt).toLocaleString()}</td>
                <td>{ruleNameById.get(event.ruleId) ?? event.ruleId}</td>
                <td>{event.observedValue}</td>
                <td>{event.deliveryState === "queued" ? `Queued to ${event.destinationCount} destination(s)` : "Recorded — no destination"}</td>
                <td>{event.message}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}
