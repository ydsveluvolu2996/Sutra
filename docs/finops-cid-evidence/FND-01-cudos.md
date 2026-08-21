# FND-01 — CUDOS Dashboard evidence record

Reviewed: 2026-08-21

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/cudos-cid-kpi.html#foundational-cudos-dashboard>

Official implementation inventory: <https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/9cecc158b81504344cf96b38d5918b6953b2e97d/dashboards/cudos/CUDOS-v5-definition.yaml>

Official version: `v5.9.1`

Immutable definition SHA-256: `4db8cd567b3aea50b44f4e7c3d175586799a5aaf3e923db260b570ae56d1aea2`

Current maturity: `LOCAL_VERTICAL_CANDIDATE`

## Official requirement inventory

- CUR/CUR 2.0 billing data with cost-allocation tags and Cost Categories.
- Executive invoiced/amortized summaries plus monthly, weekly, and daily trends.
- Savings/discount disclosure for SP, RI, Spot, credits, and refunds.
- Bounded, attributable optimization candidates and idle-resource views.
- RI/SP coverage, utilization, unused commitments, and expiry context.
- Compute, databases, storage, AI/ML (including Bedrock token/cache usage),
  analytics, security, and data-transfer modules.
- Resource/hourly drilldowns and organizational taxonomy filters.

The current official CUDOS v5 definition contains these interactive sheets:
Executive Billing Summary, Executive RI/SP Summary, Executive Trends, Compute,
Storage & Backup, Amazon S3, Databases, Amazon DynamoDB, AI/ML, Data Transfer &
Networking, Messaging and Streaming, Monitoring & Observability, Analytics,
Security, End User Computing, GameTech & Media, Taxonomy Explorer, and OPTICS
Explorer. `About` is documentation rather than a billing projection.

The immutable v5.9.1 YAML contains exactly **19 sheets, 409 visuals, 88 parameter
controls, 54 filter controls, 40 parameter declarations, 402 calculated fields
and 1,261 filter groups**. The full ordered sheet/count inventory is encoded in
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
| AI/ML, Data Transfer & Networking, Messaging, Monitoring, Analytics, Security | `IMPLEMENTED_PARTIAL` | Billing classification and compatible unit-cost evidence are local. Bedrock input/output/cache token quantities and read/write ratios are native when month, currency, and raw unit evidence is compatible; AWS telemetry and inferred cache savings are not substituted. |
| End User Computing and GameTech & Media | `IMPLEMENTED` | Evidence-backed service-family classification added from the official sheet inventory. |
| Taxonomy Explorer | `IMPLEMENTED_PARTIAL` | Tenant-owned taxonomy allocation is served by the Cost Intelligence vertical; QuickSight visual parity is not claimed. |
| OPTICS Explorer | `IMPLEMENTED_PARTIAL` | Account/service/region/category rankings, unit cost, drilldown availability, and review candidates exist; arbitrary QuickSight field parity is not claimed. |
| Source completeness disclosure | `IMPLEMENTED` | Rejected rows, missing manifest object coverage, or missing source freshness change the API state to `partial` and are visible in every CUDOS surface. |

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | AWS guidance and the commit-pinned official CUDOS v5.9.1 definition above, reviewed 2026-08-21. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | CUR2 export/add-on templates and exact-prefix read/decrypt/status policy tests; controlled AWS activation remains gated. |
| G2 collector | `IMPLEMENTED_UNVERIFIED` | Data Export manifest/object ingestion and correction-safe generation path; no claim that every official supplemental resource source is collected. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | Active billing generation repository, tenant/export/period/generation scope, immutable canonical rows, correction head. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | `GET /api/v1/finops/cudos`; exact query allowlist, authenticated live AWS connection, active-generation-only reads. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Exact 19-sheet/409-visual/142-control coverage navigator, executive monthly/weekly/daily trends, FOCUS category/service rankings, explorer, commitment, all official service-family projections, and the two v5.9.1 Bedrock token/cache visuals; missing source fields remain unavailable. The immutable official-source audit renders independently in loading, configuration, waiting, incomplete, error, null-report, and ready states. Successful API definitions must match the exact version, commit, path, and SHA-256; the local constant is only the no-response fallback. |
| G6 focused verification | `VERIFIED` | At feature commit `1844643967bcc9872fffa14db351427cc4bedfe5`, 50 CUDOS/route/definition/native SSR/shared Foundational assertions and 7 migration-registry assertions pass with no failures/skips; root typecheck, focused ESLint, secret scan, and diff check pass. |
| G7 exact-tree gate | `NOT_STARTED` | Must be rerun on the eventual release SHA with PostgreSQL, Docker, rendered, and full repository gates. |
| G8–G10 | `NOT_STARTED` | Controlled source reconciliation, reviewed release, immutable deployment, and live visual acceptance remain. |

