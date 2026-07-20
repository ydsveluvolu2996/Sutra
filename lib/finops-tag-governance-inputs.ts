/**
 * Adapter: maps collected CMDB resources + ingested CUR/FOCUS lines + a
 * required-tag policy into the pure tag-governance engine's input.
 *
 * Coverage is measured over COST-ALLOCATABLE resources only — the resource
 * kinds that carry a directly attributable line on the bill (compute, storage,
 * managed data stores, load balancers, registries, clusters). Network metadata
 * (VPCs, subnets, security groups, route tables, gateways, ENIs) and posture-
 * only records (IAM account, GuardDuty, Security Hub, CloudTrail) are excluded
 * because a cost-allocation tag on them does not attribute spend. The included
 * set is disclosed and overridable. Nothing about the tag values is inferred:
 * the resource's collected tags are passed through verbatim.
 */
import type { NormalizedCurLine } from "./finops-cur.ts";
import type { PilotResource } from "./pilot-types.ts";
import type { TagGovernanceInput, TagGovernanceResource } from "./finops-tag-governance.ts";

/** Resource types whose spend is directly cost-allocatable (matched on suffix). */
export const COST_ALLOCATABLE_RESOURCE_TYPES: readonly string[] = [
  "ec2.instance",
  "ec2.volume",
  "ec2.snapshot",
  "ec2.elastic-ip",
  "rds.db-instance",
  "s3.bucket",
  "elasticloadbalancingv2.load-balancer",
  "dynamodb.table",
  "ecr.repository",
  "eks.cluster",
];

export interface TagGovernanceAdapterInput {
  readonly resources: readonly PilotResource[];
  readonly curLines?: readonly NormalizedCurLine[];
  /** Required-tag policy; the engine falls back to its bundled default when omitted. */
  readonly requiredTags?: readonly string[];
  /** Override the cost-allocatable resource-type suffixes (tests / custom scopes). */
  readonly includeResourceTypeSuffixes?: readonly string[];
}

function isCostAllocatable(resource: PilotResource, suffixes: readonly string[]): boolean {
  const type = resource.resourceType.toLowerCase();
  return suffixes.some((suffix) => type === suffix || type.endsWith(`.${suffix}`) || type.endsWith(suffix));
}

export function buildTagGovernanceInputs(input: TagGovernanceAdapterInput): TagGovernanceInput {
  const suffixes = input.includeResourceTypeSuffixes ?? COST_ALLOCATABLE_RESOURCE_TYPES;
  const resources: TagGovernanceResource[] = [];
  for (const resource of input.resources) {
    if (!isCostAllocatable(resource, suffixes)) continue;
    resources.push({
      resourceKey: resource.resourceKey,
      service: resource.service.length > 0 ? resource.service : null,
      region: resource.region.length > 0 ? resource.region : null,
      tags: resource.tags,
    });
  }
  return {
    resources,
    ...(input.curLines === undefined ? {} : { curLines: input.curLines }),
    ...(input.requiredTags === undefined ? {} : { requiredTags: input.requiredTags }),
  };
}
