# Wiz-style console plan

Working memory for the multi-step effort to bring the Sutra console to the
Wiz-style shape the user supplied as reference screenshots (AWS connector
wizard, Azure connector wizard, Deployments list, icon navigation rail).

**Build order agreed with the user: onboarding first, then everything else,
one step at a time.** Do not start a later step until the current one is
accepted.

This plan is subordinate to `CLAUDE.md`. Where the reference design and the
repository protocol disagree, the protocol wins and the conflict is recorded
here rather than guessed at.

## Inventory taken 2026-08-07 (before any edit)

Per the anti-rework protocol, every asset below was classified before work
started. **Most of what the screenshots show already exists.**

| Asset | Path | Class |
| --- | --- | --- |
| Nav glyph system (60+ hand-drawn 24px icons, no icon font) | `app/components/nav-icon.tsx` | `REUSE_AS_IS` |
| Per-destination semantic tones (`navTone`, 10 hues) | `app/components/nav-icon.tsx` | `REUSE_AS_IS` |
| Nav destinations, groups, sections, capability gating | `app/components/navigation-config.ts` | `REUSE_AS_IS` |
| Sidebar / topbar / mobile drawer shell | `app/components/app-shell.tsx` | `REPAIR` (rail mode only) |
| Radio-card pattern CSS (`.onboard-path`, selected state, trait pills) | `app/globals.css:462-475` | `REUSE_AS_IS` |
| AWS onboarding flow (4 steps, 3 paths, ExternalId handoff, trust proving, CFN quick-launch, Terraform/CFN/JSON artifacts, lifecycle) | `app/onboard/onboard-account.tsx` (1040 lines) | `REUSE_AS_IS` |
| Client onboarding guide | `app/onboard/client/` | `REUSE_AS_IS` |
| Connection health page | `app/connection-health/` | `REUSE_AS_IS` |
| Permission packs `standard-2026-08.1` … `.19` | `infrastructure/*.yaml` | `REUSE_AS_IS`, immutable |

### The nav icons in the reference screenshots are already built

`app/components/nav-icon.tsx:153` already carries the comment "Feature colors,
Wiz-style". Every nav destination already renders
`<span class="nav-glyph-chip" data-tone={navTone(key)}><NavIcon/></span>`.

The remaining difference from the reference is **shape, not iconography**: Wiz
uses a narrow always-visible icon rail with the label under each glyph, where
Sutra uses a wide grouped text nav. That is step 3 below.

## Steps

### Step 1 — AWS onboarding wizard (IN PROGRESS)

Restructure the presentation of `/onboard` into the reference wizard shape.
The underlying flow, request bodies, validation and security properties are
reused unchanged.

- Numbered step rail on the left (`1 Connection`, `2 Details`).
- `Choose Your Setup` card: Connector Scope, Installation Type.
- `Deploy` card: Deployment Method as radio cards, generated artifact panel.
- Copyable `main.tf` module block for the Terraform path.
- `Launch CloudFormation` primary action for the template path.
- Step 2 `Details` collects the resulting Role ARN and proves the trust
  boundary using the existing negative-probe validation.

Reuse, do not re-derive: `ONBOARD_PATHS`, `selectOnboardPath`, the ExternalId
one-time handoff and its sessionStorage recovery draft, `quickLaunchUrl`,
`expectedRoleArn`, `validateCustomerManagedRoleSelection`, and every existing
`/api` call.

### Step 2 — Deployments list page

The reference "Deployments" screen: tab strip (All, Cloud, Kubernetes,
Registry, Version Control, Outpost, Sensor, Broker, Remediation & Response),
search, filter chips, and a table of deployment / health / status / sources /
modules / last activity.

Sutra equivalents already exist and must be aggregated, not re-collected:
`/customers`, `/connection-health`, `/kubernetes`, `/registry/inventory`.

### Step 3 — Icon navigation rail

Collapse the sidebar to a Wiz-style icon rail (glyph over short label) with a
flyout for group contents. Constraint: Sutra has 100+ destinations across 8
groups against Wiz's ~9 top-level entries, so the rail must be a collapsed
*mode* of the existing grouped nav, never a replacement that hides
destinations. `tests/navigation-config.test.ts` and
`tests/finops-navigation-subsections.test.mjs` already assert that every
visible item appears in exactly one section — that invariant must survive.

### Step 4 — Additional connectors

Only after steps 1-3 are accepted.

## Recorded conflicts — resolve with the user, do not guess

1. **Per-connection permission toggles.** The reference AWS screen offers
   `Add DSPM Permissions`, `Add Lightsail workload scanning permissions` and
   `Add EKS Scanning` as free checkboxes that recompose the role's policy.
   Sutra's model is the opposite by design: permission packs are immutable,
   use exact enumerated allowlists, and successors `.8.12`-`.8.19` must be
   integrated **sequentially by the designated integrator**. Checkboxes that
   compose a policy per connection would break that reservation.
   *Proposed resolution:* render the toggles as a **selector over existing
   packs**, showing which pack a given combination resolves to, and disable
   any combination with no published pack. No new pack authored as part of
   the UI work.

2. **Connector Scope: Organization.** The reference offers org-wide or
   single-account onboarding. Sutra is single-account today ("Onboard one AWS
   account"); org-wide role assumption across member accounts is a collector
   capability, not a form field. *Proposed resolution:* ship the control with
   Account functional and Organization visibly unavailable-pending-capability
   — never rendered as working.

3. **Installation Type: Outpost.** No Sutra equivalent of a Wiz Outpost
   (customer-hosted scanner plane). Do not render a control for a capability
   that does not exist.

4. **Azure and GCP connectors.** The user supplied an Azure screenshot, but
   `CLAUDE.md` excludes ADD-02 Azure and ADD-03 GCP from the 27-dashboard
   release. Azure onboarding also has no collector behind it. Deferred to
   step 4 and out of the current release.

## Standing constraints

- Shared files stay with the designated integrator: `package.json`,
  `pnpm-lock.yaml`, `services/aws-collector/src/role-broker.ts`,
  `services/aws-collector/src/local-server.ts`, `lib/finops-daily.ts`, the
  three migration registries, the onboarding CloudFormation templates, the
  permission catalogs, and the tracker/handover docs. UI work must not touch
  them.
- Tests that guard this surface and must keep passing:
  `tests/aws-customer-role-onboarding-ui.test.mjs`,
  `tests/navigation-config.test.ts`,
  `tests/finops-navigation-subsections.test.mjs`,
  `tests/finops-workspace-shell.test.mjs`,
  `tests/connection-health-page.test.mjs`,
  `tests/invitation-only-client-onboarding.test.mjs`,
  `tests/publish-onboarding-template.test.mjs`.
- Never present a missing provider signal as zero or healthy.
- Node `v22.23.2` for authoritative verification.
