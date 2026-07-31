# End User Computing source contract

Sutra's End User Computing engine combines four evidence classes without
blending their meaning:

1. point-in-time WorkSpaces and WorkSpaces Applications (AppStream 2.0)
   inventory;
2. WorkSpaces connection state and privacy-minimized AppStream session counts;
3. CloudWatch utilization/performance observations; and
4. cost, usage, and commitment classifications from one active, exactly
   reconciled canonical CUR2 generation.

The engine is pure and tenant-pinned. It accepts no AWS credentials, performs
no network or database I/O, and keeps no global cache. Account and Region
scope comes only from the server-resolved connection boundary. Cross-tenant,
cross-account, cross-Region, and cross-partition captures fail closed.

## Read operations

The bounded AWS collector needs only:

- `workspaces:DescribeWorkspaces`
- `workspaces:DescribeWorkspaceBundles`
- `workspaces:DescribeWorkspacesConnectionStatus`
- `appstream:DescribeFleets`
- `appstream:DescribeStacks`
- `appstream:ListAssociatedFleets`
- `appstream:DescribeSessions`
- `cloudwatch:GetMetricData`

No create, start, stop, terminate, update, association, metric publication, or
session-expiry operation is part of this contract. CUR2 rows come from Sutra's
already activated billing generation; this slice does not add an S3 or Billing
Data Exports read to the EUC control-plane collector.

Current AWS service authorization has important least-privilege caveats:

- the three WorkSpaces reads above expose no resource type;
- AppStream `DescribeFleets` and `DescribeStacks` expose no resource type;
- AppStream `DescribeSessions` supports the exact fleet and stack ARNs;
- AppStream `ListAssociatedFleets` supports the exact stack ARN; and
- CloudWatch currently lists optional `dataset` resource scoping for
  `GetMetricData`, but classic `AWS/WorkSpaces` and `AWS/AppStream` metric
  queries must be live policy-simulated before claiming that dataset ARNs can
  replace `Resource: "*"`.

Where AWS publishes no compatible resource type, the production policy must
use the narrow customer-account temporary session and restrict requested
Regions where the service/global condition semantics permit. A broad account
role or permanent credential is not an acceptable substitute.

Authoritative references:

- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_workspaces.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_appstream.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudwatch.html>
- <https://docs.aws.amazon.com/workspaces/latest/api/API_DescribeWorkspaces.html>
- <https://docs.aws.amazon.com/workspaces/latest/api/API_DescribeWorkspaceBundles.html>
- <https://docs.aws.amazon.com/workspaces/latest/api/API_DescribeWorkspacesConnectionStatus.html>
- <https://docs.aws.amazon.com/appstream2/latest/APIReference/API_DescribeFleets.html>
- <https://docs.aws.amazon.com/appstream2/latest/APIReference/API_DescribeStacks.html>
- <https://docs.aws.amazon.com/appstream2/latest/APIReference/API_ListAssociatedFleets.html>
- <https://docs.aws.amazon.com/appstream2/latest/APIReference/API_DescribeSessions.html>
- <https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricData.html>

## Privacy boundary

The AppStream API returns user IDs, session IDs, instance IDs, connection
state, and network data. Those raw objects must never cross the broker. The
collector emits only per-fleet/per-stack state counts and token/query hashes.
WorkSpaces user names, computer names, IP addresses, error messages, and the
last-known user connection timestamp are also excluded.

The runtime validator uses exact object shapes. Extra personal, session,
instance, network, or provider-message fields are rejected. The dashboard
contains resource inventory and aggregate activity only; it never returns an
AppStream user/session/instance identifier. Hashed pagination tokens are
validated for chaining and replay, then discarded before dashboard output.

## Evidence semantics

- `AVAILABLE` and `STOPPED` inventory states are provider observations, not
  inferred utilization.
- WorkSpaces `CONNECTED`, `DISCONNECTED`, and `UNKNOWN` are preserved as
  connection evidence. A missing connection record stays missing.
- AppStream session state is reported only as aggregate active, pending,
  expired, connected, and not-connected counts. A complete empty query is an
  observed zero; a missing or bounded query is partial/unknown.
- Performance and utilization values exist only when a bounded
  `GetMetricData` observation has a positive sample count, a valid unit, an
  authoritative time window, and the required privacy aggregation.
- A missing CloudWatch metric is `UNKNOWN`; it is never synthesized as zero.
- AppStream instance/session performance metrics are aggregated before the
  broker and remain separate from control-plane capacity and session counts.
- Cost totals use signed integer micro-units. Currencies are never combined or
  converted. Missing net/amortized/list/contracted/public bases remain null
  with partial/unavailable coverage.
- Cost/commitment evidence never implies connection state, session count,
  utilization, performance, or savings.

WorkSpaces metric definitions are documented at
<https://docs.aws.amazon.com/workspaces/latest/adminguide/cloudwatch-metrics.html>.
WorkSpaces Applications metric applicability and dimensions are documented at
<https://docs.aws.amazon.com/appstream2/latest/developerguide/monitoring-with-cloudwatch.html>.

## Bounds and deterministic handling

The contract caps collection at four concurrent calls, 15 minutes, 20,000
pages, 50,000 WorkSpaces, 10,000 bundles, 10,000 fleets, 10,000 stacks, one
million summarized sessions, 100,000 metric observations, 250,000 matching
CUR2 lines, 64 MiB per capture, and 8 MiB per dashboard response. History is
limited to 93 days and resource responses are cursor-paged to at most 5,000
items.

Every pagination chain starts without a token, advances through SHA-256 token
digests without replay, and declares whether it exhausted the result. Exact
duplicate identities are deterministically collapsed; conflicting duplicates
fail closed. Coverage counts must reconcile to the normalized account/Region
records. Provider exception text is replaced by a bounded generic code.

## Production acceptance gates

This source-only slice is locally implemented, but is not production-accepted
until all of these gates pass:

1. **Permission gate:** the versioned collector/session policy contains only
   the eight reads above, with exact fleet/stack ARNs where AWS supports them,
   and live policy simulation documents every unavoidable `Resource: "*"`.
2. **Broker gate:** a signed, replay-resistant broker invokes bounded regional
   SDK runners with temporary customer-role credentials and strips PII before
   returning evidence.
3. **Persistence gate:** capture attempts, account/Region coverage, sanitized
   snapshots, and active billing-generation lineage are stored under the exact
   organization/customer/connection boundary.
4. **API gate:** an authenticated tenant-scoped route reads persisted evidence,
   enforces bounded filters/cursors, and never accepts a client tenant ID or
   AWS account outside the server boundary.
5. **UI gate:** the FinOps operations UI renders inventory, activity,
   telemetry, cost, commitment, coverage, freshness, and all empty, partial,
   stale, and unavailable states without dummy data.
6. **Live gate:** controlled tests cover multiple accounts/Regions, pagination,
   zero-session fleets, missing CloudWatch metrics, access denial, throttling,
   stale evidence, CUR2 rows with incomplete cost bases, and adversarial
   cross-tenant/PII payloads.

No IAM policy, broker implementation, persistence schema, route, UI, customer
account, or live environment is changed by this source-only slice.
