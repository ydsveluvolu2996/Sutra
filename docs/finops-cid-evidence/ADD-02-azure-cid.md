# ADD-02 — Cloud Intelligence Dashboard for Azure evidence record

Reviewed: 2026-08-01

Official sources:

- AWS Cloud Intelligence Dashboards catalog: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/dashboards.html>
- AWS implementation guidance, “How to view Azure costs using Amazon QuickSight”: <https://aws.amazon.com/blogs/modernizing-with-aws/cloud-intelligence-dashboard-for-azure/>
- AWS reference data pipeline for Azure Storage: <https://github.com/aws-samples/aws-data-pipelines-for-azure-storage>
- Microsoft Cost Management recurring exports: <https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-improved-exports>
- Microsoft Cost Details automation guidance: <https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/manage-automation>

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
| G2 collector contract | `IMPLEMENTED_UNVERIFIED` | Server-owned Azure workload identity or secret reference; export, run-history, and Blob reads only; credential material prohibited; billing and Sutra tenant scope pinned. A concrete Azure provider adapter is not deployed. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | SQLite `0105` and PostgreSQL `0100`; immutable content-addressed snapshots; exact org/customer/source scope; READY/EMPTY-only monotonic accepted head; incomplete attempts retained without replacing the accepted generation. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | Authenticated read-only `GET /api/v1/finops/azure-cloud-intelligence`; browser supplies no org/customer scope; server discovers the authenticated organization’s sources, filters each by stored-customer authorization, supports multiple-source selection, and uses exact activation reasons. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Native responsive dashboard contains summary, six-month trend, 30-day activity, service/subscription/region/resource-group allocation, pricing/commitment, charge, tag and resource views, source selector, evidence history, gap disclosure, and formula-safe CSV. |
| G6 focused verification | `VERIFIED` | `tests/finops-azure-cid-vertical.test.mjs`: 5 passed, 0 failed, 0 skipped. Targeted ESLint passed. |
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
node --test tests/finops-azure-cid-vertical.test.mjs
pnpm exec eslint app/costs/finops-azure-cloud-intelligence-dashboard.tsx app/api/v1/finops/azure-cloud-intelligence/route.ts lib/finops-azure-cid.ts lib/finops-azure-cid-collector-job.ts db/finops-azure-cid-repository.ts tests/finops-azure-cid-vertical.test.mjs
pnpm typecheck
git diff --check
```
