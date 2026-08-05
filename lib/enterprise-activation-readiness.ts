/**
 * Evidence-honest activation readiness for the product engines that otherwise
 * risk looking "complete" merely because their routes and dashboards exist.
 *
 * This module is deliberately pure. The authenticated API route gathers only
 * scoped counts/timestamps and hands them here; no tenant identifiers, secrets,
 * findings, billing lines, or audit payloads are returned to the browser.
 */

export type EnterpriseReadinessState =
  | "ready"
  | "attention"
  | "blocked"
  | "not_configured";

export interface EnterpriseReadinessDomain {
  readonly key:
    | "finops"
    | "compliance"
    | "notifications"
    | "itsm"
    | "threat_intelligence"
    | "platform_health";
  readonly title: string;
  readonly state: EnterpriseReadinessState;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly actions: readonly string[];
}

export interface EnterpriseActivationReadiness {
  readonly schema: "sutra.enterprise-activation-readiness.v1";
  readonly generatedAt: string;
  readonly connectionId: string;
  readonly overall: EnterpriseReadinessState;
  readonly summary: Readonly<Record<EnterpriseReadinessState, number>>;
  readonly domains: readonly EnterpriseReadinessDomain[];
  readonly disclaimer: string;
}

export interface EnterpriseActivationReadinessInput {
  readonly now: number;
  readonly connectionId: string;
  readonly finops: {
    readonly curPeriodCount: number;
    readonly curLineCount: number;
    readonly costStatus: "COMPLETE" | "PARTIAL" | "UNAVAILABLE" | null;
    readonly costCollectedAt: string | null;
    readonly forecastStatus: "AVAILABLE" | "FALLBACK" | "UNAVAILABLE" | null;
  };
  readonly compliance: {
    readonly snapshotId: string | null;
    readonly snapshotCollectedAt: string | null;
    readonly snapshotCoverageState: "complete" | "partial" | null;
    readonly total: number;
    readonly fail: number;
    readonly unknown: number;
    readonly approvedMfaSignoffCount: number;
  };
  readonly notifications: {
    readonly state: "not_configured" | "healthy" | "degraded" | "blocked";
    readonly enabledDestinations: number;
    readonly configuredDestinations: number;
    readonly actionableJobs: number;
    readonly deadLetter: number;
  };
  readonly itsm: {
    readonly connectorCount: number;
    readonly enabledConnectorCount: number;
    /** True only when every enabled connector row is actually managed-backed. */
    readonly managedSecretBacked: boolean;
    /** Enabled connectors with current-version outbound and authenticated inbound proof. */
    readonly bidirectionallyVerifiedConnectorCount: number;
  };
  readonly threatIntelligence: {
    readonly asOf: string | null;
    readonly cveCount: number;
  };
  readonly platformHealth: {
    readonly overall: "operational" | "degraded" | "down" | "unknown";
  };
}

const HOUR_MS = 60 * 60 * 1_000;
const COST_FRESH_MS = 48 * HOUR_MS;
const SNAPSHOT_FRESH_MS = 24 * HOUR_MS;
const THREAT_FEED_FRESH_MS = 36 * HOUR_MS;

function ageHours(now: number, value: string | null): number | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp > now) return null;
  return Math.floor((now - timestamp) / HOUR_MS);
}

function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

