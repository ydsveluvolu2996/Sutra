/**
 * Onboarding-time view of which FinOps dashboards an onboarded AWS account can
 * feed, and what it takes to actually feed them.
 *
 * Every fact here is derived from an existing declaration:
 *
 * - the dashboard identity, level, glyph and tone come from
 *   `lib/finops-dashboard-catalog.ts`;
 * - the capability-to-source mapping comes from `FINOPS_CAPABILITY_DEFINITIONS`
 *   in `lib/finops-source-health.ts`;
 * - what each source actually reads, and whether a provider evidence adapter
 *   and a dashboard report builder are registered, come from
 *   `lib/finops-source-runtime-registry.ts`;
 * - the permission-pack version a source needs is the immutable successor pack
 *   whose CloudFormation `Metadata.SutraPermissionPack` first declares that
 *   source contract, and the set of successor packs this build's collector will
 *   accept at all is the set of pack constants exported by
 *   `services/aws-collector/src/types.ts`;
 * - the role template this onboarding screen actually hands the customer is
 *   `AWS_CUSTOMER_ROLE_TEMPLATE_VERSION` from `lib/aws-template-contract.ts`.
 *
 * Nothing here is a health signal. This module deliberately cannot report a
 * dashboard as collecting: onboarding proves a trust boundary, not a delivered
 * export. Live per-tenant source health is computed only by
 * `buildFinopsSourceReadiness` from persisted evidence.
 */
import { AWS_CUSTOMER_ROLE_TEMPLATE_VERSION } from "../../lib/aws-template-contract";
import {
  FINOPS_DASHBOARD_CATALOG,
  type FinopsDashboardCatalogEntry,
  type FinopsDashboardLevel,
} from "../../lib/finops-dashboard-catalog";
import {
  FINOPS_CAPABILITY_DEFINITIONS,
  FINOPS_SOURCE_DEFINITIONS,
  type FinopsCapabilityId,
  type FinopsSourceId,
} from "../../lib/finops-source-health";
import {
  getFinopsCapabilityRuntime,
  getFinopsSourceRuntimeBinding,
  type FinopsRuntimeTransport,
} from "../../lib/finops-source-runtime-registry";
import {
  ADVANCED_FINOPS_PERMISSION_PACK_VERSION,
  AWS_HEALTH_PERMISSION_PACK_VERSION,
  AWS_SUPPORT_CASES_PERMISSION_PACK_VERSION,
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
  COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION,
  DCF_STEP_FUNCTIONS_PERMISSION_PACK_VERSION,
  END_USER_COMPUTING_PERMISSION_PACK_VERSION,
  EXTENDED_SUPPORT_PERMISSION_PACK_VERSION,
  FOUNDATIONAL_FINOPS_PERMISSION_PACK_VERSION,
  GRAVITON_SAVINGS_PERMISSION_PACK_VERSION,
  ORGANIZATION_FINOPS_PERMISSION_PACK_VERSION,
  RESILIENCE_VUE_PERMISSION_PACK_VERSION,
} from "../../services/aws-collector/src/types";

/** Pack version the CloudFormation role this screen deploys actually pins. */
export const ONBOARDING_TEMPLATE_PACK_VERSION = AWS_CUSTOMER_ROLE_TEMPLATE_VERSION;

/**
 * Successor packs whose exact action sets exist in this build. A connection can
 * only be recorded against a pack the collector's `PermissionPackVersion` union
 * accepts, so a required pack outside this set cannot collect at all yet.
 */
export const ACCEPTED_SUCCESSOR_PACK_VERSIONS: readonly string[] = Object.freeze([
  FOUNDATIONAL_FINOPS_PERMISSION_PACK_VERSION,
  ORGANIZATION_FINOPS_PERMISSION_PACK_VERSION,
  ADVANCED_FINOPS_PERMISSION_PACK_VERSION,
  COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION,
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
  EXTENDED_SUPPORT_PERMISSION_PACK_VERSION,
  AWS_SUPPORT_CASES_PERMISSION_PACK_VERSION,
  AWS_HEALTH_PERMISSION_PACK_VERSION,
  RESILIENCE_VUE_PERMISSION_PACK_VERSION,
  DCF_STEP_FUNCTIONS_PERMISSION_PACK_VERSION,
  END_USER_COMPUTING_PERMISSION_PACK_VERSION,
  GRAVITON_SAVINGS_PERMISSION_PACK_VERSION,
]);

