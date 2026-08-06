# FND-01 — CUDOS Dashboard evidence record

Reviewed: 2026-08-02

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
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Exact 19-sheet/407-visual/142-control coverage navigator, executive monthly/weekly/daily trends, FOCUS category/service rankings, explorer, commitment, and all official service-family projections in `finops-foundational-panels.tsx`; missing source fields remain unavailable. The immutable official-source audit renders independently in loading, configuration, waiting, incomplete, error, null-report, and ready states. Successful API definitions must match the exact commit, path, and SHA-256; the local constant is only the no-response fallback. |
| G6 focused verification | `VERIFIED` | CUDOS engine, route, immutable definition, native SSR and shared Foundational UI tests pass with no failures/skips. |
| G7 exact-tree gate | `NOT_STARTED` | Must be rerun on the eventual release SHA with PostgreSQL, Docker, rendered, and full repository gates. |
| G8–G10 | `NOT_STARTED` | Controlled source reconciliation, reviewed release, immutable deployment, and live visual acceptance remain. |

## Evidence-honesty limits

Billing-derived opportunities are estimates with bounded source-line evidence,
not AWS recommendations or approved remediation. Idle-resource telemetry,
architecture compatibility, and commitment completeness remain unavailable when
the canonical export does not prove them. Currencies and usage units are never
combined. The report-independent audit exposes only frozen definition metadata;
it never manufactures spend, usage, savings, or provider evidence.

Focused command:

```sh
npx tsx --test \
  tests/finops-cudos.test.ts \
  tests/finops-cudos-route-contract.test.mjs \
  tests/finops-cudos-official-definition.test.ts \
  tests/finops-cudos-official-ui.test.mjs \
  tests/finops-foundational-ui-contract.test.mjs
```

Result: **23 passed, 0 failed, 0 skipped**.

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

- **New `aws_static_credentials` onboarding method — `6298f03` (PR #39).**
  Onboarding now offers an access key ID plus secret access key (with a session
  token required for temporary `ASIA` keys) as an alternative to the
  CloudFormation trust-role flow, which stays the recommended default. The
  credential material lives only in the collector's AES-GCM-encrypted registry
  document; the app database stores the `aws_static_credentials` source kind and
  nothing else. Static sessions carry **no STS inline session-policy ceiling and
  no role-contract attestation** — both are impossible without `AssumeRole`.
  **This row's connection prerequisite is unchanged: the FinOps per-source
  verticals still require the trust-role method.** The FinOps source guards were
  deliberately left trust-role-only, so an `aws_static_credentials` connection
  cannot satisfy the prerequisite recorded above. No permission ceiling,
  attestation, or role contract in this record is relaxed by it.
