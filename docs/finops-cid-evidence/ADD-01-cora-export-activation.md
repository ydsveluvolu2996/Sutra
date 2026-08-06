# ADD-01 CORA — permanent Cost Optimization Hub export activation

Status: `PARTIAL_PIPELINE` until the credential-owning AWS S3/Data Exports adapter and durable background handler are registered. The complete app-side contract, immutable storage, orchestration, and local proofs are present; no discovery result or direct recommendation API response is promoted as historical export evidence.

## Provider facts verified

- [AWS Cost Optimization Hub](https://docs.aws.amazon.com/cost-management/latest/userguide/cost-optimization-hub.html) consolidates recommendations from Compute Optimizer and other AWS sources and labels savings as estimates.
- [The Data Exports cost optimization recommendations table](https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-cor.html) is `COST_OPTIMIZATION_RECOMMENDATIONS`. `INCLUDE_ALL_RECOMMENDATIONS=TRUE` retains incompatible alternatives; `FILTER` is applied before provider deduplication. CORA therefore requires include-all with no filter for full evidence coverage.
- [AWS standard export creation](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-create-standard.html) states recommendation exports require the Data Exports service-linked role, are refreshed up to daily, and do not support overwrite mode.
- [AWS export delivery](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-export-delivery.html) documents execution-specific create-new data and manifest paths. The mutable partition-level `Manifest.json` is only a pointer to the latest refresh and is rejected as historical evidence.
- [AWS Data Exports creation](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-create.html) notes first delivery can take up to 24 hours and refresh timing can vary. Waiting is a normal state, not an empty recommendation set.

## Closed activation gap

`lib/finops-cora-export-materialization.ts` defines and validates a server-owned boundary for organization/customer/connection, partition, management account, active-account set, allowed Regions, exact export ARN/name/bucket/prefix/partition, unfiltered include-all table configuration, query/configuration hashes, and create-new format. A materialization is accepted only when:

1. `GetExport` and `GetExecution` reconciliation hashes match the pinned target.
2. The manifest path is execution-specific and embeds the same execution ID; the mutable latest alias is rejected.
3. Every manifest object is present exactly once, under the matching execution-specific data path, with ETag, optional version ID, SHA-256, size, row count, and processed state.
4. Object, parsed, accepted, rejected, duplicate, pagination, account, and Region coverage reconcile exactly.
5. Every recommendation carries its source object digest and row ordinal and stays inside the server-owned account/Region set.
6. `directApiRecommendationRowsAccepted` is the literal `false`.

Attempts are classified as `WAITING_DELIVERY`, `FAILED`, `PARTIAL`, `EMPTY`, or `COMPLETE`. Only `EMPTY` and `COMPLETE` are complete evidence and may advance the export head.

## Persistence, replay, and publication

- SQLite: `drizzle/0108_finops_cora_export_objects.sql`
- PostgreSQL: `postgres/migrations/0103_finops_cora_export_objects.sql`
- Both migrations are registered in the SQLite and PostgreSQL runtime
  migration registries.
- Immutable generations are unique by request key, materialization ID, and provider execution ID inside the tenant scope.
- Exact replay returns the existing generation. A replay with different content is a conflict.
- Failed, waiting, and partial attempts remain audit history but cannot replace the accepted head.
- Head movement is monotonic by data-through time, provider generation time, and generation digest.
- The orchestration request selects `EXECUTION_SPECIFIC_ONLY`, rejects the mutable latest manifest, accepts no direct API recommendation rows, bounds bytes/objects/rows, and pins the exact read operations.
- Request identity is derived from tenant scope, scheduled provider window, export ARN, and pinned export/query/configuration hashes rather than the transient durable-job ID. A retry therefore replays the same request key while a new provider window or definition receives a new key.
- A complete export is converted into the existing `CoraCapture`; only prior complete export-object generations build recommendation lifecycle history.
- Current enrollment/preferences API reads are readiness/configuration evidence only. Existing immutable CUR2 observations remain cost facts with `OBSERVED_COST_NOT_ATTRIBUTED_SAVINGS`; AWS recommendation savings remain estimates.
- Complete rows are passed through the existing CORA domain normalizer before
  immutable publication, so malformed money, resource identity, workflow, or
  account evidence cannot be labelled as an accepted export row.
- Bounded history selects the newest accepted generations and returns them in
  chronological order for deterministic lifecycle derivation.

## Remaining live activation

The repository does not contain credentials or an installed AWS S3/Parquet adapter, and the shared background-handler registry was intentionally out of scope. The exact reason is `CORA_EXPORT_S3_ADAPTER_NOT_DEPLOYED`. Integration must bind `runCoraExportMaterializationJob` to a durable job handler and implement `CoraExportS3Adapter` with the trusted AWS connection. No production deployment was performed.

## Merge record — 2026-08-06

Merged to `main` since this record was last updated (2026-08-05 15:01). Every
item below is source-only work that landed through review with CI green on the
merge commit — nothing more. No provider, live, two-tenant, or release evidence
is created by any of it.

**Maturity is unchanged (`PARTIAL_PIPELINE`) and no child-stage gate passed.** G7
fixed-tree, G8 controlled provider acceptance, G9 release and G10 deployment
remain unpassed for this row; no live acceptance, provider reconciliation, or
two-tenant acceptance is claimed.

- **New `aws_static_credentials` onboarding method — `6298f03` (PR #39).**
  Onboarding now offers an access key ID plus secret access key (with a session
  token required for temporary `ASIA` keys) as an alternative to the
  CloudFormation trust-role flow, which stays the recommended default. The
  credential material lives only in the collector's AES-GCM-encrypted registry
  document; the app database stores the `aws_static_credentials` source kind and
  nothing else. Static sessions carry **no STS inline session-policy ceiling and
  no role-contract attestation** — both are impossible without `AssumeRole`.
  **This row's connection prerequisite is unchanged: the FinOps per-source
  verticals still require the trust-role method.** The FinOps source guards were
  deliberately left trust-role-only, so an `aws_static_credentials` connection
  cannot satisfy the prerequisite recorded above. No permission ceiling,
  attestation, or role contract in this record is relaxed by it.
