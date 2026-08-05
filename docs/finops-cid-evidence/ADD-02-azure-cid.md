# ADD-02 — Cloud Intelligence Dashboard for Azure evidence record

Reviewed: 2026-08-01

Official sources:

- AWS Cloud Intelligence Dashboards catalog: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/dashboards.html>
- AWS implementation guidance, “How to view Azure costs using Amazon QuickSight”: <https://aws.amazon.com/blogs/modernizing-with-aws/cloud-intelligence-dashboard-for-azure/>
- AWS reference data pipeline for Azure Storage: <https://github.com/aws-samples/aws-data-pipelines-for-azure-storage>
- Microsoft Cost Management recurring exports: <https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-improved-exports>
- Microsoft Cost Details automation guidance: <https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/manage-automation>

## Immutable official-source audit

The linked AWS sample repository is pinned at
`aws-samples/aws-data-pipelines-for-azure-storage@ca870a82ce9e8fba4670af9a649df4074f931e02`.
The CID framework commit
`f9e36d88c47709f10e8fa784ad11d5cc0e728021` contains **0
Azure-dashboard-specific artifacts**.

| Published artifact | Path or extraction | SHA-256 | Hash basis |
|---|---|---|---|
| README | `README.md` | `3d41c089cbf99c082504c01da029fcddcfc585a272af4b2e1e34ab3ede8c4b2f` | Raw file bytes |
| CloudFormation template | `CloudIntelligenceDashboardforAzure/CFN/cid-azure-stack.yaml` | `f91c63ab490f20df14434a14b945178f994ea3089fe9f07ae368b886b2e9dc00` | Raw file bytes |
| Dashboard manifest | `CloudIntelligenceDashboardforAzure/CFN/cid-azure-dashboard.yaml` | `7da6faa098d8e56c3bc3620139e70c7a246f58df95281676a4afd734c5c52905` | Raw file bytes |
| Embedded SPICE dataset | `cid-azure-dashboard.yaml#datasets` | `46ebf6e4750e4e22a266fcd49bb0f99a9d3a3b5cdbd184db320755bc49c057c9` | UTF-8 canonical JSON with recursively sorted object keys |
| Embedded Standard view query | `cid-azure-dashboard.yaml#views` | `77b6d8b0ceb69e95913c68bf2bb3ec00d6d751ae3ba6da8e3b2536f0bf74f3e5` | Exact UTF-8 bytes of decoded 204-byte YAML block scalar |
| Standard transform | `CloudIntelligenceDashboardforAzure/CFN/cid-azure-gluejob.py` | `1918596a83ba0a9a503d3a366531ffaf2520b1dd7b3c2a1426d02d45fb122b90` | Raw file bytes |
| FOCUS 1.0 transform | `CloudIntelligenceDashboardforAzure/CFN/cid-azure-gluejob-FOCUS-1.0.py` | `8633a21a72941e4ca7fd92c24a8793992b56c657c05c113b6ff6ce1852792be8` | Raw file bytes |
| Standard query | `CloudIntelligenceDashboardforAzure/TF/cid-azure-standard_view.sql` | `3dad019cf030ec5cb8ffd2eabeba80b4168164676554eef5d10eaf37f6241b92` | Raw file bytes |
| FOCUS consolidation query | `CloudIntelligenceDashboardforAzure/TF/cid-azure-focus_consolidation_view.sql` | `c35561bd208984659be28ec06334ae35ba93de5b305c6306fe280b9d58f8f434` | Raw file bytes |
| FOCUS resource query | `CloudIntelligenceDashboardforAzure/TF/cid-azure-focus_resource_view.sql` | `27495242f53cb74ad2fce145165aec9e2ad56edf6197e17d1d89a120d4f7a6c5` | Raw file bytes |
| FOCUS summary query | `CloudIntelligenceDashboardforAzure/TF/cid-azure-focus_summary_view.sql` | `d7b1d6549abc13a7033766311895b9674ca5f5cb1dd66dc7855deaef85330fd9` | Raw file bytes |

The manifest publishes one 21-column dataset and one embedded six-month view,
but references the service-hosted QuickSight template `cid-azure-cost`. It does
not publish a complete QuickSight definition or changelog. Exact sheet,
visual, parameter-control, filter-control, parameter, calculated-field, and
filter-group totals are therefore all **`null`**, not zero. Pixel geometry and
controls are not inferred from screenshots.

Only AWS-documented purposes are mapped: Azure cost visualizations and reports,
daily recurring exports, Glue transformation/tag expansion/error isolation,
six-month Athena/SPICE scope, and detailed resource analysis. The native UI
labels provider, price-sheet, recommendation, exact-definition, and live
acceptance gaps independently.

Assessment tree: working tree over `agent/enterprise-hardening-2`; the parent integration gate must record the final exact revision.

Current maturity: `PARTIAL_PIPELINE`

## Verified requirement inventory

AWS describes the Azure CID as Azure cost visualizations and reports for executives, finance, procurement, FinOps, and product owners. The reference pipeline uses recurring Azure Cost Management exports to Blob Storage, copies them to S3, transforms and deduplicates rows and tags, and supplies a six-month summary plus detailed recent resource views. The current AWS sample repository documents Standard and FOCUS export support.

