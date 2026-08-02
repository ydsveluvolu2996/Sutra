# AWS Health Organizational View source contract

Sutra models AWS Health Organizational View as retained provider evidence, not
as a real-time incident feed. The source covers open, upcoming, and closed
events still available from AWS, plus the affected accounts, affected
entities/resources, per-account details, status, category, service, Region,
start/end time, and last-updated evidence returned by the provider.

## Read-only collection

The credential-owning AWS collector is limited to:

- `health:DescribeEventsForOrganization`
- `health:DescribeAffectedAccountsForOrganization`
- `health:DescribeEventDetailsForOrganization`
- `health:DescribeAffectedEntitiesForOrganization`

The management account can additionally use
`health:DescribeHealthServiceStatusForOrganization` to prove whether
Organizational View is enabled. A registered delegated administrator can
collect organizational events, but its enablement evidence must be verified by
the management account. No enable, disable, registration, notification, or
remediation action belongs to this collector.

The broker request is constructed from server-owned organization, customer,
connection, collector-account, partition, and endpoint configuration. A client
cannot send or override those values. The app never receives AWS credentials,
and the pure normalizer keeps no global tenant cache.

Commercial-partition requests are pinned to `us-east-1`. GovCloud requests are
pinned to the documented `us-gov-west-1` AWS Health API endpoint. Cross-scope,
cross-account, cross-partition, and cross-endpoint captures fail closed.

## Bounded evidence

Collection is bounded to:

- 100 records per paginated API call;
- 10 filters per detail/entity API batch;
- four concurrent calls;
- 15 minutes;
- 20,000 pages;
- 10,000 events;
- 100,000 affected-account rows;
- 200,000 affected-entity rows;
- 48 MiB serialized capture size;
- bounded descriptions and metadata.

Every pagination chain starts without a token, must advance without replay, and
must explicitly say whether it exhausted the provider result. Duplicate event
ARNs and entity identities are accepted only when their normalized content is
identical. Conflicting duplicates fail closed. AWS exception text is never
returned; only bounded generic codes such as `ACCESS_DENIED`, `THROTTLED`, or
`SUBSCRIPTION_REQUIRED` cross the broker boundary.

## Configuration, partial, and freshness semantics

A complete snapshot requires:

1. AWS Organizations all-features mode;
2. Organizational View proven `ENABLED`;
3. a validated qualifying AWS Health API support entitlement;
4. collection from the management account or a registered delegated
   administrator;
5. the four event read permissions validated;
6. initial Organizational View loading proven complete;
7. exhaustive event, account, and entity pagination;
8. a successful detail result for every public event or observed
   event/account pair;
9. service, Region, start time, and last-updated evidence on every event; and
10. no provider filter failures.

`PENDING` enablement or initial loading produces a pending/partial result.
Disabled view or a failed API entitlement produces unavailable evidence.
Unknown prerequisites, bounded pagination, missing summary fields, and generic
provider failures remain partial. A dashboard older than 72 hours is marked
stale.

AWS documents that initial account and historical-event loading can take up to
24 hours and that organizational events are retained for at most 90 days.
Therefore, query completion is not represented as a provider publication
guarantee. An empty complete query means only that the bounded provider read
returned no retained events. Sutra must persist snapshots separately if a
client needs more than the AWS retention window.

Authoritative AWS references:

- <https://docs.aws.amazon.com/health/latest/ug/aggregate-events.html>
- <https://docs.aws.amazon.com/health/latest/ug/enable-organizational-view.html>
- <https://docs.aws.amazon.com/health/latest/ug/delegated-administrator-organizational-view.html>
- <https://docs.aws.amazon.com/health/latest/APIReference/API_DescribeHealthServiceStatusForOrganization.html>
- <https://docs.aws.amazon.com/health/latest/APIReference/API_DescribeEventsForOrganization.html>
- <https://docs.aws.amazon.com/health/latest/APIReference/API_DescribeAffectedAccountsForOrganization.html>
- <https://docs.aws.amazon.com/health/latest/APIReference/API_DescribeEventDetailsForOrganization.html>
- <https://docs.aws.amazon.com/health/latest/APIReference/API_DescribeAffectedEntitiesForOrganization.html>
- <https://docs.aws.amazon.com/health/latest/APIReference/API_OrganizationEvent.html>
- <https://docs.aws.amazon.com/health/latest/APIReference/API_AffectedEntity.html>
- <https://docs.aws.amazon.com/general/latest/gr/awshealth.html>

## Production acceptance gates

The unique ADV-06 provider, runtime, persistence, API and UI components are
locally implemented and tested, but the vertical is not production-accepted
until all of the following are complete:

1. the versioned customer role and its session ceiling grant exactly the four
   event reads (and the management-only status read where applicable);
2. the signed broker route invokes a bounded AWS SDK runner with temporary,
   tenant-scoped credentials;
3. collection attempts and normalized snapshots are persisted under
   organization, customer, connection, account, and partition scope;
4. source readiness reads only that persisted evidence;
5. the professional FinOps operations UI renders the projection and all empty,
   pending, partial, unavailable, and stale states;
6. controlled live tests cover public and account-specific events, affected
   resources, pagination, access denial, subscription denial, initial loading,
   stale snapshots, and adversarial cross-tenant requests.

The shared `.8.8` permission successor, concrete AWS SDK reader, hosted route,
worker/tick registration and migration registries are locally integrated and
tested. Controlled entitled-organization reconciliation, release-time
PostgreSQL migration application, two-tenant acceptance and deployment/live
smoke evidence remain. No customer account or live environment has been changed
by this local implementation.
