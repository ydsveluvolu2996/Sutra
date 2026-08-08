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

### Step 2 — Deployments operating queue (DONE)

The reference "Deployments" screen: tab strip, search, filter chips, and a
table of deployment / health / status / sources / modules / last activity.

**Built by restyling `/customers` in place, not as a new page.** The user chose
this after the inventory found that `app/customers/customers-browser.tsx`
already rendered a "Customer cloud accounts" table carrying health, evidence
source, workload and freshness for every connection. A separate `/deployments`
route would have duplicated that table and its data path.

Shipped as `app/customers/deployments-panel.tsx`: tab strip, controlled search,
status chips, live result count and reset, over the same server-scoped
`usePortfolio()` read. Filters narrow rows already returned, so no filter can
widen what the browser can see.

Two constraints found while building, both honoured:

- Only three client data hooks exist (`use-pilot-state`, `use-portfolio`,
  `use-session`). There is no browser-reachable Kubernetes or registry
  collector list, so those tabs have no data path and were not invented.
- `PortfolioConnectionSummary.sourceKind` is only `aws_trust_role |
  simulated_fixture`. The tab strip is derived from the kinds actually present
  and hides itself entirely below two, rather than declaring a fixed set.

Per the user's decision, tabs with no Sutra equivalent (Outpost, Sensor,
Broker, Remediation & Response) are omitted rather than rendered empty.

### Step 3 — Icon navigation rail (DONE)

The sidebar collapses to an icon rail: one glyph per nav group with the label
under it, and the group's destinations in a flyout. A control on the rail
restores the expanded nav, and the choice persists per operator.

Built as a **mode**, never a replacement. Sutra carries 100+ destinations
across 8 groups against the reference console's ~9 top-level entries, so a
standalone rail would have to drop most of the product — and silently: the
shell still renders, the operator just cannot reach a page.

What keeps it honest:

- The rail is fed `allVisibleNav` (`visibleNavigation(capabilitySet)`), the same
  capability-filtered list the expanded nav uses. It cannot show a group the
  operator cannot open, or hide one they can.
- The flyout renders `open.items` in full through the **same** `NavItemLink`
  component as the expanded nav — one component, so active marking, glyph chip
  and tone cannot drift between the two.
- The mobile drawer is untouched and still enumerates every group and item.
- Group glyphs and tones are their own maps rather than borrowed from each
  group's first item, so reordering a group's items cannot repaint the rail.

`tests/navigation-rail-contract.test.mjs` pins all of the above.
**Verified non-vacuous** by mutation: truncating the flyout to five items,
feeding the rail unfiltered `navGroups`, and deleting the expand control each
fail exactly one assertion and nothing else.

The preference is read through `useSyncExternalStore`, not seeded by an effect —
the server has no `localStorage`, so an effect-seeded value would contradict its
own hydrated markup. Every storage access is guarded; private mode, a full
quota or disabled storage all read as expanded rather than breaking the shell.

The pre-existing invariant that every visible item appears in exactly one
section survives: `tests/navigation-config.test.ts` and
`tests/finops-navigation-subsections.test.mjs` still pass, along with the five
exact source strings the latter asserts against `app-shell.tsx`.

### Step 4 — Additional connectors

Only after steps 1-3 are accepted.

## Recorded conflicts — resolve with the user, do not guess

1. **Per-connection permission toggles. RESOLVED — stated, not selectable.**
   The reference AWS screen offers `Add DSPM Permissions`, `Add Lightsail
   workload scanning permissions` and `Add EKS Scanning` as free checkboxes
   that recompose the role's policy.

   The proposed resolution — a selector over published packs — turned out to
   be impossible, and the reason matters. Onboarding deploys exactly one pack:
   `AWS_CUSTOMER_ROLE_TEMPLATE_VERSION` is a single pinned literal
   (`standard-2026-08.12`, 274 actions). Packs `.6`-`.19` are *runtime*
   allowlists answering "is this pack new enough for capability X", not
   alternative onboarding roles. **There is nothing to select between.**

   Worse, two of the three reference toggles would have been false either way:
   the pinned pack already grants EKS (`eks:ListClusters`,
   `eks:DescribeCluster`, `eks:DescribeClusterVersions`) and S3 object reads,
   so "Add EKS Scanning" would offer something already granted; and no
   `lightsail:` action exists in any pack, so "Add Lightsail" could not be
   honoured at all.

   *Shipped instead:* `lib/aws-onboarding-role-capabilities.ts` declares seven
   capabilities with the exact actions that evidence each, rendered as disabled
   rows stating granted / not granted and naming the pack.
   `tests/aws-onboarding-role-capabilities.test.mjs` checks every declared
   action against the pack YAML in both directions — a granted row whose action
   is missing fails, and an ungranted row whose action the pack quietly gains
   also fails. The pack is resolved from the template constant, so a successor
   bump re-verifies every row rather than leaving stale claims passing.

   No pack was authored, modified or renumbered. The reservation is intact.

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
