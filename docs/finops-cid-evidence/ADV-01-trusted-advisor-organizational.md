# ADV-01 — Trusted Advisor Organizational Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/trusted-advisor-dashboard.html>

Official visual reference: <https://docs.aws.amazon.com/images/guidance/latest/cloud-intelligence-dashboards/images/tao_demo.png>

Assessment scope: the integrated ADV-01 source, orchestration, persistence,
API, native UI, evidence, and focused verification slice.

Current maturity: `NATIVE_FUNCTIONAL_WITH_PROVIDER_GAPS`

## Official requirement and visual inventory

### Immutable upstream definition

| Evidence | Pinned value |
|---|---|
| Repository | `aws-solutions-library-samples/cloud-intelligence-dashboards-framework` |
| Commit | `f9e36d88c47709f10e8fa784ad11d5cc0e728021` |
| Manifest | `dashboards/tao/tao.yaml` |
| Manifest SHA-256 | `dc0168c5655e69d1d87c414e952b30b6f4303ade439cbfac43568187d0cdaf8c` |
| Definition | `dashboards/tao/tao-definition.yaml` |
| Definition SHA-256 | `c2eafc68c9e40ae41d6f397b914c0a039fb39f6b487a1fefe74137dec67dcf43` |
| Dashboard/version/theme | `ta-organizational-view` / `v4.0.1` / `MIDNIGHT` |
| Datasets | `ta-organizational-view`, `ta_priority_org_view` |

The pinned definition contains **11 sheets, 147 visuals, 18 parameter
controls, 4 filter controls, 2 parameter declarations, 45 calculated fields,
and 153 filter groups**. Its visual histogram is 70 bar charts, 3 combo
charts, 18 insights, 8 KPIs, 5 pivot tables, and 43 tables.

| Official sheet | Visual inventory | Official controls | Sutra native coverage |
|---|---:|---|---|
| Summary | 9: 8 bar, 1 combo | Account, IsSuppressed, 1 dropdown | Evidence-backed standard-check summaries; exact category history requires upstream TAO rows. |
| TA Explorer | 3: 2 pivot, 1 table | Account, IsSuppressed | Native bounded account/check/resource explorer. |
| Security | 30: 11 bar, 9 insight, 10 table | Account, IsSuppressed | Native `security` category drilldown; named checks appear only when provider evidence contains them. |
| Security Hub Checks | 4: 2 bar, 2 table | IsSuppressed, Account | Conditional standard-check evidence only; independent Security Hub findings are not relabelled. |
| Cost Optimization | 30: 11 bar, 2 combo, 8 KPI, 9 table | Account, IsSuppressed, 1 list | Native `cost_optimizing` drilldown; savings require authoritative check metadata. |
| Fault Tolerance | 33: 22 bar, 11 table | Account, IsSuppressed | Native `fault_tolerance` drilldown. |
| Performance | 24: 8 bar, 8 insight, 8 table | Account, IsSuppressed | Native `performance` drilldown. |
| Service Limits | 3: 2 bar, 1 table | Account, IsSuppressed | Native `service_limits` drilldown. |
| TA Priority | 7: 4 bar, 2 pivot, 1 table | 2 dropdowns | `PROVIDER_SOURCE_REQUIRED`: separate `ta_priority_org_view`; never substituted. |
| Well-Architected Reviews | 3: 2 bar, 1 pivot | IsSuppressed, Account | `PROVIDER_SOURCE_REQUIRED`: Support API snapshots contain no authoritative workload-review rows. |
| About | 1 insight | None | Native immutable-source, freshness, evidence, and limitation disclosure. |

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
| G0 requirements | `VERIFIED` | Official AWS narrative plus the pinned v4.0.1 manifest/definition, exact sheet/visual/control inventory, and immutable SHA-256 evidence above, reviewed 2026-08-01. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | Standard account checks use the read-only AWS Support operations `support:DescribeTrustedAdvisorChecks` and `support:DescribeTrustedAdvisorCheckResult` through the fixed commercial-partition `us-east-1` endpoint. Trusted Advisor Priority organization recommendations remain a separate supplemental source and are never substituted. Eligible Support-plan and Organizations taxonomy prerequisites remain explicit. |
| G2 collector and orchestration | `IMPLEMENTED_UNVERIFIED` | The bounded standard-check runner owns check/resource/metadata/output/deadline/concurrency limits and sanitized failure states. The credential-owning Organizations adapter now uses the fixed commercial endpoint, fully paginates with replay and size/deadline limits, retains all five official `Account.State` values without names/emails, signs the canonical SHA-256 digest with a dedicated workload-account RSA-3072 KMS key, and exposes only an authenticated exact-contract broker route. App-side KMS verification and infrastructure enforce broker-only Sign/app-only Verify with digest-mode RSA-PSS. Orchestration freezes the manifest, maps active same-tenant trust-role accounts, queues manifest-bound account/finalizer jobs, consumes exact immutable standard-check evidence bytes, and finalizes only terminal manifests. The successor customer-role binding and durable handler registrations remain unavailable. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | Server-owned account manifests, account/check/resource snapshots, organization generations, and active heads are tenant/customer/connection scoped. Evidence is checksum-bound and append-only; database guards prevent incomplete or partial generations from advancing the complete active head. |
| G4 API | `IMPLEMENTED_VERIFIED` | Authenticated same-tenant `GET /api/v1/finops/trusted-advisor-organizational` accepts one bounded connection/account/check/status/Region/category/suppression value, queries only the immutable active standard-check generation, exposes the pinned official definition, bounds output, minimizes metadata, and preserves explicit source states. |
| G5 visual UI | `IMPLEMENTED_VERIFIED` | ADV-01 renders all 11 official sheet entries with exact upstream object/control counts and honest coverage badges, evidence-backed category/status/Region visuals, coverage KPIs, generation history, account/check/resource drilldowns, native Category and IsSuppressed controls, responsive layouts, and immutable source evidence. The frozen definition remains visible during loading, configuration-required, failed and null-report states. Provider-only sheets remain visible and unavailable rather than substituted. |
| G6 focused verification | `VERIFIED` | Exact-definition arithmetic, repository filters/isolation, catalog/navigation/render/accessibility, manifest-job/migration/signed-taxonomy/fan-out/evidence/finalization, TypeScript, targeted ESLint, and diff checks pass. Exact current command counts are recorded below. |
| G7 exact-tree gate | `NOT_STARTED` | The complete eventual release SHA still requires the full application, collector, migration, PostgreSQL, build, rendered, security, and image scan gates after all capability work is integrated. |
| G8 provider acceptance | `NOT_STARTED` | Controlled eligible-Support-plan AWS accounts, accepted server-owned Organizations taxonomy, standard-check reconciliation, failure/partial/freshness exercises, and two-tenant isolation evidence remain. |
| G9 release acceptance | `NOT_STARTED` | Reviewed merge, immutable image digest, SBOM/security approval, database rollout, rollback rehearsal, and deployment authorization remain. |
| G10 live acceptance | `NOT_STARTED` | The deployed digest must pass authenticated live dashboard, API, responsive visual, accessibility, freshness, evidence, and rollback checks. |

