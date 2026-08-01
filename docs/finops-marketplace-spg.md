# AWS Marketplace Single Pane of Glass source contract

This slice defines the read-only, evidence-honest source and normalization
contract for Sutra's AWS Marketplace Single Pane of Glass capability. It joins
three authoritative but deliberately separate evidence planes:

- AWS Marketplace Agreement Service for buyer-accepted agreements, accepted
  terms, agreement entitlements, known charges, and contract expiration;
- AWS License Manager for Marketplace-issued received licenses, entitlements,
  organization grants, grant beneficiaries, and activation state;
- reconciled CUR 2.0 evidence for realized Marketplace spend, invoices,
  accounts, products, sellers, charge categories, and cost bases.

The engine does not perform AWS, network, persistence, route, or UI work. It
accepts only a bounded, server-pinned capture for an authenticated Sutra
organization/customer/connection and produces explicit channel, freshness,
configuration, and organization-coverage states.

AWS's SPG dashboard describes spend, invoice, granted/entitled-license, license
sharing, agreement, charge, legal-term, deployment, and expiration views:

- <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/marketplace-dashboard.html>

The native definition audit is pinned to
`aws-samples/aws-cudos-framework-deployment` commit
`f9e36d88c47709f10e8fa784ad11d5cc0e728021`, manifest
`dashboards/aws-marketplace/aws-marketplace-spg.yaml`, SHA-256
`67aaab07865d8c5096379bd3baf962f92e2337762d365b75bbfb8cbc28276f5d`.
That manifest references the AWS-managed `aws-marketplace` QuickSight template
but does not embed its analysis definition, so an exact QuickSight control,
object-count, or pixel-layout inventory is not available from the immutable
artifact. The separately documented AWS catalog contains five tabs and 23
named visual areas; Sutra maps those names to supported, partial, or unavailable
evidence-backed native views without claiming undisclosed QuickSight parity.

## Exact permanent collector reads

### Buyer Agreement Service

The collector assumes each approved buyer account separately and uses the
commercial AWS Marketplace Agreement Service endpoint in `us-east-1`. Each
search is pinned to `PartyType=Acceptor`, `AgreementType=PurchaseAgreement`;
every returned acceptor account must equal the source account in that capture.

Required IAM reads:

- `aws-marketplace:SearchAgreements`
- `aws-marketplace:DescribeAgreement`
- `aws-marketplace:GetAgreementTerms`
- `aws-marketplace:GetAgreementEntitlements`
- `aws-marketplace:ListAgreementCharges`

The AWS Marketplace Agreement authorization service does not define resource
ARNs. These actions therefore require `Resource: "*"`. Use the documented
`aws-marketplace:AgreementType=PurchaseAgreement` and
`aws-marketplace:PartyType=Acceptor` condition keys on actions that support
them. `GetAgreementEntitlements` and `ListAgreementCharges` document the
agreement-type key but not the party-type key. Runtime account pinning remains
mandatory because IAM cannot scope these reads to an agreement ARN.

Authoritative references:

- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_marketplace-agreement.html>
- <https://docs.aws.amazon.com/marketplace/latest/developerguide/agreement-apis.html>
- <https://docs.aws.amazon.com/marketplace/latest/APIReference/API_marketplace-agreements_SearchAgreements.html>
- <https://docs.aws.amazon.com/marketplace/latest/APIReference/API_marketplace-agreements_DescribeAgreement.html>
- <https://docs.aws.amazon.com/marketplace/latest/APIReference/API_marketplace-agreements_GetAgreementTerms.html>
- <https://docs.aws.amazon.com/marketplace/latest/APIReference/API_marketplace-agreements_GetAgreementEntitlements.html>
- <https://docs.aws.amazon.com/marketplace/latest/APIReference/API_marketplace-agreements_ListAgreementCharges.html>

### Buyer Discovery product metadata

Agreement resource product IDs are enriched with the buyer-accessible
Marketplace Discovery API:

- `aws-marketplace:GetProduct`

Unlike Agreement reads, this action supports a required Product resource. The
collector statement can use:

