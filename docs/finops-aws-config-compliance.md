# AWS Config organization compliance source contract

This slice defines Sutra's bounded, tenant-pinned AWS Config compliance and
cost-contributor contract. It combines four evidence planes without blurring
their meanings:

- the AWS Config organization aggregator for replicated current compliance,
  conformance-pack summaries, resource counts, and minimized inventory;
- account/Region rule and recorder reads for rule lifecycle and proof that AWS
  Config is actually recording in every intended account and Region;
- optional exact-prefix AWS Config S3 delivery evidence for historical
  configuration-item and rule-evaluation activity; and
- the active, reconciled CUR 2.0 generation for actual AWS Config spend.

The engine performs no AWS, network, persistence, route, or UI work. It accepts
only a bounded capture for a server-owned organization/customer/connection,
normalizes it, and reports explicit ready, empty, partial, stale, failed, and
configuration-required states.

AWS describes an aggregator as a read-only replicated view across accounts and
Regions. It does not grant mutation access to source accounts. The AWS Cloud
Intelligence Config dashboard calls for rule and conformance-pack compliance,
account/Region/resource drilldowns, resource inventory, configuration history,
and cost-contributor activity:

- <https://docs.aws.amazon.com/config/latest/developerguide/aggregate-data.html>
- <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/config-resource-compliance-dashboard.html>

## Exact permanent collector reads

### Central aggregator account and Region

The aggregator capture uses exactly:

- `config:DescribeConfigurationAggregators`
- `config:DescribeConfigurationAggregatorSourcesStatus`
- `config:DescribeAggregateComplianceByConfigRules`
- `config:GetAggregateComplianceDetailsByConfigRule`
- `config:DescribeAggregateComplianceByConformancePacks`
- `config:GetAggregateDiscoveredResourceCounts`
- `config:SelectAggregateResourceConfig`

Except for `DescribeConfigurationAggregators`, AWS's service-authorization
table supports the required `ConfigurationAggregator` resource. Use the exact
registered aggregator ARN when it is known:

`arn:${Partition}:config:${AggregatorRegion}:${AggregatorAccount}:config-aggregator/${AggregatorId}`

`DescribeConfigurationAggregators` does not support resource-level
authorization and therefore requires `Resource: "*"`. Runtime scope still
requires the configured aggregator name and returned ARN/partition/Region/
account/ID to match the server-owned connection exactly.

The advanced query is fixed to this projection:

```text
SELECT accountId, awsRegion, resourceType, resourceId, configurationItemCaptureTime, resourceCreationTime, configurationItemStatus
```

Client-supplied queries are forbidden. Raw configuration JSON, tags, and
relationships are outside this contract. `ListAggregateDiscoveredResources`
is not required because resource counts and the fixed inventory projection use
the two APIs above.

AWS explicitly notes that compliance-detail pagination can return an empty
page with a non-null token. The adapter must follow every token until null or a
declared bound is reached. A provider-capped contributor count keeps coverage
partial; it never becomes an exact resource total.

Authoritative references:

- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_config.html>
- <https://docs.aws.amazon.com/config/latest/APIReference/API_DescribeConfigurationAggregators.html>
- <https://docs.aws.amazon.com/config/latest/APIReference/API_DescribeConfigurationAggregatorSourcesStatus.html>
- <https://docs.aws.amazon.com/config/latest/APIReference/API_DescribeAggregateComplianceByConfigRules.html>
- <https://docs.aws.amazon.com/config/latest/APIReference/API_GetAggregateComplianceDetailsByConfigRule.html>
- <https://docs.aws.amazon.com/config/latest/APIReference/API_DescribeAggregateComplianceByConformancePacks.html>
- <https://docs.aws.amazon.com/config/latest/APIReference/API_GetAggregateDiscoveredResourceCounts.html>
- <https://docs.aws.amazon.com/config/latest/APIReference/API_SelectAggregateResourceConfig.html>

### Account/Region recorder and rule lifecycle

An organization source-status row is Region-scoped and identifies the
organization, not every member account. Sutra therefore does not claim account
coverage merely because the organization source says `SUCCEEDED`. For every
expected active-account/Region pair, the collector assumes the approved
account role and uses:

- `config:DescribeConfigurationRecorders`
- `config:DescribeConfigurationRecorderStatus`
- `config:DescribeConfigRules`
- `config:DescribeConfigRuleEvaluationStatus`

The two recorder reads support the `ConfigurationRecorder` resource and should
use the account/Region recorder ARN pattern:

`arn:${Partition}:config:${Region}:${Account}:configuration-recorder/*/*`

The two rule discovery/status operations do not support resource-level
authorization and require `Resource: "*"` inside the already tenant-pinned,
account-specific assumed-role session. These calls are reads only. No rule,
recorder, evaluation, remediation, or conformance-pack mutation is allowed.

