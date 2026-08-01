# Sutra Amazon Connect Cost Insight source contract

This v1 slice implements a pure, evidence-honest source and projection contract
for the seven view families documented by the AWS Amazon Connect Cost Insight
Dashboard: overview, contact-center analysis, Connect service detail, telecom
spend, daily usage, aggregated call patterns, and privacy-gated contact search.
It combines two independent evidence classes:

1. one immutable, atomically active CUR 2.0 generation filtered to Amazon
   Connect and Contact Center Telecommunications cost and usage; and
2. bounded, read-only Amazon Connect instance metadata plus phone inventory
   aggregated by instance, country, number type, and status.

AWS states that the dashboard is CUR-driven. Detailed contact analysis requires
granular billing/resource IDs, and endpoint/instance allocation requires the
relevant Connect system cost-allocation tags. An absent resource ID or tag is
therefore an explicit coverage limitation, never an inferred zero.

Authoritative AWS references:

- <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/connect-cost-insight.html>
- <https://docs.aws.amazon.com/connect/latest/adminguide/granular-billing.html>
- <https://docs.aws.amazon.com/connect/latest/APIReference/API_DescribeInstance.html>
- <https://docs.aws.amazon.com/connect/latest/APIReference/API_ListPhoneNumbersV2.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_connect.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_awsdirectoryservice.html>

## Exact runtime read actions

The contract requests exactly these actions:

- `connect:DescribeInstance`
- `connect:ListPhoneNumbersV2`
- `ds:DescribeDirectories`

`ds:DescribeDirectories` is listed by the AWS service-authorization table as a
dependent action for `connect:DescribeInstance`. There are no contact, user,
agent, queue, metrics, Contact Lens, recording, transcript, object-storage,
tag-read, search, create, update, delete, or other mutation permissions.

Instance discovery is intentionally outside the recurring collector. The
trusted connection configuration contains the sorted set of authorized exact
instance ARNs. The collector calls `DescribeInstance` and
`ListPhoneNumbersV2(TargetArn=<exact authorized instance ARN>)` only for those
instances. If no instances have been authorized, the capability is
`configuration_required`; the runtime does not expand its own scope with
`ListInstances`.

## IAM resource scope and unavoidable gaps

Use these resource scopes in the later versioned permission plan:

| Action | Resource scope | Caveat |
|---|---|---|
| `connect:DescribeInstance` | Each exact `arn:${Partition}:connect:${Region}:${Account}:instance/${InstanceId}` | Server-authorized account, partition, Region, and instance only. |
| `connect:ListPhoneNumbersV2` | `arn:${Partition}:connect:${Region}:${Account}:phone-number/*` | AWS defines `wildcard-phone-number` without an instance segment. The request must still set `TargetArn` to one exact authorized instance. IAM cannot reduce this action to one instance. |
| `ds:DescribeDirectories` | `*` | AWS Directory Service exposes no resource type for this dependent list action. |

The last two grants are wider than the data Sutra retains. They are read-only,
but their raw API responses can contain sensitive account-wide directory or
telephone-number information. A signed broker request, an operation allowlist,
exact target-ARN enforcement, concurrency/page/record/time bounds, isolated
collector identity, generic errors, and output schema validation are mandatory
compensating controls. The collector must not offer these credentials or raw
responses to the browser, application worker, or customer-facing API.

Global Resiliency traffic-distribution-group phone inventory is not in v1.
Supporting it later requires a separate server-authorized traffic-distribution
group boundary and corresponding exact read actions. It must not be silently
folded into an instance result.

## Privacy and sensitive drilldown boundary

The normal broker schema cannot contain:

- raw contact IDs or contact records;
- telephone numbers, phone-number IDs or ARNs, descriptions, or endpoint
  addresses;
- customer, agent, user, queue, or participant identifiers;
- contact attributes, tag values, free-form provider messages, recordings,
  transcripts, or Contact Lens output; or
- instance access URLs, service-role names, or directory details.

`ListPhoneNumbersV2` responses are aggregated in collector memory by exact
authorized instance ARN, two-letter country, number type, and status. The raw
number, phone ARN/ID, description, source ARN, and target ARN are discarded
before signing the broker result. Aggregate counts must reconcile exactly to
the number of scanned records.

If CUR2 contact resource IDs or activated endpoint tags are present, the
billing normalizer replaces them with rotating tenant-scoped HMAC-SHA256 tokens
before this module receives the rows. Tokens are not shared across tenants and
the key version is retained as lineage. Raw AWS UUIDs and endpoint values fail
schema validation. AWS warns that Connect contact tags are not intended for PII
or confidential information; Sutra does not trust or expose arbitrary tag
values even when customers disregard that guidance.

The standard dashboard never emits contact or endpoint tokens. It exposes only
aggregated contact counts, costs, quantities, directions, channels, countries,
number types, usage types, operations, units, and time buckets. Optional exact
token lookup requires all of the following:

