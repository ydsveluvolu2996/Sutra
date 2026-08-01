# ADD-04 — FOCUS Dashboard evidence record

Reviewed: 2026-08-01

Official sources:

- AWS FOCUS Dashboard: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/focus-dashboard.html>
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

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Official feature and architecture inventory above, reviewed 2026-08-01. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | Provider-neutral `sutra.focus-neutral-line.v1` contract accepts explicit FOCUS 1.0, 1.0r2, 1.1, and 1.2 provenance, retains provider/dataset/generation/digest/data-through evidence, enforces exact same-tenant sources and signed integer micros, and rejects duplicate/unbound rows. Mixed versions normalize only into common explicit fields; missing columns remain null. |
| G2 collector | `PARTIAL` | AWS FOCUS 1.2 Data Export remains the only materially bound collector. Authorized Azure sources are discovered but return `AZURE_FOCUS_1_0_NORMALIZED_BINDING_NOT_DEPLOYED`; non-FOCUS Azure sources return `AZURE_SOURCE_IS_NOT_FOCUS`. Existing GCP detailed billing export is never relabeled as Google’s separate preview FOCUS export and returns `GCP_FOCUS_EXPORT_ADAPTER_NOT_DEPLOYED`. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | Active FOCUS 1.2 canonical generations are immutable and scoped by tenant/export/period/generation; rejected source rows and evidence identity are retained. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | Authenticated same-tenant `GET /api/v1/finops/focus` retains the existing AWS connection/period behavior, adds an exact provider-source allowlist, discovers Azure/GCP sources server-side, filters each against its stored customer authorization, accepts no client org/customer scope, and returns exact non-substitution activation reasons. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Existing exact per-currency KPIs, trends, dimensions, drilldown, quality, evidence, responsive layout, and delivery states remain. A provider source selector, normalized provider/version provenance, governed baseline tag taxonomy view, and evidence-backed effective-discount-rate state are added. The rate is unavailable—not zero—unless charge-class semantics, complete EffectiveCost/ListCost coverage, and a positive list-cost denominator are proven. |
| G6 focused verification | `VERIFIED` | Native engine, neutral-contract, route, and rendered UI suite passes 19/19 with 0 failures/skips; full typecheck and targeted lint pass on the working tree. |
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
node --test tests/finops-focus-dashboard.test.ts tests/finops-focus-neutral.test.mjs tests/finops-focus-route-contract.test.mjs tests/finops-focus-dashboard-ui-contract.test.mjs
```

Result: **19 passed, 0 failed, 0 skipped**.
