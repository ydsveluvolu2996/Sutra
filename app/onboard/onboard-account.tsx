"use client";

import { FormEvent, useMemo, useState } from "react";
import type { CollectorHealth, PilotConnection } from "../../lib/pilot-types";
import { formatTimestamp, postPilot, usePilotState } from "../components/use-pilot-state";

interface CreateConnectionResponse {
  readonly connection: PilotConnection;
  readonly trust: {
    readonly externalId: string;
    readonly vendorCollectorRoleArn: string;
    readonly sessionNamePrefix: string;
    readonly customerTenantId: string;
    readonly roleName: string;
  };
  readonly collector: CollectorHealth;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Sutra could not complete onboarding";
}

function arnPartition(partition: string): string {
  return partition === "aws-cn" ? "aws-cn" : partition === "aws-us-gov" ? "aws-us-gov" : "aws";
}

export function OnboardAccount() {
  const { state, health, loading, refresh } = usePilotState();
  const [customerName, setCustomerName] = useState("Pilot Customer");
  const [accountId, setAccountId] = useState("123456789012");
  const [partition, setPartition] = useState("aws");
  const [regions, setRegions] = useState("us-east-1, ap-south-1");
  const [roleArn, setRoleArn] = useState("");
  const [created, setCreated] = useState<CreateConnectionResponse | null>(null);
  const [busy, setBusy] = useState<"create" | "role" | "validate" | "sync" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedConnection = state?.connection ?? created?.connection ?? null;
  const connection = selectedConnection?.sourceKind === "aws_trust_role" ? selectedConnection : null;
  const effectiveRoleArn = roleArn || connection?.roleArn || "";
  const arnAccount = useMemo(() => effectiveRoleArn.match(/^arn:(?:aws|aws-us-gov|aws-cn):iam::(\d{12}):role\/[A-Za-z0-9+=,.@_\/-]+$/u)?.[1], [effectiveRoleArn]);
  const accountValid = /^\d{12}$/u.test(accountId);
  const roleValid = Boolean(arnAccount && connection && arnAccount === connection.awsAccountId);
  const currentStep = connection?.status === "active" ? (state?.activeSnapshot ? 4 : 3) : connection?.roleArn ? 3 : connection ? 2 : 1;

  async function createConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create");
    setError(null);
    setNotice(null);
    try {
      const response = await postPilot<CreateConnectionResponse>("/api/pilot/connections", {
        customerName,
        awsAccountId: accountId,
        partition,
        enabledRegions: regions.split(",").map((region) => region.trim()).filter(Boolean),
      });
      setCreated(response);
      setRoleArn(`arn:${arnPartition(response.connection.partition)}:iam::${response.connection.awsAccountId}:role/sutra/SutraReadOnlyRole`);
      setNotice("Connection contract created. Copy the ExternalId now, then deploy the customer-owned role.");
      await refresh();
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy(null);
    }
  }

  async function registerRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connection) return;
    setBusy("role");
    setError(null);
    setNotice(null);
    try {
      const response = await postPilot<{ connection: PilotConnection }>("/api/pilot/connections/role", {
        connectionId: connection.id,
        roleArn: effectiveRoleArn,
      });
      if (created) setCreated({ ...created, connection: response.connection });
      setNotice("Role registered. Sutra is ready to prove the trust policy behavior.");
      await refresh();
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy(null);
    }
  }

  async function validateAndSync() {
    if (!connection) return;
    setBusy("validate");
    setError(null);
    setNotice(null);
    try {
      await postPilot("/api/pilot/connections/validate", { connectionId: connection.id });
      await refresh();
      setBusy("sync");
      await postPilot("/api/pilot/connections/sync", { connectionId: connection.id });
      setNotice("Trust validation passed and the first complete CMDB snapshot was published.");
      await refresh();
    } catch (caught) {
      setError(messageFrom(caught));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function runSync() {
    if (!connection) return;
    setBusy("sync");
    setError(null);
    setNotice(null);
    try {
      await postPilot("/api/pilot/connections/sync", { connectionId: connection.id });
      setNotice("Inventory collection finished. The latest complete snapshot is now active.");
      await refresh();
    } catch (caught) {
      setError(messageFrom(caught));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  const collectorMode = created?.collector.mode ?? health?.mode;
  const principalArn = created?.trust.vendorCollectorRoleArn ?? health?.principalArn;

  return (
    <>
      <section className="page-heading onboard-heading">
        <div><p className="eyebrow">Secure AWS connection</p><h1>Onboard one AWS account</h1><p className="page-subtitle">Create a customer-owned read-only role, prove the ExternalId boundary, then publish a complete CMDB snapshot.</p></div>
        <span className={`status-pill ${collectorMode === "live" ? "status-positive" : "status-medium"}`}>{collectorMode === "live" ? "Live collector" : collectorMode === "fixture" ? "Simulations only" : "Collector checking"}</span>
      </section>

      <div className="onboard-layout">
        <section className="panel onboard-panel">
          <div className="stepper" aria-label="Onboarding steps">
            {["Connection", "Deploy role", "Validate trust", "Inventory"].map((label, index) => {
              const step = index + 1;
              return <span key={label} className={step === currentStep ? "active" : step < currentStep ? "complete" : undefined}><b>{step < currentStep ? "✓" : step}</b>{label}</span>;
            })}
          </div>

          {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Checking the local pilot workspace…</div> : null}

          {!loading && !connection && collectorMode !== "live" ? (
            <div className="onboard-copy"><p className="eyebrow">Local-only safety boundary</p><h2>AWS trust onboarding is disabled</h2><p>The collector is running in deterministic fixture mode, so Sutra will not create a trust-role connection or contact AWS. Use Simulation runs to exercise the durable queue, CMDB, change history, findings, and exports with clearly labelled local evidence.</p><a className="button button-primary" href="/operations">Open Simulation runs</a></div>
          ) : null}

          {!loading && !connection && collectorMode === "live" ? (
            <>
              <div className="onboard-copy"><p className="eyebrow">Step 1 of 4</p><h2>Create the connection contract</h2><p>Sutra binds a platform-generated ExternalId to this customer and account. The ExternalId is returned once for the CloudFormation handoff.</p></div>
              <form className="onboard-form" onSubmit={createConnection}>
                <label><span>Customer workspace</span><input value={customerName} maxLength={80} onChange={(event) => setCustomerName(event.target.value)} required /><small>This local pilot supports one customer and one AWS account.</small></label>
                <div className="form-grid">
                  <label><span>AWS account ID</span><input inputMode="numeric" maxLength={12} value={accountId} onChange={(event) => setAccountId(event.target.value.replace(/\D/gu, ""))} aria-invalid={accountId.length > 0 && !accountValid} required /><small>{health?.mode === "fixture" ? "Fixture mode expects 123456789012." : "Exactly 12 digits from the client AWS account."}</small></label>
                  <label><span>AWS partition</span><select value={partition} onChange={(event) => setPartition(event.target.value)}><option value="aws">Commercial (aws)</option><option value="aws-us-gov">GovCloud</option><option value="aws-cn">China</option></select><small>The collector principal and role must use the same partition.</small></label>
                </div>
                <label><span>Enabled regions</span><input value={regions} onChange={(event) => setRegions(event.target.value)} placeholder="us-east-1, ap-south-1" required /><small>Comma-separated AWS regions. Global IAM and S3 inventory are collected once.</small></label>
                <button className="button button-primary onboard-submit" type="submit" disabled={!accountValid || customerName.trim().length < 2 || busy !== null}>{busy === "create" ? "Creating secure contract…" : "Create connection contract"}</button>
              </form>
            </>
          ) : null}

          {connection ? (
            <>
              <div className="onboard-copy"><p className="eyebrow">Step 2 of 4</p><h2>Deploy and register the customer role</h2><p>Use the exact collector principal and ExternalId below as CloudFormation parameters. Sutra never creates or stores long-lived customer access keys.</p></div>
              <div className="connection-contract" aria-label="AWS connection contract">
                <div><small>Customer</small><strong>{connection.customerName}</strong><span>{connection.awsAccountId} · {connection.partition}</span></div>
                <div><small>Regions</small><strong>{connection.enabledRegions.length}</strong><span>{connection.enabledRegions.join(", ")}</span></div>
                <div><small>Status</small><strong className={`connection-status connection-${connection.status}`}>{connection.status.replace("_", " ")}</strong><span>Validated {formatTimestamp(connection.lastValidatedAt)}</span></div>
              </div>

              {created?.trust.externalId ? <label className="contract-field"><span>One-time ExternalId</span><div className="copy-field"><code>{created.trust.externalId}</code><button type="button" onClick={() => void navigator.clipboard?.writeText(created.trust.externalId)}>Copy</button></div><small>Copy this now. Sutra stores only an encrypted server-side value and does not show it again after a reload.</small></label> : <div className="inline-warning"><strong>ExternalId is no longer displayed.</strong><span>If you already deployed the role, continue with its ARN. This pilot intentionally does not expose stored trust material.</span></div>}

              <div className="deployment-parameters" aria-label="CloudFormation trust parameters">
                <div><small>SessionNamePrefix</small><code>{created?.trust.sessionNamePrefix ?? "sutra-"}</code></div>
                <div><small>CustomerTenantId</small><code>{created?.trust.customerTenantId ?? connection.customerId}</code></div>
                <div><small>RoleName</small><code>{created?.trust.roleName ?? "SutraReadOnlyRole"}</code></div>
              </div>

              <label className="contract-field"><span>Exact collector principal</span><div className="copy-field"><code>{principalArn ?? "Collector principal unavailable"}</code><button type="button" disabled={!principalArn} onClick={() => principalArn && void navigator.clipboard?.writeText(principalArn)}>Copy</button></div></label>

              <div className="template-actions"><a className="button button-secondary" href="/sutra-customer-role.yaml" download>Download CloudFormation</a><span>Deploy with <code>CAPABILITY_NAMED_IAM</code>. The template reads metadata only and never enables AWS security services.</span></div>

              <form className="onboard-form role-registration" onSubmit={registerRole}>
                <label><span>Customer role ARN</span><input value={effectiveRoleArn} onChange={(event) => setRoleArn(event.target.value.trim())} placeholder={`arn:${connection.partition}:iam::${connection.awsAccountId}:role/sutra/SutraReadOnlyRole`} aria-invalid={effectiveRoleArn.length > 0 && !roleValid} required /><small>{effectiveRoleArn.length === 0 ? "Paste the CloudFormation output after the stack completes." : !roleValid ? "Use a canonical IAM role ARN from the connected account." : "Role ARN syntax and account binding match."}</small></label>
                <button className="button button-secondary onboard-submit" type="submit" disabled={!roleValid || busy !== null || collectorMode !== "live"}>{busy === "role" ? "Registering role…" : collectorMode === "live" ? connection.roleArn ? "Update registered role" : "Register customer role" : "Live collector required"}</button>
              </form>

              <div className="onboard-validation-action">
                <div><p className="eyebrow">Step 3 of 4</p><h2>Prove the trust boundary</h2><p>Sutra checks the expected caller identity and confirms missing or incorrect ExternalIds cannot assume the role.</p></div>
                {connection.status === "active" ? <button className="button button-primary" type="button" disabled={busy !== null || collectorMode !== "live"} onClick={() => void runSync()}>{busy === "sync" ? "Collecting AWS metadata…" : collectorMode === "live" ? "Run inventory sync" : "Live collector required"}</button> : <button className="button button-primary" type="button" disabled={!connection.roleArn || busy !== null || collectorMode !== "live"} onClick={() => void validateAndSync()}>{busy === "validate" ? "Validating trust…" : busy === "sync" ? "Publishing first snapshot…" : collectorMode === "live" ? "Validate trust & run first sync" : "Live collector required"}</button>}
              </div>
            </>
          ) : null}

          {notice ? <div className="validation-result" role="status"><span>✓</span><div><strong>Onboarding advanced</strong><p>{notice}</p></div></div> : null}
          {error ? <div className="validation-result validation-error" role="alert"><span>!</span><div><strong>Action needs attention</strong><p>{error}</p></div></div> : null}
        </section>

        <aside className="onboard-aside">
          <section className="panel"><p className="eyebrow">Trust checklist</p><h2>Customer stays in control</h2><ul className="check-list compact"><li><span>✓</span>Exact collector workload-role principal</li><li><span>✓</span>Unique ExternalId condition</li><li><span>✓</span>Metadata-only permissions</li><li><span>✓</span>Maximum one-hour STS session</li><li><span>✓</span>No S3 objects, secrets, KMS decrypt, or mutations</li></ul></section>
          <section className="panel aside-warning"><p className="eyebrow">Collector mode</p><h2>{collectorMode === "live" ? "Connected to AWS" : collectorMode === "fixture" ? "Safe fixture environment" : "Collector unavailable"}</h2><p>{collectorMode === "live" ? "Validation and inventory use the configured AWS workload identity. AWS permissions and service availability determine coverage." : collectorMode === "fixture" ? "Fixture mode uses the dedicated Simulation runs workflow and cannot create or synchronize AWS trust connections. Every resulting snapshot is labelled as simulated evidence." : "Start the local collector before creating, validating, or synchronizing an AWS connection. Stored complete snapshots remain readable while it is offline."}</p></section>
          <section className="panel data-path-card"><p className="eyebrow">Credential path</p><ol><li><b>1</b>Signed scoped job</li><li><b>2</b>Collector workload identity</li><li><b>3</b>STS AssumeRole</li><li><b>4</b>Temporary in-memory credentials</li><li><b>5</b>Validated normalized evidence</li></ol></section>
        </aside>
      </div>
    </>
  );
}
