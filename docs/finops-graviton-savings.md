# AWS Graviton savings evidence engine

## Scope and trust boundary

`lib/finops-graviton-savings.ts` is a pure, server-pinned projection boundary.
It performs no network, database, credential, provisioning, or remediation work
and retains no tenant state in process globals. Its caller must pin the Sutra
organization, customer, AWS connection, management account, account allowlist,
partition, and Region allowlist from authenticated server state.

The engine supports Compute Optimizer evidence for EC2 instances, EC2 Auto
Scaling groups, and Aurora or RDS DB instances. Aurora cluster-storage
recommendations are deliberately excluded because the Graviton selector is
available only on the database **Instance** view, not the Storage view. The
engine never treats an
instance-family string containing a familiar Graviton suffix as compatibility
evidence. The recommendation must explicitly record the Compute Optimizer
`AWS_ARM64` CPU-vendor/architecture preference.

AWS documents that `AWS_ARM64` causes EC2 and Auto Scaling recommendation APIs
and exports to return Graviton instance types, and describes the same preference
for supported database recommendations:

- <https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_RecommendationPreferences.html>
- <https://docs.aws.amazon.com/compute-optimizer/latest/ug/graviton-recommendations.html>
- <https://docs.aws.amazon.com/compute-optimizer/latest/ug/rds-view-recommendations.html>

## Required evidence

A modeled opportunity is emitted only when all of the following resolve to the
same tenant-pinned resource and immutable collection:

1. an explicit AWS Compute Optimizer `AWS_ARM64` recommendation;
2. current inventory from the appropriate AWS read API;
3. versioned target instance metadata that explicitly says `ARM64`;
4. one affirmative compatibility assessment for each of architecture, OS/AMI,
   licensing, workload, and service-feature support;
5. a canonical CUR2 public On-Demand-equivalent cost and usage record for one
   exact billing period;
6. current and target public On-Demand prices from versioned AWS price lists,
   both effective for the complete billing period; and
7. exact reconciliation of the current price multiplied by CUR2 usage to the
   canonical CUR2 public cost basis.

AWS states that inferred workload type uses resource attributes such as names,
tags, and configuration and helps estimate migration effort. That inference is
useful evidence but is not treated here as proof that an OS image, license,
binary, dependency, or service feature is Arm-compatible:

- <https://docs.aws.amazon.com/compute-optimizer/latest/ug/inferred-workload-type.html>
- <https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_InstanceRecommendationOption.html>

The compatibility matrix therefore requires explicit, dimension-specific
evidence. Missing dimensions produce `*_EVIDENCE_REQUIRED`; incompatible
dimensions produce `*_INCOMPATIBLE`; and evidence requiring human validation
produces `*_REVIEW_REQUIRED`. A blocked or configuration-required resource has
no Sutra modeled-potential savings value.

## Money, periods, and claims

All input and output money and hourly quantities are decimal strings in integer
millionths. Arithmetic uses exact integer operations with an explicit
half-micro rounding rule. Floating-point money is not used.

Three values remain intentionally separate:

- `AWS_COMPUTE_OPTIMIZER_ESTIMATE` is AWS's monthly provider estimate and keeps
  its `MONTH` period and provenance. AWS documents that this estimate requires
  Cost Explorer integration and is based on historical usage and pricing:
  <https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_SavingsOpportunity.html>
- `MODELED_POTENTIAL` uses one exact CUR2 billing period and versioned public
  On-Demand prices. It assumes unchanged billed usage hours, excludes migration
  implementation cost, and is explicitly not a savings promise.
- `MEASURED_REALIZED` is emitted only for equal-duration, equal-billed-hour
  pre/post periods using canonical `OBSERVED_EFFECTIVE` CUR2 costs, an observed
  Arm target, and affirmative comparable-workload evidence. A cost increase is
  reported separately and is never converted to a negative savings claim.

Totals are grouped by exact period start, period end, and currency. The engine
never adds different currencies or periods. AWS's price-list API requires an
effective date and currency and returns versioned price-list references; Sutra
preserves those identifiers and effective dates:

- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_pricing_ListPriceLists.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_pricing_GetPriceListFileUrl.html>

## Bounds and privacy

The contract enforces exact object shapes, generic error codes, strict capture
and response byte limits, a 15-minute collection duration, bounded accounts,
Regions, records, evidence references, 24 history records per resource, 400
days of history, and 5,000 response opportunities. Exact duplicates collapse;
conflicting IDs fail closed. Output ordering and totals are deterministic.

Credential-shaped fields are rejected recursively. Raw provider exceptions,
customer-authored free text, credentials, client-selected tenant identifiers,
and unbounded evidence cannot cross this boundary.

## Remaining production gates

This bounded slice provides normalization, projection, focused tests, and this
contract only. It does not make the dashboard production-ready. Acceptance
still requires:

1. exact version-pinned collector permissions and broker attestation for the
   read operations, CUR2 prefix, price lists, inventory, and Compute Optimizer;
2. credential-owning AWS adapters with exhaustive pagination, bounded retries,
   immutable hashes, and source-job ledger integration;
3. durable tenant-scoped capture/snapshot/history persistence and generation
   activation;
4. authenticated API routes with adversarial cross-tenant tests;
5. professional UI views for blockers, assumptions, provider estimates,
   modeled potential, realized measurement, and evidence drill-down; and
6. live management/member-account acceptance with real CUR2, pricing,
   inventory, workload, OS/AMI, licensing, and service-feature evidence.

No infrastructure, public role, image, EC2 host, or production site is changed
or deployed by this slice.
