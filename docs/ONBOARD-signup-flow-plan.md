# Self-serve signup onboarding (Cloudaware-style)

Target supplied by the user as four reference screenshots, 2026-08-08. This
supersedes the Wiz-style org-scope direction (see the superseded worksheet in
`docs/finops-cid-evidence/`).

The shape: someone signs up with their Google account and lands in a guided
three-step flow — **Choose your goals → Share the name → Connect your
infrastructure** — with a progress strip in the top bar, a minimal Home-only
sidebar during onboarding, and a goal-driven home dashboard afterwards
("Connect your infrastructure to track every asset, everywhere" hero, goal
cards for CMDB / FinOps / Vulnerabilities).

## What exists today (inventory before any edit)

| Asset | Path | Class |
| --- | --- | --- |
| Google OIDC federation (Google + Entra), invitation-gated | `lib/hosted-oidc-providers.ts`, `app/api/auth/oidc/start/route.ts` | `REPAIR` — needs a self-serve signup path |
| Login page | `app/login/page.tsx` | `REPAIR` |
| Invitation-only client onboarding + its test | `tests/invitation-only-client-onboarding.test.mjs` | boundary to renegotiate deliberately |
| AWS connect flow: ExternalId handoff, role ARN validation, CFN quick-launch link, template download, partition select, access-key path | `app/onboard/onboard-account.tsx` | `REUSE_AS_IS` mechanics; new chrome |
| Wizard chrome | `app/onboard/onboard-wizard-chrome.tsx` | `REUSE_AS_IS` / extend |
| Org/customer/tenancy model | `db/schema.ts` (`organizations`, `customers`) | `REPAIR` — trial orgs born from signup |

The reference "New AWS Account" form is closer to Sutra's existing flow than
the Wiz reference was: ExternalId with regenerate, Role ARN from the stack
output, pre-generated quick-create template link OR manual template download,
partition select, and an Access & Secret Keys tab. All of those mechanics ship
today; what changes is who may reach them (self-serve trial orgs, not just
invited operators) and the chrome around them.

## Runtime constraint

One EC2 instance runs the Docker image and the database. Self-serve signup adds
unauthenticated account creation to a single-node system: rate limiting,
disposable-address abuse, and tenant isolation are design inputs from phase 1,
not hardening afterwards.

## Phases — each lands on `develop` independently green

0. **Plan acceptance** — this document, reviewed by the user.
1. **Self-serve Google signup → trial org bootstrap.** "Continue with Google"
   without an invitation creates an `organizations` row in a `trial` state
   bound to the verified Google identity, with abuse limits and the existing
   session machinery. The invitation path stays for invited operators;
   the invitation-only test is renegotiated to assert the *boundary between*
   the two paths instead of the absence of one.
2. **Onboarding progress model + chrome.** The three-step strip (goals → name
   → connect) as recorded per-org state, the Home-only sidebar during
   onboarding, and the trial badge in the account menu.
3. **Choose your goals + Share the name.** Goal cards (CMDB, FinOps,
   Vulnerability management) persisted per org; they drive the home page and
   nothing else — a goal is a lens, never a permission.
4. **Connect your infrastructure hub.** Provider cards: AWS functional; Azure,
   GCP, Oracle rendered as roadmap cards without working buttons (ADD-02/03
   stay excluded from release scope).
5. **New AWS Account form.** The reference layout (name, auth-method tabs,
   ExternalId + regenerate, Role ARN, quick-create OR manual template,
   partition; access-key tab) over the existing contract/registration APIs.
6. **Goal-driven Home.** Hero banner until a connection exists, then goal
   cards routing into the product.
7. **Gate sweep at one SHA**, then user-directed "commit to main" and
   "deploy".
