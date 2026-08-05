# Sutra Media Services Insights source contract

This v1 slice provides an evidence-honest source and projection contract for
AWS Elemental MediaConnect, MediaConvert, MediaLive, MediaPackage v1 and v2,
and MediaTailor. It combines two independently retained evidence classes:

1. bounded read-only regional inventory and recent activity normalized from
   the AWS service APIs; and
2. media-only cost and usage rows from one immutable, active CUR 2.0 billing
   generation.

This follows the AWS Media Services Insights Hub's use of CUR for service cost
and usage analysis, while adding exact resource inventory lineage. Inventory
and billing are joined only when CUR contains the exact observed resource ARN.
Rows without an ARN, rows for deleted resources, and rows whose resources were
not observed in the bounded capture remain service-level unattributed spend.
Sutra never spreads those rows across resources.

The dashboard projection retains the selected CUR cost basis and currency,
signed cost and usage-quantity micros, operation, usage type, and unit.
Usage is aggregated only within an identical service/operation/usage-type/unit
tuple. Hours, bytes, requests, outputs, normalized minutes, and other unlike
units are never summed. A negative total may represent a captured credit or
refund; it is not rewritten to zero.

Authoritative AWS references:

- <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/media-services-insights.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_mediaconnect.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_mediaconvert.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_medialive.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_awselementalmediapackage.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_mediapackagev2.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_mediatailor.html>

## Exact read-only collector operations

MediaConnect:

- `mediaconnect:ListFlows`
- `mediaconnect:DescribeFlow`
- `mediaconnect:ListTagsForResource`

MediaConvert:

- `mediaconvert:DescribeEndpoints`
- `mediaconvert:ListQueues`
- `mediaconvert:GetQueue`
- `mediaconvert:ListJobs`
- `mediaconvert:GetJob`
- `mediaconvert:ListTagsForResource`

MediaLive:

- `medialive:ListChannels`
- `medialive:DescribeChannel`
- `medialive:ListMultiplexes`
- `medialive:DescribeMultiplex`
- `medialive:ListOfferings`
- `medialive:DescribeOffering`
- `medialive:ListReservations`
- `medialive:DescribeReservation`
- `medialive:ListTagsForResource`

MediaPackage v1:

- `mediapackage:ListChannels`
- `mediapackage:DescribeChannel`
- `mediapackage:ListOriginEndpoints`
- `mediapackage:DescribeOriginEndpoint`
- `mediapackage:ListHarvestJobs`
- `mediapackage:DescribeHarvestJob`
- `mediapackage:ListTagsForResource`

MediaPackage v2:

- `mediapackagev2:ListChannelGroups`
- `mediapackagev2:GetChannelGroup`
- `mediapackagev2:ListChannels`
- `mediapackagev2:GetChannel`
- `mediapackagev2:ListOriginEndpoints`
- `mediapackagev2:GetOriginEndpoint`
- `mediapackagev2:ListHarvestJobs`
- `mediapackagev2:GetHarvestJob`
- `mediapackagev2:ListTagsForResource`

MediaTailor:

- `mediatailor:ListPlaybackConfigurations`
- `mediatailor:GetPlaybackConfiguration`
- `mediatailor:ListChannels`
- `mediatailor:DescribeChannel`
- `mediatailor:ListSourceLocations`
- `mediatailor:DescribeSourceLocation`
- `mediatailor:ListLiveSources`
- `mediatailor:DescribeLiveSource`
- `mediatailor:ListVodSources`
- `mediatailor:DescribeVodSource`
- `mediatailor:ListAlerts`
- `mediatailor:ListTagsForResource`

This is 46 read/list operations. There is no create, update, delete, start,
stop, purchase, reservation mutation, tag mutation, policy mutation, harvest,
playback, object retrieval, thumbnail, source metadata, input URL, ad-decision
URL, S3 object, or CloudWatch log/metric permission in this slice.

## IAM resource-scope caveats

AWS service authorization requires `Resource: "*"` for account/Region
discovery actions that expose no resource type in the authorization table. In
this contract those unavoidable wildcard reads are:

- MediaConnect `ListFlows` and `ListTagsForResource`;
- MediaConvert `DescribeEndpoints`, `ListQueues`, and any unfiltered
  account-wide discovery needed before a queue ARN is known;
- MediaLive `ListChannels`, `ListMultiplexes`, `ListOfferings`, and
  `ListReservations`;
- MediaPackage v1 `ListChannels`, `ListOriginEndpoints`, and
  `ListHarvestJobs`;
- MediaPackage v2 `ListChannelGroups`; and
- MediaTailor `ListPlaybackConfigurations`, `ListChannels`,
  `ListSourceLocations`, `ListLiveSources`, `ListVodSources`, and `ListAlerts`.

`DescribeFlow`, MediaConvert `Get*`, MediaLive `Describe*` (including exact
Offering and Reservation ARNs), MediaPackage v1
`Describe*`, MediaTailor `GetPlaybackConfiguration`/`Describe*`, and supported
tag reads should use the exact discovered resource ARN patterns. MediaConvert
`ListJobs` supports a Queue resource and should be issued for each discovered
queue; `GetJob` uses the exact Job ARN. Do not collapse these into an
account-wide wildcard statement merely for policy convenience.