Microsoft documents recurring exports for cost and usage data, FOCUS, price sheets, reservation recommendations, reservation details, and reservation transactions. Those datasets are separate authorities; the implementation does not invent price-sheet or reservation-recommendation values when they have not been joined.

| Required analysis plane | Native Sutra implementation | Evidence boundary |
|---|---|---|
| Six-month summary | Monthly exact billed/effective/list/contracted aggregation by currency | `summaryMonths` must equal six in the accepted capture. |
| 30-day resource detail | Daily activity and bounded resource drilldown | `resourceDetailDays` must equal 30; dates come from export rows. |
| Service and product | Service groups plus product/meter/SKU resource fields | Values remain null when absent in the export. |
| Subscription ownership | Subscription filter and allocation view | Stored source customer scope is resolved server-side. |
| Region/resource group | Region and resource-group filters and allocation views | Missing dimensions are explicitly “Unattributed.” |
| Pricing/commitments | Pricing category, commitment type/status, effective cost, list and contracted deltas | Deltas are calculated opportunity comparisons, never realized savings. |
| Charge classification | Usage, purchase, tax, credit, refund, adjustment, and other | Signed corrections are retained. |
| Tags | Tag key/value filters and row-level allocation evidence | Duplicate tag keys are rejected per row. |
| Resource export | Visible filtered rows with provenance-compatible fields | CSV cells beginning with formula control characters are neutralized. |

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 official requirements | `VERIFIED` | AWS and Microsoft primary sources above were reviewed on 2026-08-01. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | Strict Standard Actual Cost / FOCUS 1.0 capture schema, exact fields, signed integer micros, currencies and usage units isolated, six-month/30-day coverage declarations, row/byte/time bounds, explicit completeness and reconciliation. |
| G2 collector contract | `IMPLEMENTED_UNVERIFIED` | Server-owned Azure workload identity or secret reference; export, run-history, and Blob reads only; credential material prohibited; billing and Sutra tenant scope pinned. An identity-only daily scheduler and strict five-attempt durable handler reload the exact source boundary and hash-verify replay results. The shared runtime/replay adapter and concrete Azure provider adapter are not deployed. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | SQLite `0105` and PostgreSQL `0100`; immutable content-addressed snapshots; exact org/customer/source scope; READY/EMPTY-only monotonic accepted head; incomplete attempts retained without replacing the accepted generation. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | Authenticated read-only `GET /api/v1/finops/azure-cloud-intelligence`; browser supplies no org/customer scope; server discovers the authenticated organization’s sources, filters each by stored-customer authorization, supports multiple-source selection, uses exact activation reasons, and includes the frozen official audit in all five HTTP-200 branches. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Native responsive dashboard contains summary, six-month trend, 30-day activity, service/subscription/region/resource-group allocation, pricing/commitment, charge, tag and resource views, source selector, durable-runtime disclosure, evidence history, gap disclosure, and formula-safe CSV. The report-independent official panel validates the source pin/hash and remains visible during loading, configuration-required, failed, and ready states without synthesizing Azure evidence. |
| G6 focused verification | `VERIFIED` | Official-definition, vertical, and runtime suites: 13 passed, 0 failed, 0 skipped. Targeted ESLint, root TypeScript, and diff checks passed. |
| G7 exact-tree gate | `WORKING_TREE_VERIFIED` | Repository-wide `pnpm typecheck` passed on the current shared working tree. The parent must rerun the complete exact-revision gate after integration. |
| G8 controlled provider acceptance | `BLOCKED` | No Azure credential, recurring export, delivered Blob manifest, price sheet, reservation recommendation dataset, or deployed provider adapter is configured in this environment. |
| G9–G10 deployment | `NOT_STARTED` | Reviewed integration, immutable image build, deployment, rollback proof, and live two-tenant visual/API acceptance belong to the parent release gate. |

## Exact configuration and runtime states

- `AZURE_SOURCE_NOT_REGISTERED`
- `AZURE_SOURCE_NOT_SELECTED`
- `AZURE_CREDENTIAL_NOT_CONFIGURED`
- `AZURE_EXPORT_NOT_CONFIGURED`
- `AZURE_STORAGE_ACCESS_NOT_CONFIGURED`
- `AZURE_EXPORT_DELIVERY_NOT_OBSERVED`
- `AZURE_DATASET_SCHEMA_UNSUPPORTED`
- `AZURE_EXPORT_ADAPTER_NOT_DEPLOYED`

No local/browser credentials, synthetic cost rows, inferred invoices, simulated reservation recommendations, or placeholder savings values are used. Exported `billedCostMicros` is the realized cost measure. `calculatedListDeltaMicros` and `calculatedContractedDeltaMicros` are explicitly non-realized opportunities. Currencies and consumption units remain separate throughout normalization, persistence, API projection, UI, and CSV export.

Focused commands:

```text
node --experimental-strip-types --test --test-concurrency=1 tests/finops-azure-cid-official-definition.test.ts tests/finops-azure-cid-runtime-binding.test.ts tests/finops-azure-cid-vertical.test.mjs
pnpm exec eslint app/costs/finops-azure-cloud-intelligence-dashboard.tsx app/api/v1/finops/azure-cloud-intelligence/route.ts lib/finops-azure-cid-official-definition.ts tests/finops-azure-cid-official-definition.test.ts tests/finops-azure-cid-vertical.test.mjs
pnpm typecheck
git diff --check
```
