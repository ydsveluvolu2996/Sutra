"use client";

import { FormEvent, useMemo, useState, type ReactNode } from "react";
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
import {
  isLiveAwsSourceKind,
  type CollectorHealth,
  type PilotConnection,
  type PilotState,
} from "../../lib/pilot-types";
import { formatTimestamp, postPilot, usePilotState } from "../components/use-pilot-state";
import { useSession } from "../components/use-session";
import {
  WizardCodeBlock,
  WizardPermissionToggle,
  WizardRadioGroup,
  WizardStepRail,
  type WizardStep,
} from "./onboard-wizard-chrome";
import { ConnectProviderGrid } from "./connect-provider-grid";
import { ONBOARDING_ROLE_ALLOWED_ACTION_COUNT, ONBOARDING_ROLE_CAPABILITIES } from "../../lib/aws-onboarding-role-capabilities";
import { GlyphIcon } from "../components/nav-icon";

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

type OnboardConnectionMethod = "iam_role" | "static_credentials";

// One visible choice instead of two nested selects. The old form only revealed
// the customer-managed option AFTER picking "IAM role", so the path that
// answers the most common customer objection -- a Sutra CloudFormation stack
// raising drift alerts in their account -- read as absent. It is not a
// different capability; it is the same role contract, provisioned by the
// customer's own tooling.
type OnboardPath = "customer_managed_role" | "sutra_template_role" | "static_credentials";

interface OnboardPathOption {
  readonly id: OnboardPath;
  readonly title: string;
  readonly summary: string;
  readonly traits: readonly string[];
  readonly recommended?: true;
}

const ONBOARD_PATHS: readonly OnboardPathOption[] = Object.freeze([
  {
    id: "customer_managed_role",
    title: "Terraform or their own tooling",
    summary:
      "Sutra generates Terraform, CloudFormation and JSON trust-policy artifacts for a dedicated role. The customer applies them with whatever already manages their IAM, so Sutra deploys nothing in their account.",
    traits: ["No stack in their account", "No drift alert", "No stored secret"],
    recommended: true,
  },
  {
    id: "sutra_template_role",
    title: "Sutra CloudFormation template",
    summary:
      "One-click quick-create of Sutra's reviewed, fixed role template. Fastest to complete, but it does create a CloudFormation stack in the customer's account.",
    traits: ["Fastest to complete", "Creates a stack", "No stored secret"],
  },
  {
    id: "static_credentials",
    title: "Access keys",
    summary:
      "The customer supplies access key, secret key and optional session token for a dedicated read-only IAM user. The collector stores them encrypted. Use when the customer cannot create a role at all.",
    traits: ["No role required", "Stored encrypted", "Customer must rotate"],
  },
] as const);

interface RegisterCredentialsResponse {
  readonly connection: PilotConnection;
  readonly registered: true;
  readonly verification: {
    readonly accountId: string;
    readonly callerIdentityArn: string;
    readonly accessKeyLast4: string;
  };
  readonly collection: { readonly jobId: string; readonly status: "queued" };
}

// AWS long-lived (AKIA) and temporary (ASIA) access key IDs share this shape.
const AWS_ACCESS_KEY_ID_PATTERN = /^(AKIA|ASIA)[A-Z0-9]{16}$/u;
const AWS_SECRET_ACCESS_KEY_LENGTH = 40;

