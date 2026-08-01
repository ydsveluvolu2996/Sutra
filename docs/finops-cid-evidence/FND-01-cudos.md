# FND-01 — CUDOS Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/cudos-cid-kpi.html#cudos-dashboard>

Official implementation inventory: <https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/cudos/CUDOS-v5-definition.yaml>

Immutable definition SHA-256: `7f0516c146b1de528e3960305a01b090d2521c020c6f8fba4b756f3a62f444c1`

Current maturity: `LOCAL_VERTICAL_CANDIDATE`

## Official requirement inventory

- CUR/CUR 2.0 billing data with cost-allocation tags and Cost Categories.
- Executive invoiced/amortized summaries plus monthly, weekly, and daily trends.
- Savings/discount disclosure for SP, RI, Spot, credits, and refunds.
- Bounded, attributable optimization candidates and idle-resource views.
- RI/SP coverage, utilization, unused commitments, and expiry context.
- Compute, databases, storage, AI/ML, analytics, security, and data-transfer modules.
- Resource/hourly drilldowns and organizational taxonomy filters.

The current official CUDOS v5 definition contains these interactive sheets:
Executive Billing Summary, Executive RI/SP Summary, Executive Trends, Compute,
Storage & Backup, Amazon S3, Databases, Amazon DynamoDB, AI/ML, Data Transfer &
Networking, Messaging and Streaming, Monitoring & Observability, Analytics,
Security, End User Computing, GameTech & Media, Taxonomy Explorer, and OPTICS
Explorer. `About` is documentation rather than a billing projection.

The immutable YAML contains exactly **19 sheets, 407 visuals, 88 parameter
controls, 54 filter controls, 40 parameter declarations, 399 calculated fields
and 1,263 filter groups**. The full ordered sheet/count inventory is encoded in
`lib/finops-cudos-official-definition.ts`, returned in both waiting and ready
API states, rendered natively, and enforced by definition and SSR tests. This
is semantic evidence coverage; it is not a claim of pixel-for-pixel QuickSight
layout parity.

## Local capability comparison

| Official capability | Local state | Evidence-honesty boundary |
|---|---|---|
| Executive billing and signed charge disclosure | `IMPLEMENTED` | Exact integer micros; currencies never combined; missing bases are labelled. |
| Monthly, weekly, and daily trends | `IMPLEMENTED` | Weekly periods are deterministic UTC Monday week starts. |
| FOCUS Service Category grouping | `IMPLEMENTED` | Null category is retained as an explicit missing-dimension bucket. |
| RI/SP coverage, utilization, unused cost, true-up | `IMPLEMENTED_PARTIAL` | Expiry and purchase recommendations remain unavailable without source term evidence. |
| Compute, Storage & Backup, S3, Databases, DynamoDB | `IMPLEMENTED` | Modules appear only when canonical rows match. |
| AI/ML, Data Transfer & Networking, Messaging, Monitoring, Analytics, Security | `IMPLEMENTED_PARTIAL` | Billing classification and compatible unit-cost evidence are local; AWS telemetry-specific visuals are not inferred. |
| End User Computing and GameTech & Media | `IMPLEMENTED` | Evidence-backed service-family classification added from the official sheet inventory. |
| Taxonomy Explorer | `IMPLEMENTED_PARTIAL` | Tenant-owned taxonomy allocation is served by the Cost Intelligence vertical; QuickSight visual parity is not claimed. |
| OPTICS Explorer | `IMPLEMENTED_PARTIAL` | Account/service/region/category rankings, unit cost, drilldown availability, and review candidates exist; arbitrary QuickSight field parity is not claimed. |
| Source completeness disclosure | `IMPLEMENTED` | Rejected rows, missing manifest object coverage, or missing source freshness change the API state to `partial` and are visible in every CUDOS surface. |

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | AWS guidance and the commit-pinned official CUDOS v5 definition above, reviewed 2026-08-01. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | CUR2 export/add-on templates and exact-prefix read/decrypt/status policy tests; controlled AWS activation remains gated. |
| G2 collector | `IMPLEMENTED_UNVERIFIED` | Data Export manifest/object ingestion and correction-safe generation path; no claim that every official supplemental resource source is collected. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | Active billing generation repository, tenant/export/period/generation scope, immutable canonical rows, correction head. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | `GET /api/v1/finops/cudos`; exact query allowlist, authenticated live AWS connection, active-generation-only reads. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Exact 19-sheet/407-visual/142-control coverage navigator, executive monthly/weekly/daily trends, FOCUS category/service rankings, explorer, commitment, and all official service-family projections in `finops-foundational-panels.tsx`; missing source fields remain unavailable. |
| G6 focused verification | `VERIFIED` | CUDOS engine, route, immutable definition, native SSR and shared Foundational UI tests pass with no failures/skips. |
| G7 exact-tree gate | `NOT_STARTED` | Must be rerun on the eventual release SHA with PostgreSQL, Docker, rendered, and full repository gates. |
| G8–G10 | `NOT_STARTED` | Controlled source reconciliation, reviewed release, immutable deployment, and live visual acceptance remain. |

## Evidence-honesty limits

Billing-derived opportunities are estimates with bounded source-line evidence,
not AWS recommendations or approved remediation. Idle-resource telemetry,
architecture compatibility, and commitment completeness remain unavailable when
the canonical export does not prove them. Currencies and usage units are never
combined.

Focused command:

```sh
npx tsx --test \
  tests/finops-cudos.test.ts \
  tests/finops-cudos-route-contract.test.mjs \
  tests/finops-cudos-official-definition.test.ts \
  tests/finops-cudos-official-ui.test.mjs \
  tests/finops-foundational-ui-contract.test.mjs
```

Result: **22 passed, 0 failed, 0 skipped**.