const SUCCESSOR_PATTERN = /^standard-2026-08\.(\d+)$/u;

function successorOrdinal(version: string): number {
  const ordinal = SUCCESSOR_PATTERN.exec(version)?.[1];
  if (ordinal === undefined) throw new Error(`Not a 2026-08 successor pack: ${version}`);
  return Number(ordinal);
}

/** Highest successor pack this build's collector will accept for a connection. */
export const ACCEPTED_SUCCESSOR_PACK_CEILING = ACCEPTED_SUCCESSOR_PACK_VERSIONS
  .reduce((highest, version) =>
    successorOrdinal(version) > successorOrdinal(highest) ? version : highest);

export interface FinopsOnboardingPackRequirement {
  readonly version: string;
  readonly ordinal: number;
  /** True when this build's collector accepts a connection at this pack. */
  readonly accepted: boolean;
  /** True when the template this screen deploys already grants it. Never true
   * today: onboarding pins the base inventory pack, not a FinOps successor. */
  readonly deployedByOnboardingTemplate: boolean;
}

function pack(version: string): FinopsOnboardingPackRequirement {
  return {
    version,
    ordinal: successorOrdinal(version),
    accepted: ACCEPTED_SUCCESSOR_PACK_VERSIONS.includes(version),
    deployedByOnboardingTemplate: version === ONBOARDING_TEMPLATE_PACK_VERSION,
  };
}

export type FinopsOnboardingGrant =
  | {
      readonly kind: "successor_pack";
      readonly pack: FinopsOnboardingPackRequirement;
      /** Source contract declared by that template's `AdvancedFinopsSources`
       * or `FoundationalFinopsAddOn` metadata. Null when the pack is only a
       * minimum accepted ceiling and no contract names this source. */
      readonly contractId: string | null;
      readonly note?: string;
    }
  | {
      readonly kind: "reserved_pack";
      readonly pack: FinopsOnboardingPackRequirement;
      readonly reservedFor: string;
    }
  | { readonly kind: "unassigned_pack"; readonly reason: string }
  | { readonly kind: "no_aws_permission"; readonly reason: string };

/**
 * Source contract and successor pack for each of the 25 declared sources.
 *
 * A `successor_pack` entry names the pack whose immutable template metadata
 * first declares that contract. A `reserved_pack` entry names the successor
 * reserved for that vertical in the FinOps handover, which this build's
 * collector does not accept yet. An `unassigned_pack` entry means no template
 * declares a contract for the source at all.
 */