function finopsDomain(input: EnterpriseActivationReadinessInput): EnterpriseReadinessDomain {
  const age = ageHours(input.now, input.finops.costCollectedAt);
  const hasCur = input.finops.curPeriodCount > 0 && input.finops.curLineCount > 0;
  const currentCost =
    input.finops.costStatus === "COMPLETE" &&
    age !== null &&
    age * HOUR_MS <= COST_FRESH_MS;
  const hasForecast =
    input.finops.forecastStatus === "AVAILABLE" ||
    input.finops.forecastStatus === "FALLBACK";

  if (
    input.finops.curPeriodCount === 0 &&
    input.finops.costStatus === null
  ) {
    return {
      key: "finops",
      title: "FinOps data plane",
      state: "not_configured",
      summary: "No CUR period or AWS Cost Explorer snapshot has been ingested for this connection.",
      evidence: ["0 CUR billing periods", "No Cost Explorer snapshot"],
      actions: [
        "Enable AWS Cost Explorer in the payer or management account.",
        "Ingest a current CUR/FOCUS period and run the AWS cost collector.",
      ],
    };
  }

  if (hasCur && currentCost && hasForecast) {
    return {
      key: "finops",
      title: "FinOps data plane",
      state: "ready",
      summary: "Detailed billing, current spend, and forecast evidence are available.",
      evidence: [
        plural(input.finops.curPeriodCount, "CUR period"),
        plural(input.finops.curLineCount, "accepted billing line"),
        `Cost snapshot ${age}h old`,
        `Forecast ${input.finops.forecastStatus?.toLocaleLowerCase("en-US")}`,
      ],
      actions: [],
    };
  }

  return {
    key: "finops",
    title: "FinOps data plane",
    state: input.finops.costStatus === "UNAVAILABLE" ? "blocked" : "attention",
    summary: "FinOps is only partially activated; some cost conclusions remain unavailable or stale.",
    evidence: [
      plural(input.finops.curPeriodCount, "CUR period"),
      plural(input.finops.curLineCount, "accepted billing line"),
      `Cost status ${input.finops.costStatus?.toLocaleLowerCase("en-US") ?? "not collected"}`,
      age === null ? "Cost freshness unknown" : `Cost snapshot ${age}h old`,
      `Forecast ${input.finops.forecastStatus?.toLocaleLowerCase("en-US") ?? "not collected"}`,
    ],
    actions: [
      ...(hasCur ? [] : ["Ingest a current CUR/FOCUS billing period."]),
      ...(currentCost ? [] : ["Run a successful AWS Cost Explorer collection within the 48-hour freshness target."]),
      ...(hasForecast ? [] : ["Grant ce:GetCostForecast and verify Cost Explorer forecast availability."]),
    ],
  };
}

function complianceDomain(input: EnterpriseActivationReadinessInput): EnterpriseReadinessDomain {
  const age = ageHours(input.now, input.compliance.snapshotCollectedAt);
  if (input.compliance.snapshotId === null) {
    return {
      key: "compliance",
      title: "Compliance evidence and review",
      state: "not_configured",
      summary: "No immutable cloud snapshot is available for a compliance assessment.",
      evidence: ["No evidence snapshot", `${input.compliance.total} catalog controls`],
      actions: ["Complete a successful AWS collection before opening an auditor review."],
    };
  }
  const fresh =
    age !== null &&
    age * HOUR_MS <= SNAPSHOT_FRESH_MS;
  const evidenceComplete =
    input.compliance.snapshotCoverageState === "complete" &&
    input.compliance.unknown === 0;
  const reviewed = input.compliance.approvedMfaSignoffCount > 0;
  if (fresh && evidenceComplete && reviewed) {
    return {
      key: "compliance",
      title: "Compliance evidence and review",
      state: "ready",
      summary: "Current, complete evidence has an MFA-verified approval record.",
      evidence: [
        `Snapshot ${age}h old`,
        `${input.compliance.total} controls assessed`,
        plural(input.compliance.fail, "failing control"),
        plural(input.compliance.approvedMfaSignoffCount, "MFA-approved sign-off"),
      ],
      actions: [],
    };
  }
  return {
    key: "compliance",
    title: "Compliance evidence and review",
    state: "attention",
    summary: "Compliance assessment exists, but collection completeness, freshness, or auditor sign-off is unfinished.",
    evidence: [
      age === null ? "Snapshot freshness unknown" : `Snapshot ${age}h old`,
      `Coverage ${input.compliance.snapshotCoverageState ?? "unknown"}`,
      plural(input.compliance.unknown, "unknown control"),
      plural(input.compliance.approvedMfaSignoffCount, "MFA-approved sign-off"),
    ],
    actions: [
      ...(fresh ? [] : ["Collect a new immutable AWS snapshot within the 24-hour evidence target."]),
      ...(evidenceComplete ? [] : ["Resolve incomplete collector coverage and unknown controls."]),
      ...(reviewed ? [] : ["Record an MFA-verified approval against the current report hash."]),
    ],
  };
}

