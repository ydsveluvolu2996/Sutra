# Extended Support Projection evidence contract

Status: the normalization/projection engine, immutable READY-only persistence,
durable replay ledger, deterministic daily scheduler, signed collector transport,
strict credential-owning provider boundary, authenticated same-tenant API, and
native dashboard UI are implemented and covered by focused/hostile tests. Shared
runtime/collector registration, pinned default AWS SDK inventory clients, and
the immutable `standard-2026-08.6` fourteen-action customer permission contract
are also implemented. Live AWS and signed-in deployment acceptance remain
explicit release gates; this document does not claim them.

## Trust and cost boundary

`lib/finops-extended-support-projection.ts` is a pure, fail-closed engine. It
does not receive AWS credentials, call AWS, write a database, cache tenant
state, or infer a tenant from request content. The server must provide the
tenant's pinned organization, customer, connection, management account,
allowed account list, partition, and Region list. The capture must repeat that
boundary exactly.

The result intentionally keeps these measures separate:

- `RECONCILED_ACTUAL_EXTENDED_SUPPORT_COST` is accepted only from bounded,
  resource-attributed CUR 2.0 evidence. Observed billable usage is retained
  beside cost rather than inferred from money.
- `PROJECTED_INCREMENTAL_EXTENDED_SUPPORT_COST_IF_UNCHANGED` is the additional
  Extended Support charge implied by an explicit lifecycle calendar, observed
  capacity basis, and effective-dated rate. It excludes normal service cost and
  is not a quote or a savings commitment.
- A missing version key, calendar, enrollment state, capacity basis, complete
  calendar end date, or price interval produces `PARTIAL` or
  `CONFIGURATION_REQUIRED` with `null` cost. It never becomes a zero-cost
  claim.
- Actual and projected amounts are grouped by ISO currency. The engine never
  converts or totals across currencies.

The 3, 6, and 12 calendar-month windows use the latest tenant-pinned
observation for each resource. History is retained only as bounded observation
counts and first/latest timestamps. Exact duplicates collapse deterministically
and conflicting duplicates fail closed.

## Authoritative service evidence

### Amazon EKS

Inventory comes from `ListClusters` and `DescribeCluster`; the latter exposes
the cluster Kubernetes version and `upgradePolicy.supportType`. Calendar rows
come from the paginated `DescribeClusterVersions` API, which exposes
`endOfStandardSupportDate`, `endOfExtendedSupportDate`, and version status:

