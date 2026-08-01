# ADD-04 — FOCUS Dashboard evidence record

Reviewed: 2026-08-01

Official sources:

- AWS FOCUS Dashboard: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/focus-dashboard.html>
- Pinned AWS CID Framework definition: <https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/focus/focus-definition.yaml>
- FOCUS specification 1.2: <https://focus.finops.org/focus-specification/v1-2/>
- AWS organizational taxonomy guidance: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/add-org-taxonomy.html>
- Azure Cost Management exports: <https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-improved-exports>
- Google Cloud FOCUS export setup: <https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-focus-setup>

Assessment scope: the integrated provider-neutral contract, AWS report binding,
same-customer provider discovery, native UI, tests, and evidence slice.

Current maturity: `PARTIAL_PIPELINE`

## Official requirement inventory

- Consolidated FOCUS cost and usage across an organization and cloud providers.
- Multiple FOCUS specification versions in one consolidated view.
- Month-over-month trends with high-level-to-resource drilldown.
- Organizational taxonomy from tags.
- Effective discount-rate calculation.
- AWS FOCUS 1.2 Data Export from payer accounts, with other providers added by
  provider-specific collection integrations.

## Exact pinned-definition audit

The definition at commit `f9e36d88c47709f10e8fa784ad11d5cc0e728021`
has SHA-256 `bc7bafbcb47e745dd256a151ee3fbe260aad10515fc5e626e02aec0c6e6ea1cc`
and contains exactly three sheets and 27 visuals:

| Sheet | Exact controls | Official visual inventory | Sutra local mapping |
|---|---|---|---|
| `Billing Summary` | Charge Category, Billing Account, Sub Account, Publisher, Provider, Billing Period; two Group By controls; Cost (`Billed`, `Contracted`, `Effective`, `List`) | 18 visuals: daily cost by two selected dimensions, dimension pivot, discounts/adjustments/credits KPI and waterfall, effective discount rate, subaccount bar, provider/service-category Sankey, provider/service/account counts, region ranking and additional cost comparisons | Exact bounded billing controls are applied after the full immutable source is validated. All four cost columns retain completeness states. Daily trend, two independent dimension selectors, counts, exact discount-rate state, and charge-category analysis provide native functional equivalents; no missing optional cost column is substituted. |
| `MoM Trends` | The same cross-sheet dimensions plus two Group By controls | 9 visuals: effective cost by billing account, subaccount, service, provider and service category; two grouped pivots; detailed resource view; top-15 resource trend | Bounded monthly dimension buckets expose account, subaccount, provider, publisher, service, service category, charge category, invoice, Region, resource and resource type. The UI computes exact prior/current amount and percentage deltas only with complete selected-cost evidence and a non-zero prior denominator. Resource drilldown and top-resource selection remain bounded. |
| `About` | Cross-sheet Charge Category, Billing Account, Publisher and Provider | Notices and dashboard/version attribution | Sutra exposes source schema/version, immutable generations, manifests, limitations and explicit non-conformance/non-reconciliation notices. |

The official QuickSight Sankey, waterfall and word-cloud chart geometries are
not copied. Their evidence-backed functions are represented through bounded
rankings, charge-category analysis and exact KPIs. This is visual equivalence,
not a claim that Sutra reproduces AWS QuickSight assets pixel-for-pixel.

Exact title map from the pinned file:

- `Billing Summary` (18): `Daily ${Cost} per ${summaryGroupByTwo} in ${Currency}`;
  `${Cost} per ${summaryGroupByTwo} and ${summaryGroupByOne} in ${Currency}`;
  `Total Discounts, Adjustments and Credits in ${Currency}`; `Daily ${Cost} per
  ${summaryGroupByOne} in ${Currency}`; `Total Discounts, Credits and
  Adjustmets in ${Currency}`; `Effective Discount Rate in ${Currency}`; `${Cost}
  per Sub Account Name in ${Currency}`; `Service Category ${Cost} per Provider
  in ${Currency}`; `Total Providers`; `${Cost} per ${summaryGroupByTwo} in
  ${Currency}`; `Most popular Region by ${Cost}`; `Total Services`; `Total
  Accounts`; three `${Cost} in ${Currency}` KPIs; `${Cost} per
  ${summaryGroupByOne} in ${Currency}`; and `Credits and Adjustmets in
  ${Currency}`.
