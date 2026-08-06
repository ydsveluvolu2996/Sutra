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
| G1 source contract | `IMPLEMENTED_VERIFIED` | Standard account checks use the read-only AWS Support operations `support:DescribeTrustedAdvisorChecks` and `support:DescribeTrustedAdvisorCheckResult` through the fixed commercial-partition `us-east-1` endpoint. The immutable `standard-2026-08.2` candidate adds exact dedicated policies for those two Support reads and the two Organizations taxonomy reads while preserving prior trust and ceilings. Local template, broker-attestation, permission-coverage, and pinned CloudFormation lint gates pass. Trusted Advisor Priority organization recommendations remain a separate supplemental source and are never substituted. Eligible Support-plan and Organizations taxonomy prerequisites remain explicit. |
| G2 collector and orchestration | `IMPLEMENTED_VERIFIED` | The bounded standard-check runner owns check/resource/metadata/output/deadline/concurrency limits and sanitized failure states. The credential-owning Organizations adapter uses the fixed commercial endpoint, fully paginates with replay and size/deadline limits, retains all five official `Account.State` values without names/emails, signs the canonical SHA-256 digest with a dedicated workload-account RSA-3072 KMS key, and exposes only an authenticated exact-contract broker route. App-side KMS verification and infrastructure enforce broker-only Sign/app-only Verify with digest-mode RSA-PSS. All three shared durable handlers are registered lazily. Activation freezes the signed manifest and queues only frozen member identities; exact source snapshots are recovered by job/attempt and reopened through tenant/source/generation-bound encrypted references. Transient account failures retry, terminal/crash replays enqueue the same deterministic finalizer, and finalization is never queued while member work remains non-terminal. Live 08.2/source-binding acceptance remains G8. |
| G3 persistence | `IMPLEMENTED_VERIFIED` | Server-owned account manifests, account/check/resource snapshots, organization generations, and active heads are tenant/customer/connection scoped. Evidence is checksum-bound and append-only; exact manifest-identity and source-attempt reads cannot cross tenants. Database guards prevent incomplete or partial generations from advancing the complete active head, and exact immutable race replays are accepted without allowing conflicting content. |
| G4 API | `IMPLEMENTED_VERIFIED` | Authenticated same-tenant `GET /api/v1/finops/trusted-advisor-organizational` accepts one bounded connection/account/check/status/Region/category/suppression value, queries only the immutable active standard-check generation, exposes the pinned official definition, bounds output, minimizes metadata, and preserves explicit source states. The protected `POST` accepts exactly `{connectionId}`, requires `sync:run`, active 08.2 trust-role ownership and configured signing/evidence keys, and enqueues a five-minute-idempotent server-owned activation; no account list, AWS operation, contract, taxonomy, Region, or credential is browser-controlled. |
| G5 visual UI | `IMPLEMENTED_VERIFIED` | ADV-01 renders all 11 official sheet entries with exact upstream object/control counts and honest coverage badges, evidence-backed category/status/Region visuals, coverage KPIs, generation history, account/check/resource drilldowns, native Category and IsSuppressed controls, responsive layouts, and immutable source evidence. The frozen definition remains visible during loading, configuration-required, failed and null-report states. A guarded Start organization collection control shows queued/failure state and refreshes the report without accepting a browser account list. Provider-only sheets remain visible and unavailable rather than substituted. |
| G6 focused verification | `VERIFIED` | Exact-definition arithmetic, repository filters/isolation, catalog/navigation/render/accessibility, manifest-job/migration/signed-taxonomy/fan-out/evidence/finalization, TypeScript, targeted ESLint, and diff checks pass. Exact current command counts are recorded below. |
| G7 exact-tree gate | `NOT_STARTED` | The complete eventual release SHA still requires the full application, collector, migration, PostgreSQL, build, rendered, security, and image scan gates after all capability work is integrated. |
| G8 provider acceptance | `NOT_STARTED` | Controlled eligible-Support-plan AWS accounts, accepted server-owned Organizations taxonomy, standard-check reconciliation, failure/partial/freshness exercises, and two-tenant isolation evidence remain. |
| G9 release acceptance | `NOT_STARTED` | Reviewed merge, immutable image digest, SBOM/security approval, database rollout, rollback rehearsal, and deployment authorization remain. |
| G10 live acceptance | `NOT_STARTED` | The deployed digest must pass authenticated live dashboard, API, responsive visual, accessibility, freshness, evidence, and rollback checks. |