const SOURCE_GRANTS: Readonly<Record<FinopsSourceId, FinopsOnboardingGrant>> = {
  aws_cur2_data_export: {
    kind: "successor_pack",
    pack: pack(FOUNDATIONAL_FINOPS_PERMISSION_PACK_VERSION),
    contractId: "foundational-cur2-export-v1",
    note: "The base role only opens its deny ceiling. Exact bucket, prefix and export ARN come from a separately attested immutable add-on.",
  },
  aws_focus_1_2_data_export: {
    kind: "reserved_pack",
    pack: pack("standard-2026-08.19"),
    reservedFor: "ADD-04 FOCUS",
  },
  trusted_advisor_organization: {
    kind: "unassigned_pack",
    reason: "No permission pack declares a Trusted Advisor Priority organization contract. The Priority APIs also need a qualifying Support plan and delegated-administrator access, so they stay supplemental.",
  },
  trusted_advisor_standard_checks: {
    kind: "successor_pack",
    pack: pack(ORGANIZATION_FINOPS_PERMISSION_PACK_VERSION),
    contractId: "trusted-advisor-standard-v1",
  },
  compute_optimizer_organization_export: {
    kind: "successor_pack",
    pack: pack(ADVANCED_FINOPS_PERMISSION_PACK_VERSION),
    contractId: "compute-optimizer-export-discovery-v1",
    note: `Discovery only. Reading export objects needs ${COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION} with compute-optimizer-export-read-v1, and launching exports needs ${COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION} with compute-optimizer-export-launch-v1.`,
  },
  cost_anomaly_detection: {
    kind: "successor_pack",
    pack: pack(ORGANIZATION_FINOPS_PERMISSION_PACK_VERSION),
    contractId: "cost-anomaly-v1",
  },
  extended_support_inventory: {
    kind: "successor_pack",
    pack: pack(EXTENDED_SUPPORT_PERMISSION_PACK_VERSION),
    contractId: "extended-support-projection-v1",
  },
  aws_health_organization: {
    kind: "successor_pack",
    pack: pack(AWS_HEALTH_PERMISSION_PACK_VERSION),
    contractId: "health-events-v1",
  },
  aws_news_feeds: {
    kind: "no_aws_permission",
    reason: "Public AWS feeds are fetched over a bounded HTTPS allowlist. No customer IAM permission is requested, and none is granted by onboarding.",
  },
  aws_budgets: {
    kind: "unassigned_pack",
    reason: "No permission pack declares an AWS Budgets source contract yet; the customer-role rollout for this reader is still outstanding.",
  },
  aws_support_cases_organization: {
    kind: "successor_pack",
    pack: pack(AWS_SUPPORT_CASES_PERMISSION_PACK_VERSION),
    contractId: "support-cases-radar-v1",
    note: "AWS Support exposes account-local cases only, so organization coverage needs explicit tenant-pinned account fan-out.",
  },
  aws_resilience_hub: {
    kind: "successor_pack",
    pack: pack(RESILIENCE_VUE_PERMISSION_PACK_VERSION),
    contractId: "resilience-vue-v1",
  },
  end_user_computing_telemetry: {
    kind: "successor_pack",
    pack: pack(END_USER_COMPUTING_PERMISSION_PACK_VERSION),
    contractId: "end-user-computing-v1",
  },
  data_collection_telemetry: {
    kind: "successor_pack",
    pack: pack(DCF_STEP_FUNCTIONS_PERMISSION_PACK_VERSION),
    contractId: "data-collection-monitor-v1",
    note: "Step Functions reads are scoped to the exact server-declared DCF state machines supplied as stack parameters.",
  },
  media_services_telemetry: {
    kind: "unassigned_pack",
    reason: "No permission pack declares a media-services source contract. The required IAM additions must be audited before any successor version is assigned.",
  },
  cost_optimization_hub_export: {
    kind: "reserved_pack",
    pack: pack("standard-2026-08.14"),
    reservedFor: "ADD-01 CORA",
  },
  aws_marketplace_intelligence: {
    kind: "reserved_pack",
    pack: pack("standard-2026-08.13"),
    reservedFor: "ADD-05 Marketplace SPG",
  },
  kubecost_allocation: {
    kind: "successor_pack",
    pack: pack(RESILIENCE_VUE_PERMISSION_PACK_VERSION),
    contractId: null,
    note: `No dedicated pack or source contract is created for Kubecost. The collector reads a tenant-pinned exporter prefix under an explicit known-pack allowlist starting at ${RESILIENCE_VUE_PERMISSION_PACK_VERSION}. The per-cluster exporter identity that writes those objects is never the Sutra collector.`,
  },
  scad_allocation: {
    kind: "successor_pack",
    pack: pack(FOUNDATIONAL_FINOPS_PERMISSION_PACK_VERSION),
    contractId: "foundational-cur2-export-v1",
    note: "No dedicated pack is created for Split Cost Allocation Data: it reuses the exact CUR 2.0 export contract. AWS does not backfill data from before SCAD is enabled.",
  },
  aws_carbon_footprint: {
    kind: "reserved_pack",
    pack: pack("standard-2026-08.15"),
    reservedFor: "ADD-08 Sustainability",
  },
  amazon_connect_telemetry: {
    kind: "reserved_pack",
    pack: pack("standard-2026-08.16"),
    reservedFor: "ADD-11 Amazon Connect",
  },
  aws_config_organization_aggregator: {
    kind: "reserved_pack",
    pack: pack("standard-2026-08.18"),
    reservedFor: "ADD-12 Config Compliance",
  },
  aws_pricing_catalog: {
    kind: "reserved_pack",
    pack: pack("standard-2026-08.17"),
    reservedFor: "ADD-13 Pricing Change",
  },
  aws_organizations_taxonomy: {
    kind: "successor_pack",
    pack: pack(ORGANIZATION_FINOPS_PERMISSION_PACK_VERSION),
    contractId: "organizations-taxonomy-v1",
  },
  sutra_billing_workspace: {
    kind: "no_aws_permission",
    reason: "Sutra's own persisted billing workspace. It reads nothing from the customer account and is never evidence that an AWS export arrived.",
  },
};

