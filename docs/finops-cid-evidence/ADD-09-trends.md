# ADD-09 — Trends Dashboard evidence record

Reviewed: 2026-08-01

Official catalog source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/trends-dashboard.html>

Official feature inventory: <https://aws.amazon.com/blogs/aws-cloud-financial-management/trends-dashboard-with-aws-cost-and-usage-reports-amazon-athena-and-amazon-quicksight/>

Assessment tree: working tree over `78dfdc1a2d4a`; final integration revision
must be recorded by the parent exact-tree gate.

Current maturity: `LOCAL_VERTICAL_CANDIDATE`

## Official requirement and visual inventory

The current implementation guide defines the audience and prerequisite: the
dashboard gives financial and technology leaders proactive AWS usage trends,
signals, insights, and anomalies, and requires at least one Foundational
Dashboard. The linked AWS feature article supplies the detailed visual
inventory:

- yearly, monthly, and quarterly trends with monthly actuals and ML forecast;
- threshold alerts and scheduled report delivery;
- expandable service-category and service usage trends with one-click
  same-sheet filtering;
- service percentage change over the latest three months;
- payer and usage-account trends, including AWS Organizations friendly names;
- date, payer, usage-account, service, charge-type, and other filter controls;
- selectable unblended and amortized cost; and
- a global geographic usage map with Region drilldown.

Acceptance cases derived from that inventory include complete 24-plus-month
history for rolling-year comparison, partial/missing-month suppression,
currency and cost-basis isolation, one-click companion-panel filtering,
account/service/Region movement, safe export lineage, tenant isolation,
bounded over-volume rejection, and explicit unavailable states for any
provider feature whose evidence is absent.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Current AWS guide plus the AWS-authored detailed feature/visual inventory above, reviewed 2026-08-01. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | Reuses canonical AWS CUR 2.0 Data Export evidence; the Trends engine adds no AWS operation. Rows must repeat the exact tenant/customer/connection/export/period/generation scope and accepted currencies. Organizations friendly-name taxonomy is not substituted. |
| G2 collector | `IMPLEMENTED_UNVERIFIED` | Reuses the governed CUR2 Data Exports/S3 collector and its reconciled active generations. No client-supplied source or synthetic Trends collector is accepted. Exact-tree collector verification remains G7. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | The query path reads immutable active billing partitions with manifest SHA-256, source evidence, generation identity, accepted/rejected row counts, commit time, and last-good active-head semantics. Live PostgreSQL and replay proof remain G7/G8. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | Authenticated same-tenant read-only `GET /api/v1/finops/trends`; exact query allowlist; 36-period request cap, 120 available-period cap, 500,000-row engine cap, active canonical CUR2-only selection, and waiting/empty/incomplete/error contracts. |
| G5 visual UI | `PARTIAL` | Native monthly actuals, exact MoM and selectable monthly/quarterly/yearly rolling comparisons, date/currency/cost-basis controls, click-to-select month interaction, four movement dimensions, pinned informational signals, bounded CSV evidence export, responsive/keyboard controls, and an immutable-lineage drawer are present. ML forecast, alert/report scheduling, service-category/usage taxonomy, payer/friendly names, and the geographic usage map are explicitly unavailable rather than inferred. |
| G6 focused verification | `VERIFIED` | Working tree over `78dfdc1a2d4a`: 35 Trends engine/adapter/export/route/render-contract tests (including server-rendered UI) passed with 0 failures and 0 skips; root typecheck and focused ESLint passed. |
| G7 exact-tree gate | `NOT_STARTED` | Must run at one clean integration SHA after concurrent dashboard slices finish. |
| G8–G10 | `NOT_STARTED` | Controlled CUR2 reconciliation, two-tenant/provider evidence, reviewed merge, immutable image deployment, and live visual/API acceptance remain. |

## Evidence-honesty limits

The enterprise path does not use the older generic Number-based forecast
engine. It produces exact BigInt micro-unit totals and reduced rational
percentages, keeps currencies and cost bases separate, and never interpolates
missing or partial months. Its two pinned threshold signals are informational
review indicators, not AWS Cost Anomaly Detection findings or ML inference.

The visual describes Region cost movement as a list, not a geographic usage
map. CUR2 usage-account IDs are not presented as payer IDs or friendly
organization names. Forecast, alerts, scheduled reports, service categories,
actual service usage, and map parity remain blockers, so maturity stays
`LOCAL_VERTICAL_CANDIDATE`.

Focused commands:

```text
node --test tests/finops-cur-intelligence-routes-ui-contract.test.mjs
node --experimental-strip-types --test tests/finops-trends-intelligence.test.ts tests/finops-trends-inputs.test.ts tests/finops-trends.test.ts tests/finops-trends-export.test.ts
pnpm typecheck
pnpm exec eslint app/costs/finops-cur-intelligence-panels.tsx app/api/v1/finops/trends/route.ts tests/finops-cur-intelligence-routes-ui-contract.test.mjs
```

Result: **35 passed, 0 failed, 0 skipped**; root typecheck and focused ESLint
passed.
