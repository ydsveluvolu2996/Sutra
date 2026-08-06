# ADD-03 — Cloud Intelligence Dashboard for GCP

Status: `PARTIAL_PIPELINE` until a live, same-tenant GCP Cloud Billing export adapter produces a complete generation. No sample or inferred money is shown.

Reviewed: 2026-08-01

## Official scope verified

The common CID framework commit `f9e36d88c47709f10e8fa784ad11d5cc0e728021`
contains no GCP dashboard definition. The authoritative separate repository was
audited at immutable commit `d0b5983db3a0931a63fcc21a9f7e2764483cfcaf`:
<https://github.com/awslabs/cid-gcp-cost-dashboard/blob/d0b5983db3a0931a63fcc21a9f7e2764483cfcaf/GCP-Cost-Dashboard.yaml>.
The audited manifest SHA-256 is
`78ed3d8245be60aea8f212e38f1458d6ea5be8b9f0fe660deee71f494ec7087c`.
Its seven sheets are Summary, Compute Engine, Cloud SQL, Big Query, Network,
Kubernetes, and About. Sutra now exposes all seven evidence views (using the
provider product spelling `BigQuery`) plus separate Credits, Resources,
Opportunities, and Evidence views. Exact visual geometry remains a live/browser
acceptance gate.

## Immutable public artifact audit

| Artifact | SHA-256 | Hash basis |
|---|---|---|
| `README.md` | `3e8baa8574a604fe4d061beebbe1a84cb4ea28afb0fc8e36a35b5c3b5bcd9059` | Raw file bytes |
| `GCP-Cost-Dashboard.yaml` | `78ed3d8245be60aea8f212e38f1458d6ea5be8b9f0fe660deee71f494ec7087c` | Raw file bytes |
| Embedded QuickSight definition | `f0c8192efe855309d5cd63189b9a7c10e0819b2ee7eb64e124fae47588347b07` | Decoded YAML scalar UTF-8 bytes |
| `GCP-Cost-Dashboard-Stack.yaml` | `d6d4b02fd0ca40270e212600e88bf021e431db924875fb0d3670b5ec6cdea8a4` | Raw file bytes |
| Embedded dataset `gcp_currency` | `a20a78ce6cc2150640e7f0aa39671c0c2ec5e5964b5fc48141ee6f1d2a6920e8` | UTF-8 canonical JSON with recursively sorted object keys |
| Embedded dataset `gcp_summary_with_pricing` | `171af7d3e269bd51871a3bc860cda8354bf37fd3b942ddbd6b63d15a22016624` | UTF-8 canonical JSON with recursively sorted object keys |
| Embedded view query `gcp_currency` | `0cc292a475e92c5b47eef7308f367dad25f71ef382f8f0d70214a4cf7de449f7` | Decoded YAML scalar UTF-8 bytes |
| Embedded view query `gcp_current_pricing` | `0edd777957dccca9dcc7d92d8868aaf93dc1b23a22496f3b981e8bf5cac8206b` | Decoded YAML scalar UTF-8 bytes |
| Embedded view query `gcp_summary` | `d0fe4d58905b1a95a2da2ea24f0c22fce196854112559430352fc26abac5c221` | Decoded YAML scalar UTF-8 bytes |

The pinned repository publishes no changelog, release version, standalone
QuickSight definition, standalone template body, or external template ID.
Those fields are `null`; they are not inferred from Git history or deployment
defaults. The two embedded dataset contracts contain respectively two input
columns and 72 physical input-column occurrences (66 unique names).

## Exact QuickSight source inventory

The complete embedded definition has exactly seven sheets, 60 visuals, 47
parameter controls, seven filter controls, 14 parameter declarations, 53
calculated fields, 172 filter groups, 23 column configurations, two datasets,
and three manifest views.