## Evidence-honesty limits

Billing-derived opportunities are estimates with bounded source-line evidence,
not AWS recommendations or approved remediation. Idle-resource telemetry,
architecture compatibility, and commitment completeness remain unavailable when
the canonical export does not prove them. Currencies and usage units are never
combined. The report-independent audit exposes only frozen definition metadata;
it never manufactures spend, usage, savings, or provider evidence.

Bedrock cache read/write ratios use only input, cache-read, and cache-write
quantities from the same UTC month, billing currency, and raw usage unit. A
missing class, missing quantity/unit, negative quantity, or non-positive
denominator withholds the ratio. Raw `1K Tokens`, `1M Tokens`, `Units`, and other
units are never normalized together because the canonical row does not prove
the official pricing-unit multiplier. `Bedrock Cache Cost Savings %` is
explicitly withheld because a compatible authoritative uncached input-token
rate is not present in canonical rows.

Focused command:

```sh
node --test --test-concurrency=1 \
  tests/finops-cudos.test.ts \
  tests/finops-cudos-route-contract.test.mjs \
  tests/finops-cudos-official-definition.test.ts \
  tests/finops-cudos-official-ui.test.mjs \
  tests/finops-foundational-ui-contract.test.mjs \
  tests/finops-foundational-sheet-rendering.test.mjs \
  tests/finops-foundational-sheets.test.ts
```

Result at feature commit `1844643967bcc9872fffa14db351427cc4bedfe5`:
**50 passed, 0 failed, 0 skipped**.

Migration/no-drift command:

```sh
node --test --test-concurrency=1 \
  tests/postgres-migration-registry-parity.test.mjs \
  tests/finops-foundational-config-migration-contract.test.mjs \
  tests/finops-billing-engine-migration-contract.test.mjs
```

Result: **7 passed, 0 failed, 0 skipped**. No collector operation, IAM action,
credential flow, persistence schema, or migration changed in this reconciliation.

## CUDOS v5.9.1 reconciliation — 2026-08-21

Feature checkpoint: `1844643967bcc9872fffa14db351427cc4bedfe5` on
`develop` (standing PR #78, `develop → main`). Maturity remains
`LOCAL_VERTICAL_CANDIDATE`; this source-only checkpoint is not a deployment or
provider/live acceptance claim.

- Repinned the immutable definition to current AWS framework commit
  `9cecc158b81504344cf96b38d5918b6953b2e97d` and exact v5.9.1 SHA-256.
- Reconciled the official inventory from 407 to 409 visuals. The AI/ML sheet
  changed from 48 to 50 visuals; every other sheet count remained stable.
- Added canonical Bedrock input/output/cache-read/cache-write monthly evidence,
  exact integer-micro quantities, compatible-unit read/write ratios, bounded
  buckets, and explicit unavailable reasons.
- Added native usage and ratio chart/table surfaces to the AI/ML sheet. Missing
  classes render `Unavailable`; unproven cache savings render `withheld`.
- Reused the existing server-derived tenant boundary, active-generation
  persistence, API route, collector adapter, and least-privilege foundational
  export permissions. No AWS SDK operation or credential surface was added.

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
