# CloudAware-informed AWS CMDB implementation ledger

This ledger records implementation checkpoints for the AWS CMDB roadmap in
`docs/CODEX_MAC_MINI_CLOUDAWARE_AWS_HANDOVER.md`. Status is evidence-based: a
catalog entry is not collector coverage, local verification is not live AWS
acceptance, and absent or failed evidence is never reported as zero.

## Completed checkpoint — Foundational AWS Cloud Intelligence dashboards

| Field | Value |
|---|---|
| Date | 2026-08-21 (Asia/Kolkata) |
| Baseline commit | `05e2eb3a6045303cc6356dbe8d10f572ea376b4a` |
| Feature commit | `1eb00d50f6b360f0582bf0dbbe15d9fd2478112e` |
| Branch | `develop` only |
| Verticals | FND-01 CUDOS, FND-02 Cost Intelligence, and FND-03 KPI and Modernization |
| Measurable outcome | FND-01 closes incomplete Bedrock-quantity and source-format truth defects; FND-02 adds bounded canonical OPTICS controls and exact currency/unit-separated MoM usage; FND-03 adds governed versioned mutation and full history states for all 19 goals. |
| Tenant isolation / security | Organization, customer, connection, actor, and authorization scope remain server-derived. Query inputs and exact KPI resource scope fail closed. Same-origin/no-store requests and cross-tenant negative contracts remain enforced. No credential field or AWS secret is stored, logged, or returned. |
| Truthful state / failure handling | Missing compatible quantities withhold ratios; incomplete usage is partial/unavailable, not zero; raw units and currencies never combine; goal history distinguishes loading, verified empty, failure, permission/conflict, and success. |
| AWS operations / IAM | No change. All source reads reuse the existing collector boundary and foundational export role; no AWS SDK call moved into the application. |
| Persistence / migrations | Reused the active-generation billing and versioned KPI-goal repositories. No schema, migration file, migrator, or registry changed. |
| External acceptance | `PENDING_EXTERNAL_ACCEPTANCE` — no controlled two-tenant/provider reconciliation or signed-in live visual acceptance was available; exact QuickSight geometry is not claimed. |
| Known remaining gaps | FND-01 provider telemetry/recommendations, cache-savings and commitment authority; FND-02 complete compute/storage and RI/SP evidence plus unambiguous DB/instance/platform fields; FND-03 multi-generation MoM and authoritative inventory/activity/compatibility/pricing evidence; shared fixed-tree, provider, release, and live gates for all three. |
| Standing PR / CI | [PR #78](https://github.com/ydsveluvolu2996/Sutra/pull/78); [exact CI run 32493632168](https://github.com/ydsveluvolu2996/Sutra/actions/runs/32493632168) passed for `1eb00d50f6b360f0582bf0dbbe15d9fd2478112e`. |

### Verification record

| Check | Result |
|---|---|
| Combined Foundational/active-generation matrix | 130 passed, 0 failed, including route/API allowlists, exact official inventories, truthful quantity/ratio states, persistence, UI rendering, server-derived tenant scope, and cross-tenant negatives. |
| FND-02 focused rerun | 26 passed, 0 failed, 0 skipped. |
| Typecheck / affected lint | Root typecheck and scoped ESLint passed. |
| Secret scan / migration diff | Secret scan passed for 2,670 files; diff check passed; migration checks are unchanged/not applicable because no persistence artifact changed. |
| Signed-in browser evidence | Pending externally; no available signed-in Sutra session was used and no live mutation was attempted. |
| Standing PR CI | Exact-SHA resolution, application quality/build, collector/CloudFormation/PostgreSQL, scanner/vulnerability gate, and all six offline shards passed for the feature commit. |

Maturity for FND-01, FND-02, and FND-03 remains
`LOCAL_VERTICAL_CANDIDATE`. This checkpoint is not a main merge, deployment,
provider reconciliation, or live-acceptance claim.

## Completed checkpoint — AWS onboarding evidence-storage publication repair

| Field | Value |
|---|---|
| Date | 2026-08-21 (Asia/Kolkata) |
| Baseline commit | `6757939c106fbfed891b95f383dad91f34625aaa` |
| Final implementation commit | `f5da93dd318295701722c3f72ed133df6fa35a25` |
| Branch | `develop` only |
| Vertical | Restore first-inventory publication on the single-node private-beta host without weakening archive-before-promotion. |
| User-visible symptom | Static access keys or role trust validate, then Inventory reports a generic collection failure and correctly publishes no authoritative CMDB projection. |
| Root cause | The staging runtime requires managed S3/KMS evidence archival, but the single-node CloudFormation stack, Compose runtime, and Worker runtime file did not provision or propagate the four `SUTRA_EVIDENCE_*` settings. `EvidenceRepository.archive` therefore failed before CMDB staging. |
| Infrastructure | Added a dedicated retained, versioned, public-blocked S3 bucket; a retained rotating CMK; TLS/exact-key bucket denies; bounded lifecycle; an exact non-secret SSM descriptor; and outputs. |
| Least privilege | The EC2 role receives only `s3:GetObject`/`s3:PutObject` under `evidence/v1/*`, no list/delete, KMS use only for the exact key through regional S3, and `ssm:GetParameter` only for `/sutra/private-beta/evidence-config`. Customer onboarding roles and collector operations are unchanged. |
| Runtime propagation | A new host helper validates and atomically copies the descriptor without logging identifiers. Bootstrap, redeploy, and release staging invoke it before app startup; Compose passes the values; `setup-local-pilot.mjs` validates and materializes them into the Worker runtime. |
| Tenant isolation / credentials | No tenant routing or persistence scope changed. Evidence object keys remain opaque and tenant-scoped inside the existing repository. No AWS access key or secret is accepted, stored, logged, or added; workload identity remains the Sutra-host credential source. |
| Truthful state / failure handling | Archive-before-staging remains unchanged. Missing, malformed, placeholder, cross-Region, duplicate, or overridden configuration fails startup/release and never turns a failed/unpublished collection into zero or success. |
| Migrations | Not applicable; no schema, registry, migrator, or persisted shape changed. |
| External rollout | Pending explicit authorization. No CloudFormation update, application deploy, customer AWS call, or live-provider mutation is part of this checkpoint. Existing live onboarding remains blocked until the stack and approved immutable release are updated. |
| Standing PR / CI | [PR #77](https://github.com/ydsveluvolu2996/Sutra/pull/77); [exact CI run 32476012087](https://github.com/ydsveluvolu2996/Sutra/actions/runs/32476012087) and [Kubernetes/supply-chain run 32476012146](https://github.com/ydsveluvolu2996/Sutra/actions/runs/32476012146) passed for `f5da93dd318295701722c3f72ed133df6fa35a25`. |

### Verification record

| Check | Result |
|---|---|
| Focused storage/runtime/security tests | 18 new/adjacent storage and private-beta tests plus 61 existing evidence, cross-tenant, onboarding, sync-truth, and collector-boundary tests passed; 0 failed. |
| EC2 operational contracts / CloudFormation lint | Passed. All 28 templates passed with 42 existing documented Bedrock catalog false positives suppressed; isolated Compose, Caddy, and Tunnel runtime verification passed outside the Docker Desktop `Documents` mount restriction. |
| Typecheck / collector typecheck / affected lint | Root and collector typechecks passed; affected and full ESLint passed. |
| Secret scan / migration diff | Secret scan passed for 2,669 files. Migration diff passed / not applicable: no schema, registry, migrator, or migration file changed. |
| Build / rendered routes | Production build passed; rendered route checks passed 4/4, including anonymous private-route redirects. |
| Signed-in browser evidence | Unavailable: the available Chrome session has no Sutra application tab; no live mutation attempted. |
| Standing PR CI | Exact-SHA resolution, application quality/build, collector/CloudFormation/PostgreSQL, scanner image/vulnerability, all six offline shards, final aggregate, infrastructure scan, dependency review, SBOM, and Cosign verification passed for the implementation commit. |

The bounded diagnosis, frozen files, security decisions, and rollout boundary are
recorded in `docs/AWS_ONBOARDING_EVIDENCE_STORAGE_CLOSURE.md`.

## Completed checkpoint — Milestone 1A VPC first-class subresources

| Field | Value |
|---|---|
| Date | 2026-08-21 (Asia/Kolkata) |
| Baseline commit | `e3224404de15c0447b215fe1c82297e24d45c677` |
| Final implementation commit | `b45b05fbfdba7280f3993d375e7d340f7cae0a67` |
| Branch | `develop` only |
| Vertical | Milestone 1A — first-class VPC route, association, ACL-entry, and gateway-attachment projection from already-authorized EC2 reads |
| Measurable outcome | Promoted five captured VPC object types from catalog-only to implemented normalized resources, scoped counts/search/Resource 360, and field-backed topology without adding an AWS SDK operation or permission. |
| Files / shared integration points | Repaired the existing inventory normalizers and signed snapshot relationship projector; extended canonical bindings and pure CMDB relationships; reused generic persistence, tenant-scoped APIs, Navigator UI, search, and Resource 360 unchanged. See the closure worksheet for the exact frozen/edit sets. |
| Resource types | `aws.ec2.route`, `aws.ec2.route-table-association`, `aws.ec2.network-acl-entry`, `aws.ec2.network-acl-association`, `aws.ec2.internet-gateway-attachment` |
| AWS operations | Reused only `ec2:DescribeRouteTables`, `ec2:DescribeNetworkAcls`, and `ec2:DescribeInternetGateways`; all remain bounded, paginated, retry/deadline-aware collector calls. |
| IAM | No policy change. The exact three operations already exist in the immutable role deny ceiling and allowlist. Reserved `.8.19` remains untouched for FOCUS. |
| Normalization / persistence | Provider association IDs are retained. Provider objects without IDs use transparent stable owner/key composites and no invented ARN. Existing immutable generic snapshot persistence stores the five types atomically; no schema or migration is required. |
| Tenant isolation | Reuses signed collector account/partition/Region context, server-derived organization/customer/connection lookup, and the Navigator connection/customer/account state assertion. New-type search and count tests include Region exclusion and wrong-tenant/account rejection. |
| Truthful state | Each child shares the exact owning collector coverage row. Missing IDs are skipped; permission denial, incomplete pagination/Region coverage, failure, no snapshot, retention, and staleness suppress authoritative counts. |
| Relationships | Routes link to their route table and evidenced target; route-table and ACL associations link to their owner and subnet/gateway; ACL entries link to their ACL; internet-gateway attachments link to their gateway and VPC only through stored fields. |
| Migrations | Not applicable; no database or migration-registry file changes. |
| External acceptance | `PENDING_EXTERNAL_ACCEPTANCE` — no disposable multi-Region/two-tenant AWS account evidence and no signed-in Sutra Chrome session are available. |
| Known limitations / next slice | NAT/transit gateways, endpoints, peering, VPN, Direct Connect, and propagation require new exact IAM operations. A valid standard successor cannot be created until reserved FOCUS `.8.19` is integrated; this slice does not steal or skip that reservation. |
| Standing PR / CI | [PR #77](https://github.com/ydsveluvolu2996/Sutra/pull/77); [exact CI run 32461752486](https://github.com/ydsveluvolu2996/Sutra/actions/runs/32461752486) and [Kubernetes/supply-chain run 32461752428](https://github.com/ydsveluvolu2996/Sutra/actions/runs/32461752428) passed for `b45b05fbfdba7280f3993d375e7d340f7cae0a67`. |

### Verification record

| Check | Result |
|---|---|
| Collector inventory / signed snapshot | 21 inventory plus 14 local-server tests passed, 0 failed, including shared pagination, exact normalized children/counts, API provenance, persisted child edges, failure isolation, deadlines, and repeated-token handling |
| Catalog/Navigator/relationships | 24 passed, 0 failed, including exact five bindings, API/UI contracts, current-count boundary, Region exclusion, wrong-tenant/account rejection, deterministic topology, and unresolved-target honesty |
| Typecheck | Root and collector passed |
| Permission/CloudFormation | 12 permission/template tests passed; CloudFormation lint passed 28 templates with 42 documented Bedrock catalog false positives suppressed; no command or template changed |
| Migration diff | Passed / not applicable; no database schema, migration, migrator, or registry file changed |
| Lint / secret scan / build / rendered routes | Affected and full ESLint passed; secret scan passed for 2,666 files; production build passed; rendered routes passed 4/4 |
| Signed-in browser evidence | Pending externally; the available Chrome session has no Sutra application tab |
| Standing PR CI | Exact-SHA resolution, application quality/build, collector/CloudFormation/PostgreSQL, scanner image/vulnerability, all six offline shards, final aggregate, and the separate Kubernetes/supply-chain workflow passed for the implementation commit |

The bounded reuse and contract decisions are recorded in
`docs/CLOUDAWARE_AWS_VPC_SUBRESOURCE_CLOSURE.md`.

## Completed checkpoint — Milestone 0A catalog and AWS Navigator foundation

| Field | Value |
|---|---|
| Date | 2026-08-21 (Asia/Kolkata) |
| Baseline commit | `6fdddfdb0f3c739fe8dfb3598045e483ac07d916` |
| Final implementation commit | `e8c87e25d4a6c9c287540103bb0ac1a60aed9956` |
| Branch | `develop` only |
| Vertical | Milestone 0A — canonical AWS catalog and tenant-scoped AWS Navigator over the existing durable CMDB projection |
| Measurable outcome | Added a deterministic catalog with 18 categories, 114 services, 986 reference resource types, and one explicit Sutra SSM extension; added authenticated category, service, resource-type, and scoped search routes without moving AWS SDK access outside the collector. |
| Collector coverage | Twenty-seven existing normalized resource types are explicitly bound to exact catalog rows, collector coverage keys, scope, and read operations. Catalog membership, adapter implementation, and external acceptance remain independent claims. |
| Tenant isolation | Organization comes only from the authenticated actor; connection lookup is organization-scoped; customer capability is checked server-side; returned state must match the authorized connection, customer, and AWS account; organization/customer/account substitution parameters are rejected. |
| Truthful state | Numeric current counts require an implemented adapter, active complete snapshot, complete exact collector/Region coverage, no newer incomplete attempt, and freshness under 48 hours. Unconfigured, waiting, not-collected, unavailable, permission-denied, partial, failed, retained, and stale states suppress current counts. Catalog-only types never receive a synthetic last-known zero. |
| Persistence / migrations | Immutable generated catalog plus reads from existing CMDB tables only. No schema change; all three migration registries remain unchanged. |
| IAM / AWS operations | No collector or CloudFormation change in this slice. The UI/API performs no AWS SDK calls and introduces no credentials or provider writes. |
| UI integration | Added `/cmdb/navigator`, category/service/type destinations, breadcrumbs, Region and connection scope, server-scoped catalog/resource search, Resource 360 links, and bounded per-connection recent/pinned catalog destinations. |
| External acceptance | `PENDING_EXTERNAL_ACCEPTANCE` — the available Chrome session has no signed-in Sutra application tab, and no disposable multi-account/multi-partition AWS fixture is available. Local route, rendered-page, build, and security evidence do not replace those checks. |
| Known limitations | Broader application-wide search and organization-scale account navigation remain a separate Milestone 0 vertical; catalog rows do not claim unimplemented VPC or other adapters. |
| Next slice | After this checkpoint and its exact standing-PR CI pass: the complete VPC networking vertical, beginning with first-class subresources from already-authorized EC2 reads. |
| Standing PR / CI | [PR #77](https://github.com/ydsveluvolu2996/Sutra/pull/77); [exact CI run 32457823809](https://github.com/ydsveluvolu2996/Sutra/actions/runs/32457823809) and [Kubernetes/supply-chain run 32457823732](https://github.com/ydsveluvolu2996/Sutra/actions/runs/32457823732) passed for `e8c87e25d4a6c9c287540103bb0ac1a60aed9956`. |

### Verification record

| Check | Result |
|---|---|
| Catalog/Navigator/navigation contracts | 17 passed, 0 failed, 0 skipped in the final focused run |
| Catalog provenance/drift | Passed; captured source hashes and generated artifact agree |
| Tenant/false-zero negatives | Wrong-tenant state, forbidden substitution parameters, incomplete Region coverage, catalog-only, permission-denied, retained, and stale cases passed |
| Typecheck | Root and collector passed |
| Affected ESLint | Passed |
| Secret scan | Passed for 2,665 source files |
| Build/rendered routes | Production build passed with the Navigator API and page routes present; 4 rendered-route checks passed, including anonymous private-route redirects |
| Migrations / CloudFormation | Not applicable: no migration, registry, collector permission, or template change |
| Signed-in browser evidence | Pending externally; Chrome is running but has no signed-in Sutra application tab |
| Standing PR CI | Exact-SHA resolution, application quality/build, collector/CloudFormation/PostgreSQL, scanner image/vulnerability, all six offline shards, final aggregate, and the separate Kubernetes/supply-chain workflow passed |

See `docs/AWS_CMDB_CATALOG_AND_NAVIGATOR.md` for the generated-source model,
route contract, count semantics, and explicit limits.

## Completed checkpoint — Gate A / ADV-05 prerequisite

| Field | Value |
|---|---|
| Date | 2026-08-21 (Asia/Kolkata) |
| Baseline commit | `2e9b8a7d76a91e711d79e9a0c739d278fb2c2c1c` |
| Final implementation/evidence commit | `537da717c7a8050b9fe54f06dacc8361e766f0e6` |
| Branch | `develop` only |
| Vertical | Gate A prerequisite — ADV-05 Graviton Savings |
| Measurable outcome | Reconciled already-landed collector/runtime/IAM/migrations against G0–G6 and promoted ADV-05 from `PARTIAL_PIPELINE` to `LOCAL_VERTICAL_CANDIDATE`. |
| Existing implementation commit | `43c625d` (`Complete Cloud Intelligence FinOps dashboard program (#26)`) |
| Shared integration points | Collector role broker/local server, background handlers, three migration registries, immutable `.8.12` permission template; frozen unless verification proves a defect. |
| AWS operations | 15 enumerated Compute Optimizer, EC2, Auto Scaling, RDS, OpenSearch, ElastiCache, and Pricing read operations; no write operations. |
| Migrations | Drizzle `0122_finops_graviton_runtime`; PostgreSQL `0118_finops_graviton_runtime`; all three registries verified; 130 PostgreSQL migrations applied successfully in the isolated test stack. |
| Tenant isolation | Server-derived org/customer/connection/account/partition/Region scope; same-tenant positive, cross-tenant/account substitution, replay, and signed-response negative tests passed. |
| External acceptance | `PENDING_EXTERNAL_ACCEPTANCE` — no disposable multi-account/two-tenant AWS evidence is available in this repository session. |
| Known limitations | Authority-dependent CUR2/pricing/compatibility/workload/license data fails closed as configuration-required; exact provider reconciliation and live UI acceptance are unclaimed. |
| Next slice | After the prerequisite and exact CI pass: Milestone 0 canonical AWS catalog and Navigator foundation. |
| Standing PR / CI | [PR #77](https://github.com/ydsveluvolu2996/Sutra/pull/77); [exact CI run 32453805907](https://github.com/ydsveluvolu2996/Sutra/actions/runs/32453805907) passed all required jobs for `537da717c7a8050b9fe54f06dacc8361e766f0e6`. |

### Verification record

| Check | Result |
|---|---|
| Focused Graviton engine/runtime/UI | 36 passed, 0 failed, 0 skipped |
| Durable runtime/shared handler | 13 passed, 0 failed, 0 skipped |
| Collector provider route | 4 passed, 0 failed, 0 skipped |
| Permission/predecessor/schema contracts | 12 passed, 0 failed; initial environment-only PostgreSQL catalog test skipped, then covered by the real PostgreSQL run |
| PostgreSQL 18 migration/runtime roles | 130 migrations applied; 13 passed, 0 failed, 0 skipped across emitted TAP suites |
| Typecheck/build | Root and collector passed |
| Affected ESLint | Passed |
| Secret scan | Passed for 2,652 source files |
| CloudFormation | 28 templates passed with only 42 documented Bedrock catalog false positives suppressed |
| UI evidence | SSR/native chart contract passed; signed-in exact-tree/browser acceptance remains external |
| Standing PR CI | Exact-SHA resolution, application quality/build, collector/CloudFormation/PostgreSQL, scanner image/vulnerability, and all six offline shards passed in run `32453805907` |

The first direct PostgreSQL attempt was blocked because Docker Desktop could not
mount `~/Documents`. The same fixed `HEAD` was archived to an isolated
`/Users/Shared` checkout, used only for the test, and the Docker test stack was
removed by its own cleanup path after success. No credentials or live provider
state were used.
