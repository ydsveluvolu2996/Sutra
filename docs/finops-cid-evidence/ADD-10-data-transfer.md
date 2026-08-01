# ADD-10 — Data Transfer Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/datatransfer-dashboard.html>

AWS CUR transfer authority: <https://docs.aws.amazon.com/cur/latest/userguide/cur-data-transfers-charges.html>

AWS Global Accelerator price-list authority: <https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSGlobalAccelerator/current/index.json>

Assessment tree: working tree over `78dfdc1a2d4a`; the final integration
revision must be recorded by the parent exact-tree gate.

Current maturity: `LOCAL_VERTICAL_CANDIDATE`

## Official requirement and visual inventory

The official dashboard provides accessible, interactive visibility into
charged AWS data transfer. Its named views cover:

- overall charged transfer and outbound-to-internet costs;
- internet and AWS Global Accelerator analysis;
- inter-Region detail;
- inter-Availability-Zone detail; and
- Amazon CloudFront analysis.

Acceptance cases include exact signed cost by currency/basis, transfer volume,
inbound/outbound direction, account/service/Region/AZ/resource drilldown,
partial and unknown classification, missing-unit disclosure, safe export,
immutable lineage, narrow-screen/keyboard access, and explicit source states.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Official dashboard and AWS CUR/price-list authorities above, reviewed 2026-08-01. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | Reuses immutable active AWS CUR 2.0 Data Export evidence; adds no AWS API permission. The pinned taxonomy uses exact AWS-documented product/usage-type signals and disclosed decimal/binary byte multipliers. |
| G2 collector | `IMPLEMENTED_UNVERIFIED` | Reuses the governed CUR2 manifest/S3 collector, server-owned scope, bounded object processing, canonical row validation, and reconciliation. No browser or Cost Explorer substitute is accepted. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | Active generation/head semantics retain the manifest SHA, accepted/rejected rows and committed file coverage only after manifest reconciliation. Failed or partial corrections do not replace the last accepted active generation. Live PostgreSQL proof remains G7/G8. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | Authenticated same-tenant read-only `GET /api/v1/finops/data-transfer`; exact connection/period/group-limit allowlist; canonical CUR2-only active history; bounded rows/groups; honest waiting/empty/incomplete/partial/stale/failed/complete states. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Native responsive view has currency/cost-basis plus category/direction/account/service/Region filters; billed internet, Global Accelerator, inter-Region, inter-AZ and CloudFront cards; Region/AZ/resource drilldown; formula-safe filtered CSV; and an evidence/classification/parity drawer. |
| G6 focused verification | `VERIFIED` | Working tree over `78dfdc1a2d4a`: engine/taxonomy, export and actual SSR-render tests pass with no skips; the persistence/route combined count is recorded after integration. |
| G7 exact-tree gate | `NOT_STARTED` | Must run on one clean integration SHA with all repository, PostgreSQL, build, security and image gates. |
| G8–G10 | `NOT_STARTED` | Controlled CUR2 reconciliation, two-tenant provider evidence, reviewed merge, immutable image deployment, rollback and live visual/API acceptance remain. |

## Evidence-honesty limits

Global Accelerator values are accepted billed CUR evidence, not a simulated
future pricing quote. CUR Region and AZ dimensions are never presented as both
traffic endpoints. Unknown usage types and units remain unclassified/null.
Signed corrections are retained, currencies and cost bases are isolated, and
no invoice, forecast, network telemetry, or savings value is inferred.

Focused commands:

```text
node --experimental-strip-types --test tests/finops-data-transfer.test.ts tests/finops-data-transfer-export.test.ts
node --test tests/finops-data-transfer-dashboard-render.test.mjs tests/finops-cur-intelligence-routes-ui-contract.test.mjs
pnpm typecheck
pnpm exec eslint app/costs/finops-cur-intelligence-panels.tsx app/api/v1/finops/data-transfer/route.ts lib/finops-data-transfer.ts lib/finops-data-transfer-export.ts
```

The exact combined pass/fail/skip count and clean integration SHA are filled
after the committed-file coverage persistence slice and parent regression run.
