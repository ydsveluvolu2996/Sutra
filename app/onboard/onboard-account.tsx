"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  describeLatestCollection,
  describeLiveSyncFailure,
  describeLiveSyncResult,
  describeTrustHealth,
} from "../../lib/live-sync-presentation";
import {
  AWS_CUSTOMER_ROLE_TEMPLATE_PATH,
  AWS_CUSTOMER_ROLE_TEMPLATE_SHA256,
  AWS_CUSTOMER_ROLE_TEMPLATE_VERSION,
} from "../../lib/aws-template-contract";
import {
  buildOneTimeCloudFormationQuickCreateUrl,
  selectCommercialQuickCreateRegion,
} from "../../lib/aws-cloudformation-quick-launch";
import {
  ALL_ENABLED_AWS_REGIONS,
  isAllEnabledAwsRegionSelection,
  type AwsRegionSelectionMode,
} from "../../lib/aws-region-selection.ts";
import {
  buildCustomerManagedRoleArtifacts,
  SUTRA_CUSTOM_ROLE_DEFAULT_NAME,
  SUTRA_ROLE_NAMESPACE,
  SUTRA_TEMPLATE_ROLE_NAME,
  validateCustomerManagedRoleSelection,
  type AwsRoleProvisioningMode,
} from "../../lib/aws-customer-role-artifacts";
import type { CollectorHealth, PilotConnection, PilotState } from "../../lib/pilot-types";
import { formatTimestamp, postPilot, usePilotState } from "../components/use-pilot-state";
import { useSession } from "../components/use-session";

interface CreateConnectionResponse {
  readonly connection: PilotConnection;
  readonly handoff: { readonly recovered: boolean };
  readonly trust: {
    readonly externalId: string;
    readonly collectorPrincipal?: string;
    readonly vendorCollectorRoleArn?: string;
    readonly roleSessionName?: string;
    readonly sessionNamePrefix?: string;
    readonly customerTenantId: string;
    readonly permissionPackVersion?: string;
    readonly roleProvisioningMode: AwsRoleProvisioningMode;
    readonly rolePath: string;
    readonly roleName: string;
  };
  readonly deployment: { readonly publicTemplateUrl: string | null };
  readonly collector: CollectorHealth;
}

interface PendingHandoffDraft {
  readonly operationId: string;
  readonly customerName: string;
  readonly awsAccountId: string;
  readonly partition: string;
  readonly enabledRegions: readonly string[];
  readonly roleProvisioningMode: AwsRoleProvisioningMode;
  readonly rolePath: string;
  readonly roleName: string;
}

interface LiveSyncResponse {
  readonly runId: string;
  readonly state: PilotState;
}

interface ConnectionLifecycleResponse {
  readonly collectorCleanup: "completed" | "pending";
  readonly customerIamRoleRevocationRequired?: true;
}

interface ActionNotice {
  readonly tone: "success" | "warning";
  readonly title: string;
  readonly message: string;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Sutra could not complete onboarding";
}

function arnPartition(partition: string): string {
  return partition === "aws-cn" ? "aws-cn" : partition === "aws-us-gov" ? "aws-us-gov" : "aws";
}

function expectedRoleArn(response: CreateConnectionResponse): string {
  return `arn:${arnPartition(response.connection.partition)}:iam::${response.connection.awsAccountId}:role/${response.trust.rolePath.slice(1)}${response.trust.roleName}`;
}

function downloadSensitiveArtifact(filename: string, contents: string, mimeType: string): void {
  const objectUrl = URL.createObjectURL(new Blob([contents], { type: mimeType }));
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

const HANDOFF_STORAGE_KEY = "sutra.aws-onboarding-handoffs.v1";

function readHandoffDrafts(): PendingHandoffDraft[] {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(HANDOFF_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    const drafts: PendingHandoffDraft[] = [];
    for (const candidate of value) {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
      const draft = candidate as Record<string, unknown>;
      if (!(typeof draft.operationId === "string" && /^onb_[a-f0-9]{32}$/u.test(draft.operationId) &&
        typeof draft.customerName === "string" && typeof draft.awsAccountId === "string" &&
        typeof draft.partition === "string" && Array.isArray(draft.enabledRegions) &&
        draft.enabledRegions.every((region) => typeof region === "string"))) continue;
      const roleProvisioningMode = draft.roleProvisioningMode === "customer_managed"
        ? "customer_managed"
        : "sutra_template";
      const rolePath = typeof draft.rolePath === "string" ? draft.rolePath : SUTRA_ROLE_NAMESPACE;
      const roleName = typeof draft.roleName === "string"
        ? draft.roleName
        : roleProvisioningMode === "customer_managed"
          ? SUTRA_CUSTOM_ROLE_DEFAULT_NAME
          : SUTRA_TEMPLATE_ROLE_NAME;
      drafts.push({
        operationId: draft.operationId,
        customerName: draft.customerName,
        awsAccountId: draft.awsAccountId,
        partition: draft.partition,
        enabledRegions: draft.enabledRegions as string[],
        roleProvisioningMode,
        rolePath,
        roleName,
      });
    }
    return drafts.slice(-5);
  } catch {
    return [];
  }
}

function storeHandoffDraft(draft: PendingHandoffDraft): boolean {
  try {
    const retained = readHandoffDrafts().filter((candidate) => candidate.operationId !== draft.operationId);
    window.sessionStorage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify([...retained, draft].slice(-5)));
    return true;
  } catch {
    return false;
  }
}

function forgetHandoffDraft(operationId: string): void {
  try {
    const retained = readHandoffDrafts().filter((candidate) => candidate.operationId !== operationId);
    if (retained.length === 0) window.sessionStorage.removeItem(HANDOFF_STORAGE_KEY);
    else window.sessionStorage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(retained));
  } catch {
    // The server-side handoff still closes on role registration. Storage
    // cleanup is only a local convenience and never authorizes recovery.
  }
}

