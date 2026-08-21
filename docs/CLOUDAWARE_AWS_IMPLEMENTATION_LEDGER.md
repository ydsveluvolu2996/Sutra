# CloudAware-informed AWS CMDB implementation ledger

This ledger records implementation checkpoints for the AWS CMDB roadmap in
`docs/CODEX_MAC_MINI_CLOUDAWARE_AWS_HANDOVER.md`. Status is evidence-based: a
catalog entry is not collector coverage, local verification is not live AWS
acceptance, and absent or failed evidence is never reported as zero.

## Active checkpoint — Milestone 0A catalog and AWS Navigator foundation

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
| Next slice | After this checkpoint and its exact standing-PR CI pass: organization-scale Navigator/search scope, then the complete VPC networking vertical. |
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