## Provider activation prerequisites

The signed taxonomy adapter, immutable `standard-2026-08.2` customer-role
candidate, exact-contract fan-out, protected activation API/UI, and shared
durable handlers now exist and pass local gates. The browser is not allowed to
supply or expand the account set. Activation becomes available only when the
selected persisted connection uses 08.2 and the app has both the KMS verifier
ARN and the independent FinOps evidence-reference key. The next production
secret version must therefore add `SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY`; the
task definition supplies the fixed version label
`production-finops-evidence-v1`. The collector registry must also hold the
exact Organizations and standard-check source contracts for each activated
connection. Until those prerequisites are applied, the API and UI remain
fail-closed with a configuration reason. No Priority recommendation source is
used as a fallback. Provider acceptance additionally requires a real eligible
Support-plan organization and reconciliation across its accepted account
manifest.

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

Result: **12 passed, 0 failed, 0 skipped**.

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

Result: **21 passed, 0 failed, 0 skipped**.

Focused ADV-01 and directly related catalog/orchestration total:
**33 passed, 0 failed, 0 skipped**.

Exact-attempt source persistence and shared handler registration add **6/6**
passing cases. The managed production evidence-key/HA contract adds **14/14**
passing cases. Across these non-overlapping ADV-01 activation and deployment
readiness commands, **53 passed, 0 failed, 0 skipped**.

Additional checks:

```text
pnpm typecheck
pnpm typecheck:collector
pnpm --dir services/aws-collector build
pnpm build
pnpm exec eslint app/api/v1/finops/trusted-advisor-organizational/route.ts app/costs/finops-trusted-advisor-organizational-dashboard.tsx db/background-job-handlers.ts db/finops-source-snapshot-repository.ts db/finops-trusted-advisor-organization-repository.ts db/pilot-repository.ts lib/finops-trusted-advisor-standard-orchestration.ts
PATH=/private/tmp/sutra-cfn-lint.iVkPWR/bin:$PATH pnpm lint:cloudformation
git diff --check
```

Result: **all passed**.

The collector/KMS boundary adds **12 focused tests** (8 collector and 4 app
verifier). The immutable permission-pack slice adds **9 focused tests** (7
template/runbook and 2 broker-attestation cases), while the combined prior
pack and permission-coverage command passes **19/19**. The exact collector tree
passes **233/233** tests under the pinned Node runtime; root and collector
typechecks, focused ESLint, the 21 production/bootstrap infrastructure contract
tests, and diff checks pass. Pinned `cfn-lint 1.46.0` passes all 10 configured
templates locally, including both immutable successor packs; the same semantic
check remains required in exact-tree CI.

## Merge record — 2026-08-06

Merged to `main` since this record was last updated (2026-08-05 15:01). Every
item below is source-only work that landed through review with CI green on the
merge commit — nothing more. No provider, live, two-tenant, or release evidence
is created by any of it.

**Maturity is unchanged (`PARTIAL_PIPELINE`) and no child-stage gate passed.** G7
fixed-tree, G8 controlled provider acceptance, G9 release and G10 deployment
remain unpassed for this row; no live acceptance, provider reconciliation, or
two-tenant acceptance is claimed.

- **Native chart kit and catalog identity — `4ac72bd` (PR #36) and `f107cdf`
  (PR #37).** This row's view moved onto the shared native chart kit at
  `app/components/charts`:
  - `app/costs/finops-trusted-advisor-organizational-dashboard.tsx`

  Focused rendering proof added with it:
  - `tests/finops-trusted-advisor-charts.test.mjs`

  Across `app/costs/`, 28 view modules plus the catalog page now import the kit,
  and the kit's own rendering suite `tests/chart-kit-rendering.test.mjs` holds
  12 tests. `app/costs/finops-dashboard-identity.tsx` renders each dashboard's
  catalog glyph, name and ID above every opened view
  (`tests/finops-dashboard-identity.test.mjs`). This is UI rendering work only:
  no source contract, collector operation, migration, API shape, or evidence
  semantic changed, and no G5 or G6 stage status is promoted by it.

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
