# Trusted Advisor organization Priority evidence contract

## Implemented boundary

`lib/finops-trusted-advisor-organization.ts` normalizes a server-scoped,
read-only capture of the current AWS Trusted Advisor organization recommendation
operations:

- `ListOrganizationRecommendations`
- `GetOrganizationRecommendation`
- `ListOrganizationRecommendationAccounts`
- `ListOrganizationRecommendationResources`

The resulting immutable snapshot supports recommendation, account, and resource
drilldowns, 48-hour freshness reporting, status/lifecycle/pillar/source
breakdowns, and bounded historical snapshots. It also projects compatible
`trusted_advisor_organization` source-health evidence.

The adapter has no AWS credentials, web credentials, network calls, database
access, module-level tenant state, or shared cache. The caller must derive
`orgId`, `customerId`, and `connectionId` from the authenticated server context,
not from request query or body fields.

## Evidence-honest coverage

AWS explicitly documents the four organization recommendation operations as
supporting prioritized recommendations. Therefore, this contract names the
source `organization_priority_recommendations` and always discloses that it is
not evidence of every standard Trusted Advisor check or of a complete legacy
organizational-view report.

AWS also returns an estimated monthly savings number without a currency field
on this recommendation object. Sutra retains that value per recommendation,
sets currency to `null`, and prohibits aggregation. It does not invent a
currency or a cross-recommendation savings total.

Official contracts:

- [List organization recommendations](https://docs.aws.amazon.com/trustedadvisor/latest/APIReference/API_ListOrganizationRecommendations.html)
- [Get an organization recommendation](https://docs.aws.amazon.com/trustedadvisor/latest/APIReference/API_GetOrganizationRecommendation.html)
- [List affected accounts](https://docs.aws.amazon.com/trustedadvisor/latest/APIReference/API_ListOrganizationRecommendationAccounts.html)
- [List affected resources](https://docs.aws.amazon.com/trustedadvisor/latest/APIReference/API_ListOrganizationRecommendationResources.html)
- [Trusted Advisor Public API prerequisites](https://docs.aws.amazon.com/awssupport/latest/user/get-started-with-aws-trusted-advisor-api.html)
- [Trusted Advisor Priority prerequisites](https://docs.aws.amazon.com/awssupport/latest/user/trusted-advisor-priority.html)
- [Trusted Advisor organizational view and standard-check caveats](https://docs.aws.amazon.com/awssupport/latest/user/organizational-view.html)

## Collection acceptance rules

A complete snapshot requires all of the following:

1. Enterprise Support or AWS Unified Operations is proven for Trusted Advisor
   Priority.
2. AWS Organizations all-features mode is proven.
3. Trusted Advisor trusted access is proven.
4. Trusted Advisor Priority is proven enabled.
5. Collection runs from the management account or a registered delegated
   administrator.
6. All four read permissions were authorization-tested.
7. Recommendation, account, and resource pagination is unfiltered, continuous,
   replay-free, and exhausted.
8. Every listed recommendation has an authoritative detail response and
   exhausted account and resource sequences.
9. Observed resource status counts reconcile with AWS resource aggregates.
10. Capture duration, serialized bytes, pages, records, metadata, and response
    sizes remain inside the exported fixed bounds.

A bound-limited but structurally valid page sequence is retained as partial
evidence. Invalid tokens, filtered calls, foreign recommendation references,
conflicting duplicates, malformed records, and over-limit captures fail closed
with generic errors.

## Remaining production gates

This pure adapter and query engine do not make the Advanced CID capability
production-accepted. Remaining work is:

- add the four read actions to an attested customer collector role that is
  allowed by the active onboarding role ceiling;
- implement a durable, retrying collector job that measures the raw response
  byte count and records every page request/response token;
- persist immutable snapshots and tenant-keyed history;
- create an authenticated route that derives scope solely from the session and
  tenant repository;
- wire the professional dashboard view and empty/partial/stale states;
- validate a live management or delegated-administrator account with eligible
  support, Trusted Advisor trusted access, and Priority enabled;
- separately implement standard-check organization coverage using an
  authoritative organizational-view report or bounded per-account standard
  recommendation collection. Priority evidence must not satisfy that broader
  gate.

No AWS resource, role, customer account, or production deployment is changed by
this slice.
