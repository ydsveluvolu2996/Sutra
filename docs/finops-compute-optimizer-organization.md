# AWS Compute Optimizer organization evidence

## Scope

`lib/finops-compute-optimizer-organization.ts` is the app-side trust boundary
for authoritative AWS Compute Optimizer evidence. It accepts no AWS
credentials, performs no network/database I/O, and does not mutate the
customer account.

The boundary is pinned from server state to one Sutra organization, customer,
connection, AWS management account, partition, and sorted Region set. A client
cannot provide or override those values. Collection responses for any other
scope are rejected.

The allowed provider operations are read-only:

- `GetEnrollmentStatus`
- `GetEnrollmentStatusesForOrganization`
- `GetRecommendationSummaries`
- resource-specific `Get*Recommendations`
- `DescribeRecommendationExportJobs`

`Export*Recommendations`, enrollment changes, recommendation-preference
changes, S3 bucket creation, and bucket-policy changes are intentionally not
part of this collector. Export creation belongs to the separate, approved
provisioner/action role.

## Evidence model

Current and historical evidence are deliberately separate:

- `DIRECT_GET_API` records are current AWS Compute Optimizer observations.
  They must not be shown as recommendation history.
- `S3_EXPORT` records are history only when the export job is complete, both
  CSV and metadata objects are hash-addressed, the destination matches the
  pinned prefix, and Sutra's immutable provisioning ledger proves
  `includeMemberAccounts=true`.
- Sutra cost heuristics are never converted to AWS recommendations. The
  normalized record and dashboard both retain `AWS_COMPUTE_OPTIMIZER`
  provenance.

AWS documents that recommendation exports produce a CSV plus JSON metadata and
are the mechanism for recording recommendations over time:

- <https://docs.aws.amazon.com/compute-optimizer/latest/ug/exporting-recommendations.html>
- <https://docs.aws.amazon.com/compute-optimizer/latest/ug/exported-files.html>

AWS documents that export jobs are Region- and resource-type-specific, can
take hours, and permit only one in-progress job per resource type and Region:

- <https://docs.aws.amazon.com/compute-optimizer/latest/ug/exporting-your-recommendations.html>
- <https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_DescribeRecommendationExportJobs.html>

## Fail-closed configuration states

The engine returns one explicit state:

- `ENROLLMENT_REQUIRED`
- `ENROLLMENT_PENDING`
- `ENROLLMENT_FAILED`
- `ORGANIZATION_ACCESS_REQUIRED`
- `EXPORT_CONFIGURATION_REQUIRED`
- `EXPORT_IN_PROGRESS`
- `EXPORT_FAILED`
- `COLLECTION_PARTIAL`
- `COLLECTION_UNAVAILABLE`
- `READY`

`READY` requires active enrollment, management-account collection, persisted
trusted-access evidence, complete member-account enrollment pagination,
successful and exhaustive direct collection for every pinned active account,
Region, and supported operation, complete export-job pagination for every
Region, and at least one verified organization-wide immutable export.

AWS documents the organization enrollment API and the requirement for opted-in
member accounts and trusted access:

- <https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_GetEnrollmentStatusesForOrganization.html>
- <https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_ExportEC2InstanceRecommendations.html>

## Hard bounds and privacy

The module enforces a 10-minute capture duration, four-way declared maximum
concurrency, 100 records per page, continuous non-replayed pagination, empty
filters for coverage evidence, bounded Regions/accounts/sequences/pages/
records/options/text/bytes, stable sorting and deduplication, conflict
rejection, and generic provider errors.

Credential-shaped fields are rejected recursively. Raw AWS exception messages,
temporary credentials, access keys, status reasons, and export failure
messages must not cross the broker boundary. Only bounded safe error codes may
be retained.

## AWS limitations retained in the product

- Savings are AWS evidence only when AWS returns them. AWS notes that savings
  opportunity requires Cost Explorer and its EC2 resource-recommendation
  integration:
  <https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_RecommendationSummary.html>
- Memory projections can be absent unless a supported memory metric source is
  configured:
  <https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_InstanceRecommendationOption.html>
- Resource eligibility and available recommendation types vary by AWS service
  and Region:
  <https://docs.aws.amazon.com/compute-optimizer/latest/ug/what-is-compute-optimizer.html>

## Remaining integration gates

This slice is source code and focused tests only. Production acceptance still
requires:

1. add the exact read actions to the version-pinned collector role and broker
   attestation;
2. implement the credential-owning AWS SDK adapter and signed broker route;
3. implement the separate export provisioner and immutable request ledger;
4. ingest exact-prefix S3 CSV/metadata objects with hash verification;
5. persist tenant-scoped snapshots and history;
6. expose the authenticated tenant-scoped API and professional dashboard;
7. run live management/member-account acceptance, adversarial isolation, stale
   export, pagination, retry, and reconciliation tests.

No infrastructure was changed or deployed by this slice.