/**
 * Capability-level source contracts. A vertical can need its own successor pack
 * even when every source it reads is already granted.
 */
const CAPABILITY_PACKS: Partial<Readonly<Record<FinopsCapabilityId, FinopsOnboardingGrant>>> = {
  graviton_savings: {
    kind: "successor_pack",
    pack: pack(GRAVITON_SAVINGS_PERMISSION_PACK_VERSION),
    contractId: "graviton-savings-v1",
  },
};

export const FINOPS_ONBOARDING_SOURCE_GRANTS = Object.freeze(SOURCE_GRANTS);
export const FINOPS_ONBOARDING_CAPABILITY_GRANTS = Object.freeze(CAPABILITY_PACKS);

export interface FinopsOnboardingSourceView {
  readonly sourceId: FinopsSourceId;
  readonly name: string;
  readonly kind: string;
  readonly transport: FinopsRuntimeTransport;
  readonly freshnessSlaHours: number;
  /** Exact IAM actions when the contract fixes them, else null. */
  readonly operations: readonly string[] | null;
  /** Declaration that owns the operation list when it is not inlined. */
  readonly operationDeclarations: readonly string[] | null;
  readonly readsCustomerAccount: boolean;
  /** False when no provider evidence adapter is registered for the source. */
  readonly adapterRegistered: boolean;
  readonly grant: FinopsOnboardingGrant;
}

export type FinopsOnboardingDashboardState =
  | "awaiting_pack_deployment"
  | "pack_unavailable"
  | "not_aws_backed";

export interface FinopsOnboardingDashboardView {
  readonly catalogId: string;
  readonly slug: string;
  readonly shortName: string;
  readonly name: string;
  readonly icon: FinopsDashboardCatalogEntry["icon"];
  readonly tone: FinopsDashboardCatalogEntry["tone"];
  readonly level: FinopsDashboardLevel;
  readonly provider: FinopsDashboardCatalogEntry["provider"];
  readonly maturity: FinopsDashboardCatalogEntry["currentMaturity"];
  readonly documentationUrl: string;
  readonly state: FinopsOnboardingDashboardState;
  readonly stateLabel: string;
  /** Highest pack this dashboard needs, or null when it is not AWS-backed. */
  readonly requiredPack: FinopsOnboardingPackRequirement | null;
  readonly requiredSources: readonly FinopsOnboardingSourceView[];
  readonly supplementalSources: readonly FinopsOnboardingSourceView[];
  /** Plain reasons this dashboard is not collecting yet. Never empty. */
  readonly blockers: readonly string[];
}

export interface FinopsOnboardingLevelGroup {
  readonly level: FinopsDashboardLevel;
  readonly label: string;
  readonly dashboards: readonly FinopsOnboardingDashboardView[];
}

export interface FinopsOnboardingCoverage {
  readonly templatePackVersion: string;
  readonly acceptedPackCeiling: string;
  readonly levels: readonly FinopsOnboardingLevelGroup[];
  readonly summary: {
    readonly awsBackedDashboards: number;
    readonly collectingNow: number;
    readonly awaitingPackDeployment: number;
    readonly packUnavailable: number;
    readonly notAwsBacked: number;
    readonly customerAccountSources: number;
  };
}

const LEVEL_LABEL: Readonly<Record<FinopsDashboardLevel, string>> = {
  foundational: "Foundational",
  advanced: "Advanced",
  additional: "Additional",
};

const LEVEL_ORDER: readonly FinopsDashboardLevel[] = ["foundational", "advanced", "additional"];

