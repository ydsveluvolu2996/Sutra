# FinOps vertical closure worksheet — Foundational source activation

Scope: the shared G1 source-activation gap behind **FND-01 CUDOS**, **FND-02 Cost
Intelligence** and **FND-03 KPI & Modernization**. All three already sit at
`LOCAL_VERTICAL_CANDIDATE` with G5 UI implemented; none of them renders data,
because nothing ever observes a billing delivery. One producer is missing, and
it is missing for all three identically, so it is closed once rather than three
times.

## Identity and starting state

| Field | Value |
|---|---|
| Dashboard ID and name | FND-01 CUDOS, FND-02 Cost Intelligence, FND-03 KPI & Modernization (shared source) |
| Sutra dashboard ID | `cudos`, `cost_intelligence_dashboard`, `kpi_dashboard` |
| Starting branch | `claude/finops-foundational-closure` (from `origin/main`) |
| Starting SHA | `b924a1b40f7cc82b492322e4e10548ebc28c1ab2` |
| Required predecessor SHA/version | permission pack `standard-2026-08.12` (published, byte-exact `5ff89681…4db80`) |
| Permission reservation | none required — see contract decisions |
| Drizzle/PostgreSQL reservations | none required — see inventory |
| Primary implementer | this agent |
| Shared-file integrator | this agent (single-agent session) |
| Dashboard aliases searched | `cudos`, `cost-intelligence`, `kpi`, `foundational`, `cur2`, `data-export`, `focus` |

```text
git status --short --branch: ## claude/finops-foundational-closure...origin/main
git rev-parse HEAD:          b924a1b40f7cc82b492322e4e10548ebc28c1ab2
node --version:              v22.22.2
```

Note: commit `4a2aa98` named in `CLAUDE.md` is not present in this clone, and the
continuation branch `agent/mac-mini-finops-continuation` does not exist on the
remote. Work has been proceeding on `main` for the whole of this session with the
user's direction. **Recorded as a conflict with the documented protocol rather
than silently reinterpreted.**

## The one-sentence gap

`FinopsDataExportObservationRepository.recordVerifiedObservation` has **no
caller**. The outbox table, the consumer route, the ingest job, the manifest
validator, the billing engine and all three dashboards exist. Nothing writes an
observation, so nothing is ever ingested, so every Foundational dashboard
truthfully reports "awaiting first delivery" forever.

Evidence:

```
$ grep -rl "FinopsDataExportObservationRepository" --include=*.ts .
./app/api/v1/finops/data-export/ingest/route.ts     # reads
./db/finops-data-export-observation-repository.ts   # defines
```

## Existing-asset reuse inventory

