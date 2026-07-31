# AWS Cost Anomaly Detection source contract

Sutra treats AWS Cost Anomaly Detection and Sutra statistical billing signals
as two independent sources. An AWS finding is never synthesized from a Sutra
heuristic, and the absence of a finding in either source is not presented as
proof that spend is correct.

## Read-only collection

The credential-owning AWS collector normalizes these APIs:

- `ce:GetAnomalies`
- `ce:GetAnomalyMonitors`
- `ce:GetAnomalySubscriptions`

The app/control plane receives the result only through the authenticated,
signed broker transport. It never receives AWS credentials. The query contract
pins the organization and connection when the service is constructed; an API
consumer cannot supply or override a tenant identifier.

Collection has explicit lookback, page, record, per-command, overall-time, text,
and serialized-output limits. Pagination token loops and malformed tokens are
reported as partial coverage. Provider exception text is mapped to generic
codes. Subscription email addresses and SNS ARNs, raw monitor expressions, and
raw threshold expressions are not returned.

## Evidence semantics

- AWS evaluates net unblended cost approximately three times each day.
- AWS Marketplace third-party products are not monitored by Cost Anomaly
  Detection and are never claimed as covered.
- `TotalImpactPercentage` may be absent when expected spend is zero. Sutra
  preserves this as `null`; it does not invent a percentage.
- `GetAnomalies` can return anomalies that are below every subscription
  notification threshold. A subscription threshold is not used as a finding
  filter.
- Root-cause evidence is limited to the provider fields for service, linked
  account, linked-account name, Region, usage type, and contribution.
- Source freshness uses the latest returned monitor evaluation timestamp. The
  broker response time is not substituted for provider data freshness.

Authoritative AWS references:

- <https://docs.aws.amazon.com/cost-management/latest/userguide/manage-ad.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetAnomalies.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetAnomalyMonitors.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetAnomalySubscriptions.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_Anomaly.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_RootCause.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_AnomalySubscription.html>

## Production acceptance prerequisites

This source is not production-accepted until all of the following are true:

1. the reviewed customer collector role and its session ceiling allow exactly
   the three read operations above;
2. a signed broker route invokes the bounded runner using temporary credentials
   obtained from the tenant-scoped role registry;
3. normalized evidence and collection attempts are persisted under
   organization, customer, and connection scope;
4. source readiness reads only that persisted tenant-scoped evidence;
5. controlled live AWS tests prove monitor, subscription, anomaly, root-cause,
   pagination, access-denied, freshness, and cross-tenant behavior.

No monitor is created or modified by this read-only source. Provisioning and
acknowledgement actions remain separate approval-controlled capabilities.
