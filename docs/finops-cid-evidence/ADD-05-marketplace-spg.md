# ADD-05 — AWS Marketplace Single Pane of Glass

## Status

`PARTIAL_PIPELINE` — the normalized buyer engine, server-owned job contract,
permanent scheduler/runtime boundary, immutable tenant-scoped persistence,
authenticated same-tenant API, and native dashboard are implemented. The
signed AWS provider adapter, reviewed role-policy deployment, shared scheduler
registration, and live buyer-account evidence have not been deployed or
accepted. The UI therefore reports configuration required
when no generation exists and the API reports
`MARKETPLACE_SIGNED_BROKER_ADAPTER_NOT_DEPLOYED`; this vertical is not live
verified.

## Immutable official-definition audit

The source audit is pinned to AWS's public CID repository at commit
`f9e36d88c47709f10e8fa784ad11d5cc0e728021`. The Marketplace manifest is
`dashboards/aws-marketplace/aws-marketplace-spg.yaml`, with SHA-256
`67aaab07865d8c5096379bd3baf962f92e2337762d365b75bbfb8cbc28276f5d`.
It identifies dashboard/template ID `aws-marketplace`, category `Additional`,
theme `MIDNIGHT`, and the agreements, Marketplace licenses/grants, Marketplace
spend, and terms datasets.

The immutable manifest references an AWS-managed QuickSight template; it does
not embed the QuickSight analysis definition. Exact sheet objects, visual
objects, controls, placements, and pixel geometry therefore cannot be audited
from this source. Sutra records the control inventory as
`NOT_DISCLOSED_IN_IMMUTABLE_SOURCE`, keeps the QuickSight visual-object count
`null`, and makes no pixel-parity claim.

The API returns this same frozen audit in configuration-required and
report-bearing responses. The browser validates its commit, manifest hash,
five-tab and 23-area identity and renders the audit independently during
disconnected, loading, configuration-required, failed, and report states. It
does not turn catalog metadata into Marketplace procurement or CUR2 evidence.

AWS's official guidance page documents five tabs and 23 named visual areas:

| Documented tab | Named areas |
|---|---:|
| Spend Summary | 5 |
| Spend Deep Dive | 4 |
| Bedrock 3P Foundational Model Spend | 2 |
| Granted and Entitled Licenses | 5 |
| Marketplace Agreements | 7 |

The pinned inventory and per-area support state are encoded in
`lib/finops-marketplace-spg-official-definition.ts` and rendered in the native
dashboard. The Bedrock 3P areas remain explicitly unavailable because the
approved evidence contract has no authoritative foundational-model
classification or usage-unit dimension; product names are not used to infer
either fact.

## Official capability coverage

The native workspace covers the official dashboard areas that the current
evidence contract can prove:

| Area | Implemented evidence |
|---|---|
| Spend summary and deep dive | Reconciled CUR2 rows only, with exact signed micro-units, currencies separated, billing period/account/product/seller/charge-category filters, trend, seller/product/account/invoice rankings, and safe visible-row CSV. |
| Invoice tracker | Allowlisted CUR2 invoice ID, billing period, product, seller, account, charge category, billed and amortized amounts. Missing invoice IDs remain missing. |
| Agreements and subscriptions | Buyer/acceptor agreements, lifecycle status, acceptance/start/end, product, seller, fulfillment metadata, offer ID, terms, agreement entitlements and known charges. |
| Renewal and expiration | Explicit 30/60/90-day agreement and license expiration classifications, end dates, renewal-term `autoRenew` evidence where supplied, and status drilldown. |
| Licenses and entitlements | Received License Manager licenses, beneficiary, validity, status and allowlisted entitlement quantities. |
| Sharing and grants | Received grant beneficiary, activation state and allowlisted operations. |
| Deployment | Marketplace Discovery `deployedOnAws` product metadata only; no resource deployment is inferred. |
| Procurement/legal/GRC | Agreement, offer ID, legal document *type* (not URL/content), validity, renewal, deployment-status counts, lifecycle commitment by deployment status, agreement charges by month, and license/grant evidence in one tenant-scoped view. |

The following official dimensions remain explicit gaps rather than inferred
claims:

- public self-service versus private-offer classification is not present in
  the current buyer capture;
- software, data, and professional-services product-type classification is
  not present in the minimized Discovery projection;
- resource-level deployment telemetry is not produced by `deployedOnAws`;
- AWS's five-minute `GetBuyerDashboard` bearer URL is never stored or exposed.

## Source separation

- Realized spend and usage: active reconciled CUR2 evidence only.
- Agreements, accepted terms, lifecycle commitment, entitlements, licenses,
  and grants: AWS Marketplace Agreement/Discovery and License Manager control
  planes only.
- Agreement estimated charges retain
  `KNOWN_LIFECYCLE_COMMITMENT_NOT_USAGE_ACTUAL` and are never added to CUR2
  billed or amortized spend.
- No spend row is used to infer entitlement, and no license/agreement is used
  to infer an invoice.

## Implemented chain

