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

The authenticated refresh endpoint accepts only a connection ID. The server
owns source `cost_anomaly_detection` and contract
`cost-anomaly-primary-v1`, requires the attested `standard-2026-08.1`
permission pack and `sync:run`, and enqueues the existing durable
`finops-source-collect` worker. Account, partition, Region, source, contract,
AWS operations, role and endpoints never come from the browser.

Collection has explicit lookback, page, record, per-command, overall-time, text,
and serialized-output limits. Pagination token loops and malformed tokens are
reported as partial coverage. Provider exception text is mapped to generic
codes. Subscription email addresses and SNS ARNs, raw monitor expressions, and
raw threshold expressions are not returned.

## Durable materialization and dashboard

Accepted broker results are written as immutable
`sutra.finops-source-evidence.v2` evidence. The projection retains bounded,
provider-neutral per-operation coverage required to distinguish complete and
partial collection, while caller-defined monitor/subscription names, anomaly
dimension labels, linked-account names, contacts, raw expressions and provider
exception text remain redacted. Only complete, fully reconciled, zero-rejection
generations advance the active head.

The dynamic `GET /api/v1/finops/cost-anomaly` route:

- derives organization from the authenticated session and customer/account
  from the exact active AWS connection;
- authenticates the sealed evidence reference against organization, customer,
  connection, source and generation;
- independently rebinds the private object to the same scope, snapshot, SHA-256,
  artifact kind, availability and retention window;
- revalidates the persisted account, partition, schema, aggregate counts and
  all three operation-level coverage records;
- uses `buildCostAnomalyDashboard` with real persisted AWS findings and the
  existing Sutra statistical engine over at most three billing periods and
  50,000 normalized lines;
- derives a bounded `sutra.aws-cost-anomaly-analysis.v1` view over the accepted
  provider records: null-aware monthly total/actual/expected values, open and
  ended windows, assessment counts, ranked provider contribution across
  service/account/Region/usage-type dimensions, monitor method/dimension
  coverage and subscription frequency/channel counts; and
- returns explicit `waiting`, `complete`, `partial`, `stale` or `failed` state. A
  failed refresh never replaces an accepted complete generation.

The Budgets & anomalies workspace presents AWS provider findings and Sutra
statistical signals in separate labelled cards. No-finding and no-billing-data
states remain distinct; neither is rendered as proof of correct or optimized
spend. All provider filters cascade over accepted findings and every accepted
root cause. The UI supports anomaly ID, current score, total impact, service,
linked account, Region, usage type, assessment, monitor type, overlapping date
window and derived window-state controls, plus deterministic sorting and safe
CSV.

## Evidence semantics

- AWS evaluates net unblended cost approximately three times each day.
- AWS Marketplace third-party products are not monitored by Cost Anomaly
  Detection and are never claimed as covered.
- `TotalImpactPercentage` may be absent when expected spend is zero. Sutra
  preserves this as `null`; it does not invent a percentage.
- `MaxImpact` is retained as a separate provider field and is never substituted
  for absent `TotalImpact`. Monthly actual, expected and total-impact aggregates
  disclose observed and unavailable finding counts.
- `GetAnomalies` can return anomalies that are below every subscription
  notification threshold. A subscription threshold is not used as a finding
  filter.
- Root-cause evidence is limited to service, linked-account ID, Region, usage
  type and contribution. Provider account names remain redacted. Contribution
  is ranked only when AWS returned it; whole-anomaly impact is not assigned to a
  missing root-cause contribution.
- Source freshness uses the latest returned monitor evaluation timestamp. The
  broker response time is not substituted for provider data freshness.

Authoritative AWS references:

- <https://docs.aws.amazon.com/cost-management/latest/userguide/manage-ad.html>
- <https://docs.aws.amazon.com/cost-management/latest/userguide/getting-started-ad.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetAnomalies.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetAnomalyMonitors.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetAnomalySubscriptions.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_Anomaly.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_RootCause.html>
- <https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_AnomalySubscription.html>

## Production acceptance prerequisites

The reviewed customer permission pack, exact session ceiling, signed broker,
tenant-scoped temporary-role lookup, durable worker and dashboard path are
implemented and covered by local contract/adversarial tests. Production
acceptance still requires a controlled live AWS run proving monitor,
subscription, anomaly, root-cause, pagination, access-denied, freshness and
cross-tenant behavior with an approved customer account.

No monitor is created or modified by this read-only source. Provisioning and
acknowledgement actions remain separate approval-controlled capabilities.
