# AWS Budgets organization source contract

This slice imports AWS Budgets as an authoritative, read-only AWS source and
projects each budget through separately evidenced AWS Organizations hierarchy
and Sutra's canonical tenant taxonomy. It does not replace or merge Sutra's
internal budgets. The two sources must remain visibly distinct in storage,
APIs, and the UI.

## Evidence captured

The normalized contract preserves:

- budget type, time unit, effective start/end, fixed and planned limits;
- cost filters, cost-type flags, metrics, and provider last-updated time;
- provider-calculated actual and forecast spend without substituting zero;
- daily, monthly, or quarterly performance history when AWS supports it;
- actual/forecast notification thresholds and comparison metadata;
- subscriber type and count while excluding email addresses and SNS ARNs;
- action type, threshold, approval model, status, role presence, and target
  count, while excluding role ARNs, policy content, and provider error text.
- only the `cid:budget-level` AWS Budget tag used by the official dashboard
  hierarchy; other provider tags do not cross this minimized boundary.

Money is normalized to exact signed integer micro-units. Units are retained;
only three-letter ISO-style units are identified as currencies, and currencies
are never converted or combined. Missing forecast, actual, access, history,
hierarchy, or taxonomy evidence yields `partial`, `configuration_required`, or
`unavailable`, never a fabricated zero.

AWS documents that budget status is refreshed several times per day. The
dashboard therefore reports the provider update timestamp and a freshness SLA;
capture time is not silently presented as provider data freshness.

## Bounded collection

The broker contract permits only these AWS Budgets API calls:

- `DescribeBudgets`
- `DescribeBudgetPerformanceHistory`
- `DescribeNotificationsForBudget`
- `DescribeSubscribersForNotification`
- `DescribeBudgetActionsForBudget`
- `ListTagsForResource` (the adapter retains only `cid:budget-level`)

The current AWS service-authorization mapping requires these read permissions:

- `aws-portal:ViewBilling`
- `budgets:ViewBudget`
- `budgets:DescribeBudgetActionsForBudget`

AWS lists `billing:GetBillingViewData` as a dependent action for
`budgets:ViewBudget`. Budget resources should be restricted to the connected
account's `arn:${Partition}:budgets::${Account}:budget/*` wherever AWS supports
resource scoping; account IDs in every API page remain pinned to the registered
connection.

No create, update, delete, execute, tag, policy, or pass-role permission belongs
in the permanent collector. Executing or changing a Budget Action remains a
separate short-lived, owner-approved action role.

Authoritative references:

- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_budgets.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_budgets_DescribeBudgets.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_budgets_DescribeBudgetPerformanceHistory.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_budgets_DescribeNotificationsForBudget.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_budgets_DescribeSubscribersForNotification.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_budgets_DescribeBudgetActionsForBudget.html>

Every operation has explicit page, record, token, capture-size, and response
bounds. Replayed pagination tokens, wrong-account page requests, conflicting
duplicates, oversized text, subscriber contact fields, or malformed timestamps
are rejected with generic error messages.

## Organization and business projection

AWS Organizations hierarchy is a separate dependency with these read calls:

- `organizations:DescribeOrganization`
- `organizations:ListAccounts`
- `organizations:ListRoots`
- `organizations:ListOrganizationalUnitsForParent`
- `organizations:ListParents`

`organizations:ListTagsForResource` is optional and should be granted only if
the customer explicitly chooses AWS Organizations tags as taxonomy input. It is
not required when the canonical taxonomy comes from an operator map or CMDB.

The projection maps a `LinkedAccount` cost filter to exact accounts. A budget
without that filter is organization-wide only when hierarchy evidence is
available. Unknown linked accounts, missing OU evidence, and missing business
assignments remain explicit coverage gaps. Canonical company, business unit,
environment, cost center, and owner values come only from the pinned taxonomy
snapshot for the same organization, customer, and connection.

Dashboard grouping uses the exact provider-side `cid:budget-level` tag. A
missing or inaccessible tag is a hierarchy coverage gap, never a hierarchy
inferred from the budget name. Budgeted, AWS-calculated actual, and
AWS-forecasted values remain distinct in every projection and currency.

The Data Collection prerequisites are both AWS Budgets and AWS Organizations:
the connected payer/member account supplies budget definitions and calculated
spend, while the management account or authorized delegated administrator
supplies the complete account/OU set. The active Sutra taxonomy is an optional
business-ownership enrichment. None of these sources is equivalent to the
Sutra-authored budgets stored in `finops_budgets`.

AWS requires callers to follow `NextToken` until it is null even when a page is
empty, so the collector cannot treat an empty page as completion.

Authoritative references:

- <https://docs.aws.amazon.com/organizations/latest/APIReference/API_ListAccounts.html>
- <https://docs.aws.amazon.com/organizations/latest/APIReference/API_ListRoots.html>
- <https://docs.aws.amazon.com/organizations/latest/APIReference/API_ListOrganizationalUnitsForParent.html>
- <https://docs.aws.amazon.com/organizations/latest/APIReference/API_ListParents.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_awsorganizations.html>

## Production acceptance gates

The pure engine and focused contracts are not production acceptance. Remaining
gates are:

1. add the exact missing read actions to the reviewed collector role and its
   session ceiling without adding mutation authority;
2. provision the deployed signed-broker keys/origin and execute the registered
   durable scheduler/handler against the implemented credential-owning adapter;
3. run live management-account and delegated-administrator tests for empty,
   populated, multi-currency, planned, history-ineligible, paginated,
   access-denied, stale, unknown-account, and cross-tenant cases.

Immutable persistence, accepted-head promotion, shared scheduling/handling,
the bounded provider adapter and exact signed route, authenticated API, native
UI, and explicit AWS/Sutra source separation now exist locally. Until the
remaining provider gates pass, this capability must not be reported as
production accepted.
