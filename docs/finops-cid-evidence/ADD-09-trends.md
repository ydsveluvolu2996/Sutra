# ADD-09 — Trends Dashboard evidence record

Reviewed: 2026-08-01

Official catalog source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/trends-dashboard.html>

Official feature inventory: <https://aws.amazon.com/blogs/aws-cloud-financial-management/trends-dashboard-with-aws-cost-and-usage-reports-amazon-athena-and-amazon-quicksight/>

Immutable framework source: AWS
`cloud-intelligence-dashboards-framework` commit
`f9e36d88c47709f10e8fa784ad11d5cc0e728021`.

Assessment: immutable official-source audit plus local native ADD-09 vertical;
not yet provider or release validated.

Current maturity: `LOCAL_VERTICAL_CANDIDATE`

## Published artifact inventory

The pinned framework does **not** publish the Trends QuickSight analysis or
dashboard definition. It identifies service-hosted template
`cudos-trends-dashboard-template`, dashboard `trends-dashboard`, minimum
template version 1 / description `v5.0.0`, while the public changelog documents
`v5.1.0`. Consequently, exact sheet, visual, filter-control,
parameter-control, parameter and calculated-field totals are all **unknown
(`null`)**, not zero. No pixel-parity claim is possible from the public source.

All public deployment, manifest, changelog, query and dataset-template
artifacts relevant to Trends at the pinned commit were independently hashed:

| Kind | Pinned path | SHA-256 |
|---|---|---|
| Resource manifest | `cid/builtin/core/data/resources.yaml` | `41ad438cea2a297f62976689e77eee8fda371913a6af53c946fb615bdccb5b71` |
| Changelog | `changes/CHANGELOG-trends.md` | `7ce940a15cdd50957df18f0a362484a04e9be44f665aefede779c87401f7365e` |
| Deployment template | `cfn-templates/cid-plugin.yml` | `b96a47e6b53418293ec7127d0a95f96f2ffdae2781cde2b2dffcabad926a713d` |
| Athena query | `cid/builtin/core/data/queries/trends/daily_anomaly_detection.sql` | `a17a40f084dfebbf14c146bfc466282f78a14607c5898a19a53b320c13e9901b` |
| Athena query | `cid/builtin/core/data/queries/trends/monthly_anomaly_detection.sql` | `e21fce72e791f95d9e7d4a01952367ed41b27391069a082fc51d19e85e96dfa2` |
| Athena query | `cid/builtin/core/data/queries/trends/monthly_bill_by_account.sql` | `30916d149b3d7d06f8ef9cedbb281cd71e3c14e8d0f41d5f0232abd0019c6fe1` |
| SPICE dataset definition | `cid/builtin/core/data/datasets/trends/daily_anomaly_detection.json` | `bf9d4e26a4d2fb13f9f6dc05c9f5b38e4853d20733c4fce5370f856cf43aafc5` |
| SPICE dataset definition | `cid/builtin/core/data/datasets/trends/monthly_anomaly_detection.json` | `705bafb2b8c2abe7d217addc454b026d1c573e85f9d10658c6811aa9711fccb4` |
| SPICE dataset definition | `cid/builtin/core/data/datasets/trends/monthly_bill_by_account.json` | `f33c76de9e8c12d12129d0491dcf5cb1e326db666ea35b177f81622e5e093739` |

The manifest proves exactly three SPICE datasets and three Athena views:

| Dataset | Columns | Query window / purpose |
|---|---:|---|
| `daily-anomaly-detection` | 6 | Daily account/product unblended cost and usage, latest 110 days |
| `monthly-anomaly-detection` | 6 | Monthly account/product unblended cost and usage, latest 20 months |
| `monthly-bill-by-account` | 14 | Monthly payer/usage account, charge type, product, Region, unblended/amortized cost, account names, coordinates and service category |

The monthly view joins public account, payer-name, Region-coordinate and
service-category maps. Those joins are part of the official query contract;
Sutra does not claim them when its governed evidence has not ingested them.

## Provable documented feature areas

The current AWS guide defines the audience and prerequisite: the dashboard
gives financial and technology leaders proactive usage trends, signals,
insights and anomalies, and requires at least one Foundational Dashboard. The
AWS-authored feature article and v5.1 changelog prove these purposes:

- yearly, monthly and quarterly trends with monthly actuals;
- QuickSight ML forecast;
- expandable service-category and service-usage trends with one-click
  same-sheet filtering;