export function OnboardAccount() {
  const { state, health, loading, refresh } = usePilotState();
  const { session } = useSession();
  const capabilities = new Set(session?.capabilities ?? []);
  const canCreateConnection = capabilities.has("customer:create")
    && capabilities.has("connection:manage");
  const [customerName, setCustomerName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [partition, setPartition] = useState("aws");
  const [regionSelectionMode, setRegionSelectionMode] =
    useState<AwsRegionSelectionMode>(ALL_ENABLED_AWS_REGIONS);
  const [regions, setRegions] = useState("us-east-1, ap-south-1");
  const [roleProvisioningMode, setRoleProvisioningMode] =
    useState<AwsRoleProvisioningMode>("sutra_template");
  const [rolePath, setRolePath] = useState(SUTRA_ROLE_NAMESPACE);
  const [roleName, setRoleName] = useState(SUTRA_TEMPLATE_ROLE_NAME);
  const [roleArn, setRoleArn] = useState("");
  const [created, setCreated] = useState<CreateConnectionResponse | null>(null);
  const [oneTimeExternalId, setOneTimeExternalId] = useState<string | null>(null);
  const [handoffDrafts, setHandoffDrafts] = useState<PendingHandoffDraft[]>(() =>
    typeof window === "undefined" ? [] : readHandoffDrafts(),
  );
  const [offboardConfirmation, setOffboardConfirmation] = useState("");
  const [offboardStepUpCode, setOffboardStepUpCode] = useState("");
  const [confirmingOffboard, setConfirmingOffboard] = useState(false);
  const [busy, setBusy] = useState<
    "create" | "handoff" | "role" | "validate" | "sync" | "disable" | "offboard" | null
  >(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedConnection = state?.connection ?? created?.connection ?? null;
  const connection = selectedConnection?.sourceKind === "aws_trust_role" ? selectedConnection : null;
  const effectiveRoleArn = roleArn || connection?.roleArn || "";
  const arnAccount = useMemo(() => effectiveRoleArn.match(/^arn:(?:aws|aws-us-gov|aws-cn):iam::(\d{12}):role\/[A-Za-z0-9+=,.@_\/-]+$/u)?.[1], [effectiveRoleArn]);
  const selectedRoleArn = connection
    ? `arn:${arnPartition(connection.partition)}:iam::${connection.awsAccountId}:role/${connection.expectedRolePath.slice(1)}${connection.expectedRoleName}`
    : null;
  const accountValid = /^\d{12}$/u.test(accountId);
  const customerManagedRoleError = roleProvisioningMode === "customer_managed"
    ? validateCustomerManagedRoleSelection(rolePath, roleName)
    : null;
  const roleValid = Boolean(
    arnAccount && connection && arnAccount === connection.awsAccountId &&
    selectedRoleArn !== null && effectiveRoleArn === selectedRoleArn,
  );
  const currentStep = connection?.status === "active" || connection?.status === "disabled"
    ? 4
    : connection?.roleArn ? 3 : connection ? 2 : 1;
  const trustHealth = connection ? describeTrustHealth(connection) : null;
  const collectionHealth = state && connection ? describeLatestCollection(state) : null;
  const connectionOffboarded = connection?.status === "disabled" && connection.roleArn === null;
  const connectionDisabled = connection?.status === "disabled" && connection.roleArn !== null;
  const collectorMode = created?.collector.mode ?? health?.mode;
  const principalArn = created?.trust.collectorPrincipal ?? created?.trust.vendorCollectorRoleArn ?? health?.principalArn;
  const createdRoleMode = created?.trust.roleProvisioningMode ?? connection?.roleProvisioningMode ?? "sutra_template";
  const createdRoleSessionName = created?.trust.roleSessionName ?? created?.trust.sessionNamePrefix ?? "sutra-";
  const recoverableDraft = useMemo(() => {
    if (!connection || connection.roleArn || connection.status !== "pending") return null;
    return [...handoffDrafts].reverse().find((draft) =>
      draft.awsAccountId === connection.awsAccountId && draft.partition === connection.partition &&
      draft.customerName === connection.customerName &&
      JSON.stringify(draft.enabledRegions) === JSON.stringify(connection.enabledRegions) &&
      draft.roleProvisioningMode === connection.roleProvisioningMode &&
      draft.rolePath === connection.expectedRolePath && draft.roleName === connection.expectedRoleName,
    ) ?? null;
  }, [connection, handoffDrafts]);
  const canDisplayInitialExternalId = Boolean(
    oneTimeExternalId && connection?.status === "pending" && !connection.roleArn,
  );
  const quickLaunchUrl = useMemo(() => {
    if (
      !canDisplayInitialExternalId ||
      !connection ||
      !created ||
      !oneTimeExternalId ||
      !principalArn ||
      createdRoleMode !== "sutra_template"
    ) return null;
    try {
      return buildOneTimeCloudFormationQuickCreateUrl({
        handoffVisible: true,
        partition: connection.partition,
        templateUrl: created.deployment.publicTemplateUrl,
        region: selectCommercialQuickCreateRegion(connection.enabledRegions),
        stackName: `sutra-customer-role-${connection.awsAccountId}`,
        externalId: oneTimeExternalId,
        vendorCollectorRoleArn: principalArn,
        sessionNamePrefix: createdRoleSessionName,
        customerTenantId: created.trust.customerTenantId,
        roleName: created.trust.roleName,
      });
    } catch {
      // The server validates the public template URL before creating a handoff.
      // Any unexpected contract mismatch fails closed to the manual download.
      return null;
    }
  }, [canDisplayInitialExternalId, connection, created, createdRoleMode, createdRoleSessionName, oneTimeExternalId, principalArn]);
  const customerManagedArtifacts = useMemo(() => {
    if (
      !canDisplayInitialExternalId ||
      !connection ||
      !created ||
      !oneTimeExternalId ||
      !principalArn ||
      createdRoleMode !== "customer_managed"
    ) return null;
    try {
      return buildCustomerManagedRoleArtifacts({
        partition: connection.partition as "aws" | "aws-us-gov" | "aws-cn",
        accountId: connection.awsAccountId,
        collectorPrincipal: principalArn,
        externalId: oneTimeExternalId,
        roleSessionName: createdRoleSessionName,
        customerTenantId: created.trust.customerTenantId,
        permissionPackVersion: created.trust.permissionPackVersion ?? connection.permissionPackVersion,
        rolePath: created.trust.rolePath,
        roleName: created.trust.roleName,
      });
    } catch {
      return null;
    }
  }, [canDisplayInitialExternalId, connection, created, createdRoleMode, createdRoleSessionName, oneTimeExternalId, principalArn]);

  async function createConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create");
    setError(null);
    setNotice(null);
    const normalizedName = customerName.trim().replace(/\s+/gu, " ");
    const enabledRegions = regionSelectionMode === ALL_ENABLED_AWS_REGIONS
      ? [ALL_ENABLED_AWS_REGIONS]
      : [...new Set(
          regions.split(",").map((region) => region.trim()).filter(Boolean),
        )].sort();
    const existingDraft = readHandoffDrafts().find((draft) =>
      draft.customerName === normalizedName && draft.awsAccountId === accountId &&
      draft.partition === partition &&
      JSON.stringify(draft.enabledRegions) === JSON.stringify(enabledRegions) &&
      draft.roleProvisioningMode === roleProvisioningMode &&
      draft.rolePath === rolePath && draft.roleName === roleName,
    );
    const draft: PendingHandoffDraft = existingDraft ?? {
      operationId: `onb_${crypto.randomUUID().replaceAll("-", "")}`,
      customerName: normalizedName,
      awsAccountId: accountId,
      partition,
      enabledRegions,
      roleProvisioningMode,
      rolePath,
      roleName,
    };
    if (!storeHandoffDraft(draft)) {
      setError("Browser session storage is unavailable, so Sutra did not create a handoff that could be stranded by a lost response.");
      setBusy(null);
      return;
    }
    setHandoffDrafts(readHandoffDrafts());
    try {
      const response = await postPilot<CreateConnectionResponse>("/api/pilot/connections", draft);
      setCreated(response);
      setOneTimeExternalId(response.trust.externalId);
      setRoleArn(expectedRoleArn(response));
      setNotice({
        tone: "success",
        title: response.handoff.recovered ? "Trust handoff recovered" : "Connection contract created",
        message: response.handoff.recovered
          ? "The same pending ExternalId handoff was recovered. Copy it, then deploy the customer-owned role."
          : "Copy the ExternalId now, then deploy the customer-owned role.",
      });
      await refresh();
    } catch (caught) {
      setError(messageFrom(caught));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function recoverConnectionHandoff() {
    if (!recoverableDraft || connection?.roleArn || connection?.status !== "pending") return;
    setBusy("create");
    setError(null);
    setNotice(null);
    try {
      const response = await postPilot<CreateConnectionResponse>(
        "/api/pilot/connections",
        recoverableDraft,
      );
      setCreated(response);
      setOneTimeExternalId(response.trust.externalId);
      setRoleArn(expectedRoleArn(response));
      setNotice({
        tone: "success",
        title: "Trust handoff recovered",
        message: "Sutra returned the same actor-bound pending ExternalId. It closes only after AWS proves the role contract and registration commits.",
      });
      await refresh();
    } catch (caught) {
      setError(messageFrom(caught));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function claimAssignedConnectionHandoff() {
    if (!connection || connection.roleArn || connection.status !== "pending") return;
    setBusy("handoff");
    setError(null);
    setNotice(null);
    try {
      const response = await postPilot<CreateConnectionResponse>(
        "/api/pilot/connections/handoff",
        { connectionId: connection.id },
      );
      setCreated(response);
      setOneTimeExternalId(response.trust.externalId);
      setRoleArn(expectedRoleArn(response));
      setNotice({
        tone: "success",
        title: "Assigned AWS onboarding handoff opened",
        message: "This MFA-verified customer administrator can now deploy the customer-owned role. The disclosure was audited and closes when role registration succeeds.",
      });
      await refresh();
    } catch (caught) {
      setError(messageFrom(caught));
      await refresh();
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
      // Hide the value during proof so it cannot linger on screen. The server
      // keeps the same actor-bound handoff recoverable if AWS proof or the
      // atomic database commit fails.
      setOneTimeExternalId(null);
      const response = await postPilot<{ connection: PilotConnection }>("/api/pilot/connections/role", {
        connectionId: connection.id,
        roleArn: effectiveRoleArn,
      });
      if (created) setCreated({ ...created, connection: response.connection });
      if (recoverableDraft) {
        forgetHandoffDraft(recoverableDraft.operationId);
        setHandoffDrafts(readHandoffDrafts());
      }
      const missingCapabilities = response.connection.permissionCapabilities?.missingActions ?? [];
      setNotice({
        tone: missingCapabilities.length === 0 ? "success" : "warning",
        title: missingCapabilities.length === 0
          ? "Trust verified and customer role registered"
          : `Trust verified with ${missingCapabilities.length} unavailable capabilities`,
        message: missingCapabilities.length === 0
          ? "AWS returned the expected caller identity, missing and incorrect ExternalIds were denied, and Sutra atomically activated the verified role."
          : `The dedicated role is safe and active, but this customer omitted ${missingCapabilities.length} reviewed metadata actions. Sutra will report the affected collectors as unavailable instead of claiming coverage.`,
      });
      await refresh();
    } catch (caught) {
      setError(messageFrom(caught));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function validateAndSync() {
    if (!connection) return;
    let trustValidatedThisAttempt = false;
    setBusy("validate");
    setError(null);
    setNotice(null);
    try {
      await postPilot("/api/pilot/connections/validate", { connectionId: connection.id });
      trustValidatedThisAttempt = true;
      await refresh();
      setBusy("sync");
      const response = await postPilot<LiveSyncResponse>("/api/pilot/connections/sync", { connectionId: connection.id });
      const result = describeLiveSyncResult(response.state, response.runId);
      setNotice({
        tone: result.kind === "complete" ? "success" : "warning",
        title: trustValidatedThisAttempt && result.kind === "complete"
          ? "Trust validated and snapshot published"
          : result.title,
        message: result.message,
      });
      await refresh();
    } catch (caught) {
      setError(describeLiveSyncFailure({
        publicError: messageFrom(caught),
        trustValidatedThisAttempt,
        existingTrustWasActive: connection.status === "active",
        hasActiveSnapshot: state?.activeSnapshot !== null && state?.activeSnapshot !== undefined,
      }));
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
      const response = await postPilot<LiveSyncResponse>("/api/pilot/connections/sync", { connectionId: connection.id });
      const result = describeLiveSyncResult(response.state, response.runId);
      setNotice({
        tone: result.kind === "complete" ? "success" : "warning",
        title: result.title,
        message: result.message,
      });
      await refresh();
    } catch (caught) {
      setError(describeLiveSyncFailure({
        publicError: messageFrom(caught),
        trustValidatedThisAttempt: false,
        existingTrustWasActive: connection.status === "active",
        hasActiveSnapshot: state?.activeSnapshot !== null && state?.activeSnapshot !== undefined,
      }));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function revalidateTrust() {
    if (!connection) return;
    setBusy("validate");
    setError(null);
    setNotice(null);
    try {
      await postPilot("/api/pilot/connections/validate", { connectionId: connection.id });
      setNotice({
        tone: "success",
        title: "Trust boundary revalidated",
        message: "The expected caller identity and both negative ExternalId probes passed. Inventory was not run by this action.",
      });
      await refresh();
    } catch (caught) {
      setError(describeLiveSyncFailure({
        publicError: messageFrom(caught),
        trustValidatedThisAttempt: false,
        existingTrustWasActive: false,
        hasActiveSnapshot: state?.activeSnapshot !== null && state?.activeSnapshot !== undefined,
      }));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function disableConnection() {
    if (!connection) return;
    setBusy("disable");
    setError(null);
    setNotice(null);
    try {
      const response = await postPilot<ConnectionLifecycleResponse>(
        "/api/pilot/connections/disable",
        { connectionId: connection.id },
      );
      setOneTimeExternalId(null);
      setNotice({
        tone: "warning",
        title: response.collectorCleanup === "completed"
          ? "AWS connection disabled"
          : "AWS connection disabled; collector cleanup pending",
        message: response.collectorCleanup === "completed"
          ? "New validation and inventory work is blocked in Sutra and the collector. Encrypted trust material and CMDB history remain for investigation."
          : "New Sutra work is blocked now. Restore the collector service and use Reconcile collector disable to finish its idempotent cleanup.",
      });
      await refresh();
    } catch (caught) {
      setError(messageFrom(caught));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function offboardConnection(reconcileOnly = false) {
    if (!connection || (!reconcileOnly && offboardConfirmation !== connection.awsAccountId)) return;
    setBusy("offboard");
    setError(null);
    setNotice(null);
    try {
      if (!reconcileOnly) {
        await postPilot("/api/auth/mfa/step-up", { code: offboardStepUpCode });
        setOffboardStepUpCode("");
      }
      const response = await postPilot<ConnectionLifecycleResponse>("/api/pilot/connections/offboard", {
        connectionId: connection.id,
        awsAccountId: connection.awsAccountId,
      });
      setOneTimeExternalId(null);
      setRoleArn("");
      setOffboardConfirmation("");
      setOffboardStepUpCode("");
      setConfirmingOffboard(false);
      setNotice({
        tone: response.collectorCleanup === "completed" ? "success" : "warning",
        title: response.collectorCleanup === "completed"
          ? "Local AWS trust offboarded"
          : "Local AWS trust offboarded; collector cleanup pending",
        message: response.collectorCleanup === "completed"
          ? "Sutra and its collector removed their trust material. CMDB and audit history remain. The customer-owned IAM role is unchanged; delete its CloudFormation stack or remove its trust policy in AWS."
          : "Sutra removed its control-plane trust material and blocked future work. Restore the collector service and reconcile cleanup. The customer-owned IAM role is unchanged and must be revoked separately in AWS.",
      });
      await refresh();
    } catch (caught) {
      setError(messageFrom(caught));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

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

          {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Checking the AWS workspace…</div> : null}

          {!loading && !connection && collectorMode !== "live" ? (
            <div className="onboard-copy"><p className="eyebrow">Local-only safety boundary</p><h2>AWS trust onboarding is disabled</h2><p>The collector is running in deterministic fixture mode, so Sutra will not create a trust-role connection or contact AWS. Use Simulation runs to exercise the durable queue, CMDB, change history, findings, and exports with clearly labelled local evidence.</p><a className="button button-primary" href="/operations">Open Simulation runs</a></div>
          ) : null}

          {!loading && !connection && collectorMode === "live" && canCreateConnection ? (
            <>
              <div className="onboard-copy"><p className="eyebrow">Step 1 of 4</p><h2>Create the connection contract</h2><p>Sutra binds a platform-generated ExternalId to this customer and account. A lost response can recover the same actor-bound value only until the customer role is registered.</p></div>
              <form className="onboard-form" onSubmit={createConnection}>
                <label><span>Customer workspace</span><input value={customerName} maxLength={80} onChange={(event) => setCustomerName(event.target.value)} placeholder="Customer or company name" required /><small>Each connection is bound to one approved customer workspace and one AWS account.</small></label>
                <div className="form-grid">
                  <label><span>AWS account ID</span><input inputMode="numeric" maxLength={12} value={accountId} onChange={(event) => setAccountId(event.target.value.replace(/\D/gu, ""))} aria-invalid={accountId.length > 0 && !accountValid} required /><small>{health?.mode === "fixture" ? "Fixture mode expects 123456789012." : "Exactly 12 digits from the client AWS account."}</small></label>
                  <label><span>AWS partition</span><select value={partition} onChange={(event) => setPartition(event.target.value)}><option value="aws">Commercial (aws)</option><option value="aws-us-gov">GovCloud</option><option value="aws-cn">China</option></select><small>The collector principal and role must use the same partition.</small></label>
                </div>
                <label><span>Role provisioning</span><select value={roleProvisioningMode} onChange={(event) => {
                  const next = event.target.value as AwsRoleProvisioningMode;
                  setRoleProvisioningMode(next);
                  setRolePath(SUTRA_ROLE_NAMESPACE);
                  setRoleName(next === "sutra_template" ? SUTRA_TEMPLATE_ROLE_NAME : SUTRA_CUSTOM_ROLE_DEFAULT_NAME);
                }}><option value="sutra_template">Use Sutra template</option><option value="customer_managed">Use customer-managed role</option></select><small>{roleProvisioningMode === "sutra_template" ? "Fastest path: deploy Sutra's reviewed, fixed CloudFormation role." : "Sutra generates Terraform, CloudFormation, and JSON trust-policy downloads for a dedicated customer-named role."}</small></label>
                {roleProvisioningMode === "customer_managed" ? <>
                  <div className="form-grid">
                    <label><span>Dedicated role path</span><input value={rolePath} maxLength={512} onChange={(event) => setRolePath(event.target.value.trim())} aria-invalid={Boolean(customerManagedRoleError)} placeholder="/sutra/acme/" required /><small>Must remain inside the reserved <code>/sutra/</code> namespace and end with <code>/</code>.</small></label>
                    <label><span>Dedicated role name</span><input value={roleName} maxLength={64} onChange={(event) => setRoleName(event.target.value.trim())} aria-invalid={Boolean(customerManagedRoleError)} placeholder={SUTRA_CUSTOM_ROLE_DEFAULT_NAME} required /><small>Choose a new role used only by this Sutra connection.</small></label>
                  </div>
                  <div className="inline-warning" role={customerManagedRoleError ? "alert" : "note"}><strong>{customerManagedRoleError ? "Role contract needs attention" : "Dedicated customer role required"}</strong><span>{customerManagedRoleError ?? "Existing admin, shared operations, power-user, break-glass, account-access, broader-policy, and wildcard-trust roles are rejected during live attestation. Every accepted session is still intersected with Sutra's fixed read-only STS session policy."}</span></div>
                </> : null}
                <label><span>Region coverage</span><select value={regionSelectionMode} onChange={(event) => setRegionSelectionMode(event.target.value as AwsRegionSelectionMode)}><option value={ALL_ENABLED_AWS_REGIONS}>All account-enabled Regions (recommended)</option><option value="explicit">Only explicit Regions</option></select><small>After assuming the customer role, Sutra asks AWS which Regions are enabled and records collector coverage against those real Region names.</small></label>
                {regionSelectionMode === "explicit" ? <label><span>Explicit regions</span><input value={regions} onChange={(event) => setRegions(event.target.value)} placeholder="us-east-1, ap-south-1" required /><small>Comma-separated AWS Regions. Sutra fails validation if any selected Region is not enabled; global IAM is collected once.</small></label> : null}
                <button className="button button-primary onboard-submit" type="submit" disabled={!accountValid || customerName.trim().length < 2 || customerManagedRoleError !== null || (regionSelectionMode === "explicit" && regions.split(",").every((region) => region.trim().length === 0)) || busy !== null}>{busy === "create" ? "Creating secure contract…" : "Create connection contract"}</button>
              </form>
            </>
          ) : null}

          {!loading && !connection && collectorMode === "live" && !canCreateConnection ? (
            <div className="onboard-copy">
              <p className="eyebrow">Approval required</p>
              <h2>No assigned company account is ready</h2>
              <p>An organization owner must first create your customer workspace and pending AWS connection, then assign your approved customer-administrator profile to it. You cannot create or discover another client&apos;s account.</p>
              <a className="button button-secondary" href="/access">Review your access</a>
            </div>
          ) : null}

          {connection ? (
            <>
              <div className="onboard-copy"><p className="eyebrow">Step 2 of 4</p><h2>Deploy and register the customer role</h2><p>Use the exact collector principal and ExternalId below with the selected deployment method. Sutra never creates or stores long-lived customer access keys.</p></div>
              <div className="connection-contract" aria-label="AWS connection contract">
                <div><small>Customer</small><strong>{connection.customerName}</strong><span>{connection.awsAccountId} · {connection.partition}</span></div>
                <div><small>Region scope</small><strong>{isAllEnabledAwsRegionSelection(connection.enabledRegions) ? "All" : connection.enabledRegions.length}</strong><span>{isAllEnabledAwsRegionSelection(connection.enabledRegions) ? "All account-enabled Regions; discovered at collection time" : connection.enabledRegions.join(", ")}</span></div>
                <div><small>Role contract</small><strong>{createdRoleMode === "customer_managed" ? "Customer-managed" : "Sutra template"}</strong><span>{created?.trust.rolePath ?? connection.expectedRolePath}{created?.trust.roleName ?? connection.expectedRoleName}</span></div>
                <div><small>Trust health</small><strong className={`connection-status connection-${connection.status}`} title={trustHealth?.detail}>{trustHealth?.label}</strong><span>Validated {formatTimestamp(connection.lastValidatedAt)}</span></div>
              </div>

              {collectionHealth?.kind === "complete" ? (
                <div className="validation-result" role="status"><span>✓</span><div><strong>Latest inventory: {collectionHealth.title}</strong><p>{collectionHealth.message}</p></div></div>
              ) : collectionHealth && collectionHealth.kind !== "not_started" ? (
                <div className="inline-warning" role="status"><strong>Latest inventory: {collectionHealth.title}</strong><span>{collectionHealth.message}</span></div>
              ) : null}

              {connection.permissionCapabilities && connection.permissionCapabilities.missingActions.length === 0 ? <div className="validation-result" role="status"><span>✓</span><div><strong>All reviewed inline-policy capabilities declared</strong><p>{connection.permissionCapabilities.grantedActions.length} actions are declared by the attested inline policy for permission pack <code>{connection.permissionPackVersion}</code>. Effective access is confirmed separately by collection results.</p></div></div> : connection.permissionCapabilities ? <div className="inline-warning" role="status"><strong>{connection.permissionCapabilities.missingActions.length} inline-policy capabilities omitted</strong><span>Not declared in the role policy: <code>{connection.permissionCapabilities.missingActions.slice(0, 8).join(", ")}</code>{connection.permissionCapabilities.missingActions.length > 8 ? ` and ${connection.permissionCapabilities.missingActions.length - 8} more` : ""}. Effective access can also be limited by permission boundaries, SCPs, or resource policies; collection coverage remains explicit.</span></div> : null}

              {canDisplayInitialExternalId && oneTimeExternalId ? <label className="contract-field"><span>Pending-handoff ExternalId</span><div className="copy-field"><code>{oneTimeExternalId}</code><button type="button" onClick={() => void navigator.clipboard?.writeText(oneTimeExternalId)}>Copy</button></div><small>This value is visible only while the customer role is pending. Role registration closes the handoff permanently, and each delegated disclosure is audited.</small></label> : recoverableDraft && connection.status === "pending" && !connection.roleArn ? <div className="inline-warning"><strong>The pending ExternalId handoff can be recovered.</strong><span>The previous response may have been lost. Retry the same stored operation to retrieve the original value; Sutra will not rotate or create a second contract.</span><button className="button button-secondary" type="button" disabled={busy !== null || collectorMode !== "live"} onClick={() => void recoverConnectionHandoff()}>{busy === "create" ? "Recovering handoff…" : "Recover pending handoff"}</button></div> : connection.status === "pending" && !connection.roleArn ? <div className="inline-warning"><strong>Your assigned onboarding handoff is ready.</strong><span>Only an MFA-verified customer administrator assigned to this exact customer can disclose it. The event is written to the audit chain before the value is returned.</span><button className="button button-secondary" type="button" disabled={busy !== null || collectorMode !== "live"} onClick={() => void claimAssignedConnectionHandoff()}>{busy === "handoff" ? "Opening handoff…" : "Open assigned onboarding handoff"}</button></div> : <div className="inline-warning"><strong>ExternalId handoff is closed.</strong><span>{connectionOffboarded ? "This connection has been offboarded and no trust secret remains in Sutra's control plane." : connection.roleArn ? "The customer role has been registered, so Sutra will never display the initial ExternalId again." : "No pending onboarding handoff is available for this connection."}</span></div>}

              <div className="deployment-parameters" aria-label="CloudFormation trust parameters">
                <div><small>SessionNamePrefix</small><code>{createdRoleSessionName}</code></div>
                <div><small>CustomerTenantId</small><code>{created?.trust.customerTenantId ?? connection.customerId}</code></div>
                <div><small>RoleName</small><code>{created?.trust.roleName ?? "SutraCollectorRole"}</code></div>
              </div>

              <label className="contract-field"><span>Exact collector principal</span><div className="copy-field"><code>{principalArn ?? "Collector principal unavailable"}</code><button type="button" disabled={!principalArn} onClick={() => principalArn && void navigator.clipboard?.writeText(principalArn)}>Copy</button></div></label>

              {canDisplayInitialExternalId && quickLaunchUrl ? (
                <section className="quick-launch-panel" aria-labelledby="quick-launch-title">
                  <div className="quick-launch-heading">
                    <div><p className="eyebrow">Customer-owned deployment</p><h3 id="quick-launch-title">Create the reviewed role in AWS</h3><p>Sutra pre-fills the exact trust parameters in AWS CloudFormation. The customer reviews and creates the stack in their own account.</p></div>
                    <a className="button button-primary" href={quickLaunchUrl} target="_blank" rel="noreferrer">Open AWS CloudFormation ↗</a>
                  </div>
                  <ol className="deployment-checklist">
                    <li><b>1</b><span><strong>Confirm the AWS account.</strong> Sign in to account <code>{connection.awsAccountId}</code> and check the account banner before continuing.</span></li>
                    <li><b>2</b><span><strong>Review the prefilled contract.</strong> Keep the template URL, collector principal, ExternalId, tenant ID, session prefix, and fixed role name unchanged.</span></li>
                    <li><b>3</b><span><strong>Create and wait.</strong> Acknowledge <code>CAPABILITY_NAMED_IAM</code>, create the stack, and wait for <code>CREATE_COMPLETE</code>.</span></li>
                    <li><b>4</b><span><strong>Return the output.</strong> Copy <code>CustomerReadRoleArn</code> from the Outputs tab, paste it below, then verify and register the role.</span></li>
                  </ol>
                  <div className="quick-launch-history-warning"><strong>One-time browser handoff</strong><span>The ExternalId is placed only in the AWS Console URL fragment and this button disappears when the handoff closes. A visited URL can remain in browser history, so use a private browser window and close it after role registration. Never paste the URL into chat, tickets, or logs.</span></div>
                </section>
              ) : canDisplayInitialExternalId && createdRoleMode === "sutra_template" ? (
                <div className="inline-warning"><strong>Use the manual CloudFormation path.</strong><span>{connection.partition !== "aws" ? "Quick launch currently supports only commercial AWS accounts." : !created?.deployment.publicTemplateUrl ? "The server does not have a reviewed public regional-S3 template URL configured." : "Sutra could not safely construct the quick-launch URL."} Download the template, upload it in the customer&apos;s CloudFormation console, and copy the displayed trust values into the matching parameters.</span></div>
              ) : null}

              {createdRoleMode === "sutra_template" ? <div className="template-actions"><a className="button button-secondary" href={AWS_CUSTOMER_ROLE_TEMPLATE_PATH} download>Download least-privilege CloudFormation</a><span>Version <code>{AWS_CUSTOMER_ROLE_TEMPLATE_VERSION}</code> · SHA-256 <code>{AWS_CUSTOMER_ROLE_TEMPLATE_SHA256}</code>. Deploy with <code>CAPABILITY_NAMED_IAM</code>. This version grants exactly the read-only metadata, network-exposure, IAM posture, and AWS-native finding APIs the collector invokes, and never enables AWS security services. Agentless disk scanning is a separate stack parameter that defaults to false; it is the only setting that grants any write permission, and even when enabled the role carries an explicit deny on every destructive action.</span></div> : null}

              {createdRoleMode === "customer_managed" && customerManagedArtifacts ? <section className="quick-launch-panel" aria-labelledby="customer-role-downloads-title">
                <div className="quick-launch-heading"><div><p className="eyebrow">Customer-managed deployment</p><h3 id="customer-role-downloads-title">Download the exact dedicated-role contract</h3><p>Use the Terraform or CloudFormation file for the complete deployable role. The JSON download is only the exact trust-policy fragment for customers who reproduce the same permission policy and required tags through their own IAM tooling. Every artifact is generated in this browser from the one-time server handoff.</p></div></div>
                <div className="heading-actions">
                  <button className="button button-secondary" type="button" onClick={() => downloadSensitiveArtifact(`${connection.expectedRoleName}.tf`, customerManagedArtifacts.terraformHcl, "text/plain;charset=utf-8")}>Download Terraform</button>
                  <button className="button button-secondary" type="button" onClick={() => downloadSensitiveArtifact(`${connection.expectedRoleName}.yaml`, customerManagedArtifacts.cloudFormationYaml, "application/yaml;charset=utf-8")}>Download CloudFormation</button>
                  <button className="button button-secondary" type="button" onClick={() => downloadSensitiveArtifact(`${connection.expectedRoleName}-trust-policy.json`, customerManagedArtifacts.trustPolicyJson, "application/json;charset=utf-8")}>Download JSON trust policy</button>
                </div>
                <ol className="deployment-checklist">
                  <li><b>1</b><span><strong>Create a new dedicated role.</strong> Do not reuse an administrator, power-user, shared operations, break-glass, or AWS account-access role.</span></li>
                  <li><b>2</b><span><strong>Keep trust exact.</strong> The principal must be <code>{principalArn}</code>; account roots, multiple principals, and wildcard trust are rejected.</span></li>
                  <li><b>3</b><span><strong>Preserve the permission ceiling.</strong> Sutra assesses missing metadata capabilities, rejects broader actions and attached managed policies, and applies a restrictive STS session policy on every scan.</span></li>
                  <li><b>4</b><span><strong>Register the resulting ARN.</strong> Use <code>{customerManagedArtifacts.roleArn}</code>. Sutra re-attests trust and permission drift before every collection.</span></li>
                </ol>
                <div className="quick-launch-history-warning"><strong>Handle as a one-time handoff</strong><span>These downloads contain the connection-specific ExternalId. Store them in the customer&apos;s protected infrastructure repository, never in chat or tickets, and delete local copies after deployment if they are not source-controlled securely.</span></div>
              </section> : createdRoleMode === "customer_managed" && canDisplayInitialExternalId ? <div className="inline-warning" role="alert"><strong>Customer-role artifacts are unavailable.</strong><span>The server-returned trust handoff did not pass artifact validation. Do not create or reuse a role; recover the handoff or contact the Sutra operator.</span></div> : null}

              {createdRoleMode === "customer_managed" ? <div className="inline-warning"><strong>Unsafe existing roles are rejected.</strong><span>Sutra accepts only the selected <code>/sutra/…/</code> path and role name with one exact trust statement, one reviewed inline permission contract, no attached managed policies, and the expected dedicated-role tags. Broad permissions on any reused role are not considered acceptable.</span></div> : null}

              {!connectionOffboarded ? <form className="onboard-form role-registration" onSubmit={registerRole}>
                <label><span>Customer role ARN</span><input value={effectiveRoleArn} onChange={(event) => setRoleArn(event.target.value.trim())} placeholder={created ? expectedRoleArn(created) : selectedRoleArn ?? "Dedicated role ARN"} aria-invalid={effectiveRoleArn.length > 0 && !roleValid} required /><small>{effectiveRoleArn.length === 0 ? "Paste the deployment output after the role is created." : !roleValid ? `Use the exact selected dedicated role ARN: ${selectedRoleArn ?? "unavailable"}.` : "Role ARN syntax, account, path, and name match; the server will still attest its exact trust, permissions, and tags."}</small></label>
                <p className="limitation-note">Your existing MFA-verified Sutra session authorizes this step. Sutra still proves the exact AWS account, role trust, permissions, tags, and incorrect-ExternalId denial before registration commits.</p>
                <button className="button button-secondary onboard-submit" type="submit" disabled={!roleValid || connectionDisabled || busy !== null || collectorMode !== "live"}>{busy === "role" ? "Registering role…" : collectorMode === "live" ? connection.roleArn ? "Verify & update registered role" : "Verify & register customer role" : "Live collector required"}</button>
              </form> : null}

              <div className="onboard-validation-action">
                <div><p className="eyebrow">Step 3 of 4</p><h2>{connection.status === "active" ? "Trust boundary proven" : "Prove the trust boundary"}</h2><p>{connection.status === "active" ? "The expected caller identity, exact trust and permission policies, restrictive session policy, and both negative ExternalId probes passed." : "Sutra checks the expected caller identity and confirms missing or incorrect ExternalIds cannot assume the role before registration commits."}</p></div>
                {connection.status === "active" ? <div className="heading-actions"><button className="button button-secondary" type="button" disabled={busy !== null || collectorMode !== "live"} onClick={() => void revalidateTrust()}>{busy === "validate" ? "Revalidating trust…" : "Revalidate trust"}</button><button className="button button-primary" type="button" disabled={busy !== null || collectorMode !== "live"} onClick={() => void runSync()}>{busy === "sync" ? "Collecting AWS metadata…" : collectorMode === "live" ? "Run inventory sync" : "Live collector required"}</button></div> : connection.status === "disabled" ? <span className="status-pill status-medium">{connectionOffboarded ? "Trust offboarded" : "Connection disabled"}</span> : <button className="button button-primary" type="button" disabled={!connection.roleArn || busy !== null || collectorMode !== "live"} onClick={() => void validateAndSync()}>{busy === "validate" ? "Validating trust…" : busy === "sync" ? "Publishing first snapshot…" : collectorMode === "live" ? "Validate trust & run first sync" : "Live collector required"}</button>}
              </div>

              <section id="connection-lifecycle" className="connection-lifecycle" aria-labelledby="connection-lifecycle-title">
                <div><p className="eyebrow">Trust lifecycle</p><h2 id="connection-lifecycle-title">Control or remove collector access</h2><p>These actions never delete CMDB snapshots. Offboarding removes role and ExternalId material from Sutra and asks the collector to erase its copy. It cannot delete or change the customer-owned IAM role; delete that role&apos;s CloudFormation stack or remove its trust policy separately in AWS.</p></div>
                <div className="connection-lifecycle-actions">
                  <span className="status-pill status-medium" title="A safe rotation must stage a new value, verify the customer-side trust change, and prove the previous value is denied before promotion.">Two-phase rotation pending</span>
                  {connectionDisabled ? <button className="button button-secondary" type="button" disabled={busy !== null} onClick={() => void disableConnection()}>{busy === "disable" ? "Reconciling…" : "Reconcile collector disable"}</button> : !connectionOffboarded ? <button className="button button-secondary" type="button" disabled={busy !== null} onClick={() => void disableConnection()}>{busy === "disable" ? "Disabling…" : "Disable connection"}</button> : null}
                  {!connectionOffboarded ? <button className="button button-danger" type="button" disabled={busy !== null} onClick={() => setConfirmingOffboard(true)}>Offboard AWS trust</button> : <button className="button button-secondary" type="button" disabled={busy !== null} onClick={() => void offboardConnection(true)}>{busy === "offboard" ? "Reconciling…" : "Reconcile collector offboard"}</button>}
                </div>
                {!connectionOffboarded ? <div className="inline-warning"><strong>ExternalId rotation is intentionally unavailable.</strong><span>This deployment will not overwrite active trust until a two-phase workflow can verify the new customer policy and prove the old value is denied. Offboard and revoke the customer stack if immediate replacement is required.</span></div> : null}
                {confirmingOffboard && !connectionOffboarded ? <div className="offboard-confirmation" role="group" aria-label="Confirm AWS trust offboarding"><strong>Confirm permanent AWS trust removal</strong><p>Enter AWS account ID <code>{connection.awsAccountId}</code> and a fresh authenticator code. Sutra will retain CMDB and audit evidence, but this connection cannot be reactivated. This does not revoke the customer IAM role; delete its stack or remove its trust separately in AWS.</p><input aria-label="AWS account ID confirmation" inputMode="numeric" maxLength={12} value={offboardConfirmation} onChange={(event) => setOffboardConfirmation(event.target.value.replace(/\D/gu, ""))} /><input aria-label="Authenticator code" autoComplete="one-time-code" inputMode="numeric" maxLength={6} pattern="[0-9]{6}" value={offboardStepUpCode} onChange={(event) => setOffboardStepUpCode(event.target.value.replace(/\D/gu, ""))} /><div className="heading-actions"><button className="button button-secondary" type="button" disabled={busy !== null} onClick={() => { setConfirmingOffboard(false); setOffboardConfirmation(""); setOffboardStepUpCode(""); }}>Cancel</button><button className="button button-danger" type="button" disabled={busy !== null || offboardConfirmation !== connection.awsAccountId || !/^\d{6}$/u.test(offboardStepUpCode)} onClick={() => void offboardConnection()}>{busy === "offboard" ? "Removing AWS trust…" : "Verify & confirm offboarding"}</button></div></div> : null}
              </section>
            </>
          ) : null}

          {notice?.tone === "success" ? <div className="validation-result" role="status"><span>✓</span><div><strong>{notice.title}</strong><p>{notice.message}</p></div></div> : null}
          {notice?.tone === "warning" ? <div className="inline-warning" role="status"><strong>{notice.title}</strong><span>{notice.message}</span></div> : null}
          {error ? <div className="validation-result validation-error" role="alert"><span>!</span><div><strong>Action needs attention</strong><p>{error}</p></div></div> : null}
        </section>

        <aside className="onboard-aside">
          <section className="panel"><p className="eyebrow">Trust checklist</p><h2>Customer stays in control</h2><ul className="check-list compact"><li><span>✓</span>Exact collector workload-role principal</li><li><span>✓</span>Unique ExternalId condition</li><li><span>✓</span>Metadata-only permissions</li><li><span>✓</span>Maximum one-hour STS session</li><li><span>✓</span>No S3 objects, secrets, KMS decrypt, or mutations</li></ul></section>
          <section className="panel aside-warning"><p className="eyebrow">Collector mode</p><h2>{collectorMode === "live" ? "Connected to AWS" : collectorMode === "fixture" ? "Development fixture environment" : "Collector unavailable"}</h2><p>{collectorMode === "live" ? "Validation and inventory use the configured AWS workload identity. AWS permissions and service availability determine coverage." : collectorMode === "fixture" ? "Development fixture mode cannot create or synchronize AWS trust connections. Every resulting snapshot is labelled as simulated evidence." : "Restore the collector service before creating, validating, or synchronizing an AWS connection. Stored complete snapshots remain readable while it is offline."}</p></section>
          <section className="panel data-path-card"><p className="eyebrow">Credential path</p><ol><li><b>1</b>Signed scoped job</li><li><b>2</b>Collector workload identity</li><li><b>3</b>STS AssumeRole</li><li><b>4</b>Temporary in-memory credentials</li><li><b>5</b>Validated normalized evidence</li></ol></section>
        </aside>
      </div>
    </>
  );
}