- [DescribeCluster](https://docs.aws.amazon.com/eks/latest/APIReference/API_DescribeCluster.html)
- [DescribeClusterVersions](https://docs.aws.amazon.com/eks/latest/APIReference/API_DescribeClusterVersions.html)
- [Cluster upgrade policy](https://docs.aws.amazon.com/eks/latest/userguide/view-upgrade-policy.html)
- [EKS pricing](https://aws.amazon.com/eks/pricing/)

The price input is the incremental extended-support portion per cluster-hour,
not the total cluster price. Local EKS clusters on AWS Outposts do not have EKS
extended version support. A collector must preserve that limitation rather
than applying the regional-cluster rate.

### Amazon RDS and Amazon Aurora

RDS DB instances and Aurora DB clusters are separate output services.
Inventory comes from `DescribeDBInstances` and `DescribeDBClusters`, including
the observed engine/version and `EngineLifecycleSupport` setting.
`DescribeDBMajorEngineVersions` is the preferred effective-dated calendar API.
Capacity evidence must prove billable vCPUs, for example with
`DescribeOrderableDBInstanceOptions` plus the observed instance topology.

- [DescribeDBInstances](https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DescribeDBInstances.html)
- [DescribeDBClusters](https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DescribeDBClusters.html)
- [DescribeDBMajorEngineVersions](https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DescribeDBMajorEngineVersions.html)
- [RDS Extended Support charges](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/extended-support-charges.html)
- [Aurora Extended Support](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/extended-support.html)

RDS pricing is Region-, engine-version-, and support-year-specific per
vCPU-hour. Read replicas and standby instances can be chargeable, so a primary
instance's vCPU count alone is not complete evidence. RDS Extended Support is
not offered for every RDS engine/version, and Aurora Serverless v1 is excluded.
The collector must emit an explicit calendar or `NOT_ANNOUNCED`; it must not
generalize a MySQL/PostgreSQL calendar to another engine.

### Amazon OpenSearch Service

`ListDomainNames` plus `DescribeDomain`/`DescribeDomains` provides the exact
domain ARN, engine version, instance type, and instance counts. AWS publishes
support dates in the service guide. Extended Support applies automatically
after standard support ends and is priced per Normalized Instance Hour (NIH).

- [ListDomainNames](https://docs.aws.amazon.com/opensearch-service/latest/APIReference/API_ListDomainNames.html)
- [DescribeDomains](https://docs.aws.amazon.com/opensearch-service/latest/APIReference/API_DescribeDomains.html)
- [OpenSearch version support and NIH factors](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/what-is.html)
- [OpenSearch pricing](https://aws.amazon.com/opensearch-service/pricing/)

Some published rows cover version ranges and some supported versions have no
announced end date. The collector must expand ranges into exact observed
version keys with the captured document hash/effective date. It must emit
`NOT_ANNOUNCED`, not a synthetic future date. NIH must include every
chargeable data/dedicated-master instance and the documented size factor;
ordinary instance-hours are not interchangeable with NIH.

### Amazon ElastiCache

`DescribeCacheClusters` and `DescribeReplicationGroups` provide provisioned
Redis OSS topology and engine versions; `DescribeCacheEngineVersions` supplies
the supported engine catalog. Current Extended Support applies to eligible
provisioned Redis OSS major versions and transitions automatically after
standard support ends.

- [DescribeCacheClusters](https://docs.aws.amazon.com/AmazonElastiCache/latest/APIReference/API_DescribeCacheClusters.html)
- [Extended Support version schedule](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/extended-support-versions.html)
- [Extended Support charges](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/extended-support-charges.html)
- [ElastiCache pricing](https://aws.amazon.com/elasticache/pricing/)

AWS currently describes an 80% on-demand premium in years 1 and 2 and a 160%
premium in year 3, with Region/date-dependent underlying prices. The engine
therefore verifies `baseUnitPrice × premiumPercent` when a
`ON_DEMAND_PREMIUM` rate is supplied. It does not hard-code those percentages
or apply them to serverless, Valkey, Memcached, or an unlisted Redis OSS
version.

## Read-only collection operations

The projection requires these read operations:

```text
eks:ListClusters
eks:DescribeCluster
eks:DescribeClusterVersions
rds:DescribeDBInstances
rds:DescribeDBClusters
rds:DescribeDBMajorEngineVersions
rds:DescribeOrderableDBInstanceOptions
es:ListDomainNames
es:DescribeDomain
es:DescribeDomains
elasticache:DescribeCacheClusters
elasticache:DescribeReplicationGroups
elasticache:DescribeCacheEngineVersions
pricing:GetProducts
```

CUR 2.0 object reads remain limited to the tenant's configured export prefix
under the existing billing ingestion boundary. No create, update, modify, or
delete action is required for this dashboard. If Sutra later offers upgrade
execution, that mutation belongs in the existing separate, short-lived,
approval-controlled action role; it must not be added to the permanent
collector.

## Capture and response bounds

The v1 contract enforces:

- 32 MiB capture and 8 MiB response limits;
- a 15-minute collection window;
- 1,000 authorized accounts and 50 Regions;
- 50,000 observations, 24 observations per resource, and 400 days of history;
- a 48-hour current-inventory threshold; older accepted history is surfaced as
  `STALE` and makes the affected service partial;
- a 31-day authoritative calendar/pricing refresh threshold; stale sources
  keep their audit references but suppress the monetary projection;
- 2,000 calendar entries, 10,000 non-overlapping effective-dated rates, and
  100,000 observed charge records;
- 5,000 resource projections in one response;
- strict object keys, safe codes/text, canonical UTC timestamps, official AWS
  source URLs, SHA-256 evidence identities, resource/account/Region binding,
  and generic client-safe errors.

The service coverage contract distinguishes a complete empty inventory from a
failed or partial collection. A successful zero-resource result is valid only
when every pinned account and Region was covered and the read permissions were
validated. Failed/partial collection is never displayed as zero resources.

## Remaining production gates

The local vertical is complete. Its immutable `.8.6` onboarding successor,
exact STS session intersection, credential-owning collector route, bounded SDK
reader, migrations, daily scheduler, replay ledger, same-tenant API, and native
UI are registered and tested. The remaining gates require a deployed customer
environment rather than additional local implementation:

1. Deploy and independently verify the `.8.6` customer role identity and exact
   inline policies in an approved AWS account.
2. Configure the authoritative supplemental evidence loader with the tenant's
   active reconciled CUR2 generation and reviewed OpenSearch/ElastiCache/rate
   documents. Missing supplements intentionally produce
   `CONFIGURATION_REQUIRED`; the collector never fabricates cost.
3. Deploy and signed-in verify the authenticated same-tenant aggregate route,
   exact-money projection, all honest UI states, and last-good behavior.
4. Run live collection against an approved AWS account, reconcile actual CUR2
   charges, compare effective rates to the AWS bill, verify empty/partial/error
   states, and retain acceptance evidence before production activation.