Complete recorder coverage requires a running customer-managed recorder with
no failed last status and an all-supported-resource recording strategy. A
service-linked recorder alone is retained but does not prove full account
coverage. Rule lifecycle retains active/evaluating/deleting states, activation
and success/failure timestamps, generic error codes, evaluation modes, trigger
types, frequency, and resource-type scope. It deliberately stores SHA-256
digests instead of raw Lambda ARNs, custom-policy bodies, input parameters, or
service principals.

Rule definitions that have the same owner, source-identifier digest, scope
fingerprint, modes, and triggers are surfaced as potential duplicate
deployments. That is an evidence-backed redundancy signal, not a deletion
recommendation.

### Organization coverage

The expected active account set is supplied by Sutra's canonical organization
source using:

- `organizations:DescribeOrganization`
- `organizations:ListAccounts`

Both require `Resource: "*"`. The expected Region set is explicit server-owned
policy; it is never inferred from Regions that happen to return data. Complete
coverage requires all of the following for every expected account/Region pair:

1. the aggregator source is synchronized for the Region/account source;
2. the customer-managed recorder is running with all-supported coverage;
3. both rule definition and evaluation-status reads completed; and
4. every required paginator exhausted its provider result.

Missing pairs remain visible as partial coverage. An empty, exhaustive account
is displayed as empty, never as compliant merely because nothing was returned.

### Historical activity objects

The current aggregator API is not a complete billable evaluation ledger. When
the customer enables the AWS Config S3 delivery input, the collector uses only:

- `s3:GetBucketLocation`
- `s3:ListBucket`
- `s3:GetObject`
- `s3:GetObjectAttributes`

The bucket is exact and `ListBucket` is restricted with `s3:prefix` to the
tenant-approved Config delivery prefix; object reads use only
`arn:${Partition}:s3:::${Bucket}/${Prefix}*`. The normalized broker payload
contains day/account/Region/rule counts, a non-secret evidence ID, and an
object SHA-256. Bucket names and raw object keys do not cross the broker.

These records support historical configuration-item-change and rule-evaluation
activity views. They are cost drivers, not AWS invoice amounts and not an exact
per-rule allocation of charges.

### Actual AWS Config cost

Actual spend comes only from the already validated active CUR2 generation with
the explicit `CUR2_PRODUCT_CODE_AWSCONFIG` predicate. Each retained row keeps
the billing period, linked account, Region, usage type, operation, currency,
and billed/amortized integer micros. `BigInt` arithmetic groups signed values
exactly and currencies are never combined or converted.

AWS's own Config dashboard documentation says Config cost is complex and that
its cost-contributor view reports rule evaluations and configuration-item
changes rather than calculating precise per-rule cost. Sutra follows that
boundary: CUR2 supplies reconciled actual AWS Config totals, while activity
counts remain separately labelled drivers. Current aggregate compliance
details are never relabelled as billed rule evaluations.

## Privacy and tenant isolation

The broker schema uses exact-key validation. Unknown fields fail closed, which
prevents raw provider messages, annotations, configuration JSON, tags, policy
bodies, Lambda ARNs, source input parameters, and S3 paths from being accepted
accidentally. Resource IDs and rule names remain because they provide the
in-tenant remediation lineage clients require; they must be encrypted at rest,
audited, and queried only under exact organization/customer/connection scope.

Every account, Region, organization ID, aggregator ARN, rule ARN, resource,
activity row, and cost row is validated against the server-owned scope. The
query service sends no credentials and accepts no client override of account,
Region, aggregator, operation list, inventory query, or collection bound.

## State semantics

The snapshot reports four channels independently:

- aggregator compliance: `READY`, `EMPTY`, `PARTIAL`, `FAILED`,
  `CONFIGURATION_REQUIRED`, or `STALE`;
- rule lifecycle: the same six states;
- configuration activity: `READY`, `EMPTY`, `PARTIAL`,
  `CONFIGURATION_REQUIRED`, or `STALE`; and
- actual cost: `READY`, `EMPTY`, `PARTIAL`, `CONFIGURATION_REQUIRED`, or
  `STALE`.

Overall `READY` requires all required channels to be ready/empty with complete
account/Region coverage. Missing optional activity or CUR2 sources makes the
full enterprise view partial because those requested views are not available.
Stale evidence never becomes current, capped counts never become exact, and a
provider failure never becomes an empty success.

## Production acceptance gates

The pure engine and focused tests do not constitute production acceptance.
Remaining gates are:

1. wire the exact operations, resources, S3 prefix conditions, and account
   fan-out into the permanent read-only collector/session ceiling;
2. configure or identify the organization aggregator and Config delivery
   prefix, and prove every intended recorder/account/Region;
3. implement bounded adapters that emit this exact minimized schema and follow
   empty-page pagination tokens;
4. persist immutable generations and job attempts under exact tenant scope;
5. expose authenticated APIs and professional compliance, lifecycle,
   coverage, inventory, activity, and cost views; and
6. run live tests for complete/partial organizations, disabled/limited/service-
   linked recorders, no rules, rules without results, capped counts,
   insufficient-data packs, duplicate rules, mixed currencies, stale data,
   access denial, pagination, and cross-tenant rejection.

Until those gates pass, Config compliance remains in progress and must not be
reported as production accepted.