| Surface | Existing files/symbols | Classification | Proof or exact gap | Planned action |
|---|---|---|---|---|
| Official definition/evidence | `lib/finops-cudos-official-definition.ts`, `…-cost-intelligence-…`, `…-kpi-…`; evidence records FND-01/02/03 | `REUSE_AS_IS` | G0 `VERIFIED` in all three records | Freeze |
| Domain/formulas | `app/costs/finops-foundational-panels.tsx` (2291 lines), `finops-foundational-money.ts`, `finops-foundational-sheets.ts` | `REUSE_AS_IS` | G5 `IMPLEMENTED_UNVERIFIED`; 19/10/10 sheets present | Freeze |
| Collector adapter | `services/aws-collector/src/scad-cur2-provider-adapter.ts` | `UNAVAILABLE_BY_CONTRACT` for reuse | Its whole runtime is uncomposed (`finops-scad-production-composition` has 0 callers; no `loadBoundary` implementation exists) | Do **not** build on it; mirror the wired Compute Optimizer discovery instead |
| SDK reader/client | `@aws-sdk/client-s3` in collector; no `bcm-data-exports` client | `MISSING` | No `ListExports`/`GetExport` call anywhere | Add reader; command must be declared in `COLLECTOR_COMMANDS` |
| Provider route | `app/api/v1/finops/cudos/route.ts` and siblings | `REUSE_AS_IS` | G4 `IMPLEMENTED_UNVERIFIED` | Freeze |
| Session/IAM contract | `infrastructure/finops-foundational-cur2-export-v1.1.yaml` | `REUSE_AS_IS` | **CORRECTED TWICE.** The CUR 2.0 add-on already grants `ListExports` and bounds `GetExport` to the exact created export ARN. The base role must never grant them | Freeze; run discovery under the add-on session |
| Role broker/local server | `services/aws-collector/src/local-server.ts`, `role-broker.ts` | `REPAIR` | New route needed to expose discovery; integrator-owned files | Bounded addition |
| Drizzle migration | `finops_data_export_observations` in `db/runtime-migrations.ts` | `REUSE_AS_IS` | Table exists both engines | Freeze |
| PostgreSQL migration | `postgres/migrations/0078_finops_data_export_observations.sql` | `REUSE_AS_IS` | Registered at `db/postgres-runtime-migrations.ts:205` | Freeze |
| Three migration registries | drizzle, postgres runtime, `scripts/postgres-migrate.mjs` | `REUSE_AS_IS` | 0078 registered in all three | Freeze |
| Durable repository | `db/finops-data-export-observation-repository.ts`, `finops-billing-engine-repository.ts`, `finops-active-billing-query-repository.ts` | `REUSE_AS_IS` | `recordVerifiedObservation` already implemented and signature-verifying | Call it; do not modify |
| Runtime binding/composition | `lib/finops-data-export-ingest-job.ts` | `REUSE_AS_IS` | Parses payload, validates manifest, writes generations | Freeze |
| Scheduler/shared handler | `db/background-job-handlers.ts:1502` registers the ingest kind; `lib/finops-compute-optimizer-discovery-job.ts` is the discovery precedent | `REPAIR` | No discovery kind for data exports | Add one kind, following the Compute Optimizer pattern |
| Authenticated API | `app/api/v1/finops/data-export/ingest/route.ts` | `REUSE_AS_IS` | Accepts `connectionId` + `observationId` only | Freeze |
| Native four-state UI | Foundational sheet shell + `finops-source-coverage.tsx` | `REUSE_AS_IS` | Four-state rendering asserted by existing tests | Freeze |
| Focused tests | `tests/finops-data-export-ingest-job.test.ts`, `finops-cudos*.test.*`, `finops-foundational-ui-contract.test.mjs` | `REUSE_AS_IS` | 23 passed in FND-01 record | Freeze; add discovery tests alongside |
| Shared/predecessor tests | `tests/collector-permission-coverage.test.mjs` | `REPAIR` | New SDK command must be mapped | One entry |
| Permission successor | — | `UNAVAILABLE_BY_CONTRACT` → not required | The add-on grants both actions; a base-role grant is forbidden by test | **No new pack.** `.19` was authored, then deleted |
| Documentation/tracker | FND-01/02/03 evidence, `FINOPS_CID_IMPLEMENTATION_TRACKER.md` | `REPAIR` | G1 must move from "activation gated" once observed | Update only after the final SHA passes gates |

## Second-pass finding: composed vs uncomposed runtimes

The first inventory pass treated "the module exists" as reuse. It is not
sufficient. Several FinOps runtimes exist as complete composition roots that
**nothing calls**, which is the same defect as the missing observation producer,
one layer up.

| Module | Referenced by a non-test, non-self module |
|---|---|
| `lib/finops-compute-optimizer-discovery-job.ts` | 3 — including `db/background-job-handlers.ts` |
| `lib/finops-graviton-runtime-binding.ts` | 3 — including `db/background-job-handlers.ts` |
| `lib/finops-scad-production-composition.ts` | **0** |
| `lib/finops-sustainability-carbon-runtime-composition.ts` | **0** |
| `lib/finops-amazon-connect-cost-production-composition.ts` | **0** |

