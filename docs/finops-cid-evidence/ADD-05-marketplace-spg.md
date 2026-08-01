# ADD-05 — AWS Marketplace Single Pane of Glass

## Status

`PARTIAL_PIPELINE` — the normalized buyer engine, server-owned job contract,
immutable tenant-scoped persistence, authenticated same-tenant API, and native
dashboard are implemented. The signed AWS provider adapter, reviewed role
policy deployment, scheduler binding, and live buyer-account evidence have not
been deployed or accepted. The UI therefore reports configuration required
when no generation exists and the API reports
`MARKETPLACE_SIGNED_BROKER_ADAPTER_NOT_DEPLOYED`; this vertical is not live
verified.

## Official capability coverage

The native workspace covers the official dashboard areas that the current
evidence contract can prove:

| Area | Implemented evidence |
|---|---|
| Spend summary and deep dive | Reconciled CUR2 rows only, with exact signed micro-units, currencies separated, billing period/account/product/seller/charge-category filters, trend and safe visible-row CSV. |
| Invoice tracker | Allowlisted CUR2 invoice ID, billing period, product, seller, account, charge category, billed and amortized amounts. Missing invoice IDs remain missing. |
| Agreements and subscriptions | Buyer/acceptor agreements, lifecycle status, acceptance/start/end, product, seller, fulfillment metadata, offer ID, terms, agreement entitlements and known charges. |
| Renewal and expiration | Explicit 30/60/90-day expiration classifications, end dates, renewal-term `autoRenew` evidence where supplied, and status drilldown. |
| Licenses and entitlements | Received License Manager licenses, beneficiary, validity, status and allowlisted entitlement quantities. |
| Sharing and grants | Received grant beneficiary, activation state and allowlisted operations. |
| Deployment | Marketplace Discovery `deployedOnAws` product metadata only; no resource deployment is inferred. |
| Procurement/legal/GRC | Agreement, offer ID, legal document *type* (not URL/content), validity, renewal, commitment and license/grant evidence in one tenant-scoped view. |

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
- SQLite migration: `drizzle/0096_finops_marketplace_spg.sql`
- PostgreSQL migration: `postgres/migrations/0091_finops_marketplace_spg.sql`
- Repository: `db/finops-marketplace-spg-repository.ts`
- API: `app/api/v1/finops/marketplace-spg/route.ts`
- UI: `app/costs/finops-marketplace-spg-dashboard.tsx`
- Focused tests: `tests/finops-marketplace-spg.test.ts` and
  `tests/finops-marketplace-spg-vertical.test.mjs`

The repository normalizes the exact capture before persistence. Snapshot rows
are immutable and content-addressed; the mutable head can advance only to a
newer generation with complete organization coverage and READY/EMPTY states
for agreements, licenses, and CUR2 spend. Partial, configuration-required, and
failed correction attempts remain immutable history and cannot replace the
last complete accepted head.

## Privacy and security boundary

The job contract pins buyer/acceptor reads, the active reconciled CUR2 source,
bounds, and false-valued privacy flags. Registration tokens, purchase-order
references, legal documents/URLs, contacts, raw provider messages, temporary
embed URLs, issuer keys and arbitrary metadata are not accepted. API reads
require an authenticated session, the exact organization-owned live AWS
connection, and `connection:read` capability for the same customer.

## Remaining live gates

1. Implement and review the signed provider adapter for bounded Agreement,
   Discovery, License Manager, organization-account and active-CUR2 reads.
2. Bind its schedule, retry/timeout/job-ledger behavior, and deploy its exact
   least-privilege role/session ceiling.
3. Add an approved source for offer and product-type classification, or keep
   those official views unavailable.
4. Validate complete organization, single-account, no-purchase, missing
   License Manager integration, mixed currencies, pagination, expired/replaced
   agreement, denied access, stale source and cross-tenant rejection cases in
   real buyer accounts.
5. Verify accessibility and signed-in dashboard behavior against the deployed
   site and attach immutable live evidence.

Until these gates pass, this vertical must not be marked `LOCAL_VERIFIED` or
`LIVE_VERIFIED`.