`arn:${Partition}:aws-marketplace:::catalog/AWSMarketplace/product/*`

Only product ID/name, seller display/profile ID, `deployedOnAws`, and
fulfillment types cross the broker boundary. Descriptions, promotional media,
support contacts, email addresses, phone numbers, and arbitrary links do not.

Authoritative references:

- <https://docs.aws.amazon.com/marketplace/latest/developerguide/discovery-apis.html>
- <https://docs.aws.amazon.com/marketplace/latest/APIReference/API_marketplace-discovery_GetProduct.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_marketplace-discovery.html>

### Marketplace licenses and grants

Required License Manager reads:

- `license-manager:GetServiceSettings`
- `license-manager:ListReceivedLicenses`
- `license-manager:ListReceivedGrants`
- `license-manager:ListReceivedLicensesForOrganization`
- `license-manager:ListReceivedGrantsForOrganization`

The account calls are the honest fallback when organization integration is not
available. The organization calls are accepted only when `GetServiceSettings`
proves `OrganizationConfiguration.EnableIntegration=true`, the capture uses an
approved management/organization-administrator context, and the active account
set is separately evidenced. All five actions lack resource-level support and
therefore require `Resource: "*"`.

The organization grant API is called once per received license ARN. Empty
pages with a non-null `NextToken` are not terminal; the collector follows the
token until null or a declared bound is reached.

Authoritative references:

- <https://docs.aws.amazon.com/license-manager/latest/APIReference/API_GetServiceSettings.html>
- <https://docs.aws.amazon.com/license-manager/latest/APIReference/API_ListReceivedLicenses.html>
- <https://docs.aws.amazon.com/license-manager/latest/APIReference/API_ListReceivedGrants.html>
- <https://docs.aws.amazon.com/license-manager/latest/APIReference/API_ListReceivedLicensesForOrganization.html>
- <https://docs.aws.amazon.com/license-manager/latest/APIReference/API_ListReceivedGrantsForOrganization.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_license-manager.html>
- <https://docs.aws.amazon.com/license-manager/latest/userguide/manage-granted-licenses.html>

### Organization coverage and spend dependencies

The canonical organization-account source supplies the exact active account
set using these reads, both with `Resource: "*"`:

- `organizations:DescribeOrganization`
- `organizations:ListAccounts`

This slice does not claim that Agreement Service search itself is an
organization aggregator. Organization agreement coverage is `COMPLETE` only
when the account set comes from the canonical AWS Organizations active-account
evidence and every account in that set has a completed acceptor capture. An
operator-approved subset remains `PARTIAL`, and a management account capture
alone remains `SINGLE_ACCOUNT_ONLY`.

Marketplace spend comes only from an already validated, immutable CUR2
generation under the foundational export contract. The predicate, generation,
source-evidence ID, data-through timestamp, reconciliation state, account,
billing period, invoice, product, seller, currency, billed micros, and optional
amortized micros remain explicit. Currencies are never converted or combined.
The Agreement API `estimatedCharges.agreementValue` is labelled known lifecycle
commitment; AWS documents that usage overages are excluded and pure usage
agreements can report zero because future usage is unknown. It is never shown
as realized spend.

- <https://docs.aws.amazon.com/marketplace-agreements/latest/api-reference/API_EstimatedCharges.html>
- <https://docs.aws.amazon.com/cur/latest/userguide/dataexports-table-dictionary.html>

## Buyer versus seller boundaries

The implemented Agreement calls are participant APIs, but this collector uses
them only as the acceptor/buyer. `ListAgreementCharges` is explicitly an
acceptor view. Marketplace Discovery is available to AWS customers and is the
buyer-safe product metadata source.

These similarly named operations are intentionally excluded:

- `aws-marketplace:GetEntitlements` from AWS Marketplace Entitlement Service
  is a seller/product integration used to check the seller's customer
  entitlements; it is not the buyer's organization license inventory.
- `aws-marketplace:ListAgreementInvoiceLineItems` is documented for sellers
  (proposers) to retrieve aggregated agreement billing data.