No `loadBoundary:` implementation exists anywhere in `app/`, `db/` or `scripts/`,
so the SCAD CUR2 runtime cannot resolve an export even though its adapter,
binding, signed provider and production composition are all written.

Consequences for this worksheet:

- The working pattern to copy is **Compute Optimizer discovery**, which is
  genuinely wired: `lib/finops-compute-optimizer-discovery-handler.ts` (560
  lines) + `db/finops-compute-optimizer-activation-composition.ts` (594 lines) +
  registration at `db/background-job-handlers.ts:1559`. Following it is
  mandatory, not stylistic — it is the only proven path from a scheduled job to
  a broker-attested collector call in this repository.
- The SCAD CUR2 runtime is **not** a reuse candidate for Foundational discovery.
  It is unwired itself; depending on it would add a second unfinished vertical
  to this one.
- "Exists in the tree" is not a classification. Every `REUSE_AS_IS` row above was
  re-checked for a live caller before being frozen.

## Third-pass finding: the permission gap was mine, not the repository's

Two classifications in the table above were wrong, and a third correction
reversed the first two. Recorded in full because the sequence is the lesson.

**Pass 1 — wrong.** "`bcm-data-exports` actions are present in
`public/sutra-customer-onboarding-role.yaml:216-217`, no successor needed."
They are present only inside `DenyUnimplementedActions`'s `NotAction`. A ceiling
permits an action; it never grants one.

**Pass 2 — also wrong.** Concluded the base role must grant them, authored pack
`.19` on `.18`, and pinned it. `tests/aws-template-contract.test.mjs` refused the
adoption: pack `.14` grants `s3:GetObject` with `Resource: '*'` inside
`ExactCostOptimizationHubRead` — account-wide object-payload read in the role
every customer grants, contradicting the template's own guarantee. Rebuilt `.19`
on `.12` instead, adding only the two enumeration actions.

**Pass 3 — the actual answer.** `tests/finops-foundational-cur2-export-template.test.mjs`
lists both actions in `ADD_ON_EXPORT_READS` and asserts the base role
**never** grants them. They belong to the separately deployed CUR 2.0 add-on,
which already grants them — and grants them better:

```yaml
- Sid: ListDataExports          # infrastructure/finops-foundational-cur2-export-v1.1.yaml
  Action: bcm-data-exports:ListExports
  Resource: '*'
- Sid: ReadOnlyThisDataExport
  Action: bcm-data-exports:GetExport
  Resource: !GetAtt FoundationalCur2Export.ExportArn    # bounded to the export it created
```

My `.19` would have granted `GetExport` on `*`. The add-on bounds it to one exact
export ARN.

**Net permission change required by this vertical: none.** Pack `.19` was deleted,
the pin stays at `.12`, and the two commands are scoped `source_session` in the
coverage guard — the existing scope for an action that runs under a
source-specific, fail-closed session rather than the default metadata role.

What this changes for the implementation: discovery must run under the **add-on's
session**, not the default collector session. A connection without the CUR 2.0
add-on deployed cannot enumerate, and that is a `CONFIGURATION_REQUIRED` state to
surface, not an error and not an empty result.

**Separate defect, not fixed here:** `.14`'s `s3:GetObject` on `Resource: '*'`
blocks adoption of the whole `.13`-`.19` chain and would fail a customer security
review. It needs its own repair before any vertical adopts those packs.

## Frozen reuse set and bounded edit set

### Frozen `REUSE_AS_IS` files