function sourceView(sourceId: FinopsSourceId): FinopsOnboardingSourceView {
  const definition = FINOPS_SOURCE_DEFINITIONS.find((entry) => entry.id === sourceId);
  if (definition === undefined) throw new Error(`Unknown FinOps source: ${sourceId}`);
  const binding = getFinopsSourceRuntimeBinding(sourceId);
  const operationSet = binding.queryContract.operationSet;
  return {
    sourceId,
    name: definition.name,
    kind: definition.kind,
    transport: binding.queryContract.transport,
    freshnessSlaHours: definition.freshnessSlaHours,
    operations: operationSet.kind === "fixed_operations" ? operationSet.operations : null,
    operationDeclarations: operationSet.kind === "code_references"
      ? operationSet.references.map((reference) => reference.exportName)
      : null,
    readsCustomerAccount: operationSet.kind !== "no_provider_operation",
    adapterRegistered: binding.evidenceAdapter.kind === "code_reference",
    grant: SOURCE_GRANTS[sourceId],
  };
}

function grantPack(grant: FinopsOnboardingGrant): FinopsOnboardingPackRequirement | null {
  return grant.kind === "successor_pack" || grant.kind === "reserved_pack" ? grant.pack : null;
}

function highestPack(
  grants: readonly FinopsOnboardingGrant[],
): FinopsOnboardingPackRequirement | null {
  return grants
    .map(grantPack)
    .filter((requirement): requirement is FinopsOnboardingPackRequirement => requirement !== null)
    .reduce<FinopsOnboardingPackRequirement | null>(
      (highest, requirement) =>
        highest === null || requirement.ordinal > highest.ordinal ? requirement : highest,
      null,
    );
}

function dashboardView(entry: FinopsDashboardCatalogEntry): FinopsOnboardingDashboardView {
  const definition = FINOPS_CAPABILITY_DEFINITIONS.find((candidate) => candidate.id === entry.id);
  const base = {
    catalogId: entry.catalogId,
    slug: entry.slug,
    shortName: entry.shortName,
    name: entry.name,
    icon: entry.icon,
    tone: entry.tone,
    level: entry.level,
    provider: entry.provider,
    maturity: entry.currentMaturity,
    documentationUrl: entry.documentationUrl,
  };

  if (definition === undefined) {
    // ADD-02 Azure and ADD-03 GCP are official catalog entries with no AWS
    // capability. An AWS trust role cannot prove either provider is connected,
    // so onboarding this account feeds neither of them.
    return {
      ...base,
      state: "not_aws_backed",
      stateLabel: "Not fed by an AWS account",
      requiredPack: null,
      requiredSources: [],
      supplementalSources: [],
      blockers: [
        `${entry.provider === "azure" ? "Azure" : "GCP"} billing exports are a separate provider contract. This AWS role grants no access to them, and Sutra will not infer coverage from an AWS connection.`,
      ],
    };
  }

  const runtime = getFinopsCapabilityRuntime(definition.id);
  const requiredSources = definition.requiredSourceIds.map(sourceView);
  const supplementalSources = definition.supplementalSourceIds.map(sourceView);
  const capabilityGrant = CAPABILITY_PACKS[definition.id] ?? null;
  const grants = [
    ...requiredSources.map((source) => source.grant),
    ...(capabilityGrant === null ? [] : [capabilityGrant]),
  ];
  const requiredPack = highestPack(grants);

  const blockers: string[] = [];
  const unavailable = grants.filter((grant) =>
    grant.kind === "unassigned_pack" || (grant.kind === "reserved_pack" && !grant.pack.accepted));

  for (const source of requiredSources) {
    const grant = source.grant;
    if (grant.kind === "unassigned_pack") {
      blockers.push(`${source.name}: ${grant.reason}`);
    } else if (grant.kind === "reserved_pack" && !grant.pack.accepted) {
      blockers.push(
        `${source.name} needs permission pack ${grant.pack.version}, reserved for ${grant.reservedFor}. This build's collector accepts successor packs only through ${ACCEPTED_SUCCESSOR_PACK_CEILING}, so a connection cannot be recorded or attested at that pack yet and no data can flow.`,
      );
    } else if (grant.kind === "successor_pack" && !grant.pack.deployedByOnboardingTemplate) {
      blockers.push(
        `${source.name} needs permission pack ${grant.pack.version}${grant.contractId === null ? "" : ` (source contract ${grant.contractId})`}. The role template this screen deploys pins ${ONBOARDING_TEMPLATE_PACK_VERSION}, so the customer must deploy that successor before any data is read.`,
      );
    }
    if (!source.adapterRegistered) {
      blockers.push(
        `${source.name} has no registered provider evidence adapter in this build, so Sutra cannot record a delivery for it even with the permissions granted.`,
      );
    }
  }

  if (capabilityGrant?.kind === "successor_pack" && capabilityGrant.contractId !== null) {
    blockers.push(
      `This dashboard's own source contract ${capabilityGrant.contractId} is granted only by permission pack ${capabilityGrant.pack.version}.`,
    );
  }

  if (runtime.processor.kind === "deferred") {
    blockers.push(
      "The capability report builder is not bound in this build, so collected evidence would not reach this dashboard yet.",
    );
  }

  const state: FinopsOnboardingDashboardState = unavailable.length > 0
    ? "pack_unavailable"
    : "awaiting_pack_deployment";

  return {
    ...base,
    state,
    stateLabel: state === "pack_unavailable"
      ? "Not collecting — permission pack unavailable"
      : "Not collecting — permission pack not deployed",
    requiredPack,
    requiredSources,
    supplementalSources,
    blockers,
  };
}