function notificationDomain(input: EnterpriseActivationReadinessInput): EnterpriseReadinessDomain {
  const common = {
    key: "notifications" as const,
    title: "Notification delivery",
    evidence: [
      `${input.notifications.configuredDestinations}/${input.notifications.enabledDestinations} enabled destinations adapter-ready`,
      plural(input.notifications.actionableJobs, "actionable outbox job"),
      plural(input.notifications.deadLetter, "dead-letter job"),
    ],
  };
  if (input.notifications.state === "healthy") {
    return {
      ...common,
      state: "ready",
      summary: "The durable worker and all enabled provider destinations are ready.",
      actions: [],
    };
  }
  if (input.notifications.state === "not_configured") {
    return {
      ...common,
      state: "not_configured",
      summary: "No enabled customer notification destination exists.",
      actions: ["Configure a customer destination and complete one observed test delivery."],
    };
  }
  return {
    ...common,
    state: input.notifications.state === "blocked" ? "blocked" : "attention",
    summary: input.notifications.state === "blocked"
      ? "Provider delivery is blocked by a missing worker or adapter."
      : "Delivery is delayed, retrying, or has dead-lettered work.",
    actions: input.notifications.state === "blocked"
      ? ["Activate the notification worker with workload IAM and managed-secret access."]
      : ["Resolve retrying/dead-lettered jobs and confirm a successful provider receipt."],
  };
}

function itsmDomain(input: EnterpriseActivationReadinessInput): EnterpriseReadinessDomain {
  if (input.itsm.connectorCount === 0) {
    return {
      key: "itsm",
      title: "ITSM synchronization",
      state: "not_configured",
      summary: "No Jira or ServiceNow connector is configured for this customer.",
      evidence: ["0 connectors"],
      actions: ["Configure a Jira or ServiceNow endpoint and validate outbound plus signed inbound synchronization."],
    };
  }
  if (input.itsm.enabledConnectorCount === 0) {
    return {
      key: "itsm",
      title: "ITSM synchronization",
      state: "blocked",
      summary: "ITSM connectors exist, but none is enabled.",
      evidence: [plural(input.itsm.connectorCount, "connector"), "0 enabled"],
      actions: ["Enable one connector and run an end-to-end ticket synchronization."],
    };
  }
  if (!input.itsm.managedSecretBacked) {
    return {
      key: "itsm",
      title: "ITSM synchronization",
      state: "attention",
      summary: "Bidirectional synchronization is implemented, but connector HMAC material is not managed-secret backed.",
      evidence: [
        plural(input.itsm.connectorCount, "connector"),
        plural(input.itsm.enabledConnectorCount, "enabled connector"),
        "Credential storage: application database",
      ],
      actions: ["Move connector credentials to the managed secret service before declaring hosted-production readiness."],
    };
  }
  if (
    input.itsm.bidirectionallyVerifiedConnectorCount !==
    input.itsm.enabledConnectorCount
  ) {
    return {
      key: "itsm",
      title: "ITSM synchronization",
      state: "attention",
      summary: "Managed connectors exist, but current-version bidirectional delivery has not been proven for every enabled connector.",
      evidence: [
        plural(input.itsm.connectorCount, "connector"),
        plural(input.itsm.enabledConnectorCount, "enabled connector"),
        `${input.itsm.bidirectionallyVerifiedConnectorCount}/${input.itsm.enabledConnectorCount} enabled connectors have successful outbound and authenticated inbound evidence after their latest update`,
      ],
      actions: [
        "For every enabled connector, complete one successful outbound ticket delivery and one authenticated inbound case callback after the latest configuration or secret update.",
      ],
    };
  }
  return {
    key: "itsm",
    title: "ITSM synchronization",
    state: "ready",
    summary: "Every enabled connector has managed credentials and current-version bidirectional delivery evidence.",
    evidence: [
      plural(input.itsm.connectorCount, "connector"),
      plural(input.itsm.enabledConnectorCount, "enabled connector"),
      "Credential storage: managed secret service",
      `${input.itsm.bidirectionallyVerifiedConnectorCount}/${input.itsm.enabledConnectorCount} bidirectionally verified`,
    ],
    actions: [],
  };
}