- Engine: `lib/finops-marketplace-spg.ts`
- Permanent job contract: `lib/finops-marketplace-spg-collector-job.ts`
- Permanent scheduler/runtime boundary: `lib/finops-marketplace-spg-runtime-binding.ts`
- SQLite migration: `drizzle/0096_finops_marketplace_spg.sql`
- PostgreSQL migration: `postgres/migrations/0091_finops_marketplace_spg.sql`
- Repository: `db/finops-marketplace-spg-repository.ts`
- API: `app/api/v1/finops/marketplace-spg/route.ts`
- Official definition: `lib/finops-marketplace-spg-official-definition.ts`
- Dashboard projection: `lib/finops-marketplace-spg-dashboard.ts`
- UI: `app/costs/finops-marketplace-spg-dashboard.tsx`
- Focused tests: `tests/finops-marketplace-spg.test.ts`,
  `tests/finops-marketplace-spg-dashboard.test.ts`,
  `tests/finops-marketplace-spg-vertical.test.mjs`, and
  `tests/finops-marketplace-spg-runtime-binding.test.ts`

The repository normalizes the exact capture before persistence. Snapshot rows
are immutable and content-addressed; the mutable head can advance only to a
newer generation with complete organization coverage and READY/EMPTY states
for agreements, licenses, and CUR2 spend. Partial, configuration-required, and
failed correction attempts remain immutable history and cannot replace the
last complete accepted head.

The permanent runtime boundary reloads the organization/customer/connection,
management account, AWS Organization, sorted active-account coverage evidence,
License Manager organization-integration requirements, and one active
reconciled CUR2 generation from server state. The queue payload contains only
the daily UTC window. The deterministic broker request pins the six buyer
operations, five License Manager operations, two Organizations coverage
actions, Agreement/Discovery endpoint Regions, acceptor party, 50/100 page
sizes, 5,000-page sequence ceiling, 15-minute abort, all collection bounds,
an 11 MiB evidence-archive ceiling, and every false-valued privacy control.

The CUR2 boundary retains its `fbg_...` generation, immutable source-evidence
generation, manifest SHA, data-through timestamp, reconciliation/predicate,
complete linked-account set, exhaustive-row state, separate billed/amortized
columns, and row-level currency separation. The returned capture must reproduce
the fields it can carry exactly; the full server boundary is included in the
canonical archived evidence and its digest is bound to replay and persistence.

The broker port must return an Ed25519-verified response with exact request and
capture hashes. The runtime archives the canonical boundary/request/
verification/capture as `finops_source_snapshot`, derives a deterministic
`fss_...` evidence generation, seals it with tenant/customer/connection/source/
generation AAD, and requires an application handoff to bind that evidence to
the normalized `mspg_...` snapshot. Accepted replay identities perform no
second provider call, archive, or persistence write; replay recomputes both the
snapshot generation digest and the evidence-generation digest before accepting
the receipt. Only generic failure codes are handed off; provider text is never
retained.

## Privacy and security boundary

The job contract pins buyer/acceptor reads, the active reconciled CUR2 source,
bounds, and false-valued privacy flags. Registration tokens, purchase-order
references, legal documents/URLs, contacts, raw provider messages, temporary
embed URLs, issuer keys and arbitrary metadata are not accepted. API reads
require an authenticated session, the exact organization-owned live AWS
connection, and `connection:read` capability for the same customer.

## Remaining live gates

1. Implement and review the authenticated Ed25519 broker transport and provider
   adapter for bounded Agreement, Discovery, License Manager, organization-
   account and active-CUR2 reads. Provider-validate exact pagination tokens,
   throttling/retries, response-size enforcement, endpoint routing, and the
   buyer-only operation ceiling.
2. Bind the trusted eligible-connection resolver and permanent server-boundary
   resolver for AWS Organizations coverage, License Manager organization
   settings, and the atomically active reconciled CUR2 generation.
3. Implement the atomic or recoverable immutable-handoff port that binds the
   sealed `fss_...` object, source-boundary hash, and normalized `mspg_...`
   generation under one request identity.
4. Register `finops-marketplace-spg-daily-collect` in the shared durable handler
   registry and bind the scheduler, queue, attempt ledger, evidence archive,
   key service, role sessions and observability. The isolated binding remains
   `registeredInSharedRuntime: false`; shared registries were not edited.
5. Add an approved source for offer and product-type classification, or keep
   those official views unavailable. A seller API, embed URL, spend row, or
   offer ID must not be used to infer the missing dimension.
6. Validate complete organization, single-account, no-purchase, missing
   License Manager integration, mixed currencies, pagination, expired/replaced
   agreement, denied access, stale source and cross-tenant rejection cases in
   real buyer accounts.
7. Verify signed response/capture hashes, independent CUR2 total reproduction,
   immutable lineage, accessibility and signed-in dashboard behavior against
   the deployed site; attach live evidence, rollback and post-deploy smoke
   results.

Until these gates pass, this vertical must not be marked `LOCAL_VERIFIED` or
`LIVE_VERIFIED`.

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