/**
 * Build the complete onboarding coverage view for the official catalog.
 *
 * `collectingNow` is structurally zero: onboarding deploys the base inventory
 * pack and proves a trust boundary. No dashboard collects until its successor
 * pack is deployed and a delivery is actually observed.
 */
export function buildFinopsOnboardingCoverage(): FinopsOnboardingCoverage {
  const dashboards = FINOPS_DASHBOARD_CATALOG.map(dashboardView);
  const awsBacked = dashboards.filter((dashboard) => dashboard.state !== "not_aws_backed");
  const customerAccountSources = new Set(
    awsBacked
      .flatMap((dashboard) => [...dashboard.requiredSources, ...dashboard.supplementalSources])
      .filter((source) => source.readsCustomerAccount)
      .map((source) => source.sourceId),
  );
  return {
    templatePackVersion: ONBOARDING_TEMPLATE_PACK_VERSION,
    acceptedPackCeiling: ACCEPTED_SUCCESSOR_PACK_CEILING,
    levels: LEVEL_ORDER.map((level) => ({
      level,
      label: LEVEL_LABEL[level],
      dashboards: dashboards.filter((dashboard) => dashboard.level === level),
    })),
    summary: {
      awsBackedDashboards: awsBacked.length,
      collectingNow: 0,
      awaitingPackDeployment: dashboards
        .filter((dashboard) => dashboard.state === "awaiting_pack_deployment").length,
      packUnavailable: dashboards.filter((dashboard) => dashboard.state === "pack_unavailable").length,
      notAwsBacked: dashboards.filter((dashboard) => dashboard.state === "not_aws_backed").length,
      customerAccountSources: customerAccountSources.size,
    },
  };
}

const TRANSPORT_LABEL: Readonly<Record<FinopsRuntimeTransport, string>> = {
  aws_api_broker: "Read-only AWS API calls through the signed collector broker",
  bounded_s3_export: "Bounded reads of an exact S3 export prefix",
  public_https_allowlist: "Bounded public HTTPS allowlist — no customer account access",
  persisted_internal: "Sutra's own persisted evidence — nothing is read from AWS",
};

export function describeTransport(transport: FinopsRuntimeTransport): string {
  return TRANSPORT_LABEL[transport];
}

/** Short, non-invented description of what a source reads from the account. */
export function describeSourceReads(source: FinopsOnboardingSourceView): string {
  if (!source.readsCustomerAccount) return describeTransport(source.transport);
  if (source.operations !== null) {
    return `${source.operations.length} exact read action${source.operations.length === 1 ? "" : "s"}: ${source.operations.join(", ")}`;
  }
  const declarations = source.operationDeclarations ?? [];
  return `Exact read actions declared by ${declarations.join(", ")}`;
}
