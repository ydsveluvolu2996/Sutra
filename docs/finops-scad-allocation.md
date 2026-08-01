# AWS SCAD container allocation source

## Acceptance boundary

`lib/finops-scad-allocation.ts` is a pure projection over one immutable, active
CUR 2.0 generation. It does not call AWS, own credentials, update Cost
Management preferences, create an export, or persist rows. The credential-owning
collector must pin the Sutra organization, customer, connection, payer accounts,
usage accounts, Regions, S3 bucket, and exact export prefix before invoking it.
Any cross-tenant account or Region causes the whole capture to fail closed; rows
are never silently filtered into another customer's result.

The source is accepted as complete only when:

- `COST_AND_USAGE_REPORT` is hourly, includes resource IDs, and has
  `INCLUDE_SPLIT_COST_ALLOCATION_DATA=TRUE`;
- all 11 current `split_line_item_*` CUR 2.0 columns plus the required identity,
  account, interval, unit, Region, resource ID, currency, and `resource_tags`
  columns are present;
- the runtime S3 permissions were explicitly validated;
- every expected manifest object was processed, no object failed, and the row
  stream was exhausted; and
- the immutable manifest, object SHA-256 values, source row numbers, and unique
  line-item IDs remain traceable.

AWS documents the current CUR 2.0 split column group and its types in the
[CUR 2.0 split line item dictionary](https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-cur2-split-line-item.html).
The engine pins the complete group:

1. `split_line_item_actual_usage`
2. `split_line_item_net_split_cost`
3. `split_line_item_net_unused_cost`
4. `split_line_item_parent_resource_id`
5. `split_line_item_public_on_demand_split_cost`
6. `split_line_item_public_on_demand_unused_cost`
7. `split_line_item_reserved_usage`
8. `split_line_item_split_cost`
9. `split_line_item_split_usage`
10. `split_line_item_split_usage_ratio`
11. `split_line_item_unused_cost`

## Exact allocation semantics

Every AWS decimal is supplied as its original decimal string and converted to a
reduced bigint rational. Sums and comparisons do not use JavaScript floating
point. Output values contain exact numerator and denominator strings.

- Requested utilization is `split_line_item_reserved_usage`.
- Actual utilization is `split_line_item_actual_usage`.
- Allocated utilization is `split_line_item_split_usage`. When requested and
  actual values both exist, the engine requires the AWS rule that split usage is
  their maximum. A request-only row must equal requested usage.
- `actualAboveRequest` and `requestedHeadroom` are calculated separately and
  only when both input planes exist. A missing actual value remains `null`, never
  zero.
- Allocated amortized cost is `split_line_item_split_cost`.
- Attributed unused amortized cost is `split_line_item_unused_cost` and is shown
  separately. AWS proportionately attributes that unused parent capacity to the
  pod/task; Sutra does not relabel it as workload consumption.
- Net and public On-Demand measures are complete only when every contributing
  row carries the corresponding conditional columns. Partial sums are not shown
  as totals.
- Currency is a grouping key and is never converted or combined across
  currencies.

`unallocatedAmortizedCost` has a deliberately narrower meaning: it is the
allocated plus unused SCAD cost on rows whose documented business lineage is
missing. It is not a claim about unobserved EC2 parent capacity.

## Lineage contract

The hierarchy is derived only from documented CUR 2.0 fields and AWS-generated
cost allocation tags:

- payer and usage account from the CUR line;
- EKS cluster, namespace, node, workload type/name, and deployment from
  `aws_eks_*` keys in the `resource_tags` map;
- ECS cluster and service from `aws_ecs_cluster_name` and
  `aws_ecs_service_name`; and
- pod or ECS task from `line_item_resource_id`.

AWS documents those EKS and ECS tag keys in the
[SCAD prerequisites](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/scad-containers-dashboard-prerequisites.html).
Base SCAD publishes pod/task line items, not a container identifier. Therefore
the output includes the container level explicitly as `null` with
`NOT_PUBLISHED_BY_CUR2_SCAD`; it never fabricates container lineage. The AWS CID
comparison likewise identifies pod as the lowest SCAD construct in its
[containers dashboard FAQ](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/faq.html).

## Delivery, correction, and history states

Readiness and delivery lifecycle are separate so operators cannot confuse an
empty, new, incomplete, or corrected source:

- readiness: `CONFIGURATION_REQUIRED`, `WAITING_FIRST_DELIVERY`, `READY`,
  `PARTIAL`, `STALE`, or `NO_USAGE`;
- delivery: `WAITING_FIRST_DELIVERY`, `FIRST_DELIVERY`, `REGULAR_DELIVERY`, or
  `CORRECTED_DELIVERY`; and
- history: `NO_BACKFILL_BEFORE_ENABLEMENT` or
  `PARTIAL_SINCE_ENABLEMENT`.