1. contact drilldown was explicitly enabled for the source;
2. CUR2 resource IDs were included and tokenized;
3. the requested token is an exact tenant-scoped HMAC token;
4. a server-minted grant matches organization, customer, connection, account,
   partition, Region, and the full authorized instance set;
5. the grant carries a hashed principal, bounded purpose code, immutable audit
   event ID, and expiration no more than 60 minutes after issuance; and
6. the grant is unexpired at evaluation time.

Even then, the result contains only a short HMAC-derived display pseudonym and
the matching CUR2 billing facts. It omits both tokens and cannot reveal a raw
contact ID, endpoint, phone number, contact record, recording, or transcript.
The pure engine verifies an existing audit event ID; the production route must
atomically persist and authorize the audit event before minting the grant.

HMAC tokens are pseudonymous rather than anonymous. They must receive the same
tenant isolation, retention, export, access-review, incident-response, and
deletion controls as other sensitive customer metadata.

## Exact cost, usage, and attribution semantics

All currency amounts are signed integer currency micros. Credits, refunds, and
corrections remain negative. Usage is signed integer micros of the exact CUR2
unit. The engine never converts or combines minutes, hours, messages, units,
or other unlike dimensions. One snapshot carries one explicit currency and one
cost basis (`UNBLENDED`, `AMORTIZED`, `NET_UNBLENDED`, or `NET_AMORTIZED`).

Each row retains service, charge family, channel, direction, country, phone
number type, operation, usage type, unit, charge category, and a classification
basis:

- `AWS_CUR2_NATIVE` for a native billing dimension;
- `AWS_ACTIVATED_SYSTEM_TAGS` for activated Connect system-tag evidence;
- `SUTRA_USAGE_TYPE_RULE` for a versioned, explainable usage-type rule; and
- `UNATTRIBUTED` when no resource attribution is present.

Unattributed spend remains unattributed. The engine does not spread account-
level or service-level rows across instances, phone aggregates, endpoints, or
contacts. Dashboard totals remain tied to the active generation ID, manifest
SHA-256, data-through timestamp, cost basis, and currency.

## Bounded collection

The source caps collection at four concurrent calls, 15 minutes, 100 authorized
instances, 20,000 API calls, 250,000 scanned phone records, 10,000 phone
aggregate rows, 500,000 CUR2 rows, and a 64 MiB capture. Dashboard inputs and
group counts are separately bounded. A contact drilldown returns at most 500
billing rows. Pagination exhaustion is explicit for every authorized instance.
A page, time, API, record, or byte limit becomes `partial`; it never becomes a
complete zero.

## Honest states

- `configuration_required`: no server-authorized instance or an instance
  collection is not configured.
- `permission_required`: a configured, region-supported instance has not
  validated the full read contract.
- `failed`: a configured collection failed without an instance observation.
- `partial`: a page/bound/provider failure occurred or the active CUR2 slice is
  incomplete.
- `empty`: exhaustive, fresh sources contain no instance, aggregate, or cost
  records.
- `stale`: otherwise complete control-plane or billing evidence is older than
  48 hours.
- `current`: configuration, permissions, pagination, CUR2 rows, and freshness
  are all complete. This describes evidence coverage, not business health.

Contact-detail coverage is reported separately as `NOT_ENABLED`,
`TOKENIZED_PARTIAL`, or `TOKENIZED_COMPLETE`. A current aggregate dashboard can
honestly coexist with unavailable contact search.

## Live privacy and production gaps

This source/engine slice is not production accepted. Live acceptance still
requires:

1. put the three actions into the versioned collector contract with the exact
   scopes above and attest the resulting policy before every session;
2. implement the signed, replay-resistant broker runner with exact target-ARN,
   page, duration, concurrency, retry, and output-byte enforcement;
3. implement audited tenant-specific HMAC key generation, rotation, retention,
   and destruction outside application logs and source-job messages;
4. prove that raw Connect/phone responses, CUR resource IDs, system endpoint
   tags, and arbitrary tag values never cross the normalization boundary or
   appear in errors, traces, metrics, logs, caches, exports, or support tools;
5. deploy the implemented immutable active-generation persistence and retain
   permission attestation, pagination completeness, aggregate reconciliation,
   token key version, and safe attempts in the permanent job ledger;
6. deploy and signed-in verify the implemented authorization-derived aggregate
   route; separately design the policy/approval/audit route for tokenized
   contact drilldown before enabling privileged lookup;
7. establish customer retention, DSAR/deletion, legal basis, residency,
   incident-response, and privileged-access policies for HMAC tokens and audit
   events;
8. validate CUR2 product-code/usage-type classification rules against real
   invoices in every supported Region, including taxes, credits, refunds,
   currencies, missing resource IDs, missing tags, transfers, and endpoint
   charges; and
9. run adversarial live tests for cross-tenant/account/partition/Region/instance
   substitution, wildcard phone-number abuse, expired/replayed grants, raw PII
   leakage, pagination/throttling, unsupported Regions, stale data, and high-
   volume granular billing.

This slice still adds no central IAM policy, provider adapter, customer AWS
resource, deployment, privileged token-lookup route, or production access.
