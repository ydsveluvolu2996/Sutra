# ADD-10 — Data Transfer Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/datatransfer-dashboard.html>

AWS CUR transfer authority: <https://docs.aws.amazon.com/cur/latest/userguide/cur-data-transfers-charges.html>

Official dataset contract at audited commit `f9e36d88c47709f10e8fa784ad11d5cc0e728021`: <https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/data-transfer/DataTransfer-Cost-Analysis-Dashboard.yaml>

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

Current AWS guidance categorizes Data Transfer Dashboard as **Additional**, is
explicit that it analyzes charged outbound/internet, inter-Region and inter-AZ
transfer across services, and lists the five purposes above. The pinned public
repository contains only one dashboard-specific file.

| Artifact | Publication and immutable evidence |
|---|---|
| Manifest/dataset | Published at `dashboards/data-transfer/DataTransfer-Cost-Analysis-Dashboard.yaml`; SHA-256 `85826c34fcd4f9f63599cdb257894eb4afa11bf014c903aad83427fc2704d698`. |
| Athena view SQL | Published inline at `views.data_transfer_view.data`; SHA-256 `37c210858303233c2f328cb5484f0031756dff5281696da97715edba5bd954f9`. |
| QuickSight definition | **Not published** at the pinned commit; path and hash are `null`. |
| QuickSight template body | **Not published**. The manifest only references external template ID `data-transfer-aga-cost-analysis-template-enhanced-v6`, source account `869004330191`, Region `us-east-1`; path and hash are `null`. |
| Dashboard changelog | **Not published** at the pinned commit; path and hash are `null`. |

Because no QuickSight definition or template body is public, exact sheets,
visuals, parameter controls, filter controls, parameter declarations,
calculated fields, filter groups, and dataset-object totals are all **`null`**.
The five AWS guidance bullets are documented purposes, not proof of five
QuickSight visual objects. Neither the guidance nor public artifact enumerates
control purposes, so the official control-purpose inventory is empty rather
than inferred from Sutra's native filters.

| Documented AWS purpose | Native mapping | Preserved gap |
|---|---|---|
| Data Transfer Summary | Exact currency/cost-basis category summaries plus classified/unknown/unclassified coverage | Official object count, type, fields, interactions and layout are unpublished. |
| Internet transfer and Global Accelerator cost-estimation details | Billed CUR2 internet/Global Accelerator categories, exact cost/bytes/provider/resource drilldown | No future price simulation or unpublished QuickSight parity. |
| Regional transfer details | Inter-Region classification and exact provider endpoints when present | Missing endpoints remain missing; Region is not substituted as both endpoints. |
| Availability Zone transfer details | Inter-AZ classification and exact Region/AZ/account/service/resource evidence | Older active CUR2 provider fields require rematerialization. |
| CloudFront cost and usage | Provider product-code/usage-type classification with exact cost, direction, location and units | No CDN telemetry, performance, future pricing or unpublished visual parity. |

Acceptance cases include exact signed cost by currency/basis, transfer volume,
inbound/outbound direction, account/service/Region/AZ/resource drilldown,
partial and unknown classification, missing-unit disclosure, safe export,
immutable lineage, narrow-screen/keyboard access, and explicit source states.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Current guidance, immutable manifest and inline query audited 2026-08-01. The absence of a public QuickSight definition/template body/changelog is explicit; all exact object totals remain null and only five documented purposes are mapped. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | Reuses immutable active AWS CUR 2.0 Data Export evidence; adds no AWS API permission. The canonical parser preserves the official dataset's source, destination, location type, provider service code/name, product code/name, operation and transfer type. The pinned taxonomy uses exact AWS-documented product/usage-type signals and disclosed decimal/binary byte multipliers. |
| G2 collector | `IMPLEMENTED_UNVERIFIED` | Reuses the governed CUR2 manifest/S3 collector, server-owned scope, bounded object processing, canonical row validation, and reconciliation. No browser or Cost Explorer substitute is accepted. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | Active generation/head semantics retain the manifest SHA, accepted/rejected rows and committed file coverage only after manifest reconciliation. Failed or partial corrections do not replace the last accepted active generation. Live PostgreSQL proof remains G7/G8. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | Authenticated same-tenant read-only `GET /api/v1/finops/data-transfer`; exact connection/period/group-limit allowlist; canonical CUR2-only active history; bounded rows/groups; honest waiting/empty/incomplete/partial/stale/failed/complete states. Every successful response returns immutable `sutra.data-transfer-official-audit.v1`, including every null-report state. Zero accepted rows are `empty` only with complete committed manifest/timestamp evidence and no rejection; otherwise the route reports `source_incomplete`. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Native responsive view has currency/cost-basis plus category/direction/account/service/Region/source/destination/transfer-type filters; billed internet, Global Accelerator, inter-Region, inter-AZ and CloudFront cards; exact provider-path plus Region/AZ/resource drilldown; formula-safe filtered CSV; and evidence/classification/provider-coverage disclosures. The official-source drawer renders in report and null-report states, freezes source/query hashes, keeps exact totals unavailable, maps only the five documented purposes, and distinguishes native controls from unpublished QuickSight controls. |
| G6 focused verification | `VERIFIED` | **31/31 tests passed** with no failures, skips, or cancellations across the frozen official-source audit, taxonomy/engine, provider-path parsing and adversarial isolation, export, route contract and SSR rendering. Full TypeScript and targeted ESLint pass on the current tree. |
| G7 exact-tree gate | `NOT_STARTED` | Must run on one clean integration SHA with all repository, PostgreSQL, build, security and image gates. |
| G8–G10 | `NOT_STARTED` | Controlled CUR2 reconciliation, two-tenant provider evidence, reviewed merge, immutable image deployment, rollback and live visual/API acceptance remain. |

