# ADD-03 — Cloud Intelligence Dashboard for GCP

Status: `PARTIAL_PIPELINE` until a live, same-tenant GCP Cloud Billing export adapter produces a complete generation. No sample or inferred money is shown.

## Official scope verified

The common CID framework commit `f9e36d88c47709f10e8fa784ad11d5cc0e728021`
contains no GCP dashboard definition. The authoritative separate repository was
audited at immutable commit `d0b5983db3a0931a63fcc21a9f7e2764483cfcaf`:
<https://github.com/awslabs/cid-gcp-cost-dashboard/blob/d0b5983db3a0931a63fcc21a9f7e2764483cfcaf/GCP-Cost-Dashboard.yaml>.
The audited artifact SHA-256 is
`78ed3d8245be60aea8f212e38f1458d6ea5be8b9f0fe660deee71f494ec7087c`.
Its seven sheets are Summary, Compute Engine, Cloud SQL, Big Query, Network,
Kubernetes, and About. Sutra now exposes all seven evidence views (using the
provider product spelling `BigQuery`) plus separate Credits, Resources,
Opportunities, and Evidence views. Exact visual geometry remains a live/browser
acceptance gate.

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