MediaPackage v2 has hierarchical authorization. `ListChannels` requires the
ChannelGroup resource; `ListOriginEndpoints` requires the parent Channel and
ChannelGroup resources; `GetChannel`, `GetOriginEndpoint`, and `GetHarvestJob`
list multiple required parent/child resource types in the AWS authorization
table. The versioned collector policy generator must emit all required exact
ARNs for the call. It must not substitute a single broad
`arn:...:mediapackagev2:...:*` grant.

`ListTagsForResource` scope differs by service. The policy generator must use
the authorization table for each prefix and avoid assuming that every tag API
supports the target resource ARN. In particular, the MediaConnect table does
not expose a resource type for `ListTagsForResource`, so its wildcard read is
unavoidable.

## Tenant, AWS, and data boundary

The trusted query service supplies organization, customer, connection, AWS
account, partition, and Region. The request contains no user-selectable tenant
or AWS account field. Every captured resource ARN must match the pinned
partition, service prefix, Region, and AWS account. Every CUR row must match
the pinned account and Region; a non-null resource ARN must additionally match
the row's normalized media service. Cross-tenant, cross-account, cross-Region,
cross-partition, or cross-service substitution fails closed.

The capture must contain exactly one result for each of the six provider
contracts. Unsupported regional services are explicit `unsupported` results,
not successful empty reads. A provider that was not configured or lacked
permission cannot return hidden records or claim exhausted pagination.
Duplicate provider results, conflicting duplicate resource ARNs, and
conflicting duplicate CUR row IDs fail closed.

Only normalized, non-secret configuration evidence is retained: resource ARN,
ID, name, state, bounded tags, timestamps, counts, classes, pricing plan,
package/playback type, and reservation dates/state. The contract deliberately
does not retain MediaConnect stream metadata or thumbnails, input/output URLs,
MediaConvert S3 paths or job settings, MediaPackage ingest/origin endpoints or
DRM material, MediaTailor ad-decision/playback URLs, source credentials,
viewer/session identifiers, or content payloads.

## Bounded collection

The contract caps collection at four concurrent calls, 15 minutes, 20,000 API
calls and 100,000 resources per provider, 300,000 resources total, 500,000 CUR
rows, 50 tags and 32 allowlisted attributes per resource, a 64 MiB capture, and
an 80 MiB dashboard input. Dashboard resource and usage-dimension lists are
independently bounded. Every provider explicitly states whether pagination was
exhausted. A bound or provider interruption becomes `partial`; it never becomes
a complete zero or a reconciled total.

## Honest states and claims

Provider states are `not_configured`, `unsupported`, `permission_required`,
`failed`, `partial`, `empty`, `stale`, and `current`. The capability state is:

- `configuration_required` when any region-supported provider collector or its
  full read set is not validated;
- `failed` when a configured provider failed without usable evidence;
- `partial` when provider pagination or the active CUR2 slice is incomplete;
- `empty` when all supported provider reads and CUR2 media rows are exhaustive
  but both contain zero records;
- `stale` when complete inventory or billing evidence is older than 48 hours;
  and
- `current` only when configuration, collection, and active CUR2 evidence are
  complete and within the SLA.

`current` describes evidence freshness and coverage, not service health or
optimization. The API inventory can support resource counts, observed state,
queue/job/channel/reservation configuration, and exact resource-to-cost
lineage. It does not by itself prove bandwidth utilization, performance,
uptime, availability, viewer engagement, MediaTailor revenue, CDN cache
efficiency, or end-to-end stream reliability. Those claims require separately
designed CloudWatch, application, CDN, and business/revenue sources.

## Production acceptance gates

This source/engine slice does not make Media Services Insights production
ready. Acceptance still requires:

1. add the exact 46 reads to a versioned collector permission contract using
   resource-level ARNs and the documented unavoidable wildcard discovery calls;
2. implement signed, replay-resistant broker runners for every provider with
   regional service availability, retry, duration, concurrency, and page
   enforcement;
3. feed media CUR rows only from the atomically activated billing generation
   and prove source/product-code mapping and reconciliation;
4. durably retain scoped collection attempts, normalized evidence, generic
   failures, freshness, pagination completion, and immutable billing lineage;
5. expose only authorization-derived tenant scope through bounded APIs;
6. render professional executive, service, usage, reservation, activity,
   allocation, and lineage views with all honest empty/partial/stale states;
7. add independent CloudWatch/performance sources before presenting any
   performance, reliability, session, or revenue visual; and
8. run controlled live tests in every supported Region/service combination,
   including empty accounts, resources without CUR ARNs, deleted resources,
   credits, multiple units, pagination, throttling, access denial, stale data,
   unsupported Regions, and adversarial cross-tenant requests.

No central IAM plan, role, broker, database, route, UI, customer AWS account,
or deployment is changed by this source-only slice.
