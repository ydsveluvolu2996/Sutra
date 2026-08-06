# ADV-09 — AWS Support Cases Radar Dashboard

Reviewed: 2026-08-01

Official definition (pinned):
<https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/support-cases-radar/support-cases-radar.yaml>

Official guide:
<https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/support-cases-radar.html>

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
  collection identity, exact five-attempt leases, prevalidated tenant scopes
  and bounded initial/incremental windows, plus an explicit `DescribeCases`
  authorization-outcome entitlement probe;
- immutable tenant/customer/anchor-connection persistence in SQLite migration
  `0092` and PostgreSQL migration `0087`, with failed/partial attempts retained
  and a complete-only monotonic accepted head;
- an authenticated `connection:read` API that resolves the connection inside
  the signed-in organization, never accepts tenant/customer substitution, and
  returns only a bounded browser-safe projection;
- a native accessible dashboard with account, status, severity, service, and
  category filters; coverage and Support-plan states; case-history, open-age,
  privacy-safe response-cadence and top-topic visuals; metadata drilldown;
  provenance; freshness; and explicit activation limits.

## Official inventory audit

The pinned framework manifest SHA-256 is
`4d9970206b4c927bb1d0cf1afd4e2a732370472f1b2f54c2681c13d71131e8fa`;
the changelog SHA-256 is
`385bc28ba04f119c41ada8a3490c2a753abc6f79e3b9a6331213a8c59ea7969c`,
and the official preview SHA-256 is
`3702251ed48abe49e529ea5fc12ce3e44a3fce570043f44797a95b94b855852a`.
The manifest declares `support_cases_status_view` with 3 unique input columns
and `support_cases_communications_view` with 35 unique input columns across 2
physical tables. The latter supplies payer/account,
case-created time, status, service, category, severity, communication time,
communication lag/origin/class, and optional summary fields. The current AWS
guide confirms daily changed-case collection, nightly dashboard refresh,
multi-account/multi-organization consolidation, and an optional Bedrock
summarization plugin. Sutra covers the operational metadata inventory with
status/severity/service/category distributions, account readiness, observed
history, case age, response transitions and drilldown. It deliberately does
not expose the official definition's raw subject, body, submitter, CC, URL or
Bedrock-summary fields to the browser. The pinned YAML does not contain the
managed QuickSight definition. Exact sheet, visual and control totals are
therefore explicitly unavailable rather than inferred from the preview. The
native source inventory shows the preview's Cases Summary, Contact Summary and
About tabs, 5 named visual purposes and 8 visible controls without treating
those screenshot observations as exact object counts.

Both successful API envelopes expose this frozen source audit. The browser
validates the pinned commit and manifest hash, preserves it when the dashboard
is `null`, and renders it independently in loading, configuration-required,
failed, and report-bearing states. This never substitutes source metadata for
Support entitlement, case evidence, or provider collection.

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
boundary, response/age/topic visuals, signed transport rejection, strict
lease/window validation, all-scope scheduler prevalidation, real AWS SDK
capture minimization, exact `.8.7` permission drift rejection, and isolated
schedule-to-immutable-head composition. The scheduler proves that two account
connections produce one cohort fan-out job rather than an O(N²) duplicate
collection. Raw subjects, contacts, correspondence, attachment metadata,
provider diagnostics and pagination tokens have explicit non-leakage tests.

The implementation is not yet live-verified. Shared runtime/collector route
registration and publication of the immutable `.8.7` onboarding role remain
local closure gates. Until those hooks land, activation honestly remains false
with `AWS_SUPPORT_CASES_SIGNED_BROKER_HANDLER_NOT_REGISTERED`.

Focused local result before shared activation: **29 passed, 0 failed, 0
skipped** across the exact public audit, engine, runtime binding, vertical,
provider, permission-contract, and production-composition suites; root and
collector typechecks, scoped lint, diff checks, and the repository secret scan
passed on the same working tree before later parallel edits.

Production activation requires controlled qualifying and non-qualifying linked
accounts to validate IAM, endpoint partitioning, pagination, throttling,
resolved-case observations, daily watermark replay, periodic reconciliation,
privacy redaction, stale evidence, and adversarial cross-tenant requests. Until
those gates pass, `collection.available` is false and the accepted dashboard
can render only previously persisted evidence.

Authoritative source-contract detail and AWS references are maintained in
`docs/finops-aws-support-cases-radar.md`.

## Merge record — 2026-08-06

Merged to `main` since this record was last updated (2026-08-05 15:01). Every
item below is source-only work that landed through review with CI green on the
merge commit — nothing more. No provider, live, two-tenant, or release evidence
is created by any of it.

**Maturity is unchanged (`LOCAL_VERTICAL_CANDIDATE`) and no child-stage gate passed.** G7
fixed-tree, G8 controlled provider acceptance, G9 release and G10 deployment
remain unpassed for this row; no live acceptance, provider reconciliation, or
two-tenant acceptance is claimed.

- **Native chart kit and catalog identity — `4ac72bd` (PR #36) and `f107cdf`
  (PR #37).** This row's view moved onto the shared native chart kit at
  `app/components/charts`:
  - `app/costs/finops-aws-support-cases-radar-dashboard.tsx`
  - `app/costs/finops-aws-support-cases-radar-dashboard.module.css`

  Focused rendering proof added with it:
  - `tests/finops-support-cases-history-chart.test.mjs`

  Across `app/costs/`, 28 view modules plus the catalog page now import the kit,
  and the kit's own rendering suite `tests/chart-kit-rendering.test.mjs` holds
  12 tests. `app/costs/finops-dashboard-identity.tsx` renders each dashboard's
  catalog glyph, name and ID above every opened view
  (`tests/finops-dashboard-identity.test.mjs`). This is UI rendering work only:
  no source contract, collector operation, migration, API shape, or evidence
  semantic changed, and no G5 or G6 stage status is promoted by it.

- **New `aws_static_credentials` onboarding method — `6298f03` (PR #39).**
  Onboarding now offers an access key ID plus secret access key (with a session
  token required for temporary `ASIA` keys) as an alternative to the
  CloudFormation trust-role flow, which stays the recommended default. The
  credential material lives only in the collector's AES-GCM-encrypted registry
  document; the app database stores the `aws_static_credentials` source kind and
  nothing else. Static sessions carry **no STS inline session-policy ceiling and
  no role-contract attestation** — both are impossible without `AssumeRole`.
  **This row's connection prerequisite is unchanged: the FinOps per-source
  verticals still require the trust-role method.** The FinOps source guards were
  deliberately left trust-role-only, so an `aws_static_credentials` connection
  cannot satisfy the prerequisite recorded above. No permission ceiling,
  attestation, or role contract in this record is relaxed by it.
