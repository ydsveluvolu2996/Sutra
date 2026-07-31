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
2. implement a bounded signed-broker runner that owns temporary AWS
   credentials and emits this capture schema;
3. persist immutable capture generations and collection attempts under exact
   organization/customer/connection scope;
4. expose an authenticated tenant-scoped API and professional dashboard UI,
   keeping AWS and Sutra internal budgets visually separate;
5. run live management-account and delegated-administrator tests for empty,
   populated, multi-currency, planned, history-ineligible, paginated,
   access-denied, stale, unknown-account, and cross-tenant cases.

Until all five gates pass, this capability remains in progress and must not be
reported as production accepted.
