# FND-01 — CUDOS Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/cudos-cid-kpi.html#cudos-dashboard>

Assessment revision: `0fa8d769d4`

Current maturity: `LOCAL_VERTICAL_CANDIDATE`

## Official requirement inventory

- CUR/CUR 2.0 billing data with cost-allocation tags and Cost Categories.
- Executive invoiced/amortized summaries plus monthly, weekly, and daily trends.
- Savings/discount disclosure for SP, RI, Spot, credits, and refunds.
- Bounded, attributable optimization candidates and idle-resource views.
- RI/SP coverage, utilization, unused commitments, and expiry context.
- Compute, databases, storage, AI/ML, analytics, security, and data-transfer modules.
- Resource/hourly drilldowns and organizational taxonomy filters.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Official inventory above, reviewed 2026-08-01. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | CUR2 export/add-on templates and exact-prefix read/decrypt/status policy tests; controlled AWS activation remains gated. |
| G2 collector | `IMPLEMENTED_UNVERIFIED` | Data Export manifest/object ingestion and correction-safe generation path; no claim that every official supplemental resource source is collected. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | Active billing generation repository, tenant/export/period/generation scope, immutable canonical rows, correction head. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | `GET /api/v1/finops/cudos`; exact query allowlist, authenticated live AWS connection, active-generation-only reads. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Executive, explorer, commitment, and service projections in `finops-foundational-panels.tsx`; missing source fields remain unavailable. |
| G6 focused verification | `VERIFIED` | Included in the 67-test Foundational set below; no failures/skips. |
| G7 exact-tree gate | `NOT_STARTED` | Must be rerun on the eventual release SHA with PostgreSQL, Docker, rendered, and full repository gates. |
| G8–G10 | `NOT_STARTED` | Controlled source reconciliation, reviewed release, immutable deployment, and live visual acceptance remain. |

## Evidence-honesty limits

Billing-derived opportunities are estimates with bounded source-line evidence,
not AWS recommendations or approved remediation. Idle-resource telemetry,
architecture compatibility, and commitment completeness remain unavailable when
the canonical export does not prove them. Currencies and usage units are never
combined.

Focused command:

```text
node --experimental-strip-types --test tests/finops-cost-intelligence-route-contract.test.mjs tests/finops-cost-intelligence.test.ts tests/finops-cudos-route-contract.test.mjs tests/finops-cudos.test.ts tests/finops-foundational-config-migration-contract.test.mjs tests/finops-foundational-config-repository.test.mjs tests/finops-foundational-config-route-contract.test.mjs tests/finops-foundational-cur2-export-template.test.mjs tests/finops-foundational-focus12-export-template.test.mjs tests/finops-foundational-ui-contract.test.mjs tests/finops-kpi-route-contract.test.mjs tests/finops-kpi.test.ts
```

Result: **67 passed, 0 failed, 0 skipped**.
