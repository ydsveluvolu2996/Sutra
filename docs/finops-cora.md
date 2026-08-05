# CORA / Cost Optimization Recommended Actions source contract

This slice defines Sutra's bounded, tenant-scoped Cost Optimization Recommended
Actions (CORA) engine. It joins three evidence planes without changing their
meaning:

- the AWS Data Exports `COST_OPTIMIZATION_RECOMMENDATIONS` table from Cost
  Optimization Hub;
- Cost Optimization Hub preferences and account enrollment status;
- one immutable active CUR 2.0 generation for observed cost context.

The engine performs no AWS, network, persistence, route, UI, or credential
work. It accepts only a server-pinned capture for one Sutra
organization/customer/connection. It is not production acceptance by itself.

Authoritative AWS references:

- <https://docs.aws.amazon.com/cost-management/latest/userguide/cost-optimization-hub.html>
- <https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-cor.html>
- <https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-cor-columns.html>
- <https://docs.aws.amazon.com/cost-management/latest/userguide/coh-getting-started.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_CostOptimizationHub_GetRecommendation.html>

## Enterprise evidence semantics

The export must select all documented COR columns and use:

- table `COST_OPTIMIZATION_RECOMMENDATIONS`;
- `INCLUDE_ALL_RECOMMENDATIONS=TRUE`;
- no `FILTER` for the canonical complete generation;
- create-new-report versioning rather than overwrite;
- a dedicated immutable S3 prefix.

AWS documents that `INCLUDE_ALL_RECOMMENDATIONS=FALSE` drops lower-savings
recommendations that are incompatible with a higher-savings recommendation.
Sutra therefore calls filtered or de-duplicated captures `PARTIAL`; it does not
silently call them complete. The engine preserves all 25 documented fields,
including before/after-discount monthly estimates, configuration-detail JSON,
resource/account/Region lineage, tags, effort, restart/rollback flags, source,
and refresh/lookback evidence.

AWS recommendation IDs are short lived: the GetRecommendation API documents a
maximum validity of 24 hours because recommendations refresh daily. Sutra keeps
the AWS ID as source evidence, but workflow state is keyed by a stable,
server-generated SHA-256 tracking key. Current recommendations and retained
historical generations are distinct collections; disappearance or replacement
does not erase history.

The two optimization classes are deliberately separate:

- `PurchaseSavingsPlans` and `PurchaseReservedInstances` are
  `RATE_COMMITMENT_OPTIMIZATION`;
- rightsizing, stop, upgrade, Graviton migration, delete, and scale-in are
  `RESOURCE_USAGE_OPTIMIZATION`.

Every AWS amount remains in its source currency. Before-discount and
after-discount estimates remain separate; a missing after-discount value stays
null. Decimal strings become bigint-safe integer micros without floating-point
summation. The summary row sum is explicitly labelled
`NON_DEDUPLICATED_ROW_SUM_NOT_A_PORTFOLIO_SAVINGS_CLAIM`, because mutually
exclusive recommendations can coexist when full coverage is requested.

CUR2 cost is a separately labelled observation with active generation,
manifest, line-item, account, resource/tracking, period, cost-basis, currency,
and truncation evidence. A before/after difference is not automatically
caused by an implemented recommendation. Every displayed observation carries
`OBSERVED_COST_NOT_ATTRIBUTED_SAVINGS`; AWS estimates carry
`AWS_ESTIMATE_NOT_REALIZED_SAVINGS`.

Ownership, status, suppression, external ticket reference, and every workflow
transition use tenant-local identifiers and a contiguous audit revision chain.
The boundary carries reason codes, not free-form comments. Missing workflow
creates a visible unassigned `NEW` state instead of inventing an owner.

## Exact permanent collector policy

The permanent collector remains read-only. It does not need Cost Optimization
Hub recommendation-list APIs because the recurring COR export already carries
the complete documented recommendation schema.