function threatDomain(input: EnterpriseActivationReadinessInput): EnterpriseReadinessDomain {
  const age = ageHours(input.now, input.threatIntelligence.asOf);
  if (input.threatIntelligence.cveCount === 0 || age === null) {
    return {
      key: "threat_intelligence",
      title: "Vulnerability intelligence",
      state: "blocked",
      summary: "No usable vulnerability intelligence mirror is available.",
      evidence: [plural(input.threatIntelligence.cveCount, "mirrored CVE"), "Feed freshness unknown"],
      actions: ["Run the KEV, EPSS, and NVD refresh job and verify its database upsert."],
    };
  }
  const fresh = age * HOUR_MS <= THREAT_FEED_FRESH_MS;
  return {
    key: "threat_intelligence",
    title: "Vulnerability intelligence",
    state: fresh ? "ready" : "attention",
    summary: fresh
      ? "The vulnerability mirror is populated inside the freshness target."
      : "The vulnerability mirror is populated but stale.",
    evidence: [plural(input.threatIntelligence.cveCount, "mirrored CVE"), `Feed ${age}h old`],
    actions: fresh ? [] : ["Restore the scheduled feed refresh and bring the mirror inside the 36-hour target."],
  };
}

function platformDomain(input: EnterpriseActivationReadinessInput): EnterpriseReadinessDomain {
  const state = input.platformHealth.overall === "operational"
    ? "ready"
    : input.platformHealth.overall === "down"
      ? "blocked"
      : "attention";
  return {
    key: "platform_health",
    title: "Platform health evidence",
    state,
    summary: input.platformHealth.overall === "operational"
      ? "Every monitored platform component has a current healthy probe."
      : input.platformHealth.overall === "unknown"
        ? "At least one platform component has no current health evidence."
        : `The public status engine reports ${input.platformHealth.overall} service.`,
    evidence: [`Overall status ${input.platformHealth.overall}`],
    actions: state === "ready" ? [] : ["Restore current healthy probes for every status-page component."],
  };
}

export function buildEnterpriseActivationReadiness(
  input: EnterpriseActivationReadinessInput,
): EnterpriseActivationReadiness {
  if (!Number.isFinite(input.now)) throw new Error("A finite readiness clock is required");
  const domains = [
    finopsDomain(input),
    complianceDomain(input),
    notificationDomain(input),
    itsmDomain(input),
    threatDomain(input),
    platformDomain(input),
  ] as const;
  const summary: Record<EnterpriseReadinessState, number> = {
    ready: 0,
    attention: 0,
    blocked: 0,
    not_configured: 0,
  };
  for (const domain of domains) summary[domain.state] += 1;
  const overall: EnterpriseReadinessState = summary.blocked > 0
    ? "blocked"
    : summary.attention > 0
      ? "attention"
      : summary.not_configured > 0
        ? "not_configured"
        : "ready";
  return {
    schema: "sutra.enterprise-activation-readiness.v1",
    generatedAt: new Date(input.now).toISOString(),
    connectionId: input.connectionId,
    overall,
    summary,
    domains,
    disclaimer:
      "Readiness is derived from current stored evidence and configured delivery paths. It is not a certification, contractual SLA, provider-delivery guarantee, or substitute for an external end-to-end validation.",
  };
}
