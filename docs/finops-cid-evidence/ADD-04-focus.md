# ADD-04 — FOCUS Dashboard evidence record

Reviewed: 2026-08-01

Official sources:

- AWS FOCUS Dashboard: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/focus-dashboard.html>
- Pinned AWS CID Framework definition: <https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/focus/focus-definition.yaml>
- FOCUS specification 1.2: <https://focus.finops.org/focus-specification/v1-2/>
- AWS organizational taxonomy guidance: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/add-org-taxonomy.html>
- Azure Cost Management exports: <https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-improved-exports>
- Google Cloud FOCUS export setup: <https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-focus-setup>
- Official Azure integration repository at `ca870a82ce9e8fba4670af9a649df4074f931e02`: <https://github.com/aws-samples/aws-data-pipelines-for-azure-storage/tree/ca870a82ce9e8fba4670af9a649df4074f931e02>
- Official GCP dashboard repository at `d0b5983db3a0931a63fcc21a9f7e2764483cfcaf`: <https://github.com/awslabs/cid-gcp-cost-dashboard/tree/d0b5983db3a0931a63fcc21a9f7e2764483cfcaf>
- Official OCI integration repository at `27459467b931181635b2e070a93a8865bf3314bd`: <https://github.com/awslabs/cid-oci-cost-dashboard/tree/27459467b931181635b2e070a93a8865bf3314bd>

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
| `About` | Cross-sheet Charge Category, Billing Account, Publisher and Provider | Zero QuickSight visual objects; notices and dashboard/version attribution are layout text boxes | Sutra exposes source schema/version, immutable generations, manifests, limitations and explicit non-conformance/non-reconciliation notices. |

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

## Immutable artifact audit

All values below are SHA-256. File rows hash raw bytes. Embedded datasets and
the dynamic schema hash UTF-8 canonical JSON with recursively sorted object
keys. Embedded queries hash decoded YAML scalar UTF-8 bytes. The complete
unshortened audit is frozen in `lib/finops-focus-official-definition.ts`.

| AWS CID artifact | SHA-256 |
|---|---|
| `dashboards/focus/focus.yaml` | `a9521d2ece8cb8defe0d791ca018c660d6872394a75593fae1d0acfe12b9c4cb` |
| `dashboards/focus/focus-definition.yaml` | `bc7bafbcb47e745dd256a151ee3fbe260aad10515fc5e626e02aec0c6e6ea1cc` |
| `changes/CHANGELOG-focus.md` | `41bb336c1dcfe285c5b5dcfd469c6170a9d2cad4db41055a15f3506257606541` |
| `cid/helpers/focus_consolidation.py` | `263c68eabf1533823758354935edfd5990cd89240786342af28953d8f066d7e9` |
| consolidation SQL template | `7961d360f84f0fe60c67ff25931d02b7298f53d5ddcabeb58bdb8f64bd93f1a4` |
| `focus_resource_view` dataset (56 inputs) | `3585537829427afa0a88e0b71033797c444615375917b8395a10abfac4cfe6d2` |
| `focus_summary_view` dataset (51 inputs) | `40c5246f7d7422b4e018ea5190596e7b9fd87a5e75c502670af151e4c2269170` |
| `focus_resource_view` embedded SQL | `36a6a31c9b26c7d8ff22396cdf5bbe5d432efafa70073f10f16e2aee7192ece3` |
| `focus_summary_view` embedded SQL | `35f0c6cfb9d8bc24542d15c4f2c96a805a42630a4bc8be7a3dda7105737ab6f2` |
| dynamic 58-column consolidation schema | `c841e0fa7a9a0c202b5d226fe8b7ec675216fe3e47df6674eb800e8ed25f13d5` |

The definition contains exactly five parameter controls, 15 filter controls,
six parameter declarations, 24 calculated fields, 45 filter groups, 16 column
configurations and two dataset declarations. Its 27 visuals are five combo
charts, four pivots, eight KPIs, one waterfall, six bars, one Sankey, one word
cloud and one line chart.

### Provider repository truth

| Provider | Immutable official evidence | Native state |
|---|---|---|
| AWS | Complete CID definition, manifest, datasets, views and consolidation helper at `f9e36d88c47709f10e8fa784ad11d5cc0e728021`. | `BOUND_FOCUS_1_2`; only immutable active AWS FOCUS 1.2 generations are accepted. |
| Azure | `aws-data-pipelines-for-azure-storage@ca870a82ce9e8fba4670af9a649df4074f931e02` publishes FOCUS 1.0/1.0r2 transformation and consolidation/resource/summary queries. Relevant hashes are frozen for README, stack, manifest, transform and three queries. The separate Azure dashboard manifest has no embedded FOCUS QuickSight definition. | `AZURE_FOCUS_1_0_NORMALIZED_BINDING_NOT_DEPLOYED`. |
| GCP | `cid-gcp-cost-dashboard@d0b5983db3a0931a63fcc21a9f7e2764483cfcaf` publishes a native BigQuery detailed-billing dashboard, not a FOCUS adapter. Its manifest is `78ed3d82…`; embedded definition `f0c8192e…`; it has exactly seven sheets, 60 visuals, 47 parameter controls and seven filter controls. Those counts are supplemental non-FOCUS evidence only. | `GCP_FOCUS_EXPORT_ADAPTER_NOT_DEPLOYED`; detailed billing is never relabelled as FOCUS. |
| OCI | `cid-oci-cost-dashboard@27459467b931181635b2e070a93a8865bf3314bd` publishes a FOCUS collector/transform and consolidation queries, but no QuickSight definition or changelog. All relevant README, stack, transform and query hashes are frozen. | `OCI_SOURCE_DISCOVERY_AND_BINDING_NOT_DEPLOYED`; OCI is not offered as a selectable Sutra source. |

