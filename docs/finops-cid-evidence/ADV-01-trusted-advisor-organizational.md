# ADV-01 — Trusted Advisor Organizational Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/trusted-advisor-dashboard.html>

Official visual reference: <https://docs.aws.amazon.com/images/guidance/latest/cloud-intelligence-dashboards/images/tao_demo.png>

Assessment scope: the integrated ADV-01 source, orchestration, persistence,
API, native UI, evidence, and focused verification slice.

Current maturity: `PARTIAL_PIPELINE`

## Official requirement and visual inventory

- Organization-wide Trusted Advisor checks, details, and trends across all
  accounts in AWS Organizations.
- Infrastructure optimization, security, performance, cost reduction, and
  service-limit visibility.
- Account and resource investigation, including IAM access-key rotation,
  CloudTrail enablement, unutilized or underutilized resources sortable by
  account or cost, and accounts approaching 80% of individual service limits.
- All concerned accounts require an eligible AWS Support plan. The current AWS
  guidance lists Business, On-Ramp, or Enterprise.
- The official solution requires the Trusted Advisor Data Collection module in
  Data Collection Lab version 3.14.1 or later.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Official AWS narrative, prerequisite, benefit, architecture, and visual inventory above, reviewed 2026-08-01. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | Standard account checks use the read-only AWS Support operations `support:DescribeTrustedAdvisorChecks` and `support:DescribeTrustedAdvisorCheckResult` through the fixed commercial-partition `us-east-1` endpoint. Trusted Advisor Priority organization recommendations remain a separate supplemental source and are never substituted. Eligible Support-plan and Organizations taxonomy prerequisites remain explicit. |
| G2 collector and orchestration | `IMPLEMENTED_UNVERIFIED` | The bounded standard-check runner owns check/resource/metadata/output/deadline/concurrency limits and sanitized failure states. App-side orchestration validates a fresh fully paged KMS-signed Organizations taxonomy, freezes the manifest, maps active same-tenant trust-role accounts, queues manifest-bound account/finalizer jobs, consumes exact immutable standard-check evidence bytes, and finalizes only terminal manifests. The external signed-taxonomy adapter and durable handler registrations remain unavailable. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | Server-owned account manifests, account/check/resource snapshots, organization generations, and active heads are tenant/customer/connection scoped. Evidence is checksum-bound and append-only; database guards prevent incomplete or partial generations from advancing the complete active head. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | Authenticated same-tenant `GET /api/v1/finops/trusted-advisor-organizational` accepts only one connection/account/check/status/Region filter value, queries only the immutable active standard-check generation, bounds account/check/resource/history output, minimizes metadata, and exposes configuration-required/waiting/empty/partial/stale/failed/complete states. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | The 29-dashboard catalog routes ADV-01 to a native responsive dashboard with organization coverage KPIs, generation history, account and check selection, bounded resource evidence, freshness and limitations, keyboard-visible focus, mobile layouts, and the reusable evidence drawer. No fixture, sample, or Priority data is substituted. |
| G6 focused verification | `VERIFIED` | Four repository isolation/projection tests, 15 catalog/navigation/render/accessibility tests, and 9 manifest-job/migration/signed-taxonomy/fan-out/evidence/finalization tests passed; 28 passed total, 0 failed, 0 skipped. Root TypeScript, targeted ESLint, and `git diff --check` passed. |
| G7 exact-tree gate | `NOT_STARTED` | The complete eventual release SHA still requires the full application, collector, migration, PostgreSQL, build, rendered, security, and image scan gates after all capability work is integrated. |
| G8 provider acceptance | `NOT_STARTED` | Controlled eligible-Support-plan AWS accounts, accepted server-owned Organizations taxonomy, standard-check reconciliation, failure/partial/freshness exercises, and two-tenant isolation evidence remain. |
| G9 release acceptance | `NOT_STARTED` | Reviewed merge, immutable image digest, SBOM/security approval, database rollout, rollback rehearsal, and deployment authorization remain. |
| G10 live acceptance | `NOT_STARTED` | The deployed digest must pass authenticated live dashboard, API, responsive visual, accessibility, freshness, evidence, and rollback checks. |

## Configuration-required activation blocker

The signed taxonomy and immutable fan-out contract now exists, but Sutra does
not yet have the credential-owning Organizations adapter or durable production
handlers registered. The browser is not allowed to supply or expand the
account set. Consequently, collection activation is reported as
`configuration_required` with
`AWS_ORGANIZATIONS_SIGNED_TAXONOMY_ADAPTER_NOT_REGISTERED`; no collection is
started from UI input and no Priority recommendation source is used as a
fallback. Provider acceptance additionally requires a real eligible Support
plan organization and reconciliation across its accepted account manifest.

## Focused verification

Repository command:

```text
node --test --test-concurrency=1 tests/finops-trusted-advisor-organization-repository.test.mjs
```

Result: **4 passed, 0 failed, 0 skipped**.

Catalog, navigation, and rendered UI command:

```text
node --test tests/finops-dashboard-catalog.test.ts tests/finops-dashboard-navigation-ui-contract.test.mjs tests/finops-trusted-advisor-organizational-dashboard-ui-contract.test.mjs
```

Result: **15 passed, 0 failed, 0 skipped**.

Signed taxonomy, fan-out, standard-check evidence, replay, and finalization:

```text
node --test --test-concurrency=1 tests/finops-trusted-advisor-organization-job.test.ts tests/finops-trusted-advisor-organization-migration-contract.test.mjs tests/finops-trusted-advisor-standard-orchestration.test.ts
```

Result: **9 passed, 0 failed, 0 skipped**.

Additional checks:

```text
pnpm typecheck
pnpm exec eslint app/api/v1/finops/trusted-advisor-organizational/route.ts app/costs/finops-trusted-advisor-organizational-dashboard.tsx app/costs/finops-dashboard-catalog-nav.tsx db/finops-trusted-advisor-organization-repository.ts lib/finops-dashboard-catalog.ts tests/finops-dashboard-catalog.test.ts tests/finops-trusted-advisor-organization-repository.test.mjs tests/finops-trusted-advisor-organizational-dashboard-ui-contract.test.mjs
git diff --check
```

Result: **all passed**.
