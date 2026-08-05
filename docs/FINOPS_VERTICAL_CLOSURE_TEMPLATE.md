# FinOps vertical closure worksheet

Copy this template to a temporary working note or the matching evidence record before changing a partial dashboard. Do not commit an empty worksheet. Its purpose is to prove reuse, constrain scope and prevent duplicate implementation.

## Identity and starting state

| Field | Value |
|---|---|
| Dashboard ID and name | |
| Sutra dashboard ID | |
| Starting branch | `agent/mac-mini-finops-continuation` |
| Starting SHA | |
| Required predecessor SHA/version | |
| Permission reservation | |
| Drizzle/PostgreSQL reservations | |
| Primary implementer | |
| Shared-file integrator | |
| Dashboard aliases searched | |

Record the clean starting state:

```text
git status --short --branch:
git rev-parse HEAD:
git ls-remote origin refs/heads/agent/mac-mini-finops-continuation:
node --version:
```

## Existing-asset reuse inventory

Use only these classifications:

- `REUSE_AS_IS` — already satisfies the contract; freeze it.
- `REPAIR` — exists but a named requirement/test proves a bounded change is needed.
- `MISSING` — required surface does not exist.
- `UNAVAILABLE_BY_CONTRACT` — authoritative evidence is unpublished/unsupported; preserve explicit unavailability.

| Surface | Existing files/symbols | Classification | Proof or exact gap | Planned action |
|---|---|---|---|---|
| Official definition/evidence | | | | |
| Domain/formulas | | | | |
| Collector adapter | | | | |
| SDK reader/client | | | | |
| Provider route | | | | |
| Session/IAM contract | | | | |
| Role broker/local server | | | | |
| Drizzle migration | | | | |
| PostgreSQL migration | | | | |
| Three migration registries | | | | |
| Durable repository | | | | |
| Runtime binding/composition | | | | |
| Scheduler/shared handler | | | | |
| Authenticated API | | | | |
| Native four-state UI | | | | |
| Focused tests | | | | |
| Shared/predecessor tests | | | | |
| Permission successor | | | | |
| Documentation/tracker | | | | |

## Frozen reuse set and bounded edit set

List every file before editing. New files discovered later require a written reason here before they are touched.

### Frozen `REUSE_AS_IS` files

```text

```

### Vertical-specific files allowed to change

```text

```

### Shared files reserved for the single integrator

```text

```

## Contract decisions

| Question | Decision and authoritative basis |
|---|---|
| Exact provider sources/actions/resources | |
| Pagination, row, payload and deadline bounds | |
| Tenant/account/connection identity binding | |
| Replay/lease/CAS and READY-head semantics | |
| Evidence signature and verification | |
| Currency/micros behavior | |
| Privacy/redaction behavior | |
| Supported UI dimensions | |
| Explicitly unavailable dimensions | |
| Failure-state behavior | |

Do not implement while a required decision is blank or contradictory.

## Ordered implementation plan

Each step must consume existing assets where possible and name its verification command.

1. Step and verification command:
2. Step and verification command:
3. Step and verification command:

## Candidate verification record

| Gate | Exact command(s) | Result | Evidence/notes |
|---|---|---|---|
| Focused domain/runtime tests | | | |
| Collector/provider/route tests | | | |
| Shared registration/predecessor tests | | | |
| SQLite/PostgreSQL migration parity | | | |
| Permission/CloudFormation tests | | | |
| Root typecheck/build | | | |
| Collector typecheck/build | | | |
| UI/render/accessibility contracts | | | |
| Lint, secrets and `git diff --check` | | | |

All results must come from the final feature SHA. Interrupted or pre-integration test results do not promote the row.

## Handoff and promotion

| Field | Value |
|---|---|
| Feature commit | |
| Feature pushed and remote SHA matched | |
| Evidence file updated | |
| Tracker moved to `LOCAL_VERTICAL_CANDIDATE` | |
| Execution ledger updated | |
| Tracker/evidence commit | |
| Tracker/evidence pushed and remote SHA matched | |
| Remaining G7 release-only gaps | |

The worksheet is complete only when the final two commits are pushed and the worktree is clean.