## Configuration-required activation blocker

The signed taxonomy adapter and immutable fan-out contract now exist, but
Sutra does not yet have the immutable successor customer-role policy/binding or
durable production handlers registered. The browser is not allowed to supply
or expand the account set. Consequently, collection activation is reported as
`configuration_required` with
`AWS_ORGANIZATIONS_SIGNED_TAXONOMY_ADAPTER_NOT_REGISTERED`; no collection is
started from UI input and no Priority recommendation source is used as a
fallback. Provider acceptance additionally requires a real eligible Support
plan organization and reconciliation across its accepted account manifest.

This activation blocker affects new standard-check collection. Two official
sheet sources remain separate even after that adapter is registered:

- **TA Priority** requires authoritative `ta_priority_org_view` collection.
- **Well-Architected Reviews** requires authoritative workload-review data.

Sutra displays both sheet contracts, exact upstream object counts, and the
missing-source reason. It does not synthesize either from standard Support API
checks. Security Hub coverage is conditional on the accepted TA standard-check
evidence and is not inferred from Sutra's independent Security Hub source.

## Focused verification

The report-independent UI contract is also exercised by
`tests/finops-report-independent-official-ui.test.mjs`; it server-renders the
null-connection state and proves the full 11-sheet/147-visual audit remains
visible without accepted provider evidence.

Definition, repository, API/UI contract, and rendered UI command:

```text
node --experimental-strip-types --test --test-concurrency=1 \
  tests/finops-trusted-advisor-organizational-official-definition.test.ts \
  tests/finops-trusted-advisor-organization-repository.test.mjs \
  tests/finops-trusted-advisor-organizational-dashboard-ui-contract.test.mjs
```

Result: **11 passed, 0 failed, 0 skipped**.

Catalog, navigation, signed taxonomy, fan-out, standard-check evidence, replay,
migration parity, and finalization command:

```text
node --experimental-strip-types --test --test-concurrency=1 \
  tests/finops-dashboard-catalog.test.ts \
  tests/finops-dashboard-navigation-ui-contract.test.mjs \
  tests/finops-trusted-advisor-organization-job.test.ts \
  tests/finops-trusted-advisor-organization-migration-contract.test.mjs \
  tests/finops-trusted-advisor-standard-orchestration.test.ts
```

Result: **19 passed, 0 failed, 0 skipped**.

Focused ADV-01 and directly related catalog/orchestration total:
**30 passed, 0 failed, 0 skipped**.

Additional checks:

```text
pnpm typecheck
pnpm exec eslint app/api/v1/finops/trusted-advisor-organizational/route.ts app/costs/finops-trusted-advisor-organizational-dashboard.tsx db/finops-trusted-advisor-organization-repository.ts lib/finops-trusted-advisor-organizational-official-definition.ts tests/finops-trusted-advisor-organizational-official-definition.test.ts tests/finops-trusted-advisor-organization-repository.test.mjs tests/finops-trusted-advisor-organizational-dashboard-ui-contract.test.mjs
git diff --check
```

Result: **all passed**.

The new collector/KMS boundary adds **12 focused tests** (8 collector and 4
app verifier). The exact collector tree passes **231/231** tests under the
pinned Node runtime; root and collector typechecks, focused ESLint, the 21
production/bootstrap infrastructure contract tests, and diff checks pass. The
local `cfn-lint` binary is not installed in this Mac-mini workspace, so the
CloudFormation semantic lint remains an exact-tree CI gate rather than claimed
local evidence.
