# ADD-04 — FOCUS Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/focus-dashboard.html>

Assessment revision: `a9f7cb7`

Current maturity: `PARTIAL_PIPELINE`

## Official requirement inventory

- Consolidated FOCUS cost and usage across an organization and cloud providers.
- Multiple FOCUS specification versions in one consolidated view.
- Month-over-month trends with high-level-to-resource drilldown.
- Organizational taxonomy from tags.
- Effective discount-rate calculation.
- AWS FOCUS 1.2 Data Export from payer accounts, with other providers added by
  provider-specific collection integrations.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Official feature and architecture inventory above, reviewed 2026-08-01. |
| G1 source contract | `PARTIAL` | AWS FOCUS 1.2 export is exact and tenant-bound. FOCUS 1.0, Azure, GCP, OCI, SaaS, and on-prem provider contracts are not accepted or substituted. |
| G2 collector | `PARTIAL` | AWS Data Export ingestion exists; the official multi-provider/multi-version collection set is incomplete. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | Active FOCUS 1.2 canonical generations are immutable and scoped by tenant/export/period/generation; rejected source rows and evidence identity are retained. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | Authenticated same-tenant `GET /api/v1/finops/focus` with exact connection/period allowlist, 36-period/250,000-row bounds, honest freshness/coverage states, and no CUR/FOCUS 1.0 substitution. |
| G5 visual UI | `PARTIAL` | Exact bigint-micros per-currency KPIs, monthly trends, bounded dimensions, line drilldown, schema quality, evidence drawer, responsive layout, and all delivery states are present. Tag taxonomy, effective discount rate, and cross-provider/version consolidation remain missing. |
| G6 focused verification | `VERIFIED` | Exact revision `a9f7cb7`: direct projection, route, and rendered UI suite passed 14/14 with 0 failures/skips; broader ingestion/persistence evidence remains separate. |
| G7–G10 | `NOT_STARTED` | Exact-tree, provider reconciliation, reviewed release, immutable deployment, and live acceptance remain. |

## Evidence-honesty limits

The dashboard explicitly makes no FOCUS conformance, invoice-reconciliation,
exchange-rate, or savings claim. Currencies are never combined. CUR, FOCUS 1.0,
Cost Explorer, and sample values are never substituted. The current AWS-only
FOCUS 1.2 path is useful but does not satisfy the official multi-provider,
multi-version dashboard definition; maturity therefore remains
`PARTIAL_PIPELINE`.

Focused command:

```text
node --experimental-strip-types --test tests/finops-focus-dashboard.test.ts tests/finops-focus-route-contract.test.mjs tests/finops-focus-dashboard-ui-contract.test.mjs
```

Result: **14 passed, 0 failed, 0 skipped**.