## Evidence-honesty limits

Global Accelerator values are accepted billed CUR evidence, not a simulated
future pricing quote. CUR Region and AZ dimensions are never presented as both
traffic endpoints. Source and destination are displayed only from exact CUR2
product fields, with `PARTIAL` or `UNAVAILABLE` evidence when fields are absent;
usage-type abbreviations are not silently expanded into locations. Unknown
usage types and units remain unclassified/null.
Signed corrections are retained, currencies and cost bases are isolated, and
no invoice, forecast, network telemetry, or savings value is inferred.

Focused commands:

```text
node --experimental-strip-types --test tests/finops-data-transfer.test.ts tests/finops-data-transfer-provider-contract.test.ts tests/finops-data-transfer-export.test.ts
node --experimental-strip-types --test tests/finops-data-transfer-official-audit.test.ts tests/finops-data-transfer-dashboard-render.test.mjs tests/finops-cur-intelligence-routes-ui-contract.test.mjs
pnpm typecheck
pnpm exec eslint app/costs/finops-cur-intelligence-panels.tsx app/api/v1/finops/data-transfer/route.ts lib/finops-data-transfer.ts lib/finops-data-transfer-export.ts lib/finops-data-transfer-official-audit.ts tests/finops-data-transfer-official-audit.test.ts tests/finops-data-transfer-dashboard-render.test.mjs tests/finops-cur-intelligence-routes-ui-contract.test.mjs
```

## Remaining production gates

1. Recollect or rematerialize active CUR2 generations created before the new
   provider fields were retained; historical rows honestly report unavailable.
2. Validate live source/destination/location-type/transfer-type semantics and
   missing-field behavior across EC2, S3 acceleration, Direct Connect,
   CloudFront, Global Accelerator and other charged services.
3. Reconcile source totals, exact path groups, signed corrections and byte
   units against a controlled multi-account CUR2 period and official dataset.
4. Complete correction, object-failure, PostgreSQL, retention, two-tenant,
   exact-tree CI/build and export acceptance.
5. Complete reviewed merge, immutable image, deployment/rollback and signed-in
   browser/API acceptance. No deployment or live-provider claim is made here.

## Merge record — 2026-08-06

Merged to `main` since this record was last updated (2026-08-05 15:01). Every
item below is source-only work that landed through review with CI green on the
merge commit — nothing more. No provider, live, two-tenant, or release evidence
is created by any of it.

**Maturity is unchanged (`LOCAL_VERTICAL_CANDIDATE`) and no child-stage gate passed.** G7
fixed-tree, G8 controlled provider acceptance, G9 release and G10 deployment
remain unpassed for this row; no live acceptance, provider reconciliation, or
two-tenant acceptance is claimed.

- **Native chart kit and catalog identity — `4ac72bd` (PR #36) and `f107cdf`
  (PR #37).** This row's own view module was not modified; it was already on
  the native chart kit before these merges. What reached it is shared:
  `app/costs/finops-foundational-panels.tsx` and
  `app/costs/finops-cur-intelligence-panels.tsx` stopped drawing an absent
  series as a floored zero (`tests/finops-shared-panel-floors.test.mjs`), which
  preserves the absent-is-not-zero release invariant in the panels this row
  renders. Across `app/costs/`, 28 view modules plus the catalog page now import the kit,
  and the kit's own rendering suite `tests/chart-kit-rendering.test.mjs` holds
  12 tests. `app/costs/finops-dashboard-identity.tsx` renders each dashboard's
  catalog glyph, name and ID above every opened view
  (`tests/finops-dashboard-identity.test.mjs`). This is UI rendering work only:
  no source contract, collector operation, migration, API shape, or evidence
  semantic changed, and no G5 or G6 stage status is promoted by it.