- `MoM Trends` (9): `Effective Cost by Billing Account in ${Currency}`;
  `Effective Cost by Sub Account in ${Currency}`; `Effective Cost by Service
  Name in ${Currency}`; `Detailed Resource View`; `Effective Cost by Provider
  in ${Currency}`; `Effective Cost by Service Category in ${Currency}`;
  `Effective Cost by ${MomGroupByTwo} in ${Currency}`; `Effective Cost by
  ${MomGroupBy1} in ${Currency}`; and `Effective Cost per Top 15 Resource in
  ${Currency}`.
- `About` has no QuickSight visual objects; its two text boxes contain the
  notices, attribution, version and links.

The five cross-sheet category controls resolve to `Charge Category`, `Billing
Account`, `Sub Account`, `Publisher`, and `Provider`; Billing Summary also has
the relative `Billing Period` control. Its Group By parameters allow Billing
Account, Charge Category, Invoice, Provider, Service, Service Category and Sub
Account, while its Cost parameter allows Billed, Contracted, Effective and List
Cost. MoM has two Group By parameters allowing Billing Account, Charge
Category, Provider, Service Category, Service Name and Sub Account.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Official feature and architecture inventory above, reviewed 2026-08-01. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | Provider-neutral `sutra.focus-neutral-line.v1` contract accepts explicit FOCUS 1.0, 1.0r2, 1.1, and 1.2 provenance, retains provider/dataset/generation/digest/data-through evidence, enforces exact same-tenant sources and signed integer micros, and rejects duplicate/unbound rows. The AWS 1.2 projection now retains independent billed/effective/contracted/list coverage, exact post-validation filters, daily trends and bounded month/dimension buckets. Mixed versions normalize only into common explicit fields; missing columns remain null. |
| G2 collector | `PARTIAL` | AWS FOCUS 1.2 Data Export remains the only materially bound collector. Authorized Azure sources are discovered but return `AZURE_FOCUS_1_0_NORMALIZED_BINDING_NOT_DEPLOYED`; non-FOCUS Azure sources return `AZURE_SOURCE_IS_NOT_FOCUS`. Existing GCP detailed billing export is never relabeled as Google’s separate preview FOCUS export and returns `GCP_FOCUS_EXPORT_ADAPTER_NOT_DEPLOYED`. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | Active FOCUS 1.2 canonical generations are immutable and scoped by tenant/export/period/generation; rejected source rows and evidence identity are retained. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | Authenticated same-tenant `GET /api/v1/finops/focus` retains the existing AWS connection/period behavior, adds an exact provider-source and billing-control allowlist, discovers Azure/GCP sources server-side, filters each against its stored customer authorization, accepts no client org/customer scope, and returns exact non-substitution activation reasons. Billing controls are applied inside the engine only after every source row passes immutable evidence, tenant, schema, bound and duplicate validation. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Exact per-currency billed/effective/contracted/list KPIs, provider/service/account counts, daily and monthly trends, MoM deltas, expanded dimensions, resource drilldown, quality, taxonomy, evidence, responsive layout, and delivery states are present. A provider source selector, normalized provider/version provenance, governed baseline tag taxonomy view, and evidence-backed effective-discount-rate state remain. Optional measures and MoM percentages are unavailable—not zero—unless their complete source coverage and denominator are proven. |
| G6 focused verification | `VERIFIED` | Native engine, neutral-contract, route, and rendered UI suite passes 21/21 with 0 failures/skips; full typecheck and targeted lint pass on the working tree. |
| G7–G10 | `NOT_STARTED` | Exact-tree, provider reconciliation, reviewed release, immutable deployment, and live acceptance remain. |

## Evidence-honesty limits

The dashboard explicitly makes no FOCUS conformance, invoice-reconciliation,
exchange-rate, or realized-savings claim. Currencies are never combined. CUR,
provider-native detailed exports, Cost Explorer, and sample values are never
substituted for FOCUS. The neutral engine proves version-safe consolidation,
taxonomy, and valid denominator behavior, while Azure and GCP FOCUS collector
bindings remain fail-closed. Maturity therefore remains `PARTIAL_PIPELINE`.

Focused command:

```text
node --experimental-strip-types --test tests/finops-focus-dashboard.test.ts tests/finops-focus-neutral.test.mjs tests/finops-focus-route-contract.test.mjs tests/finops-focus-dashboard-ui-contract.test.mjs
```

Result: **21 passed, 0 failed, 0 skipped**.
