# FND-02 — Cost Intelligence Dashboard evidence record

Reviewed: 2026-08-02

Official guidance: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/cudos-cid-kpi.html#cost-intelligence-dashboard-cid>

Immutable definition: <https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/cost-intelligence/cost-intelligence-definition.yaml>

Definition SHA-256: `71795647fd09a17c3a2e1ea2f1308d6aecb150efe339a0950866ad766ef10ab0`

Current maturity: `LOCAL_VERTICAL_CANDIDATE`

## Exact official definition inventory

The pinned definition contains exactly **10 sheets, 77 visuals, 11 filter
controls, and 33 parameter controls**. The trailing space in the official
`OPTICS Explorer ` sheet name is retained in the immutable code inventory.

| Official sheet | Visuals | Filter controls | Parameter controls | Audited visual purpose/title inventory |
|---|---:|---:|---:|---|
| Billing Summary | 12 | 0 | 3 | Invoiced Spend; Amortized Forecast; Amortized Spend Forecast; Previous Month Amortized Spend; Amortized Spend; Invoiced Spend by charge type; Amortized Spend by account; Previous Month Invoice; Invoiced Spend Forecast; Invoiced Forecast; AWS Monthly Report pivot; hidden insight |
| Cost Summary | 15 | 0 | 3 | Usage Spend insights; Daily Cost; Top 10 Drill Down; Top 5 Spending Accounts; Usage Spend trend; account/region/service counts; Most Popular Region; Top Spending Account; Top Service; Usage Spend KPI; hidden insight/anomaly notices |
| Compute Summary | 11 | 0 | 3 | EC2 Compute Unit Cost; EC2 Spot Savings and percentage; EC2 Coverage month over month; EC2 Elasticity; RI/SP Savings percentage; Compute Usage Spend; EC2 Compute Cost; current-generation EC2 spend; EC2 Coverage; RI/SP Savings |
| Storage Summary | 12 | 0 | 3 | S3 Standard Storage Cost by Bucket Top 10; S3 usage by bucket; EBS and S3 spend KPIs/trends; EBS Coverage and Unit Cost; storage-class coverage; S3 Unit Cost; period insights |
| RI/SP Summary | 17 | 3 | 3 | Pricing Model Savings Summary; Coverage; Spot Coverage; RI/SP Utilization and Coverage; savings by end date/product/pricing; savings expiring this/next month; previous-month savings and unused cost; Savings Summary; on-demand eligible spend/coverage; average hourly EC2 cost; hidden insight |
| Expiring RI/SP Tracker | 2 | 0 | 3 | Expiry tracker pivot; Select Expiration Month table |
| `OPTICS Explorer ` | 3 | 8 | 12 | Usage Table; Spend Table; Top 10 Spend Chart |
| MoM Pivot | 2 | 0 | 3 | Usage pivot; Spend pivot |
| Summary of Changes | 1 | 0 | 0 | Release/change insight |
| About | 2 | 0 | 0 | About and usage notices |

The account controls on applicable sheets are **Account ID**, **Account Name**,
and **Payer Accounts**. RI/SP filters are **Usage Date Filter**, **Product
Category**, and **Service**. OPTICS filters are **Date Range**, **Database
Engine**, **Pricing Unit**, **Service**, **Instance Type Family**, **Instance
Type**, **Charge Type**, and **Platform**. OPTICS parameters cover both group-by
levels, date granularity, account/payer, charge category, product code,
operation, region, usage type, and purchase option.

## Sutra parity assessment