| Sheet | Visuals | Parameter controls | Filter control | Visual types |
|---|---:|---|---|---|
| Summary | 27 | Default Cost, Currency, Project, Product, Group By, Billing Account Id, L1–L6 | Cost Type | 6 Sankey, 10 pivot, 3 line, 1 table, 5 bar, 1 waterfall, 1 combo |
| Compute Engine | 19 | Billing Account Id, L1–L6 | Cost Type | 11 bar, 2 combo, 3 pivot, 1 heat map, 1 Sankey, 1 line |
| Cloud SQL | 7 | Billing Account Id, L1–L6 | Cost Type | 1 pivot, 5 bar, 1 Sankey |
| Big Query | 3 | Billing Account Id, L1–L6 | Cost Type | 1 pivot, 2 bar |
| Network | 3 | Billing Account Id, L1–L6 | Cost Type | 1 pivot, 2 bar |
| Kubernetes | 1 | Billing Account Id, L1–L6 | Cost Type | 1 bar |
| About | 0 | None | Cost Type | No QuickSight visual objects; attribution is layout text |

The aggregate visual inventory is eight Sankey, 16 pivot, four line, one table,
26 bar, one waterfall, three combo, and one heat-map object. These are exact
source counts, not a claim of pixel, layout, query-result, or interaction
parity in Sutra.

