# ADV-09 — AWS Support Cases Radar Dashboard

## Official capability and bounded implementation

The official AWS Cloud Intelligence Dashboard describes a daily view of changed
Support cases across linked accounts and organizations, with status, severity,
service, age, ownership/activity signals, and optional generative summaries.
The underlying AWS Support API remains account-local. Sutra therefore never
claims a native organization Support-case source: it freezes a server-resolved
set of linked account connections and fans out `DescribeCases` plus
`DescribeCommunications` in each account.

This vertical adds:

- a server-owned collection-job boundary that resolves account targets from
  trusted persistence, uses the engine's signed privacy-minimized broker
  contract, and persists only an engine-normalized snapshot;
- an Ed25519-authenticated broker transport that pins the private HTTPS origin,
  exact path/body/tenant headers, request nonce, response signature, content
  type, byte bound, request digest, job identity, scope, and normalized capture;
- a daily server-owned scheduler/runtime handler contract with deterministic
  collection identity and an explicit `DescribeCases` authorization-outcome
  entitlement probe;
- immutable tenant/customer/anchor-connection persistence in SQLite migration
  `0092` and PostgreSQL migration `0087`, with failed/partial attempts retained
  and a complete-only monotonic accepted head;
- an authenticated `connection:read` API that resolves the connection inside
  the signed-in organization, never accepts tenant/customer substitution, and
  returns only a bounded browser-safe projection;
- a native accessible dashboard with account, status, severity, service, and
  category filters; coverage and Support-plan states; case-history visuals;
  metadata drilldown; provenance; freshness; and explicit activation limits.

## Privacy and plan states

The stored snapshot contains only the engine allowlist. Raw subjects,
correspondence, submitter names/emails, CC addresses, attachment identifiers or
names, provider exception messages, and raw pagination tokens are rejected
before the broker boundary. The API further omits internal case IDs, contact and
subject evidence hashes, communication evidence arrays, and safe-summary hash
references. It exposes masked display references and operational metadata/counts
only.

Each linked account independently reports its observed plan and entitlement.
Business/legacy Business, Enterprise On-Ramp, Enterprise, Business Support+,
and Unified Operations states can be shown, but a label alone never proves API
access. Only `QUALIFYING` entitlement plus validated reads and exhausted case
and communication pagination makes an account complete. Basic/Developer or a
`SUBSCRIPTION_REQUIRED` result is unavailable; unknown plan evidence is
unverified. This accommodates the plans named by the CID while retaining the
current AWS entitlement contract.

## Daily and incremental history semantics

The job supports an initial retained-window collection and daily incremental
windows of at most 31 days with at most 48 hours of overlap. A complete snapshot
must advance its persisted watermark. The dashboard replays at most 36 immutable
snapshots, deterministically deduplicates overlapping communication evidence,
and labels history `observed_snapshots_only`.

AWS documents the time filters in terms of communications. A status-only change
without a new communication can therefore escape an incremental read. Daily
collection does not remove this provider limitation: periodic full 24-month
reconciliation remains required, `resolvedObservedAt` is Sutra's first retained
observation rather than an AWS resolution timestamp, and history older than the
provider's 24-month retention exists only when Sutra previously persisted it.
Multiple customer organizations remain isolated persistence scopes; there is no
cross-tenant aggregate or global cache.

## Optional Bedrock summarization

The local vertical does not activate Bedrock summaries. The API returns
`OPTIONAL_BEDROCK_SUMMARIZATION_NOT_CONFIGURED`, and the browser never receives
raw text that it could send to a model. A future opt-in summary pipeline requires
separate tenant policy, model/Region configuration, purpose limitation, input
redaction proof, retention controls, sealed evidence, and live acceptance. It
must not be inferred from the deterministic metadata-only synopsis available in
the pure engine.

## Verification and remaining production gates

Focused tests cover engine privacy/bounds, immutable migrations, tenant-scoped
repository and route contracts, browser-safe projection, accessible native
rendering, plan/configuration states, history/provenance, the server-owned job
boundary, signed transport rejection, and scheduler isolation. The
implementation remains `PARTIAL_PIPELINE`, not live-verified: the shared
runtime registration, credential-owning AWS SDK Support adapter, and provider
accounts are not bound in this repository. Activation therefore remains false
with `AWS_SUPPORT_CASES_SIGNED_BROKER_HANDLER_NOT_REGISTERED`.

Production activation requires controlled qualifying and non-qualifying linked
accounts to validate IAM, endpoint partitioning, pagination, throttling,
resolved-case observations, daily watermark replay, periodic reconciliation,
privacy redaction, stale evidence, and adversarial cross-tenant requests. Until
those gates pass, `collection.available` is false and the accepted dashboard
can render only previously persisted evidence.

Authoritative source-contract detail and AWS references are maintained in
`docs/finops-aws-support-cases-radar.md`.