| Official capability | Local native evidence | Status |
|---|---|---|
| Billing Summary | Exact bigint, currency-separated period summaries; previous-period delta; average daily run rate; monthly trend; disclosed integer linear forecast and deterministic residual range | `IMPLEMENTED_LOCAL` |
| Cost Summary | Cost movers, taxonomy allocation, bounded multi-dimension explorer, exact source/excluded totals | `IMPLEMENTED_LOCAL` |
| Compute Summary | Canonical rows carry usage quantity/unit and commitment type; no EC2-only unit-cost or elasticity visual is emitted unless complete service-specific quantity evidence is proved | `PARTIAL_EVIDENCE` |
| Storage Summary | Canonical product, resource, usage quantity/unit, and cost fields are retained; S3 bucket/EBS volume semantics and complete coverage are not asserted from ambiguous rows | `PARTIAL_EVIDENCE` |
| RI/SP Summary | Evidence-backed commitment costs, utilization inputs, expiry, net savings, and coverage completeness are available; route deliberately marks unused charge, public on-demand cost, and quantity coverage incomplete | `PARTIAL_EVIDENCE` |
| Expiring RI/SP Tracker | Native expiry table with terms, account/owner, gross/used/unused cost, on-demand equivalent, net savings, coverage state, and untrackable-row disclosure | `IMPLEMENTED_LOCAL` |
| OPTICS Explorer | Route now activates a 50-row, 1,000-cardinality bounded explorer over an allow-listed pair of dimensions | `PARTIAL_CONTROL_PARITY` |
| MoM Pivot | Native exact spend pivot with baseline, comparison, signed delta, and percentage state | `IMPLEMENTED_LOCAL` |
| Summary of Changes / About | This pinned evidence record, freshness strip, cost-basis disclosure, and explicit incomplete-data states | `IMPLEMENTED_LOCAL` |

This is semantic native coverage, not a claim that Sutra reproduces the
QuickSight layout pixel-for-pixel. Product-specific compute/storage visuals and
the full set of interactive account/OPTICS controls remain evidence-gated gaps;
they must not be filled with inferred quantities, fabricated dimensions, or a
different cost basis.

## Gate evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Immutable commit/path/hash plus exact 10-sheet/77-visual/44-control inventory is enforced by `finops-cost-intelligence-official-definition.test.mjs`. |
| G1–G3 source/pipeline | `IMPLEMENTED_UNVERIFIED` | Shares the correction-safe CUR2 ingestion and active-generation persistence path with FND-01; exact-tree and controlled provider evidence remain outstanding. |
| G4 API | `VERIFIED_LOCAL` | Authenticated tenant scope, one canonical export history, 36-period/250,000-row bounds, strict query allow-list, activated bounded explorer, explicit forecast options, and conservative commitment completeness. |
| G5 visual UI | `VERIFIED_LOCAL` | Immutable 10-sheet coverage navigator, per-sheet parity gaps, billing summary, trend, movers, forecast, spend pivot, bounded explorer, expiry tracker, allocation, evidence/freshness states, and exact-currency rendering are under UI contract tests. The immutable official-source audit remains visible in loading, configuration, waiting, incomplete, error, null-report, and ready states. Successful API definitions must match the exact commit, path, and SHA-256; the local constant is only the no-response fallback. |
| G6 focused verification | `VERIFIED` | Focused engine, route, official-definition, and UI contract suite passes locally; commands and count are recorded below. |
| G7–G10 | `NOT_STARTED` | Exact-tree, controlled two-tenant/provider, release, deployment, rollback, and live visual evidence remain release-level gates. |

## Evidence-honesty limits

- Forecasts stay `insufficient_data` until the configured minimum history exists.
- Money is never converted to floating point and currencies are never combined.
- Missing cost bases fail closed rather than substituting billed or amortized cost.
- Commitment savings/utilization remain partial unless active canonical fields
  prove unused charges, public on-demand cost, and usage quantity completeness.
- “No observed expiry evidence” is not presented as “no commitments exist.”
- Allocation is reporting attribution, not a mutation of an invoice.
- The report-independent audit exposes frozen definition metadata only and does
  not fabricate spend, usage, savings, or provider evidence.

Focused verification command:

```sh
node --experimental-strip-types --test \
  tests/finops-cost-intelligence.test.ts \
  tests/finops-cost-intelligence-route-contract.test.mjs \
  tests/finops-cost-intelligence-official-definition.test.mjs \
  tests/finops-cost-intelligence-official-ui.test.mjs \
  tests/finops-foundational-ui-contract.test.mjs
```

Result: **24 passed, 0 failed, 0 skipped**.

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