### Cost Optimization Hub readiness

Required actions:

- `cost-optimization-hub:GetPreferences`
- `cost-optimization-hub:ListEnrollmentStatuses`

Use `Resource: "*"`. AWS Cost Optimization Hub defines no resource ARN types
and no service-specific condition keys. Calls go to the documented
`us-east-1` endpoint. The management or registered delegated-administrator
context is required for organization visibility; a member-account result must
never be relabelled as organization coverage.

- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_cost-optimization-hub.html>
- <https://docs.aws.amazon.com/cli/latest/reference/cost-optimization-hub/>

The separately governed organization-account source supplies:

- `organizations:DescribeOrganization`
- `organizations:ListAccounts`

These require `Resource: "*"`. Sutra reports complete coverage only when the
AWS Organizations active-account evidence exists, every expected account is
returned by enrollment status, and all are active. An operator-selected set is
partial and one account is `SINGLE_ACCOUNT_ONLY`.

### Data Export health

Required actions:

- `bcm-data-exports:GetExport`
- `bcm-data-exports:GetExecution`
- `bcm-data-exports:ListExecutions`

Pin all three to the known export ARN:

`arn:${Partition}:bcm-data-exports:${Region}:${Account}:export/${ExportName}-${UUID}`

`ListExports`, `ListTables`, `GetTable`, tag reads, export mutation, and export
deletion are not required by the steady-state collector. AWS Data Exports
supports export resource ARNs and resource-tag conditions for these reads.

- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_bcm-data-exports.html>
- <https://docs.aws.amazon.com/cur/latest/userguide/bcm-data-exports-access.html>

### Exact-prefix S3 reads

Required actions:

- `s3:GetBucketLocation` on `arn:${Partition}:s3:::${Bucket}`;
- `s3:ListBucket` on that bucket ARN, constrained with `s3:prefix` to the exact
  `${Prefix}/${ExportName}/*` namespace;
- `s3:GetObject` and `s3:GetObjectAttributes` only on
  `arn:${Partition}:s3:::${Bucket}/${Prefix}/${ExportName}/*`.

The collector verifies the Data Export manifest hash, object count, object
prefix, format, accepted/rejected rows, and full exhaustion before activating a
generation. It never lists or reads outside the registered prefix.

Data Exports uses SSE-S3 by default. If an approved post-delivery process
re-encrypts these exact objects under a customer-managed KMS key, add only
`kms:Decrypt` on that exact key ARN, constrained by `kms:ViaService` for S3 and
the expected `kms:EncryptionContext:aws:s3:arn`. Do not add wildcard KMS access.

- <https://docs.aws.amazon.com/cur/latest/userguide/dataexports-export-delivery.html>
- <https://docs.aws.amazon.com/cur/latest/userguide/data-protection.html>

## Separate one-time provisioner

None of these permissions belong on the permanent collector role.

### Enroll Cost Optimization Hub

For organization enrollment, use a short-lived, approved provisioner with:

- `iam:CreateServiceLinkedRole` on
  `arn:${Partition}:iam::${Account}:role/aws-service-role/cost-optimization-hub.bcm.amazonaws.com/AWSServiceRoleForCostOptimizationHub`,
  constrained by
  `iam:AWSServiceName=cost-optimization-hub.bcm.amazonaws.com`;
- `iam:PutRolePolicy` on that exact service-linked role, as required by AWS's
  published organization-enrollment policy;
- `organizations:EnableAWSServiceAccess` on `Resource: "*"`, constrained by
  `organizations:ServicePrincipal=cost-optimization-hub.bcm.amazonaws.com`;
- `cost-optimization-hub:UpdateEnrollmentStatus` on `Resource: "*"`.

For standalone/single-account enrollment, omit the Organizations action and
set `includeMemberAccounts=false`. Enrollment can take up to 24 hours to import
all supported recommendations, so first-delivery waiting is not an empty
recommendation claim.