- service percentage change over the latest three months;
- payer and usage-account trends with friendly names;
- global usage map and Region drilldown, excluding AWS China Regions;
- QuickSight threshold alerts and scheduled delivery; and
- v5.1 AWS Usage additions: Spend by Calendar Period and a payer-plus-usage
  account spend pivot.

Named documented controls are `Date range`, `As of Date`, `PayerAccountId`,
`UsageAccountId`, `AWS service`, `charge type`, and selectable `Unblended` or
`Amortized` cost basis. AWS says other fields exist but does not enumerate
them; seven named capabilities must not be misrepresented as the complete
QuickSight control-object count.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Current AWS guide/article plus nine hash-pinned public framework artifacts above, reviewed 2026-08-01. Missing QuickSight object definition and all resulting `null` totals are explicit. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | Reuses canonical AWS CUR 2.0 Data Export evidence; the Trends engine adds no AWS operation. Rows repeat exact tenant/customer/connection/export/period/generation scope and accepted currencies. Organizations friendly-name taxonomy is not substituted. |
| G2 collector | `IMPLEMENTED_UNVERIFIED` | Reuses the governed CUR2 Data Exports/S3 collector and reconciled active generations. No client-supplied source or synthetic Trends collector is accepted. Exact-tree collector verification remains G7. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | Reads immutable active billing partitions with manifest SHA-256, source evidence, generation identity, accepted/rejected row counts, commit time and last-good active-head semantics. Live PostgreSQL and replay proof remain G7/G8. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | Authenticated same-tenant read-only `GET /api/v1/finops/trends`; exact query allowlist; 36-period request cap, 120 available-period cap, 500,000-row engine cap, active canonical CUR2-only selection, waiting/empty/incomplete/error contracts, and versioned capability closure. Every successful HTTP state returns `sutra.finops-trends-official-definition.v1`. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Native UI renders the frozen source/version boundary, all nine artifact hashes, three dataset contracts, every provable named control and all documented feature-area mappings. It preserves existing monthly actuals, exact comparisons, drilldowns, export and lineage. QuickSight object totals render as not published, and ML/Organizations/map/QuickSight automation gaps remain visible. No pixel parity is claimed. |
| G6 focused verification | `VERIFIED_LOCAL` | Trends engine, adapter, export, capability, route, render and official-definition tests cover exact arithmetic, tenancy, all source pins, explicit `null` object totals, every documented feature mapping, all successful API states and server-rendered audit coverage. |
| G7 exact-tree gate | `NOT_STARTED` | Must run at one clean integration SHA after concurrent dashboard slices finish. |
| G8–G10 | `NOT_STARTED` | Controlled CUR2 reconciliation, two-tenant/provider evidence, reviewed merge, immutable image deployment and live visual/API acceptance remain. |

## Evidence-honesty limits

The enterprise path does not use the older generic Number-based forecast
engine. It uses exact BigInt micro-unit totals and reduced rational
percentages, keeps currencies and cost bases separate, and never interpolates
missing or partial months. Its pinned signals are informational review
indicators, not AWS Cost Anomaly Detection findings or ML inference.

The visual describes CUR2 Region cost and unit-separated usage as a table, not
the official geographic map. Friendly names are shown only when CUR2 supplies
one unambiguous value; no Organizations API result is claimed. The Sutra
forecast is a deterministic integer linear trend with a mean absolute residual
band, not QuickSight ML, a statistical confidence interval or a quote. Sutra
automation is separate from absent QuickSight automation evidence. Provider
forecast, QuickSight configuration, Organizations identity, authoritative map
coordinates, exact-tree, reconciliation and live acceptance remain blockers.

Focused commands:

```text
node --test tests/finops-cur-intelligence-routes-ui-contract.test.mjs
node --experimental-strip-types --test tests/finops-trends-official-definition.test.mjs
pnpm exec tsx --test tests/finops-trends-intelligence.test.ts tests/finops-trends-inputs.test.ts tests/finops-trends.test.ts tests/finops-trends-export.test.ts tests/finops-trends-capability-closure.test.ts
pnpm typecheck
pnpm exec eslint lib/finops-trends-official-definition.ts tests/finops-trends-official-definition.test.mjs app/costs/finops-cur-intelligence-panels.tsx app/api/v1/finops/trends/route.ts tests/finops-cur-intelligence-routes-ui-contract.test.mjs
```

Result: **45 passed, 0 failed, 0 skipped**; all nine independently pinned
artifact hashes revalidated, root typecheck and scoped ESLint passed, and the
scoped diff check is clean.