Corrections always declare `REPLACE_BILLING_PERIOD_ATOMICALLY`; appending a
refreshed period would double count. AWS says delivery can take at least 24
hours after opt-in and SCAD prepares current-month data rather than backfilling
earlier periods. The CID prerequisites are more explicit that SCAD fields are
not populated by a CUR backfill. See [enabling SCAD](https://docs.aws.amazon.com/cur/latest/userguide/enabling-split-cost-allocation-data.html)
and the [CID SCAD prerequisites](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/scad-containers-dashboard-prerequisites.html).

A complete correction can be `STALE` when it is collected or replayed after the
48-hour freshness window. Freshness does not make immutable source evidence
incomplete: that correction can atomically replace an older complete period,
while the UI still reports the period as stale and a corrected delivery.

## Runtime activation boundary

`lib/finops-scad-cur2-runtime-adapter.ts` defines the production-facing boundary
without pretending a provider is already active. Its input is a server-resolved
tenant, export ARN, bucket/prefix and billing period. The provider can be backed
by the AWS S3 SDK or Sutra's signed object broker, but browser input cannot
select any of those values.

The adapter verifies that the CUR2 generation equals the manifest SHA-256,
enumerates the exact manifest objects, and pins key, ETag, version ID, SHA-256
and byte size on every row read. Pagination tokens must be well formed, cannot
repeat, are never stored, and are discarded after use. A duplicate generation
is returned before data-object reads. Rows are accepted only after every page
of their immutable object is exhausted; a failed object contributes no rows and
the capture stays `PARTIAL`.

Collection is bounded to 20,000 objects, 750,000 rows, 25,000 attempted
requests, three attempts per request and 30 minutes. Stable failure codes cross
the boundary; raw provider messages and credentials do not. The independent
daily runtime binding uses tenant/window idempotency, a 31-minute durable lease,
content-hashed completion receipts and immutable repository verification. It is
deliberately exported with `registeredInSharedRuntime: false` until production
bindings and live evidence are approved.

## Permission design

### Permanent runtime collector

The runtime role remains read-only and S3-only:

| Action | Required resource scope |
| --- | --- |
| `s3:GetBucketLocation` | exact customer export bucket ARN |
| `s3:ListBucket` | exact bucket ARN, restricted with `s3:prefix` to the tenant's export prefix |
| `s3:GetObject` | exact `bucket/prefix/*` object ARN |
| `s3:GetObjectAttributes` | exact `bucket/prefix/*` object ARN, for immutable size/ETag/checksum evidence before activation |

The role has no `ce:*`, `bcm-data-exports:*`, `cur:*`, `iam:*`, S3 write, or
wildcard-provider permission. Existing platform controls must also require TLS
and pin the AWS account/role trust boundary.

### Separate one-time provisioner

The one-time, independently approved provisioner uses only these capability
actions:

| Action | Why / constraint |
| --- | --- |
| `ce:UpdatePreferences` | opt in to SCAD in Cost Management preferences; payer/regular account only |
| `ce:UpdateCostAllocationTagsStatus` | activate any required AWS-generated EKS/ECS/Batch cost allocation tags that are not already active |
| `iam:CreateServiceLinkedRole` | conditional: only if opt-in must create `AWSServiceRoleForSplitCostAllocationData`; constrain `iam:AWSServiceName` to `split-cost-allocation-data.bcm.amazonaws.com` and the exact service-linked-role ARN |
| `bcm-data-exports:CreateExport` | create a new CUR 2.0 export with hourly/resource/SCAD configuration; scope to `COST_AND_USAGE_REPORT`, the intended export ARN pattern, and approved billing view |
| `cur:PutReportDefinition` | AWS-documented dependent permission for creating a CUR 2.0 `COST_AND_USAGE_REPORT` Data Export; this action requires `Resource: "*"` |

CUR 2.0 does not support toggling SCAD on an existing export; provision a new
versioned export instead. AWS documents both that limitation and the initial
delivery delay in the [CID prerequisites](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/scad-containers-dashboard-prerequisites.html).
AWS also documents `cur:PutReportDefinition` as a dependent permission for CUR
2.0 export creation in [Data Exports IAM](https://docs.aws.amazon.com/cur/latest/userguide/bcm-data-exports-access.html).
The service-linked role behavior and condition target are described in
[service-linked roles for SCAD](https://docs.aws.amazon.com/cost-management/latest/userguide/split-cost-allocation-data-SLR.html).

The destination bucket, encryption key, bucket policy, and delivery service
access are pre-provisioned infrastructure prerequisites and are not granted to
the permanent collector. Enabling all AWS Organizations features, and enabling
Amazon Managed Service for Prometheus or CloudWatch Container Insights when
actual EKS utilization is desired, remain explicit owner-controlled setup steps;
their broad infrastructure permissions are not smuggled into either runtime
role.

## Non-claims

- This is not a container-level telemetry source; SCAD's lowest base construct
  is pod/task.
- This is not an invoice reconciliation, quote, forecast, or savings claim.
- `split_cost` is the AWS amortized allocation; conditional net cost is not
  inferred from it.
- Resource-request mode does not prove actual utilization.
- No pre-enable period is represented as covered, and no absent row is inferred
  to be zero usage.
- The pure engine does not create an AWS role, an export, or a production
  deployment. The local API, UI, repository, adapter and unregistered runtime
  binding do not constitute live AWS activation.
