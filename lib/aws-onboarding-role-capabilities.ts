/**
 * What the onboarding role actually grants, stated as capabilities.
 *
 * Onboarding deploys exactly one permission pack --
 * `AWS_CUSTOMER_ROLE_TEMPLATE_VERSION` in `lib/aws-template-contract.ts`. There
 * is no per-connection composition and nothing here is switchable: a checkbox
 * offering to "add EKS scanning" would be false twice over, because the pack
 * already grants it and because a connection cannot carry a different pack.
 *
 * This module is presentation only. It authors no permission, widens no
 * allowlist and is not a permission catalog; it reads as a label for actions
 * the immutable pack already enumerates. The permission packs themselves stay
 * exactly as reserved.
 *
 * `tests/aws-onboarding-role-capabilities.test.mjs` pins every row below to the
 * pack YAML that onboarding currently deploys, so a capability cannot claim a
 * grant the template does not contain, and a pack bump re-verifies each row
 * instead of silently invalidating it.
 */

/**
 * How many distinct actions the deployed pack actually allows.
 *
 * The capability rows below are a chosen sample -- the questions customers ask
 * most, including several answered "no" -- not an enumeration of the pack. A
 * badge reading "2 of 7 granted" over them therefore describes the sample, but
 * reads as the permission boundary, and understates a role that allows this many
 * actions by an order of magnitude.
 *
 * `tests/aws-onboarding-role-capabilities.test.mjs` pins this to the count
 * parsed out of the pack YAML, so a pack bump fails the test rather than
 * quietly leaving a stale number on the onboarding page.
 */
export const ONBOARDING_ROLE_ALLOWED_ACTION_COUNT = 119;

export interface OnboardingRoleCapability {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /**
   * The exact actions whose presence in the deployed pack evidences this
   * capability. Every action must be present when `granted` is true, and every
   * action must be absent when it is false -- a partial grant is neither, and
   * the test fails rather than letting the UI round it to one.
   */
  readonly actions: readonly string[];
  readonly granted: boolean;
}

export const ONBOARDING_ROLE_CAPABILITIES: readonly OnboardingRoleCapability[] = Object.freeze([
  {
    id: "eks_cluster_scanning",
    label: "EKS cluster scanning",
    description:
      "Discover EKS clusters and read their configuration and version so Kubernetes posture can be assessed without an in-cluster agent.",
    actions: ["eks:ListClusters", "eks:DescribeCluster", "eks:DescribeClusterVersions"],
    granted: true,
  },
  {
    id: "s3_object_inspection",
    label: "S3 object inspection",
    description:
      "Reading object contents, versions and attributes. The deployed pack names these actions only in the DenyUnimplementedActions ceiling, which permits them to be granted later but grants nothing, so the role cannot read object contents today.",
    actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectAttributes"],
    granted: false,
  },
  {
    id: "guardduty_findings",
    label: "GuardDuty threat findings",
    description:
      "Read existing GuardDuty detectors and findings. Sutra reads what GuardDuty already produced; it does not enable GuardDuty or create detectors.",
    actions: [
      "guardduty:ListDetectors",
      "guardduty:GetDetector",
      "guardduty:ListFindings",
      "guardduty:GetFindings",
    ],
    granted: true,
  },
  {
    id: "billing_export_discovery",
    label: "Billing export discovery",
    description:
      "Enumerating AWS Data Exports and resolving the S3 destination of a CUR 2.0 or FOCUS 1.2 export. The base onboarding role does not grant this; the separate CUR 2.0 add-on stack does, scoped to the export it creates. A customer without that add-on has no billing export discovery.",
    actions: ["bcm-data-exports:ListExports", "bcm-data-exports:GetExport"],
    granted: false,
  },
  {
    id: "lightsail_workload_scanning",
    label: "Lightsail workload scanning",
    description:
      "Scanning Lightsail instances and their attached data. No Lightsail action appears in the deployed pack, so Lightsail workloads are not collected.",
    actions: ["lightsail:GetInstances", "lightsail:GetInstance"],
    granted: false,
  },
  {
    id: "managed_data_classification",
    label: "Managed data classification",
    description:
      "Reading Macie classification results for managed PII and secret discovery. No Macie action appears in the deployed pack.",
    actions: ["macie2:ListFindings", "macie2:GetFindings"],
    granted: false,
  },
  {
    id: "agentless_volume_reads",
    label: "Agentless volume block reads",
    description:
      "Reading EBS snapshot blocks directly from the customer account. Sutra's agentless scanning copies snapshots into its own scan account instead, so the customer role never carries this grant.",
    actions: ["ebs:ListSnapshotBlocks", "ebs:GetSnapshotBlock", "ec2:CreateSnapshot"],
    granted: false,
  },
] as const);
