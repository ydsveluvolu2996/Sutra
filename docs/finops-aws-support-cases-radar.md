# AWS Support Cases Radar source contract

Sutra models Support Cases Radar as account-local, retention-limited provider
evidence. AWS Support does not expose an organization-wide support-cases API.
Sutra can present a multi-account radar only by collecting each account in a
server-resolved intended-account set. A capture is complete only when every
intended account has proven entitlement and read authorization and has
exhausted both case pagination and per-case communication pagination.

## Exact read permissions and account boundary

The credential-owning collector requires exactly:

- `support:DescribeCases`
- `support:DescribeCommunications`

AWS Support does not support resource-level IAM ARNs or service-specific
condition keys, so these actions require `Resource: "*"`. The wildcard is
bounded by assuming a distinct temporary role in each intended customer
account. It does not authorize another account and does not turn the API into
an organization source. The permanent collector must not receive Support write
operations such as `CreateCase`, `AddCommunicationToCase`, or `ResolveCase`.

The commercial-partition contract pins the Support endpoint to `us-east-1`.
The GovCloud contract pins it to `us-gov-west-1`. The broker request is built
from server-owned organization, customer, parent-connection, partition,
endpoint, account, and per-account connection records. No client-provided
tenant or account identifiers are accepted.

Current AWS documentation requires Business Support+, Enterprise Support, or
Unified Operations for Support API access. AWS documentation also describes
legacy Business and Enterprise On-Ramp plans during their transition period,
and those plans remain available in GovCloud. Sutra never infers entitlement
from a plan label alone: each account carries a validated `QUALIFYING`,
`NOT_QUALIFYING`, or `UNKNOWN` entitlement observation. Unknown or inconsistent
evidence cannot become ready.

## Collection and privacy boundary

`DescribeCases` is called with:

- `includeCommunications: false`;
- `includeResolvedCases: true`;
- no case, display-ID, or language filter;
- an explicit bounded time window;
- `maxResults: 100` and an exhaustive pagination chain.

Each returned case is then collected with a separate bounded
`DescribeCommunications` pagination chain. The collector must sanitize the
provider response before the signed broker boundary. The payload rejects extra
fields and excludes:

- raw case subjects;
- communication bodies;
- submitter names and email addresses;
- CC email addresses;
- attachment IDs, file names, content, and URLs;
- raw pagination tokens; and
- provider exception messages.

The accepted payload retains only allowlisted case ID/display ID, account,
status, severity, service/category/language codes, created time, communication
times, coarse `AWS`/`CUSTOMER`/`UNKNOWN` actor kind, recipient/attachment/body
byte counts, and keyed HMAC-SHA256 evidence hashes. Pagination continuity is
validated using keyed token digests rather than raw provider tokens. Generic
failure codes are allowlisted; provider text never reaches the app.

Safe optional summaries use only status, severity, service, category, counts,
and evidence-hash references. They do not process subjects or correspondence.

## Bounds, incremental collection, and history

The pure engine enforces:

- 100 cases or communications per page;
- four requests per second per account, below the documented five-request AWS
  Support API quota;
- two concurrent requests;
- 15 minutes and 64 MiB per capture;
- 200 intended accounts;
- 10,000 case pages and 50,000 communication pages;
- 50,000 cases and 250,000 communications;
- 1 MiB measured source-text size per sanitized case subject or communication;
- at most ten attachments counted per communication;
- 730 days for an initial window, matching the documented 24-month provider
  retention ceiling;
- 31 days per incremental window with at most 48 hours of overlap;
- 36 persisted snapshots per dashboard evaluation;
- 96 MiB dashboard input and 500 returned case rows.

An incremental window must advance a persisted watermark and may overlap the
prior watermark only within the declared bound. Dashboard replay deduplicates
communication evidence deterministically across overlapping captures.
Identical duplicates are accepted; conflicting duplicates fail closed.

AWS documents `afterTime` and `beforeTime` as filters on case communications.
Therefore, an incremental query can miss a status-only change that has no new
communication. Sutra reports watermark continuity separately but labels status
history `observed_snapshots_only`; it never calls that provider history
complete. A periodic full 24-month retained-window reconciliation is required
for current-status assurance.

AWS returns case creation time and communication times but does not return a
resolution timestamp in `CaseDetails`. Sutra therefore labels resolution time
as `resolvedObservedAt`: the first retained snapshot in which the case was
observed as resolved. It must not be represented as a provider-supplied time.
Likewise, `updatedAt` is the latest retained communication or creation time,
not a hidden provider update timestamp.

## Configuration, partial, stale, and coverage states

An account is complete only when:

1. Support API entitlement is proven qualifying;
2. both exact read permissions have been authorization-tested;
3. case pagination is exhausted;
4. every observed case has exactly one communication sequence; and
5. every communication sequence is exhausted without a generic failure.

`SUBSCRIPTION_REQUIRED` and a proven non-qualifying plan make that account
unavailable. Unknown entitlement or plan evidence is unverified. Missing
permissions, bounded pagination, a failed case communication, or mixed account
outcomes remain partial. The source is complete only when every intended
account is complete. Dashboard evidence older than 48 hours is stale.

An empty complete result proves only that every intended account returned no
cases in the bounded query window. AWS documents 24 months of case-data
availability, so longer history requires Sutra persistence. The dashboard
always returns `organizationCoverageClaimed: false` to prevent an account-local
fan-out from being misrepresented as a native AWS organization source.

## Authoritative AWS references

- <https://docs.aws.amazon.com/awssupport/latest/APIReference/API_DescribeCases.html>
- <https://docs.aws.amazon.com/awssupport/latest/APIReference/API_DescribeCommunications.html>
- <https://docs.aws.amazon.com/awssupport/latest/APIReference/API_CaseDetails.html>
- <https://docs.aws.amazon.com/awssupport/latest/APIReference/API_Communication.html>
- <https://docs.aws.amazon.com/awssupport/latest/user/about-support-api.html>
- <https://docs.aws.amazon.com/awssupport/latest/user/aws-support-plans.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_awssupport.html>
- <https://docs.aws.amazon.com/general/latest/gr/awssupport.html>
- <https://docs.aws.amazon.com/govcloud-us/latest/UserGuide/govcloud-support.html>

## Production acceptance gates

This source-only slice is locally testable but is not production-accepted until
all of these gates pass:

1. **Permission gate:** a versioned role/session ceiling grants exactly the two
   reads for `Resource: "*"` in each intended account, with no Support writes.
2. **Broker gate:** a signed, replay-resistant runner assumes each pinned
   account role, rate-limits SDK calls, computes keyed evidence hashes before
   transport, and rejects unsanitized responses.
3. **Persistence gate:** attempts, sanitized captures, account coverage,
   watermarks, and immutable snapshots are stored under organization, customer,
   parent connection, account connection, account, and partition scope.
4. **API gate:** a server-authorized route loads only tenant-scoped persisted
   snapshots, caps filters/responses, and never accepts client tenant/account
   substitution.
5. **UI gate:** the professional Operations/FinOps view renders account
   coverage, status/severity/service/category distributions, incremental
   history, open-case age, privacy-safe response cadence, top topics, safe
   summaries, and empty/unverified/unavailable/partial/stale states without raw
   correspondence.
6. **Live gate:** controlled qualifying and non-qualifying accounts validate
   pagination, resolved cases, communication counts, entitlement denial,
   authorization denial, throttling, stale data, watermark replay, privacy
   redaction, and adversarial cross-tenant requests.

No IAM template, broker, database schema, registry, application API, UI,
customer account, or live environment is modified by this bounded engine
slice.