The API returns the frozen definition in all five HTTP-200 branches, including
every `report: null` response. The UI renders its exact sheets, counts,
immutable identity and provider gaps independently of billing-report presence.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Official feature and architecture inventory above, reviewed 2026-08-01. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | Provider-neutral `sutra.focus-neutral-line.v1` contract accepts explicit FOCUS 1.0, 1.0r2, 1.1, and 1.2 provenance, retains provider/dataset/generation/digest/data-through evidence, enforces exact same-tenant sources and signed integer micros, and rejects duplicate/unbound rows. The AWS 1.2 projection now retains independent billed/effective/contracted/list coverage, exact post-validation filters, daily trends and bounded month/dimension buckets. Mixed versions normalize only into common explicit fields; missing columns remain null. |
| G2 collector | `PARTIAL` | AWS FOCUS 1.2 Data Export remains the only materially bound collector. Authorized Azure sources are discovered but return `AZURE_FOCUS_1_0_NORMALIZED_BINDING_NOT_DEPLOYED`; non-FOCUS Azure sources return `AZURE_SOURCE_IS_NOT_FOCUS`. Existing GCP detailed billing export is never relabeled as Google’s separate preview FOCUS export and returns `GCP_FOCUS_EXPORT_ADAPTER_NOT_DEPLOYED`. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | Active FOCUS 1.2 canonical generations are immutable and scoped by tenant/export/period/generation; rejected source rows and evidence identity are retained. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | Authenticated same-tenant `GET /api/v1/finops/focus` retains the existing AWS connection/period behavior, adds an exact provider-source and billing-control allowlist, discovers Azure/GCP sources server-side, filters each against its stored customer authorization, accepts no client org/customer scope, and returns exact non-substitution activation reasons. Billing controls are applied only after immutable evidence, tenant, schema, bound and duplicate validation. All five HTTP-200 branches expose the frozen official definition. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Exact per-currency billed/effective/contracted/list KPIs, provider/service/account counts, daily and monthly trends, MoM deltas, expanded dimensions, resource drilldown, quality, taxonomy, evidence, responsive layout, and delivery states are present. A report-independent panel renders the three exact official sheets, object totals and AWS/Azure/GCP/OCI binding truth. Optional measures and MoM percentages are unavailable—not zero—unless complete coverage and denominator evidence are proven. |
| G6 focused verification | `VERIFIED` | Native engine, neutral-contract, route, frozen-definition and rendered UI suite passes 26/26 with 0 failures/skips; targeted lint and repository diff-check pass. The attempted full typecheck reached a concurrent Media Services test error outside ADD-04; no FOCUS error was reported. |
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
node --experimental-strip-types --test tests/finops-focus-dashboard.test.ts tests/finops-focus-neutral.test.mjs tests/finops-focus-route-contract.test.mjs tests/finops-focus-dashboard-ui-contract.test.mjs tests/finops-focus-official-definition.test.ts
```

Result: **26 passed, 0 failed, 0 skipped**.

## Merge record — 2026-08-06

Merged to `main` since this record was last updated (2026-08-05 15:01). Every
item below is source-only work that landed through review with CI green on the
merge commit — nothing more. No provider, live, two-tenant, or release evidence
is created by any of it.

**Maturity is unchanged (`PARTIAL_PIPELINE`) and no child-stage gate passed.** G7
fixed-tree, G8 controlled provider acceptance, G9 release and G10 deployment
remain unpassed for this row; no live acceptance, provider reconciliation, or
two-tenant acceptance is claimed.

- **Native chart kit and catalog identity — `4ac72bd` (PR #36) and `f107cdf`
  (PR #37).** This row's view moved onto the shared native chart kit at
  `app/components/charts`:
  - `app/costs/finops-focus-dashboard.tsx`

  Focused rendering proof added with it:
  - `tests/finops-focus-charts.test.mjs`
  - `tests/finops-focus-dashboard-ui-contract.test.mjs`

  Across `app/costs/`, 28 view modules plus the catalog page now import the kit,
  and the kit's own rendering suite `tests/chart-kit-rendering.test.mjs` holds
  12 tests. `app/costs/finops-dashboard-identity.tsx` renders each dashboard's
  catalog glyph, name and ID above every opened view
  (`tests/finops-dashboard-identity.test.mjs`). This is UI rendering work only:
  no source contract, collector operation, migration, API shape, or evidence
  semantic changed, and no G5 or G6 stage status is promoted by it.

- **Foundational export successor revisions — `dcbc08f` (PR #38).**
  `infrastructure/finops-foundational-cur2-export-v1.1.yaml` and
  `infrastructure/finops-foundational-focus12-export-v1.1.yaml` were authored to
  accept the deployable `standard-2026-08.12` base-collector ceiling. Grants,
  resources, logical names and outputs are byte-identical to the v1 templates;
  only the `BaseCollectorPermissionPackVersion` acceptance gate changed. Its
  `AllowedValues` is now exactly `standard-2026-08.1` and `standard-2026-08.12`,
  defaulting to `.12`, and the launch assertion is an exact `Fn::Or` over those
  two enumerated values — no lexical comparison and no permissive regex. The v1
  files were not touched and their bytes remain immutable. Source only: neither
  revision has been published or launched, and the add-on stays gated by
  publish-before-application — a separately reviewed base collector role must be
  deployed and attested before the stack may launch. G1 status is unchanged.