- [AWS Cloud Intelligence Dashboards — dashboard catalog](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/dashboards.html) classifies the GCP dashboard as an Additional dashboard that exports Google Cloud billing data for visualization and reporting, for executives, finance/procurement, FinOps, and product owners.
- [AWS Labs CID GCP project](https://github.com/awslabs/cid-gcp-cost-dashboard) requires one or more BigQuery billing export tables plus the Cloud Billing pricing export. Its published QuickSight definition contains the `Summary`, `Compute Engine`, `Cloud SQL`, `Big Query`, `Network`, `Kubernetes`, and `About` sheets. It filters and drills through billing account, project hierarchy, service/product, SKU, region, usage period, credit classes, usage/pricing units, labels, cores, memory, and resource detail where supplied.
- [Google Cloud Billing export table types](https://cloud.google.com/billing/docs/how-to/export-data-bigquery-tables) documents FOCUS, standard usage, detailed usage, pricing, and committed-use-discount metadata exports.
- [Google Cloud billing export setup](https://cloud.google.com/billing/docs/how-to/export-data-bigquery) documents that delivery is asynchronous, has no latency guarantee, and that regional datasets do not receive historical backfill from before enablement. Pricing export starts only after enablement.
- [Google detailed usage export schema](https://cloud.google.com/billing/docs/how-to/export-data-bigquery-tables/detailed-usage) documents resource-level fields, credits, project ancestry, labels/system labels, cost types, locations, and usage/pricing fields. Labels and hierarchy describe the resource when usage was recorded. GKE breakdown depends on GKE cost allocation.

## Native Sutra coverage

| Published/provider view | Sutra evidence-backed implementation |
|---|---|
| Summary | Exact cost before credits, realized credits, net billed cost, invoice-month trend, project/service/SKU/region/resource breakdowns |
| Compute Engine | Service/SKU/resource/location/usage drilldowns when detailed export rows supply them |
| Cloud SQL | Service/SKU/project/region/resource drilldowns; engine-specific visuals are evidence-gated by supplied SKU/system-label data |
| BigQuery | Service/SKU/project/region, usage amount/unit, pricing quantity/unit, labels, and exact billed cost |
| Network | Service/SKU/project/region and usage-unit detail |
| Kubernetes | Cluster allocation only when `goog-k8s-cluster-name` evidence is present and GKE cost allocation is enabled |
| Credits and discounts | Provider credit facts grouped as CUD, sustained-use, discount, free-tier, promotion, reseller margin, or other |
| Pricing economics | Optional list-cost/pricing variance shown as calculated, never billed or realized savings |
| Optimization | Optional authoritative GCP Recommender export channel; no opportunity is inferred from spend |
| Evidence | BigQuery job/query/schema hashes, row exhaustion/count, immutable generation/head, freshness, activation gates, limitations |

Money is stored and aggregated as signed integer nano-units (`10^-9`) to retain BigQuery `NUMERIC` precision. Billed cost, credits, calculated pricing variance, and recommendation savings are separate fields and UI sections.

## Activation and trust boundary

The engine accepts only a provider-specific `gcp_billing_connections` source bound to organization, customer, billing account, independently scoped billing and pricing export projects/datasets/tables, location, and a `gcpwif_<sha256>` workload-identity reference. It never reads `aws_connections`, never accepts a service-account key in the collection contract, never takes organization/customer scope from the client, and fails closed on provider, source, billing-account, or tenant substitution.

The authenticated API discovers active GCP billing sources inside the session organization. One source is selected automatically; multiple sources return a safe billing-account/project/location chooser; an explicit `sourceId` must belong to that same tenant. The native UI therefore has no AWS `connectionId` dependency. Shared navigation integration should render `FinopsGcpCloudIntelligenceDashboard` with no prop, or pass a previously selected GCP ID through `initialSourceId`; it must not pass the currently selected AWS connection.

## Persistence and operations

- SQLite migration: `drizzle/0106_finops_gcp_cloud_intelligence.sql`
- PostgreSQL migration: `postgres/migrations/0101_finops_gcp_cloud_intelligence.sql`
- Immutable attempts retain configuration, permission, waiting, partial, empty, and ready states.
- Only `READY` or `EMPTY` complete generations can advance the active head, and head movement is monotonic by completion time and generation ID.
- Formula-safe CSV neutralizes cells beginning with `=`, `+`, `-`, `@`, tab, or carriage return.

The permanent Workload Identity / BigQuery runtime adapter is not present in this repository, so activation remains `PARTIAL_PIPELINE` with reason `GCP_BIGQUERY_BILLING_EXPORT_ADAPTER_NOT_DEPLOYED`. The adapter contract requires `bigquery.jobs.create`, `bigquery.tables.get`, and `bigquery.tables.getData`, parameterized read-only queries, exact table scope, bounded rows, exhaustive pagination, and complete lineage. No production deployment was performed by this isolated vertical.

## Frozen evidence integration and verification

`lib/finops-gcp-cloud-intelligence-official-definition.ts` freezes the source
identity, artifact hashes and hash bases, exact QuickSight inventory, per-sheet
native mapping, unpublished fields, and live-adapter gaps. All four HTTP-200
API branches return it: no source, source selection required, configured source
without a generation, and report available. The client rejects an unrecognized
schema, commit, manifest hash, embedded-definition hash, or 7/60 object count.
The official panel is rendered independently in loading, configuration,
selection, error, and report states.

Focused verification command:

```text
node --experimental-strip-types --test tests/finops-gcp-cloud-intelligence.test.mjs tests/finops-gcp-cloud-intelligence-vertical.test.mjs tests/finops-gcp-cloud-intelligence-official-definition.test.ts tests/finops-gcp-cloud-intelligence-official-ui.test.mjs
```

Result: **10 passed, 0 failed, 0 skipped**. Scoped ESLint, full
`tsc --noEmit`, and repository diff-check pass on the integrated working tree.

Provider adapter registration, live same-tenant reconciliation, exact-tree
browser validation, reviewed release, immutable image deployment, and live
acceptance remain open. Maturity therefore remains `PARTIAL_PIPELINE`.

## Merge record — 2026-08-06

Merged to `main` since this record was last updated (2026-08-05 15:01).

**Maturity is unchanged (`PARTIAL_PIPELINE`) and no child-stage gate passed.**
Exclusion is not completion.

- **ADD-03 Cloud Intelligence Dashboard for GCP remains excluded from the 27-dashboard release build.** None of the
  workstreams merged since 2026-08-05 — the native chart-kit migration
  (`4ac72bd`, `f107cdf`), the foundational export successor revisions
  (`dcbc08f`), the `aws_static_credentials` onboarding method (`6298f03`), or
  the AWS SDK client declarations (`92a0084`) — produced any GCP-specific
  work. **No chart-kit migration is claimed for this row.** `app/costs/finops-gcp-cloud-intelligence-dashboard.tsx` was not modified. The only change reaching this view is repository-wide and shared: `app/costs/finops-foundational-panels.tsx` stopped drawing an absent series as a floored zero (`tests/finops-shared-panel-floors.test.mjs`), which tightens the absent-is-not-zero invariant rather than adding capability. The GCP
  identity, adapter, provider-generation and reconciliation gaps recorded above
  are outstanding exactly as written.