- <https://docs.aws.amazon.com/cost-management/latest/userguide/coh-getting-started.html>
- <https://docs.aws.amazon.com/cost-management/latest/userguide/cost-optimization-hub-SLR.html>

### Register the recurring COR export

Use these provisioner actions:

- `bcm-data-exports:CreateExport` on the exact table ARN
  `arn:${Partition}:bcm-data-exports:${Region}:${Account}:table/COST_OPTIMIZATION_RECOMMENDATIONS`
  and the controlled new-export ARN pattern
  `arn:${Partition}:bcm-data-exports:${Region}:${Account}:export/sutra-cora-*`;
- `bcm-data-exports:TagResource` on that controlled export ARN pattern, with
  `aws:RequestTag`/`aws:TagKeys` constraints for the Sutra connection tag;
- the CreateExport dependent reads
  `cost-optimization-hub:GetRecommendation` and
  `cost-optimization-hub:ListRecommendations` on `Resource: "*"`.

If `AWSServiceRoleForBCMDataExports` does not yet exist, the same short-lived
provisioning workflow may use `iam:CreateServiceLinkedRole` only on:

`arn:${Partition}:iam::${Account}:role/aws-service-role/bcm-data-exports.amazonaws.com/AWSServiceRoleForBCMDataExports`

with `iam:AWSServiceName=bcm-data-exports.amazonaws.com`. AWS states that the
console creates this role automatically when a table requiring it is exported.
The role is read-only for ongoing source collection and trusts
`bcm-data-exports.amazonaws.com`.

- <https://docs.aws.amazon.com/cost-management/latest/userguide/data-exports-SLR.html>
- <https://docs.aws.amazon.com/cur/latest/userguide/dataexports-create-standard.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_bcm-data-exports.html>

The preferred destination is the already hardened foundational Data Exports
bucket under a new exact prefix. If its resource policy does not yet authorize
Data Exports delivery, the one-time provisioner may use only
`s3:GetBucketPolicy` and `s3:PutBucketPolicy` on that exact bucket for a reviewed
merge of the required delivery statement. It must not replace unrelated
statements. Bucket creation, deletion, arbitrary object writes, and broad S3
administration are not part of this slice.

## Explicit states and safe bounds

The engine returns:

- overall `READY`, `PARTIAL`, `CONFIGURATION_REQUIRED`, `STALE`, `EMPTY`, or
  `ERROR`;
- independent enrollment, recommendations, CUR2, and workflow channel states;
- complete, partial, or single-account organization coverage;
- rejected-row, missing-enrollment, stale-source, filtered-export, and
  de-duplication limitations.

Capture/response bytes, accounts, recommendations, retained history, workflow
records, audit events, tags, source line IDs, configuration JSON, export
objects, and observation rows are all bounded. Exact tenant scope, AWS account
set, manifest hashes, active CUR2 generation, identifiers, timestamps,
currencies, decimal money, JSON depth/size, duplicate keys, and audit continuity
fail closed. Provider error text and unbounded user comments do not cross the
boundary.

## Production acceptance gates

This pure engine and its focused tests are not a production-complete CORA
feature. Remaining gates are:

1. add the reviewed exact statements to the separate collector and provisioner
   policies, preserving the read-only permanent role;
2. publish and run the version-pinned COR Data Export add-on in an approved AWS
   management/delegated-administrator account;
3. implement bounded export, enrollment, CUR2 join, immutable-generation, and
   workflow persistence adapters for this exact schema;
4. expose authenticated tenant-scoped APIs and professional summary,
   opportunity, resource, owner, history, suppression, action, and evidence
   views;
5. prove no-recommendation, partial enrollment, filtered export, daily ID
   rotation, pagination, mixed currency, stale delivery, access denied, CUR2
   lag, audit concurrency, and cross-tenant rejection in live E2E tests.

Until those gates pass, CORA remains in progress and must not be reported as
production accepted or as realized savings.
