# Onboarding revamp: organization scope and real permission toggles

User decisions recorded 2026-08-08, superseding the two "recorded conflicts" in
`docs/WIZ_STYLE_CONSOLE_PLAN.md`:

1. **Organization scope is to be built for real** — management-account
   onboarding, member enumeration, per-member connections — not left as an
   unavailable radio.
2. **Permission add-ons become real toggles.** The user explicitly accepted
   changing the underlying model ("ready to change the principle, also from my
   db").

## How the immutable-pack reservation survives decision 2

`CLAUDE.md` holds two reservations: older permission templates are immutable,
and successors use exact enumerated allowlists. Decision 2 does **not** amend
them, because the design never edits an existing pack:

- The base onboarding role keeps deploying exactly
  `AWS_CUSTOMER_ROLE_TEMPLATE_VERSION` (`standard-2026-08.12`), unchanged.
- Each toggle is an **add-on stack**: its own CloudFormation template, its own
  exact enumerated allowlist, deployed into the customer account alongside the
  base role and recorded against the connection. The deployed CUR 2.0 add-on
  (`finops-foundational-cur2-export-v1.1.yaml`) is the existing precedent.
- A toggle OFF means the stack is never deployed; a toggle ON after the fact
  means deploying the add-on stack later. The base role is recomposed in
  neither case.

What IS new policy: connections gain a recorded set of attached add-ons, and
the UI derives capability rows from that set rather than from the base pack
alone.

## Asset inventory (before any edit)

| Asset | Path | Class |
| --- | --- | --- |
| Wizard chrome (rail, sections, radio cards, permission rows) | `app/onboard/onboard-wizard-chrome.tsx` | `REUSE_AS_IS` |
| Onboarding flow, 3 paths, ExternalId handoff | `app/onboard/onboard-account.tsx` | `REPAIR` (org scope + toggles) |
| Capability rows pinned to pack YAML | `lib/aws-onboarding-role-capabilities.ts` + test | `REPAIR` (per-connection add-ons) |
| Base role template `.12` | `infrastructure/customer-onboarding-role-standard-2026-08.12.yaml` | `REUSE_AS_IS`, immutable |
| CUR 2.0 add-on stack (the add-on precedent) | `infrastructure/finops-foundational-cur2-export-v1.1.yaml` | `REUSE_AS_IS` |
| Connection model (`aws_connections`, `source_kind`) | `db/*` | `REPAIR` (org linkage, add-on bindings) |
| Migration registries (three) | `db/runtime-migrations.ts`, `db/postgres-runtime-migrations.ts`, `scripts/postgres-migrate.mjs` | `REPAIR`, integrator-owned |
| Collector role assumption | `services/aws-collector/src/role-broker.ts` | `REPAIR`, integrator-owned |

## Review corrections (Codex, 2026-08-08) — all three verified and adopted

1. **Lightsail cannot be the first toggle.** The `.12` base role's
   `DenyUnimplementedActions` ceiling reserves no `lightsail:` action, so an
   add-on Allow attached to that role is Deny-overridden. The CUR 2.0 add-on
   works only because its S3/KMS/BCM actions are already reserved in the
   ceiling. The first real toggles are therefore the two Foundational export
   add-ons (`foundational-cur2-export-v1`, `foundational-focus12-export-v1`),
   whose templates already exist and whose actions sit inside the ceiling.
   Lightsail waits for a successor ceiling pack, authored sequentially by the
   integrator, and only then re-enters the add-on enum by migration.

2. **Member accounts need their own trusted role.** A stack in the management
   account cannot create roles in member accounts. Member provisioning is a
   CloudFormation StackSet from the management account deploying the pinned
   base-role template to the selected OU. Organization connections use a
   management-scoped ExternalId shared by member roles (a recorded relaxation
   of one-ExternalId-per-connection, bounded to org scope); per-member trust is
   still proven by the existing role-ARN/account/partition validation before a
   member connection activates.

3. **OU scoping requires traversal, not `ListAccounts`.** The management role
   grants `organizations:ListRoots`, `ListOrganizationalUnitsForParent` and
   `ListAccountsForParent`, and enumeration walks the requested OU subtree with
   bounded pagination, so the UI can prove a listed member belongs to the OU
   the operator scoped.

## Build order

Each phase lands on `develop`, verifiable alone, in this order. A later phase
never starts before the previous one is green.

1. **DB**: add-on binding table (`aws_connection_addons`) and organization
   onboarding linkage (management connection id + `org_scope` on
   `aws_connections`). One migration, registered in all three registries,
   proven on SQLite and PostgreSQL.
2. **Templates**: management-account role template (Organizations read +
   member-role assumption path) and the Lightsail add-on pack as the first
   real toggle. New templates only; exact enumerated allowlists; nothing
   renumbered.
3. **Collector**: member enumeration under the management role
   (`organizations:ListAccounts`), per-member assumption, add-on-aware
   session scoping.
4. **API**: org onboarding endpoints (create management connection, enumerate
   members, onboard selected members) and add-on attach/detach with
   deploy-state verification.
5. **UI**: enable the Organization radio, OU ID input, member selection,
   toggles driving add-on stack deployment, capability rows derived from
   base pack + attached add-ons.
6. **Gate sweep** at one SHA, then the user decides "commit to main" /
   "deploy".

## Standing constraints

- The base pack stays pinned and immutable; add-ons are new templates.
- Missing evidence renders unavailable/collecting/failed, never healthy.
- Credentials stay collector-owned; tenant/account/connection binding is
  preserved through every new path.
- Migrations incomplete until registered in all three registries and proven
  on both engines.
- `tests/aws-onboarding-role-capabilities.test.mjs` keeps its
  both-directions guarantee, extended over add-on packs.

## SUPERSEDED 2026-08-08 — direction pivot

The user replaced this direction with a Cloudaware-style self-serve signup
onboarding (Google sign-in → choose goals → name → connect infrastructure) and
an initial goal-driven home dashboard. Phase 1 (the DB migration) had already
been completed and verified and stays landed; phases 2-5 of this worksheet are
cancelled, not pending. The new effort is planned in
`docs/ONBOARD-signup-flow-plan.md`.