function describeStaticCredentialHealth(
  connection: PilotConnection,
): { readonly label: string; readonly detail: string } {
  switch (connection.status) {
    case "active":
      return {
        label: "Validated",
        detail: "GetCallerIdentity proved the stored encrypted access keys resolve to the expected AWS account.",
      };
    case "validating":
      return {
        label: "Validating",
        detail: "Sutra is proving the stored encrypted access keys resolve to the expected AWS account.",
      };
    case "needs_attention":
      return {
        label: "Revalidation required",
        detail: "The stored access keys must pass GetCallerIdentity account binding before another inventory run can start.",
      };
    case "disabled":
      return {
        label: "Disabled",
        detail: "This connection cannot validate credentials or collect inventory.",
      };
    case "pending":
      return {
        label: "Awaiting access keys",
        detail: "Enter the customer's dedicated read-only access keys to register this connection.",
      };
  }
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

/**
 * The deployment and lifecycle surface for one connection.
 *
 * While a connection is still being set up, this content *is* the page, so it
 * renders inline. Once the trust is live the same content stays true and stays
 * reachable -- revalidating, re-registering and offboarding are all still real
 * -- but it is no longer what anyone opened this page to do. Left inline it
 * buries the next action under a wall of finished work: a step rail stalled
 * mid-journey, a deployment checklist for a stack that already exists, a notice
 * that a handoff nobody is waiting on has closed.
 *
 * So it collapses behind one disclosure. Nothing is removed and nothing moves
 * to another page; the operator who needs it opens it, and the operator adding
 * their next account never sees it.
 */
function ConnectionWorkArea({
  children,
  collapsed,
}: {
  readonly children: ReactNode;
  readonly collapsed: boolean;
}) {
  if (!collapsed) return <>{children}</>;
  return (
    <details className="onboard-advanced onboard-connection-details">
      <summary className="onboard-advanced-summary">
        <span>Connection details and trust lifecycle</span>
        <GlyphIcon className="nav-group-chevron" name="chevron" size={11} />
      </summary>
      {children}
    </details>
  );
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
  const [connectionMethod, setConnectionMethod] =
    useState<OnboardConnectionMethod>("iam_role");
  const [roleProvisioningMode, setRoleProvisioningMode] =
    useState<AwsRoleProvisioningMode>("sutra_template");
  // Static-credential secrets live only in this local component state. They
  // are never written to sessionStorage (PendingHandoffDraft), never logged,
  // never rendered back, and are cleared on every submit.
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [registeredAccessKeyLast4, setRegisteredAccessKeyLast4] = useState<string | null>(null);
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
    "create" | "handoff" | "role" | "credentials" | "validate" | "sync" | "disable" | "offboard" | null
  >(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedConnection = state?.connection ?? created?.connection ?? null;
  const liveConnection = selectedConnection !== null && isLiveAwsSourceKind(selectedConnection.sourceKind)
    ? selectedConnection
    : null;
  const connection = liveConnection?.sourceKind === "aws_trust_role" ? liveConnection : null;
  const credentialConnection = liveConnection?.sourceKind === "aws_static_credentials" ? liveConnection : null;
  const effectiveRoleArn = roleArn || connection?.roleArn || "";
  const arnAccount = useMemo(() => effectiveRoleArn.match(/^arn:(?:aws|aws-us-gov|aws-cn):iam::(\d{12}):role\/[A-Za-z0-9+=,.@_\/-]+$/u)?.[1], [effectiveRoleArn]);
  const selectedRoleArn = connection
    ? `arn:${arnPartition(connection.partition)}:iam::${connection.awsAccountId}:role/${connection.expectedRolePath.slice(1)}${connection.expectedRoleName}`
    : null;
  const accountValid = /^\d{12}$/u.test(accountId);
  const onboardPath: OnboardPath = connectionMethod === "static_credentials"
    ? "static_credentials"
    : roleProvisioningMode === "customer_managed"
      ? "customer_managed_role"
      : "sutra_template_role";

  // The card writes both underlying values, so every downstream branch, request
  // body and validation rule keeps reading exactly what it read before.
  function selectOnboardPath(next: OnboardPath): void {
    if (next === "static_credentials") {
      setConnectionMethod("static_credentials");
      return;
    }
    setConnectionMethod("iam_role");
    const mode: AwsRoleProvisioningMode =
      next === "customer_managed_role" ? "customer_managed" : "sutra_template";
    setRoleProvisioningMode(mode);
    setRolePath(SUTRA_ROLE_NAMESPACE);
    setRoleName(mode === "sutra_template" ? SUTRA_TEMPLATE_ROLE_NAME : SUTRA_CUSTOM_ROLE_DEFAULT_NAME);
  }

  const customerManagedRoleError = connectionMethod === "iam_role" && roleProvisioningMode === "customer_managed"
    ? validateCustomerManagedRoleSelection(rolePath, roleName)
    : null;
  const accessKeyIdValid = AWS_ACCESS_KEY_ID_PATTERN.test(accessKeyId);
  const temporaryAccessKey = accessKeyId.startsWith("ASIA");
  const secretAccessKeyValid = secretAccessKey.length === AWS_SECRET_ACCESS_KEY_LENGTH;
  const credentialsValid = accessKeyIdValid && secretAccessKeyValid &&
    (!temporaryAccessKey || sessionToken.trim().length > 0);
  const credentialsRegistered = credentialConnection !== null && credentialConnection.status !== "pending";
  const credentialConnectionDisabled = credentialConnection?.status === "disabled";
  const roleValid = Boolean(
    arnAccount && connection && arnAccount === connection.awsAccountId &&
    selectedRoleArn !== null && effectiveRoleArn === selectedRoleArn,
  );
  const currentStep = liveConnection?.status === "active" || liveConnection?.status === "disabled"
    ? 4
    : connection?.roleArn || credentialsRegistered ? 3 : liveConnection ? 2 : 1;
  const enteringAccessKeys = Boolean(credentialConnection)
    || (!liveConnection && connectionMethod === "static_credentials");
  // Onboarding is finished for this connection once the trust is live. Past that
  // point the page is no longer a wizard, and presenting one -- a step rail
  // stalled at "Step 2 of 4", a deployment checklist for a stack that already
  // exists, a closed-handoff notice -- describes work nobody has left to do. The
  // operational surface still exists below, one disclosure away, because
  // revalidating and offboarding remain real; it just stops being the page.
  const connectionSetupComplete = liveConnection !== null
    && (liveConnection.status === "active" || liveConnection.status === "disabled");
  // The rail states what each step actually proves, so an operator can see why
  // a step exists before reaching it. Step 2's contract differs by grant path:
  // a role is deployed in the customer account, access keys are handed over.
  const wizardSteps: readonly WizardStep[] = [
    { label: "Connection", detail: "Customer, AWS account and grant path" },
    enteringAccessKeys
      ? { label: "Enter access keys", detail: "Register keys the collector stores encrypted" }
      : { label: "Deploy role", detail: "Create the role in the customer account" },
    { label: "Validate trust", detail: "Prove the ExternalId boundary" },
    { label: "Inventory", detail: "Publish the first complete snapshot" },
  ];
  const trustHealth = connection
    ? describeTrustHealth(connection)
    : credentialConnection ? describeStaticCredentialHealth(credentialConnection) : null;
  const collectionHealth = state && liveConnection ? describeLatestCollection(state) : null;
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
    if (connectionMethod === "static_credentials") {
      // The access-key method has no ExternalId handoff to strand, so this
      // branch stores no browser draft and displays no trust value. The keys
      // themselves are collected in the next step and never accompany the
      // create call.
      try {
        const response = await postPilot<CreateConnectionResponse>("/api/pilot/connections", {
          operationId: `onb_${crypto.randomUUID().replaceAll("-", "")}`,
          customerName: normalizedName,
          awsAccountId: accountId,
          partition,
          enabledRegions,
          connectionMethod: "static_credentials",
        });
        setCreated(response);
        setNotice({
          tone: "success",
          title: "Connection contract created",
          message: "Enter the customer's dedicated read-only access keys below. The collector verifies the account with GetCallerIdentity and stores them encrypted; they are never displayed again.",
        });
        await refresh();
      } catch (caught) {
        setError(messageFrom(caught));
        await refresh();
      } finally {
        setBusy(null);
      }
      return;
    }
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

  async function registerCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!credentialConnection || !credentialsValid) return;
    setBusy("credentials");
    setError(null);
    setNotice(null);
    const payload: {
      connectionId: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    } = {
      connectionId: credentialConnection.id,
      accessKeyId,
      secretAccessKey,
    };
    if (temporaryAccessKey) payload.sessionToken = sessionToken;
    // Clear the secrets from component state before the request resolves so
    // they never outlive the submit, whether it succeeds or fails.
    setAccessKeyId("");
    setSecretAccessKey("");
    setSessionToken("");
    try {
      const response = await postPilot<RegisterCredentialsResponse>(
        "/api/pilot/connections/credentials",
        payload,
      );
      if (created) setCreated({ ...created, connection: response.connection });
      setRegisteredAccessKeyLast4(response.verification.accessKeyLast4);
      setNotice({
        tone: "success",
        title: "Access keys verified and stored encrypted",
        message: `AWS returned caller identity ${response.verification.callerIdentityArn} in account ${response.verification.accountId}. Access key ····${response.verification.accessKeyLast4} is stored encrypted by the collector and the first collection job is ${response.collection.status}.`,
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
    if (!liveConnection) return;
    let trustValidatedThisAttempt = false;
    setBusy("validate");
    setError(null);
    setNotice(null);
    try {
      await postPilot("/api/pilot/connections/validate", { connectionId: liveConnection.id });
      trustValidatedThisAttempt = true;
      await refresh();
      setBusy("sync");
      const response = await postPilot<LiveSyncResponse>("/api/pilot/connections/sync", { connectionId: liveConnection.id });
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
        existingTrustWasActive: liveConnection.status === "active",
        hasActiveSnapshot: state?.activeSnapshot !== null && state?.activeSnapshot !== undefined,
      }));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function runSync() {
    if (!liveConnection) return;
    setBusy("sync");
    setError(null);
    setNotice(null);
    try {
      const response = await postPilot<LiveSyncResponse>("/api/pilot/connections/sync", { connectionId: liveConnection.id });
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
        existingTrustWasActive: liveConnection.status === "active",
        hasActiveSnapshot: state?.activeSnapshot !== null && state?.activeSnapshot !== undefined,
      }));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function revalidateTrust() {
    if (!liveConnection) return;
    setBusy("validate");
    setError(null);
    setNotice(null);
    try {
      await postPilot("/api/pilot/connections/validate", { connectionId: liveConnection.id });
      setNotice({
        tone: "success",
        title: credentialConnection ? "Credential binding revalidated" : "Trust boundary revalidated",
        message: credentialConnection
          ? "GetCallerIdentity confirmed the stored encrypted access keys still resolve to the expected AWS account. Inventory was not run by this action."
          : "The expected caller identity and both negative ExternalId probes passed. Inventory was not run by this action.",
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
    if (!liveConnection) return;
    setBusy("disable");
    setError(null);
    setNotice(null);
    try {
      const response = await postPilot<ConnectionLifecycleResponse>(
        "/api/pilot/connections/disable",
        { connectionId: liveConnection.id },
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
    if (!liveConnection || (!reconcileOnly && offboardConfirmation !== liveConnection.awsAccountId)) return;
    setBusy("offboard");
    setError(null);
    setNotice(null);
    try {
      if (!reconcileOnly) {
        await postPilot("/api/auth/mfa/step-up", { code: offboardStepUpCode });
        setOffboardStepUpCode("");
      }
      const response = await postPilot<ConnectionLifecycleResponse>("/api/pilot/connections/offboard", {
        connectionId: liveConnection.id,
        awsAccountId: liveConnection.awsAccountId,
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
          ? credentialConnection
            ? "Sutra and its collector erased the encrypted access keys. CMDB and audit history remain. The customer's IAM access keys still exist in AWS; deactivate and delete them in the IAM console."
            : "Sutra and its collector removed their trust material. CMDB and audit history remain. The customer-owned IAM role is unchanged; delete its CloudFormation stack or remove its trust policy in AWS."
          : credentialConnection
            ? "Sutra removed its control-plane credential material and blocked future work. Restore the collector service and reconcile cleanup. The customer's IAM access keys must still be deactivated and deleted in AWS."
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
        <div><p className="eyebrow">Secure AWS connection</p><h1>Connect your infrastructure</h1><p className="page-subtitle">Create a customer-owned read-only role, prove the ExternalId boundary, then publish a complete CMDB snapshot.</p></div>
        <span className={`status-pill ${collectorMode === "live" ? "status-positive" : "status-medium"}`}>{collectorMode === "live" ? "Live collector" : collectorMode === "fixture" ? "Simulations only" : "Collector checking"}</span>
      </section>

      <div className="onboard-layout">
        <section className="panel onboard-panel">
          {/* The rail is wayfinding for work in progress. Once the trust is
              live there is no next step to point at, so it goes away rather
              than sitting frozen on a finished journey. */}
          <div className={connectionSetupComplete ? "wiz-body" : "wiz-layout"}>
            {connectionSetupComplete ? null : <WizardStepRail current={currentStep} steps={wizardSteps} />}
            <div className="wiz-body">

          {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Checking the AWS workspace…</div> : null}

          {!loading && !liveConnection && collectorMode !== "live" ? (
            <div className="onboard-copy"><p className="eyebrow">Local-only safety boundary</p><h2>AWS trust onboarding is disabled</h2><p>The collector is running in deterministic fixture mode, so Sutra will not create a trust-role connection or contact AWS. Use Simulation runs to exercise the durable queue, CMDB, change history, findings, and exports with clearly labelled local evidence.</p><a className="button button-primary" href="/operations">Open Simulation runs</a></div>
          ) : null}

          {!loading && !liveConnection && collectorMode === "live" && canCreateConnection ? (
            <>
              <form className="onboard-form aws-account-card" onSubmit={createConnection}>
                <h2 className="aws-account-card-title">New AWS Account</h2>
                <label><span>Account Name</span><input value={customerName} maxLength={80} onChange={(event) => setCustomerName(event.target.value)} placeholder="Customer or company name" required /><small>Each connection is bound to one approved customer workspace and one AWS account.</small></label>
                <label><span>AWS account ID</span><input inputMode="numeric" maxLength={12} value={accountId} onChange={(event) => setAccountId(event.target.value.replace(/\D/gu, ""))} aria-invalid={accountId.length > 0 && !accountValid} required /><small>{health?.mode === "fixture" ? "Fixture mode expects 123456789012." : "Exactly 12 digits from the client AWS account."}</small></label>
                {/* The reference presents authentication as two tabs. The tab
                    switches the SAME connectionMethod state the radio cards
                    set, so the wire contract is untouched: IAM Role shows the
                    two role paths, Access & Secret Keys is the key path. */}
                <div aria-label="Authenticate using" className="onboard-method-tabs" role="tablist">
                  <button
                    aria-selected={connectionMethod === "iam_role"}
                    className="onboard-method-tab"
                    onClick={() => selectOnboardPath(roleProvisioningMode === "customer_managed" ? "customer_managed_role" : "sutra_template_role")}
                    role="tab"
                    type="button"
                  >
                    IAM Role
                  </button>
                  <button
                    aria-selected={connectionMethod === "static_credentials"}
                    className="onboard-method-tab"
                    onClick={() => selectOnboardPath("static_credentials")}
                    role="tab"
                    type="button"
                  >
                    Access & Secret Keys
                  </button>
                </div>
                <p className="onboard-guide-link">Check Sutra <a href="/onboard/guide">AWS Start Guide</a>.</p>

                {/* The reference form shows External ID and Role ARN as fields
                    the customer fills in, with a shuffle button that mints a new
                    External ID on demand. Sutra cannot honour either half.
                    The ExternalId is generated by the server, bound to this
                    customer and this AWS account, disclosed exactly once, and
                    never rotated on an active connection -- a client-chosen or
                    client-reshuffled value would defeat the boundary the whole
                    trust model rests on. So both fields keep their place and
                    their labels, and state plainly that they fill themselves in
                    on the next step rather than pretending to accept input. */}
                {connectionMethod === "iam_role" ? <>
                  <label className="contract-field"><span>External ID</span><div className="copy-field"><code className="copy-field-pending">Generated when you continue</code></div><small>Sutra generates this value, binds it to this customer and AWS account, and discloses it once. It is never chosen here, and it is never reshuffled on a connection that already has a registered role.</small></label>
                  <label><span>Role ARN (CloudFormation stack output parameter)</span><input disabled placeholder="Paste this after the stack is created" /><small>The pre-generated template and manual download appear here once Sutra has an External ID to prefill them with.</small></label>
                </> : null}

                <label><span>Partition</span><select value={partition} onChange={(event) => setPartition(event.target.value)}><option value="aws">aws</option><option value="aws-us-gov">aws-us-gov</option><option value="aws-cn">aws-cn</option></select><small>The collector principal and role must use the same partition.</small></label>

                <details className="onboard-advanced">
                  <summary className="onboard-advanced-summary">
                    <span>Advanced options</span>
                    <GlyphIcon className="nav-group-chevron" name="chevron" size={11} />
                  </summary>
                {/* Scope is single-account today. Organization-wide assumption
                    across member accounts is a collector capability, not a form
                    field, so it is shown as unavailable rather than offered and
                    silently ignored. */}
                <WizardRadioGroup
                  legend="Connector scope"
                  name="connector-scope"
                  onChange={() => undefined}
                  options={[
                    { id: "account", label: "Account", description: "Scan the single AWS account entered above." },
                    {
                      id: "organization",
                      label: "Organization",
                      description: "Scan an AWS organization and its member accounts from one role.",
                      unavailable: "The collector assumes one customer role per account. Onboard member accounts individually until organization-wide assumption ships.",
                    },
                  ]}
                  value="account"
                />
                <label><span>Region coverage</span><select value={regionSelectionMode} onChange={(event) => setRegionSelectionMode(event.target.value as AwsRegionSelectionMode)}><option value={ALL_ENABLED_AWS_REGIONS}>All account-enabled Regions (recommended)</option><option value="explicit">Only explicit Regions</option></select><small>After assuming the customer role, Sutra asks AWS which Regions are enabled and records collector coverage against those real Region names.</small></label>
                {regionSelectionMode === "explicit" ? <label><span>Explicit regions</span><input value={regions} onChange={(event) => setRegions(event.target.value)} placeholder="us-east-1, ap-south-1" required /><small>Comma-separated AWS Regions. Sutra fails validation if any selected Region is not enabled; global IAM is collected once.</small></label> : null}
                <fieldset className="onboard-paths">
                  <legend>How will the customer grant access?</legend>
                  {ONBOARD_PATHS.filter((path) => connectionMethod === "static_credentials"
                    ? path.id === "static_credentials"
                    : path.id !== "static_credentials").map((path) => (
                    <label
                      key={path.id}
                      className="onboard-path"
                      data-selected={onboardPath === path.id ? "true" : undefined}
                    >
                      <input
                        type="radio"
                        name="onboard-path"
                        value={path.id}
                        checked={onboardPath === path.id}
                        onChange={() => selectOnboardPath(path.id)}
                      />
                      <span className="onboard-path-body">
                        <b>
                          {path.title}
                          {path.recommended ? <em>Recommended</em> : null}
                        </b>
                        <span className="onboard-path-summary">{path.summary}</span>
                        <span className="onboard-path-traits">
                          {path.traits.map((trait) => <span key={trait}>{trait}</span>)}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                {connectionMethod === "iam_role" ? <>
                {roleProvisioningMode === "customer_managed" ? <>
                  <div className="form-grid">
                    <label><span>Dedicated role path</span><input value={rolePath} maxLength={512} onChange={(event) => setRolePath(event.target.value.trim())} aria-invalid={Boolean(customerManagedRoleError)} placeholder="/sutra/acme/" required /><small>Must remain inside the reserved <code>/sutra/</code> namespace and end with <code>/</code>.</small></label>
                    <label><span>Dedicated role name</span><input value={roleName} maxLength={64} onChange={(event) => setRoleName(event.target.value.trim())} aria-invalid={Boolean(customerManagedRoleError)} placeholder={SUTRA_CUSTOM_ROLE_DEFAULT_NAME} required /><small>Choose a new role used only by this Sutra connection.</small></label>
                  </div>
                  <div className="inline-warning" role={customerManagedRoleError ? "alert" : "note"}><strong>{customerManagedRoleError ? "Role contract needs attention" : "Dedicated customer role required"}</strong><span>{customerManagedRoleError ?? "Existing admin, shared operations, power-user, break-glass, account-access, broader-policy, and wildcard-trust roles are rejected during live attestation. Every accepted session is still intersected with Sutra's fixed read-only STS session policy."}</span></div>
                </> : null}
                </> : <div className="inline-warning" role="note"><strong>Access keys are entered in the next step.</strong><span>After the connection contract exists, Sutra asks for a dedicated read-only IAM user&apos;s access key ID and secret (plus a session token for temporary ASIA keys), verifies the account with GetCallerIdentity, and stores them encrypted in the collector. Keys never accompany this create request.</span></div>}
                {/* Stated, not offered. Every row is verified against the
                    deployed pack YAML by
                    tests/aws-onboarding-role-capabilities.test.mjs, so a row
                    cannot claim a grant the template does not contain.

                    Role paths only. The access-key path deploys no role and
                    enforces no pack policy, so these rows would describe a
                    permission boundary that does not exist for that connection:
                    the IAM user's effective permissions are whatever the
                    customer attached, which may be narrower or broader. */}
                {connectionMethod === "iam_role" ? (
                <details className="wiz-capabilities">
                  <summary className="wiz-capabilities-legend">
                    <span>
                      What permission pack <code>{AWS_CUSTOMER_ROLE_TEMPLATE_VERSION}</code> grants
                    </span>
                    {/* The count of what the pack allows, not of the sample
                        below. "2 of 7 granted" described these rows but read as
                        the permission boundary, understating a role that allows
                        119 actions. */}
                    <em>{ONBOARDING_ROLE_ALLOWED_ACTION_COUNT} actions allowed</em>
                    <GlyphIcon className="nav-group-chevron" name="chevron" size={11} />
                  </summary>
                  {ONBOARDING_ROLE_CAPABILITIES.map((capability) => (
                    <WizardPermissionToggle
                      description={capability.description}
                      key={capability.id}
                      label={capability.label}
                      note={capability.granted
                        ? `Granted by ${AWS_CUSTOMER_ROLE_TEMPLATE_VERSION}: ${capability.actions.join(", ")}`
                        : `Not granted by ${AWS_CUSTOMER_ROLE_TEMPLATE_VERSION}. This capability is not collected.`}
                      state={capability.granted ? "granted" : "unavailable"}
                    />
                  ))}
                  <p className="wiz-capabilities-note">
                    The {ONBOARDING_ROLE_CAPABILITIES.length} capabilities above are selected
                    examples, including ones Sutra is <strong>not</strong> granted — they are not
                    the full pack, which allows {ONBOARDING_ROLE_ALLOWED_ACTION_COUNT} actions in
                    total. The template below is the authoritative list. These are fixed by the
                    pack this connection deploys, not per-connection settings. Permission packs are
                    immutable; a new capability arrives as a successor pack, never as a checkbox
                    here.
                  </p>
                </details>
                ) : (
                  <div className="inline-warning" role="note">
                    <strong>Permissions come from the IAM user, not from a Sutra pack.</strong>
                    <span>
                      This path deploys no role, so no versioned permission pack applies and
                      Sutra cannot state in advance what the credentials may read. Registration
                      proves the account with GetCallerIdentity; it does not attest the key&apos;s
                      policy. Grant the dedicated user read-only access, and expect collection to
                      report each source as unavailable wherever the key cannot read it.
                    </span>
                  </div>
                )}
                </details>
                <div className="aws-account-card-actions">
                  <a className="button button-secondary" href="/welcome#connect">Select another cloud provider</a>
                  <button className="button button-primary" type="submit" disabled={!accountValid || customerName.trim().length < 2 || customerManagedRoleError !== null || (regionSelectionMode === "explicit" && regions.split(",").every((region) => region.trim().length === 0)) || busy !== null}>{busy === "create" ? "Creating secure contract…" : "Continue"}</button>
                </div>
              </form>
            </>
          ) : null}

          {!loading && !liveConnection && collectorMode === "live" && !canCreateConnection ? (
            <div className="onboard-copy">
              <p className="eyebrow">Approval required</p>
              <h2>No assigned company account is ready</h2>
              <p>An organization owner must first create your customer workspace and pending AWS connection, then assign your approved customer-administrator profile to it. You cannot create or discover another client&apos;s account.</p>
              <a className="button button-secondary" href="/access">Review your access</a>
            </div>
          ) : null}

          {connection ? (
            <>
              {/* A finished connection gets a finished answer, not a wizard.
                  What an operator wants here next is almost always another
                  account, so that is what the page offers. */}
              {connectionSetupComplete ? (
                <>
                  <div className="onboard-connected" role="status">
                    <p className="eyebrow">Connected</p>
                    <h2>{connection.customerName} is connected to AWS</h2>
                    <p>
                      AWS account <code>{connection.awsAccountId}</code> · {trustHealth?.label ?? "trust recorded"}.
                      {" "}Collection health, inventory and evidence live on the connection health page.
                    </p>
                    <div className="heading-actions">
                      <a className="button button-secondary" href="/connection-health">Open connection health</a>
                    </div>
                  </div>
                  <ConnectProviderGrid heading="Connect another cloud account" />
                </>
              ) : null}
              <ConnectionWorkArea collapsed={connectionSetupComplete}>
              <div className="onboard-copy"><p className="eyebrow">Step 2 of 4</p><h2>Deploy and register the customer role</h2><p>Use the exact collector principal and ExternalId below with the selected deployment method. Sutra never creates customer access keys, and this recommended role method stores no long-lived customer secret at all. (Only the optional access-key onboarding method stores customer-supplied keys, encrypted in the collector.)</p></div>
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
                {/* The same generated Terraform, inline and copyable, for
                    operators who paste into an existing repository rather than
                    download a file. It is the identical artifact the Download
                    Terraform button writes -- rendered, not re-derived, so the
                    two can never disagree. */}
                <WizardCodeBlock
                  code={customerManagedArtifacts.terraformHcl}
                  filename={`${connection.expectedRoleName}.tf`}
                />
                <ol className="deployment-checklist">
                  <li><b>1</b><span><strong>Create a new dedicated role.</strong> Do not reuse an administrator, power-user, shared operations, break-glass, or AWS account-access role.</span></li>
                  <li><b>2</b><span><strong>Keep trust exact.</strong> The principal must be <code>{principalArn}</code>; account roots, multiple principals, and wildcard trust are rejected.</span></li>
                  <li><b>3</b><span><strong>Preserve the permission ceiling.</strong> Sutra assesses missing metadata capabilities, rejects broader actions and attached managed policies, and applies a restrictive STS session policy on every scan.</span></li>
                  <li><b>4</b><span><strong>Register the resulting ARN.</strong> Use <code>{customerManagedArtifacts.roleArn}</code>. Sutra re-attests trust and permission drift before every collection.</span></li>
                </ol>
                <div className="quick-launch-history-warning"><strong>Handle as a one-time handoff</strong><span>These downloads contain the connection-specific ExternalId. Store them in the customer&apos;s protected infrastructure repository, never in chat or tickets, and delete local copies after deployment if they are not source-controlled securely.</span></div>
              </section> : createdRoleMode === "customer_managed" && canDisplayInitialExternalId ? <div className="inline-warning" role="alert"><strong>Customer-role artifacts are unavailable.</strong><span>The server-returned trust handoff did not pass artifact validation. Do not create or reuse a role; recover the handoff or contact the Sutra operator.</span></div> : null}

              {createdRoleMode === "customer_managed" ? <div className="inline-warning"><strong>Unsafe existing roles are rejected.</strong><span>Sutra accepts only the selected <code>/sutra/…/</code> path and role name with one exact trust statement, one reviewed inline permission contract, no attached managed policies, and the expected dedicated-role tags. Broad permissions on any reused role are not considered acceptable.</span></div> : null}

              {!connectionOffboarded ? <form className="onboard-form aws-account-card role-registration" onSubmit={registerRole}>
                <h2 className="aws-account-card-title">New AWS Account</h2>
                <label><span>Role ARN (CloudFormation stack output parameter)</span><input value={effectiveRoleArn} onChange={(event) => setRoleArn(event.target.value.trim())} placeholder={created ? expectedRoleArn(created) : selectedRoleArn ?? "Dedicated role ARN"} aria-invalid={effectiveRoleArn.length > 0 && !roleValid} required /><small>{effectiveRoleArn.length === 0 ? "Paste the deployment output after the role is created." : !roleValid ? `Use the exact selected dedicated role ARN: ${selectedRoleArn ?? "unavailable"}.` : "Role ARN syntax, account, path, and name match; the server will still attest its exact trust, permissions, and tags."}</small></label>
                {/* The reference offers a prefilled quick-create link OR a manual
                    download, in one sentence under this field. Both are real
                    here, and both are conditional on facts rather than always
                    rendered: the quick-create link exists only while the
                    one-time handoff is open and only for the template path, so
                    it disappears with the handoff instead of outliving it. */}
                {createdRoleMode === "sutra_template" ? (
                  <p className="onboard-template-links">
                    {quickLaunchUrl === null
                      ? <>Download <a href={AWS_CUSTOMER_ROLE_TEMPLATE_PATH} download>this template</a> to create the stack manually.</>
                      : <>Use <a href={quickLaunchUrl} target="_blank" rel="noreferrer">this pre-generated template</a> for quicker stack creation OR download <a href={AWS_CUSTOMER_ROLE_TEMPLATE_PATH} download>this template</a> to create the stack manually.</>}
                  </p>
                ) : null}
                <p className="limitation-note">Your existing MFA-verified Sutra session authorizes this step. Sutra still proves the exact AWS account, role trust, permissions, tags, and incorrect-ExternalId denial before registration commits.</p>
                <div className="aws-account-card-actions">
                  <a className="button button-secondary" href="/welcome#connect">Select another cloud provider</a>
                  <button className="button button-primary" type="submit" disabled={!roleValid || connectionDisabled || busy !== null || collectorMode !== "live"}>{busy === "role" ? "Registering role…" : collectorMode === "live" ? connection.roleArn ? "Verify & update registered role" : "Verify & register customer role" : "Live collector required"}</button>
                </div>
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
              </ConnectionWorkArea>
            </>
          ) : null}

          {credentialConnection ? (
            <>
              {connectionSetupComplete ? (
                <>
                  <div className="onboard-connected" role="status">
                    <p className="eyebrow">Connected</p>
                    <h2>{credentialConnection.customerName} is connected to AWS</h2>
                    <p>
                      AWS account <code>{credentialConnection.awsAccountId}</code> · access keys registered.
                      {" "}Collection health, inventory and evidence live on the connection health page.
                    </p>
                    <div className="heading-actions">
                      <a className="button button-secondary" href="/connection-health">Open connection health</a>
                    </div>
                  </div>
                  <ConnectProviderGrid heading="Connect another cloud account" />
                </>
              ) : null}
              <ConnectionWorkArea collapsed={connectionSetupComplete}>
              <div className="onboard-copy"><p className="eyebrow">Step 2 of 4</p><h2>Enter and register the customer access keys</h2><p>Sutra sends the keys once over this authenticated session to its collector, which proves the AWS account with GetCallerIdentity and stores them encrypted. With this method the collector does store the customer-supplied keys; the IAM role method remains the recommended default. Keys are never echoed back, logged, or kept in this browser.</p></div>
              <div className="connection-contract" aria-label="AWS connection contract">
                <div><small>Customer</small><strong>{credentialConnection.customerName}</strong><span>{credentialConnection.awsAccountId} · {credentialConnection.partition}</span></div>
                <div><small>Region scope</small><strong>{isAllEnabledAwsRegionSelection(credentialConnection.enabledRegions) ? "All" : credentialConnection.enabledRegions.length}</strong><span>{isAllEnabledAwsRegionSelection(credentialConnection.enabledRegions) ? "All account-enabled Regions; discovered at collection time" : credentialConnection.enabledRegions.join(", ")}</span></div>
                <div><small>Connection method</small><strong>Access keys</strong><span>{registeredAccessKeyLast4 ? `Access key ····${registeredAccessKeyLast4}` : credentialsRegistered ? "Encrypted access key registered" : "No access key registered yet"}</span></div>
                <div><small>Credential health</small><strong className={`connection-status connection-${credentialConnection.status}`} title={trustHealth?.detail}>{trustHealth?.label}</strong><span>Validated {formatTimestamp(credentialConnection.lastValidatedAt)}</span></div>
              </div>

              {collectionHealth?.kind === "complete" ? (
                <div className="validation-result" role="status"><span>✓</span><div><strong>Latest inventory: {collectionHealth.title}</strong><p>{collectionHealth.message}</p></div></div>
              ) : collectionHealth && collectionHealth.kind !== "not_started" ? (
                <div className="inline-warning" role="status"><strong>Latest inventory: {collectionHealth.title}</strong><span>{collectionHealth.message}</span></div>
              ) : null}

              {credentialsRegistered && registeredAccessKeyLast4 ? <div className="validation-result" role="status"><span>✓</span><div><strong>Access key ····{registeredAccessKeyLast4} registered</strong><p>The collector verified the caller identity, stored the keys encrypted, and queued the first collection job. Neither key value will ever be displayed again.</p></div></div> : null}

              <form className="onboard-form credentials-registration" onSubmit={registerCredentials} autoComplete="off">
                <label><span>Access key ID</span><input type="password" autoComplete="off" spellCheck={false} maxLength={20} value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value.trim())} aria-invalid={accessKeyId.length > 0 && !accessKeyIdValid} required /><small>AKIA (long-lived) or ASIA (temporary) followed by exactly 16 uppercase letters or digits.</small></label>
                <label><span>Secret access key</span><input type="password" autoComplete="off" spellCheck={false} maxLength={40} value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value.trim())} aria-invalid={secretAccessKey.length > 0 && !secretAccessKeyValid} required /><small>Exactly 40 characters. Sent once, stored encrypted by the collector, never displayed again.</small></label>
                {temporaryAccessKey ? <label><span>Session token</span><input type="password" autoComplete="off" spellCheck={false} value={sessionToken} onChange={(event) => setSessionToken(event.target.value.trim())} required /><small>Required for temporary ASIA keys. Temporary credentials expire on AWS&apos;s schedule and must be re-submitted here after each rotation.</small></label> : null}
                <p className="limitation-note">Use keys from a dedicated read-only IAM user, never root or administrator keys. Sutra proves GetCallerIdentity resolves the keys to account {credentialConnection.awsAccountId} before registration commits, caps every in-memory collector session at 900 seconds, and clears this form on every submit.</p>
                <button className="button button-secondary onboard-submit" type="submit" disabled={!credentialsValid || credentialConnectionDisabled || busy !== null || collectorMode !== "live"}>{busy === "credentials" ? "Verifying & encrypting keys…" : collectorMode === "live" ? credentialsRegistered ? "Verify & rotate access keys" : "Verify & register access keys" : "Live collector required"}</button>
              </form>

              <div className="onboard-validation-action">
                <div><p className="eyebrow">Step 3 of 4</p><h2>{credentialConnection.status === "active" ? "Account binding proven" : "Prove the account binding"}</h2><p>{credentialConnection.status === "active" ? "GetCallerIdentity confirmed the stored encrypted keys resolve to the expected AWS account, and the binding is re-proven on every collector session." : "Sutra proves GetCallerIdentity resolves the stored encrypted keys to the expected AWS account before any collection starts."}</p></div>
                {credentialConnection.status === "active" ? <div className="heading-actions"><button className="button button-secondary" type="button" disabled={busy !== null || collectorMode !== "live"} onClick={() => void revalidateTrust()}>{busy === "validate" ? "Revalidating credentials…" : "Revalidate credentials"}</button><button className="button button-primary" type="button" disabled={busy !== null || collectorMode !== "live"} onClick={() => void runSync()}>{busy === "sync" ? "Collecting AWS metadata…" : collectorMode === "live" ? "Run inventory sync" : "Live collector required"}</button></div> : credentialConnection.status === "disabled" ? <span className="status-pill status-medium">Connection disabled</span> : <button className="button button-primary" type="button" disabled={!credentialsRegistered || busy !== null || collectorMode !== "live"} onClick={() => void validateAndSync()}>{busy === "validate" ? "Validating credentials…" : busy === "sync" ? "Publishing first snapshot…" : collectorMode === "live" ? "Validate credentials & run first sync" : "Live collector required"}</button>}
              </div>

              <section id="connection-lifecycle" className="connection-lifecycle" aria-labelledby="connection-lifecycle-title">
                <div><p className="eyebrow">Trust lifecycle</p><h2 id="connection-lifecycle-title">Control or remove collector access</h2><p>These actions never delete CMDB snapshots. Offboarding erases the encrypted access keys from Sutra and asks the collector to erase its copy. It cannot deactivate the customer&apos;s IAM access keys; deactivate and delete them separately in the AWS IAM console.</p></div>
                <div className="connection-lifecycle-actions">
                  <button className="button button-secondary" type="button" disabled={busy !== null} onClick={() => void disableConnection()}>{busy === "disable" ? credentialConnectionDisabled ? "Reconciling…" : "Disabling…" : credentialConnectionDisabled ? "Reconcile collector disable" : "Disable connection"}</button>
                  <button className="button button-danger" type="button" disabled={busy !== null} onClick={() => setConfirmingOffboard(true)}>Offboard access keys</button>
                </div>
                <div className="inline-warning"><strong>Rotate by re-submitting new keys.</strong><span>Create a new access key on the same dedicated IAM user, submit it through the form above, then deactivate and delete the old key in AWS IAM. Sutra replaces the stored encrypted keys after verification and never displays either value.</span></div>
                {confirmingOffboard ? <div className="offboard-confirmation" role="group" aria-label="Confirm access-key offboarding"><strong>Confirm permanent access-key removal</strong><p>Enter AWS account ID <code>{credentialConnection.awsAccountId}</code> and a fresh authenticator code. Sutra will retain CMDB and audit evidence, but this connection cannot be reactivated. This does not deactivate the customer&apos;s IAM access keys; deactivate and delete them separately in AWS IAM.</p><input aria-label="AWS account ID confirmation" inputMode="numeric" maxLength={12} value={offboardConfirmation} onChange={(event) => setOffboardConfirmation(event.target.value.replace(/\D/gu, ""))} /><input aria-label="Authenticator code" autoComplete="one-time-code" inputMode="numeric" maxLength={6} pattern="[0-9]{6}" value={offboardStepUpCode} onChange={(event) => setOffboardStepUpCode(event.target.value.replace(/\D/gu, ""))} /><div className="heading-actions"><button className="button button-secondary" type="button" disabled={busy !== null} onClick={() => { setConfirmingOffboard(false); setOffboardConfirmation(""); setOffboardStepUpCode(""); }}>Cancel</button><button className="button button-danger" type="button" disabled={busy !== null || offboardConfirmation !== credentialConnection.awsAccountId || !/^\d{6}$/u.test(offboardStepUpCode)} onClick={() => void offboardConnection()}>{busy === "offboard" ? "Removing access keys…" : "Verify & confirm offboarding"}</button></div></div> : null}
              </section>
              </ConnectionWorkArea>
            </>
          ) : null}

          {notice?.tone === "success" ? <div className="validation-result" role="status"><span>✓</span><div><strong>{notice.title}</strong><p>{notice.message}</p></div></div> : null}
          {notice?.tone === "warning" ? <div className="inline-warning" role="status"><strong>{notice.title}</strong><span>{notice.message}</span></div> : null}
          {error ? <div className="validation-result validation-error" role="alert"><span>!</span><div><strong>Action needs attention</strong><p>{error}</p></div></div> : null}
            </div>
          </div>
        </section>

        <aside className="onboard-aside">
          {/* The trust-checklist and credential-path explainers were removed. They
              described the isolation model to an operator who has already bought it,
              and pushed the live collector state below the fold. Isolation is enforced
              in db/pilot-repository.ts, not asserted in the sidebar. */}
          <section className="panel aside-warning"><p className="eyebrow">Collector mode</p><h2>{collectorMode === "live" ? "Connected to AWS" : collectorMode === "fixture" ? "Development fixture environment" : "Collector unavailable"}</h2><p>{collectorMode === "live" ? "Validation and inventory use the configured AWS workload identity. AWS permissions and service availability determine coverage." : collectorMode === "fixture" ? "Development fixture mode cannot create or synchronize AWS trust connections. Every resulting snapshot is labelled as simulated evidence." : "Restore the collector service before creating, validating, or synchronizing an AWS connection. Stored complete snapshots remain readable while it is offline."}</p></section>
        </aside>
      </div>
    </>
  );
}
