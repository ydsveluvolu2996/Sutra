"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { usePortfolio } from "../../components/use-portfolio";
import { readAuthResponse } from "../../components/use-session";
import type {
  NotificationDestination,
  NotificationOutboxJob,
} from "../../../lib/notification-destination-types";
import type { NotificationDeliveryHealth } from "../../../lib/notification-delivery-health";

interface Workspace {
  readonly destinations: readonly NotificationDestination[];
  readonly jobs: readonly NotificationOutboxJob[];
  readonly worker: { readonly configured: boolean; readonly message: string };
  readonly health: NotificationDeliveryHealth;
}

function idempotencyKey(): string {
  return `notification-test-${crypto.randomUUID()}`;
}

export function NotificationSettingsBrowser() {
  const { portfolio, loading: portfolioLoading, error: portfolioError } = usePortfolio();
  const [customerId, setCustomerId] = useState("");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [channel, setChannel] = useState<NotificationDestination["channel"]>("email");
  const [displayName, setDisplayName] = useState("Security alerts");
  const [enabled, setEnabled] = useState(true);
  const [recipients, setRecipients] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [sesRegion, setSesRegion] = useState("ap-south-1");
  const [secretReference, setSecretReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedCustomerId = customerId || portfolio?.customers[0]?.id || "";

  const load = useCallback(async () => {
    if (selectedCustomerId === "") return;
    const query = new URLSearchParams({ customerId: selectedCustomerId });
    const response = await fetch(`/api/v1/notification-destinations?${query}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    setWorkspace(await readAuthResponse<Workspace>(response));
  }, [selectedCustomerId]);

  useEffect(() => {
    let active = true;
    if (selectedCustomerId === "") return;
    void fetch(`/api/v1/notification-destinations?${new URLSearchParams({ customerId: selectedCustomerId })}`, {
      cache: "no-store",
      credentials: "same-origin",
    }).then((response) => readAuthResponse<Workspace>(response))
      .then((loaded) => { if (active) setWorkspace(loaded); })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Sutra could not load notification destinations");
      });
    return () => { active = false; };
  }, [selectedCustomerId]);

  const existing = useMemo(
    () => workspace?.destinations.find((destination) => destination.channel === channel),
    [channel, workspace],
  );

  useEffect(() => {
    if (existing === undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Channel selection resets this controlled configuration form.
      setDisplayName(
        channel === "email" ? "Security email alerts"
          : channel === "slack" ? "Security Slack alerts"
          : channel === "microsoft_teams" ? "Security Teams alerts"
          : "Security ticket webhook",
      );
      setEnabled(true);
      setRecipients("");
      setFromAddress("");
      setSecretReference("");
      return;
    }
    setDisplayName(existing.displayName);
    setEnabled(existing.enabled);
    if (existing.configuration.channel === "email") {
      setRecipients(existing.configuration.recipients.join(", "));
      setFromAddress(existing.configuration.fromAddress);
      setSesRegion(existing.configuration.sesRegion);
    } else {
      setSecretReference(existing.configuration.secretReference);
    }
  }, [channel, existing]);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (selectedCustomerId === "") return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const configuration = channel === "email"
        ? {
            channel,
            recipients: recipients.split(",").map((item) => item.trim()).filter(Boolean),
            fromAddress,
            sesRegion,
          }
        : { channel, secretReference };
      const response = await fetch("/api/v1/notification-destinations", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "save",
          customerId: selectedCustomerId,
          displayName,
          enabled,
          configuration,
        }),
      });
      await readAuthResponse<{ destination: NotificationDestination }>(response);
      setNotice("Destination configuration saved. No provider call was made.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not save the destination");
    } finally {
      setBusy(false);
    }
  }

  async function queueTest(destination: NotificationDestination): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/v1/notification-destinations", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "test",
          customerId: selectedCustomerId,
          destinationId: destination.id,
          idempotencyKey: idempotencyKey(),
        }),
      });
      await readAuthResponse<{ job: NotificationOutboxJob }>(response);
      setNotice("Test notification queued durably. The web request did not contact the provider.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not queue the test");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Tenant notification routing</p>
          <h1>Notification destinations</h1>
          <p className="page-subtitle">
            Configure customer-scoped email, Slack, Microsoft Teams, and generic ticketing-webhook delivery (Jira, ServiceNow, PagerDuty) without exposing provider secrets to the browser or database.
          </p>
        </div>
      </section>

      <div className="trust-strip" role="note">
        <span className="trust-icon">✓</span>
        <span>
          <strong>Queued delivery only.</strong> Web requests persist a bounded job. A separate worker resolves managed secrets and workload IAM before contacting a provider.
        </span>
      </div>

      {portfolioError || error ? (
        <div className="page-alert page-alert-error" role="alert">
          <strong>Notification configuration failed</strong>
          <span>{error ?? portfolioError}</span>
        </div>
      ) : null}
      {notice ? <div className="page-alert" role="status"><strong>Saved</strong><span>{notice}</span></div> : null}

      <section className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Scope</p><h2>Select a managed customer</h2></div>
          <span className="status-pill">{portfolio?.customers.length ?? 0} accessible</span>
        </div>
        <label className="auth-form">
          <span>Customer</span>
          <select
            disabled={portfolioLoading}
            value={selectedCustomerId}
            onChange={(event) => setCustomerId(event.target.value)}
          >
            {(portfolio?.customers ?? []).map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.name}</option>
            ))}
          </select>
        </label>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Destination</p><h2>Email and collaboration routing</h2></div>
          <span className={`status-pill ${workspace?.worker.configured ? "status-positive" : ""}`}>
            {workspace?.worker.configured ? "Worker ready" : "Worker adapter required"}
          </span>
        </div>
        <p className="limitation-note">{workspace?.worker.message}</p>
        {workspace?.health ? (
          <div className="report-metrics" aria-label="Notification delivery health">
            <div><small>Delivery health</small><strong>{workspace.health.state.replaceAll("_", " ")}</strong><span>{workspace.health.message}</span></div>
            <div><small>Enabled routes</small><strong>{workspace.health.enabledDestinations}</strong><span>{workspace.health.configuredDestinations} adapter-ready</span></div>
            <div><small>Actionable queue</small><strong>{workspace.health.queued + workspace.health.processing + workspace.health.retrying}</strong><span>{workspace.health.oldestActionableAgeSeconds === null ? "No queued work" : `Oldest ${workspace.health.oldestActionableAgeSeconds}s`}</span></div>
            <div><small>Delivery failures</small><strong>{workspace.health.deadLetter}</strong><span>{workspace.health.retrying} retrying · {workspace.health.adapterMissing} adapter-blocked</span></div>
          </div>
        ) : null}
        <form className="auth-form" onSubmit={(event) => void save(event)}>
          <div className="auth-field-pair">
            <label>
              <span>Channel</span>
              <select value={channel} onChange={(event) => setChannel(event.target.value as NotificationDestination["channel"])}>
                <option value="email">Amazon SES email</option>
                <option value="slack">Slack Incoming Webhook</option>
                <option value="microsoft_teams">Microsoft Teams Workflow</option>
                <option value="generic_webhook">Generic ticketing webhook (Jira / ServiceNow / PagerDuty)</option>
              </select>
            </label>
            <label>
              <span>Display name</span>
              <input required maxLength={100} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </label>
          </div>
          {channel === "email" ? (
            <>
              <label>
                <span>Recipients, comma separated</span>
                <input required maxLength={2_000} value={recipients} onChange={(event) => setRecipients(event.target.value)} placeholder="security@example.com" />
              </label>
              <div className="auth-field-pair">
                <label>
                  <span>Verified SES sender</span>
                  <input required type="email" maxLength={254} value={fromAddress} onChange={(event) => setFromAddress(event.target.value)} placeholder="alerts@example.com" />
                </label>
                <label>
                  <span>SES region</span>
                  <input required maxLength={32} value={sesRegion} onChange={(event) => setSesRegion(event.target.value)} />
                </label>
              </div>
            </>
          ) : (
            <label>
              <span>Managed secret reference</span>
              <input
                required
                maxLength={199}
                pattern="secret://[A-Za-z0-9][A-Za-z0-9._/-]{2,190}"
                value={secretReference}
                onChange={(event) => setSecretReference(event.target.value)}
                placeholder={`secret://notifications/<org>/<customer>/${channel}/primary`}
              />
              <small>
                Enter an opaque secret reference only. Sutra rejects raw webhook URLs.
                {channel === "generic_webhook"
                  ? " The worker POSTs a stable sutra.ticket.v1 JSON envelope to the webhook URL held in this managed secret."
                  : ""}
              </small>
            </label>
          )}
          <label>
            <span><input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" /> Enable this destination</span>
          </label>
          <button className="button button-primary" disabled={busy || selectedCustomerId === ""} type="submit">
            {busy ? "Saving…" : existing === undefined ? "Create destination" : "Update destination"}
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Configured routes</p><h2>Customer destinations</h2></div>
          <span className="status-pill">{workspace?.destinations.length ?? 0} configured</span>
        </div>
        <div className="data-table">
          <div className="data-row data-header"><span>Channel</span><span>Name</span><span>State</span><span>Readiness</span><span>Action</span></div>
          {(workspace?.destinations ?? []).map((destination) => (
            <div className="data-row" key={destination.id}>
              <span className="primary-cell"><strong>{destination.channel.replaceAll("_", " ")}</strong><small>{destination.id}</small></span>
              <span>{destination.displayName}</span>
              <span><span className={`connection-status connection-${destination.enabled ? "active" : "disabled"}`}>{destination.enabled ? "enabled" : "disabled"}</span></span>
              <span>{destination.deliveryReadiness.replaceAll("_", " ")}</span>
              <span><button className="button button-ghost" disabled={busy || !destination.enabled} onClick={() => void queueTest(destination)} type="button">Queue test</button></span>
            </div>
          ))}
          {(workspace?.destinations.length ?? 0) === 0 ? <div className="empty-row">No notification destinations configured for this customer.</div> : null}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Durable outbox</p><h2>Recent delivery jobs</h2></div>
          <span className="status-pill">{workspace?.jobs.length ?? 0} recorded</span>
        </div>
        <div className="data-table">
          <div className="data-row data-header"><span>Created</span><span>Channel</span><span>Status</span><span>Attempts</span><span>Result</span></div>
          {(workspace?.jobs ?? []).map((job) => (
            <div className="data-row" key={job.id}>
              <span className="primary-cell"><strong>{new Date(job.createdAt).toLocaleString()}</strong><small>{job.id}</small></span>
              <span>{job.channel.replaceAll("_", " ")}</span>
              <span><span className={`connection-status connection-${job.status === "delivered" ? "active" : job.status === "dead_letter" ? "disabled" : "pending"}`}>{job.status.replaceAll("_", " ")}</span></span>
              <span>{job.attemptCount}</span>
              <span>{job.lastErrorCode?.replaceAll("_", " ") ?? "Awaiting worker"}</span>
            </div>
          ))}
          {(workspace?.jobs.length ?? 0) === 0 ? <div className="empty-row">No notification jobs have been queued.</div> : null}
        </div>
      </section>
    </>
  );
}