```text
lib/finops-cudos-official-definition.ts
lib/finops-cost-intelligence-official-definition.ts
lib/finops-kpi-official-definition.ts
lib/finops-data-export-ingest-job.ts
db/finops-data-export-observation-repository.ts
db/finops-billing-engine-repository.ts
db/finops-active-billing-query-repository.ts
postgres/migrations/0078_finops_data_export_observations.sql
app/api/v1/finops/data-export/ingest/route.ts
app/api/v1/finops/cudos/route.ts
app/costs/finops-foundational-panels.tsx
app/costs/finops-foundational-sheets.ts
app/costs/finops-foundational-sheet-shell.tsx
public/sutra-customer-onboarding-role.yaml
infrastructure/customer-onboarding-role-standard-2026-08.12.yaml
```

### Vertical-specific files allowed to change

```text
services/aws-collector/src/finops-data-export-discovery-adapter.ts   (new)
services/aws-collector/src/finops-data-export-discovery-route.ts     (new)
lib/finops-data-export-discovery-job.ts                              (new)
tests/finops-data-export-discovery-job.test.ts                       (new)
tests/finops-data-export-discovery-adapter.test.ts                   (new)
services/aws-collector/test/finops-data-export-discovery.test.ts     (new)
```

### Shared files reserved for the single integrator

```text
services/aws-collector/src/local-server.ts        (register the discovery route)
db/background-job-handlers.ts                     (register the discovery kind)
tests/collector-permission-coverage.test.mjs      (map the new SDK command)
docs/FINOPS_CID_IMPLEMENTATION_TRACKER.md         (G1 promotion, last)
docs/finops-cid-evidence/FND-0{1,2,3}-*.md        (G1 promotion, last)
```

## Contract decisions

| Question | Decision and authoritative basis |
|---|---|
| Exact provider sources/actions/resources | `bcm-data-exports:ListExports`, `bcm-data-exports:GetExport`, then `s3:ListBucket`/`s3:GetObject`/`s3:GetObjectAttributes`/`s3:GetBucketLocation` bounded to the export's own prefix. All six are already granted by `standard-2026-08.12`; **no action outside that set may be added.** |
| Pagination, row, payload and deadline bounds | Manifest ≤ `FINOPS_MANIFEST_MAX_BYTES` (existing constant). Observation payload 2–24576 bytes (existing CHECK). Export enumeration bounded per call; a page cap that truncates must be disclosed, never silently dropped. |
| Tenant/account/connection identity binding | Observation is keyed `(org_id, customer_id, connection_id, payload_sha256)` by the existing UNIQUE. Scope comes from the persisted connection, never from a request body — the ingest route already enforces this and must not be widened. |
| Replay/lease/CAS and READY-head semantics | `INSERT OR IGNORE` on the payload hash makes rediscovery idempotent. Correction-safe generation head is already owned by the ingest job; discovery must not touch generations. |
| Evidence signature and verification | `recordVerifiedObservation` requires a `VerifiedHostedBrokerRequest`. Discovery emits through the broker-signed path; an unsigned producer is not acceptable. |
| Currency/micros behavior | Untouched. Discovery records coordinates and independent totals only; the ingest job owns micros, currency separation and lineage. |
| Privacy/redaction behavior | Observation carries manifest coordinates and totals, never CUR row content. |
| Supported UI dimensions | Unchanged — the dashboards already declare theirs. |
| Explicitly unavailable dimensions | Unchanged. Discovery must not upgrade any sheet's `PARTIAL` support vocabulary. |
| Failure-state behavior | A customer with no CUR 2.0 export is `CONFIGURATION_REQUIRED`, not empty and not zero. A `ListExports` denial is `unavailable`, never "no exports". Both must be distinguishable in the UI. |

## Ordered implementation plan

