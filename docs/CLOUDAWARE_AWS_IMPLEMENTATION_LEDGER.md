# CloudAware-informed AWS CMDB implementation ledger

This ledger records implementation checkpoints for the AWS CMDB roadmap in
`docs/CODEX_MAC_MINI_CLOUDAWARE_AWS_HANDOVER.md`. Status is evidence-based: a
catalog entry is not collector coverage, local verification is not live AWS
acceptance, and absent or failed evidence is never reported as zero.

## Active checkpoint — Gate A / ADV-05 prerequisite

| Field | Value |
|---|---|
| Date | 2026-08-21 (Asia/Kolkata) |
| Baseline commit | `2e9b8a7d76a91e711d79e9a0c739d278fb2c2c1c` |
| Final commit | Pending verification and `pnpm work:save` |
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
| Standing PR / CI | Pending checkpoint push and exact run inspection. |

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

The first direct PostgreSQL attempt was blocked because Docker Desktop could not
mount `~/Documents`. The same fixed `HEAD` was archived to an isolated
`/Users/Shared` checkout, used only for the test, and the Docker test stack was
removed by its own cleanup path after success. No credentials or live provider
state were used.