- Marketplace Catalog mutation/read APIs manage seller catalog entities and
  are not needed for this buyer slice.
- Marketplace Seller Reporting is seller context and is not collected.

Buyer agreement entitlements come from Agreement Service
`GetAgreementEntitlements`; buyer license entitlement quantities and sharing
come from License Manager. The Agreement entitlement's short-lived
`registrationToken` is forbidden from capture.

Authoritative references:

- <https://docs.aws.amazon.com/marketplace/latest/userguide/checking-entitlements.html>
- <https://docs.aws.amazon.com/marketplace/latest/APIReference/API_marketplace-entitlements_GetEntitlements.html>
- <https://docs.aws.amazon.com/marketplace/latest/APIReference/API_marketplace-agreements_ListAgreementInvoiceLineItems.html>
- <https://docs.aws.amazon.com/marketplace/latest/APIReference/API_marketplace-agreements_AgreementEntitlement.html>

AWS Marketplace Reporting `GetBuyerDashboard` does support an organization
management account or registered delegated administrator after Procurement
Insights trusted access is enabled. It returns a one-time, five-minute bearer
embed URL and no source rows, so it is not an ingestion substitute and that URL
must never be stored as evidence.

- <https://docs.aws.amazon.com/marketplace/latest/APIReference/API_marketplace-reporting_GetBuyerDashboard.html>

## Minimized evidence and explicit states

The broker permits only the structured fields represented by
`AwsMarketplaceSpgCapture`. Exact-key validation rejects unrepresented fields.
The capture excludes:

- registration tokens;
- purchase-order references;
- legal document URLs and contents (only document type remains);
- contacts, email addresses, phone numbers, support links, and descriptions;
- License Manager issuer signing keys/fingerprints and arbitrary metadata;
- grant names, principal/parent ARNs, and free-form status reasons;
- raw provider error text.

Agreement IDs, product/offer IDs, license/grant ARNs, beneficiary account IDs,
term summaries, schedule amounts/dates, and invoice IDs remain only because
they provide in-tenant procurement lineage. They must be encrypted at rest,
tenant scoped, audited, and never logged.

The normalized snapshot separately reports:

- agreements: `READY`, `EMPTY`, or `PARTIAL`;
- licenses/grants: `READY`, `EMPTY`, `PARTIAL`, or
  `CONFIGURATION_REQUIRED`;
- CUR2 spend: `READY`, `EMPTY`, `PARTIAL`, or `CONFIGURATION_REQUIRED`;
- organization coverage: `COMPLETE`, `PARTIAL`, or `SINGLE_ACCOUNT_ONLY`;
- overall: `READY`, `EMPTY`, `PARTIAL`, `CONFIGURATION_REQUIRED`, or `STALE`.

Missing data is never replaced with zero, an account capture is never relabelled
as organization coverage, and provider failure text never crosses the broker.
Commercial Agreement/Discovery availability is pinned to `us-east-1`; the
current contract fails closed for `aws-us-gov` and `aws-cn` instead of implying
unsupported parity.

## Production acceptance gates

The pure engine and focused tests are not production acceptance. Remaining
gates are:

1. add the reviewed exact reads/resources/conditions to the permanent
   collector and session ceiling without mutation actions;
2. implement bounded Agreement, Discovery, License Manager, organization, and
   active-CUR2 adapters that emit this exact minimized schema;
3. deploy the implemented immutable-generation repository and source-job
   contract under exact organization/customer/connection scope with encrypted
   contract identifiers;
4. deploy and signed-in verify the implemented authenticated tenant-scoped API
   and native SPG views for spend/deep dive, invoice tracker, licenses/grants,
   agreements, accepted terms, deployment metadata, and expirations;
5. run live buyer tests for single account, complete organization, delegated
   administration, no Marketplace purchases, organization integration absent,
   pagination, mixed currencies, expired/replaced agreements, access denied,
   stale evidence, and cross-tenant rejection.

Until all five pass, Marketplace SPG remains in progress and must not be
reported as production accepted.