1. **Data Export enumeration reader** in the collector: `ListExports` + `GetExport`, resolving the S3 destination of any CUR 2.0 / FOCUS 1.2 export. Verify: `services/aws-collector/test/finops-data-export-discovery.test.ts`, plus `node --test tests/collector-permission-coverage.test.mjs` for the command mapping.
2. **Discovery adapter** that locates the newest manifest under the resolved prefix, reads and validates it with the existing validator, and computes the independent totals the observation carries. Verify: `tests/finops-data-export-discovery-adapter.test.ts`.
3. **Broker-signed emission** calling `recordVerifiedObservation`. Verify: `tests/finops-data-export-discovery-job.test.ts` asserting an unsigned request is refused.
4. **Scheduled discovery job kind**, registered in `db/background-job-handlers.ts`, following `finops-compute-optimizer-discovery-job.ts`. Verify: the job-kind registry test plus the new job test.
5. **Enqueue ingest from a fresh observation** so the existing pipeline runs unchanged. Verify: `node --test tests/finops-data-export-ingest-job.test.ts` (must still pass untouched).
6. **Four-state disclosure** for "no export configured" vs "denied" vs "awaiting first delivery" vs "delivered". Verify: `tests/finops-foundational-ui-contract.test.mjs`.
7. **Full gate sweep at one SHA**, then tracker/evidence promotion as a separate second commit.

## Candidate verification record

| Gate | Exact command(s) | Result | Evidence/notes |
|---|---|---|---|
| Focused domain/runtime tests | | pending | |
| Collector/provider/route tests | | pending | |
| Shared registration/predecessor tests | | pending | |
| SQLite/PostgreSQL migration parity | | pending | no new migration expected |
| Permission/CloudFormation tests | | pending | no new pack expected |
| Root typecheck/build | | pending | |
| Collector typecheck/build | | pending | |
| UI/render/accessibility contracts | | pending | |
| Lint, secrets and `git diff --check` | | pending | |

## Handoff and promotion

| Field | Value |
|---|---|
| Feature commit | pending |
| Feature pushed and remote SHA matched | pending |
| Evidence file updated | pending — after gates only |
| Tracker moved to `LOCAL_VERTICAL_CANDIDATE` | already there; G1 note changes only |
| Execution ledger updated | pending |
| Tracker/evidence commit | pending — second commit |
| Tracker/evidence pushed and remote SHA matched | pending |
| Remaining G7 release-only gaps | G7–G10 stay `NOT_STARTED`: exact-tree gate, controlled reconciliation, live acceptance. Observing a first delivery does not promote them. |

## Blocker — recorded 2026-08-07

`bcm-data-exports:ListExports` is not granted by any permission pack.

```
line 216: - bcm-data-exports:ListExports   <- Sid=DenyUnimplementedActions under NotAction
line 217: - bcm-data-exports:GetExport     <- Sid=DenyUnimplementedActions under NotAction
```

Absence from a Deny is not permission; IAM requires an explicit `Allow`. The
first inventory pass read those two lines as a grant and classified the row
`REUSE_AS_IS`. That was wrong, and it is the same failure mode as the second-pass
finding above: presence in a file is not reachability.

`tests/collector-permission-coverage.test.mjs` caught it —
*"collector calls bcm-data-exports:ListExports but the onboarding template does
not Allow it"* — which is why the reader is committed with that gate red rather
than with the assertion relaxed. **Do not weaken that test to make this branch
green.** It is the only thing standing between this vertical and a discovery job
that returns `AccessDenied` for every real customer while passing locally.

Pack coverage:

| Pack | `ListExports` | `GetExport` |
|---|---|---|
| `standard-2026-08.12` (pinned, published) | no | no |
| `.13` | no | no |
| `.14`–`.18` | **no** | yes (`ExactCostOptimizationHubRead`) |

Options put to the user, unresolved:

1. Author pack `.19` granting `ListExports`. Consumes the last reserved slot and
   requires every onboarded customer to redeploy their role.
2. Drop `ListExports`: have the operator name the export during onboarding and
   resolve it with `GetExport` alone, which `.14`+ already allows. No new pack,
   but it reintroduces the configuration surface this worksheet had eliminated,
   and `.14` is still not the pinned pack.

Implementation is stopped here. The template's own rule applies: *do not
implement while a required decision is blank or contradictory.*
