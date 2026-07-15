# Security and quality plan for the MSP CMDB

Status: proposed release gates for the first production-shaped slice  
Applies to: Cloudflare control plane, D1 hot state, asynchronous jobs, R2 evidence snapshots, and an AWS-hosted collector/broker  
Security baseline: OWASP ASVS Level 2 for the web/API surface, least-privilege AWS IAM, encrypted transport and storage, and deny-by-default authorization

## 1. Scope and release posture

The first runnable slice is:

1. An authenticated MSP user creates a customer workspace and grants scoped access.
2. The service generates a unique `ExternalId` and onboarding template for a read-only customer role.
3. An AWS-hosted collector/broker, running with a workload IAM role, validates the customer role with AWS STS.
4. A manual sync becomes an authenticated, idempotent asynchronous job.
5. The collector writes a raw snapshot to R2 through the control plane's authenticated ingestion boundary; normalized resources, relationships, tags, control evaluations, and current findings are stored in D1.
6. Authorized MSP or customer users can browse the CMDB, findings, sync status, and audit trail only within their assigned scope.

The Cloudflare web worker must not hold a permanent AWS access key. Real AWS collection is not production-ready until the AWS-hosted broker uses workload identity, its request/response protocol is authenticated, and its role is restricted to assuming only registered customer roles. A local fake collector is acceptable for UI development, but it must be visibly identified and impossible to enable in production.

This slice provides evidence-backed configuration and posture checks. It is not a replacement for Inspector's package/runtime vulnerability coverage, GuardDuty's threat telemetry, Security Hub's aggregation, an EDR agent, or human incident response. Product claims must distinguish deterministic configuration checks from vulnerability scanning and behavioral threat detection.

All AWS actions in this slice are read-only. A later remediation/resource-management plane must use a separate customer role and explicit per-action grant, show a dry-run/diff, require re-authentication and approval for high-impact changes, enforce idempotency and blast-radius limits, and produce before/after evidence plus an immutable audit event. Read-only collection credentials must never acquire write permissions merely because a UI button is added.

### Non-negotiable security invariants

- Every customer-scoped record, query, object key, job, cache entry, export, and audit event is bound to both `org_id` and `customer_id`.
- The server derives scope from the authenticated membership. It never authorizes from a browser-supplied `org_id`, `customer_id`, role, email, or AWS account ID.
- A job supplies an opaque `integration_id`; the worker resolves the role ARN and ExternalId from the authorized database record. Job payloads never carry AWS credentials or caller-selected STS parameters.
- Customer accounts are accessed only with short-lived STS credentials. Those credentials exist in collector memory only and are never persisted, returned to the browser, included in a queue message, or logged.
- A sync is promoted as the current complete snapshot only after all required pages and collectors finish. A failed or partial run cannot erase or supersede the last complete snapshot.
- All resource names, tags, ARNs, provider errors, and imported evidence are untrusted data and are safely encoded at every output boundary.
- Authorization failures are fail-closed. A storage, membership, signature, or policy lookup error never falls back to broad access.

## 2. System and trust boundaries

The primary security boundary is the MSP organization. A customer workspace is a second, mandatory authorization scope within the organization.

| Boundary | Data crossing it | Required controls |
|---|---|---|
| Browser to Cloudflare control plane | Session, API input, rendered AWS metadata | Trusted identity termination, CSRF protection for cookie-authenticated writes, schema validation, RBAC/ABAC, rate limits, output encoding, CSP |
| Control plane to D1 | Memberships, integrations, resources, findings, audit/outbox | Parameterized queries, composite scope constraints, transactions, idempotency, migration checks |
| Control plane to Queue/Workflow | Sync and evaluation commands | Producer identity, versioned signed envelope, expiry, idempotency key, allowlisted action, DLQ |
| Cloudflare to AWS broker | Job claims and result manifests | Mutually authenticated channel, short expiry, request signature, replay protection, least-privilege broker API |
| AWS broker to customer AWS account | `AssumeRole`, read-only AWS API calls | Workload identity, unique ExternalId, verified target account, bounded session, no unregistered role ARN |
| Collector/control plane to R2 | Raw pages, manifests, evidence | Private bucket, scoped object keys, server-side encryption, checksums, content type limits, lifecycle, no public URLs |
| Application to telemetry vendors | Logs, traces, metrics | Data minimization, redaction, access control, retention limits, regional/privacy review |
| Build system to production | Code, migrations, config, artifacts | Protected branches, OIDC federation, signed artifact, provenance, separated deploy roles, approvals |

Identity headers such as `oai-authenticated-user-email` are trustworthy only when a controlled hosting ingress strips any client-supplied copy and injects the verified value. A directly reachable worker or local server must not treat an arbitrary inbound header as authentication. Production authentication needs a signed, audience-bound session and server-side membership lookup; email alone is not authorization.

## 3. Threat model

### Assets

- Customer AWS inventory, topology, tags, findings, suppressions, and exports.
- Tenant memberships, invitations, customer assignments, and privileged operator roles.
- AWS role ARNs, generated ExternalIds, broker identity, temporary STS credentials, queue-signing keys, webhook secrets, and encryption keys.
- CMDB provenance, raw snapshots, sync state, control definitions, evidence, and audit history.
- Service availability, quota, billing, product reputation, and customer trust.

### Threat actors

- An unauthenticated internet attacker.
- A legitimate client viewer or MSP analyst attempting horizontal or vertical privilege escalation.
- A malicious or compromised MSP administrator.
- An attacker controlling a customer AWS account, resource name, tag, or error message.
- A confused-deputy attacker who knows another customer's role ARN.
- A compromised build dependency, CI runner, broker, queue producer, or operator account.
- Accidental failures: stale jobs, duplicate delivery, pagination gaps, eventual consistency, throttling, schema mistakes, and operator error.

### Priority threats and required evidence

| Threat | Example attack | Prevent/detect controls | Release evidence |
|---|---|---|---|
| Cross-tenant IDOR | Change `/customers/A/resources/x` to customer B | Central authorization, opaque IDs, filter by `org_id` and `customer_id`, indistinguishable 404, no global lookup before scope check | Negative API tests across every customer-scoped route |
| Customer-scope bypass | An org analyst assigned to A requests B | Effective-scope calculation from memberships and explicit assignments | RBAC matrix tests for all roles and endpoints |
| Cache/export leak | A cached response or R2 export is served to B | Scope in cache/object key, private objects, short-lived audience-bound download token | Cache and object-token isolation tests |
| Confused deputy | Customer B submits customer A's known role ARN | Service-generated unique ExternalId; resolve it from B's integration; reject role if it can be assumed without the correct ID | Real sandbox test: correct succeeds; omitted and wrong IDs fail |
| STS parameter injection | User supplies session policy, tags, duration, source identity, or session name | Fixed server-side parameters and strict ARN parsing; no passthrough options | Unit/fuzz tests and request-capture assertion |
| Credential theft | STS secret appears in D1, R2, logs, trace, queue, or error response | Memory-only credentials, redaction, bounded session, egress limits, secret scanning | Canary-credential log/storage scan |
| Queue forgery/replay | Attacker enqueues a sync for another role or replays a destructive job | Signed/managed producer identity, nonce, expiry, DB claim, idempotency, action allowlist | Signature, expiry, replay, and swapped-scope tests |
| Snapshot poisoning | Duplicate, stale, truncated, or attacker-crafted pages become current | Manifest counts/checksums, staging, monotonic run generation, atomic promotion, size/type limits | Fault-injection and property tests |
| Stored injection | AWS tag contains HTML, CSV formula, control characters, or log delimiters | Contextual encoding, safe JSON, CSV formula neutralization, structured logging | XSS/CSV/log injection tests |
| Finding tampering | Rule change silently rewrites old evidence or suppression hides unrelated finding | Versioned immutable controls/evaluations, scoped suppressions, actor/reason/expiry, append-only audit | Re-evaluation and suppression-scope tests |
| SSRF | A URL in AWS metadata or webhook configuration is fetched by the control plane | No arbitrary URL fetch; strict destination allowlist; DNS/IP re-check; metadata IP denylist | SSRF corpus tests if URL features exist |
| Resource exhaustion | Huge account, pagination loop, sync spam, decompression bomb | Per-org quotas, concurrency limits, byte/page/time caps, bounded retries, circuit breakers | Load and adversarial pagination tests |
| Supply-chain compromise | Malicious package or CI token changes build | Lockfile, dependency review, SCA, secret scan, isolated CI, OIDC deploy, signed provenance | CI reports, SBOM, verified deployment digest |
| Privileged insider | Operator reads tenant evidence without business reason | Just-in-time support access, approval, reason, time limit, immutable audit, no shared accounts | Quarterly access review and support-access test |

## 4. Tenant and customer isolation

### Authorization model

- `org_owner` and `org_admin`: all customers in their organization; invitations and integration changes require step-up authentication in production.
- `analyst` and `viewer`: access only when their membership explicitly grants `all_customers` or a matching customer assignment. A viewer cannot start syncs, change connections, suppress findings, invite users, or export sensitive evidence unless separately granted.
- `customer_admin`, `customer_analyst`, and `customer_viewer`: explicit bindings to one or more customer workspaces; never inherit organization-wide access.
- `platform_operator`: not a tenant role. Support access is a separate just-in-time workflow with reason, approval, expiry, read-only default, and immutable audit.

Sessions use a vetted OIDC/SIWC provider with issuer, audience, nonce, state, redirect, and expiry validation. Session cookies are `Secure`, `HttpOnly`, and an appropriate `SameSite` value; session IDs rotate on sign-in and privilege change. Cookie-authenticated writes require CSRF protection. Organization owners/admins must use MFA or an IdP MFA claim before invitations, connection changes, exports, or future remediation. Authentication rate limits and generic errors must resist enumeration and credential stuffing.

Every customer-scoped table carries `org_id` and `customer_id`, including connections, accounts, runs, resources, relationships, tags, raw-snapshot manifests, evaluations, findings, suppressions, exports, audit records, and outbox/jobs. Foreign keys and uniqueness constraints include the same scope. A resource identifier alone is never globally authoritative.

Because D1/SQLite does not provide PostgreSQL-style row-level security, application enforcement and schema constraints are both mandatory. All repositories accept a non-optional typed `Scope { orgId, customerId }`. There is no unscoped `findById` helper in request or job code. Platform-wide maintenance code lives in a separate module and credential path that is not imported by public handlers.

### Isolation test strategy

Generate at least two organizations, two customers per organization, overlapping AWS account/resource names, and users in every role. For each API contract, run the same request as the owner, assigned analyst, unassigned analyst, customer user, other-org owner, suspended user, and anonymous user.

Tests must cover:

- Path IDs, query filters, request bodies, cursor tokens, bulk IDs, search, counts, facets, relationships, and nested resources.
- Reads, creates, updates, deletes, exports, invitations, connection validation, sync triggers, suppressions, and audit access.
- Background jobs with valid signatures but a mismatched `org_id`, `customer_id`, `integration_id`, `run_id`, or object key.
- Cache keys and invalidation; two tenants requesting the same URL cannot share a private response.
- R2 keys and download grants; a token is bound to actor, scope, object, purpose, and expiry and is single-use where practical.
- Error parity; unauthorized existence is not revealed through status, body, timing, counts, or autocomplete.
- Concurrency; revoking membership while a request or job waits causes the final privileged action to re-check authorization.
- Invitation takeover; normalized email matching, expiry, single use, intended organization/customer, and authenticated-email match.
- Audit coverage; denied and allowed high-risk operations record the correct actor and scope without sensitive payloads.

Any cross-organization or cross-customer disclosure is severity critical, blocks deployment, and consumes no error budget. The regression test must be added before the fix is merged.

## 5. IAM and ExternalId abuse cases

AWS recommends a unique, third-party-controlled ExternalId per customer account and explicitly recommends rejecting onboarding when the role can be assumed without the correct ID. The ExternalId is not an AWS secret, but it is a security binding and must not be user-selectable or globally reused.

### Onboarding protocol

1. Create the integration in `pending` state and generate at least 128 bits of cryptographically random ExternalId entropy. Do not derive it from org/customer IDs, email, account name, or a sequential value.
2. Render a trust-policy/CloudFormation template that names the exact vendor AWS principal and requires `StringEquals` on `sts:ExternalId`. Provide the minimum read-only permissions for only the collectors enabled in the plan.
3. Accept only a canonical IAM role ARN in a supported AWS partition. Reject STS assumed-role ARNs, users, wildcard components, control characters, and unsupported partitions.
4. From the AWS broker, call `AssumeRole` with fixed duration, a vendor-controlled restrictive read-only session policy for the enabled collectors, and a sanitized session name/source identity containing only internal, non-secret trace identifiers. The session policy is an additional permissions ceiling and is never supplied by the browser or job payload.
5. Call `GetCallerIdentity` with the temporary credentials and require its 12-digit account ID to match the account encoded by the role ARN and the integration record.
6. Negative-probe the role without ExternalId and with an unrelated random ExternalId. Both calls must fail. If either succeeds, keep the integration rejected and explain how to fix the trust policy. These probes create CloudTrail activity and should be disclosed in the onboarding UI.
7. Optionally inspect `iam:GetRole` trust/permissions when granted, but do not require that permission; behavioral STS probes are the acceptance control.
8. Mark active only after the positive and negative checks, persist the validation time and broker principal, and append an audit event. Never persist the returned STS credentials.

### Abuse-case matrix

| Case | Required behavior |
|---|---|
| User submits another tenant's role ARN | The current tenant's ExternalId is used; validation fails; no data is read; suspicious duplicate-account event is raised |
| User supplies or edits ExternalId | API ignores/rejects it; only the server-generated value is authoritative |
| Role succeeds without ExternalId | Onboarding is rejected even if the positive probe succeeds |
| Role succeeds with a wrong ExternalId | Onboarding is rejected as unsafe |
| Role returns a different account ID | Onboarding is rejected; no inventory calls are made |
| Same AWS account/role is registered twice | Cross-org duplicate blocks and alerts; same-org duplicate requires an explicit, audited ownership workflow |
| Crafted ARN changes partition or principal type | Strict parser rejects it before any AWS call; supported partition must match broker deployment |
| Job embeds a role ARN or STS options | Schema rejects extra sensitive fields; worker resolves fixed configuration by scoped integration ID |
| Session name/source identity contains tenant input | Input is replaced with a server-generated safe identifier |
| Customer role has write privileges | A fixed read-only STS session policy limits the effective session; optional policy inspection warns/rejects; documentation and templates still require a least-privilege role. Code allowlists alone are not treated as the permission boundary |
| Integration is disabled or membership revoked mid-run | Worker re-checks integration state before assume, before ingest promotion, and before retry; results are quarantined/discarded |
| ExternalId rotates | Versioned two-phase rotation supports one short overlap, revalidates, then revokes old value; every transition is audited |
| STS throttles or credentials expire | Bounded jittered retry; refresh only within the same claimed run; never fall back to base credentials or another integration |

The broker workload role must restrict `sts:AssumeRole` to the vendor's customer-role naming/path convention when feasible. The application registry is an additional allowlist: the broker cannot accept an arbitrary role ARN directly from a caller.

## 6. Secrets and sensitive-data handling

| Class | Examples | Handling |
|---|---|---|
| Critical secret | Broker workload identity material, queue/webhook signing keys, encryption keys, temporary STS secret/session token | Managed workload identity or secret manager only; never D1/R2/log/browser; least-privilege access; rotation and revocation tested |
| Sensitive security binding | ExternalId, integration ID, invitation token, download token | Random, scoped, encrypted where stored, hashed when comparison permits, redacted in general logs, short-lived for tokens |
| Tenant confidential | Role ARN, AWS account ID, inventory, tags, topology, findings, evidence | Encrypt in transit/at rest, tenant authorization, retention/deletion policy, no public objects or telemetry payloads |
| Public/configuration | Published control descriptions, product metadata | Integrity protected through reviewed source and signed builds |

Requirements:

- Use AWS workload IAM for the broker and CI OIDC for deployment. Do not create an IAM user access key for the Cloudflare worker, repository, developer laptop, or CI secret.
- Keep environment-specific keys separate. Development cannot decrypt production data or produce valid production job signatures.
- Store production secrets only in the platform secret manager/KMS binding, never `.env` files committed to source, D1 plaintext, build arguments, client bundles, or support tickets.
- Use envelope encryption for any application-level sensitive field that must be recoverable. Store key version beside ciphertext; rotation is an online, resumable operation.
- Scrub authorization headers, cookies, tokens, signatures, ExternalIds, STS responses, raw AWS errors, and request bodies before logs/traces. Use an allowlist logger rather than a denylist-only scrubber.
- Add a runtime egress allowlist for the broker and control plane where the platform supports it. Temporary credentials must not be reachable from plugins, templates, user rules, or browser code.
- Scan source, history, artifacts, source maps, images, logs from tests, and IaC for secrets. A detected real credential triggers revocation first, then history cleanup and incident review.
- Backups inherit the same encryption, access, retention, deletion, and restore-test requirements as primary data.
- Define retention by artifact: job payloads and verbose logs short; raw snapshots limited and configurable; current CMDB retained while subscribed; audit longer and immutable/exportable. Customer deletion includes D1, R2, caches, exports, and eventual backup expiry with a deletion certificate/event.

## 7. Webhook, broker, and job authenticity

### Job envelope

Use a minimal versioned envelope such as:

```json
{
  "v": 1,
  "job_id": "opaque-id",
  "action": "inventory.sync",
  "org_id": "opaque-id",
  "customer_id": "opaque-id",
  "integration_id": "opaque-id",
  "run_id": "opaque-id",
  "issued_at": "RFC3339",
  "expires_at": "RFC3339",
  "nonce": "random",
  "key_id": "job-signing-2026-01",
  "signature": "base64url"
}
```

The signature covers a canonical encoding of every field. Verify it in constant time before parsing business fields deeply. Managed queue access control is the primary producer boundary; the signature is defense in depth and mandatory across the Cloudflare-to-AWS-broker boundary. Do not include a role ARN, ExternalId, credentials, arbitrary URL, control expression, or free-form command.

The consumer then performs fresh database checks: job exists, outbox event matches, scope tuple matches, integration is active, run is current/claimable, action is allowlisted, timestamp is within skew, nonce is unused, and retry count is bounded. Claim with compare-and-swap. Store a durable idempotency result by `job_id`/`run_id`; duplicate delivery returns the prior result without another promotion. Send terminal failures to a DLQ with encrypted, redacted metadata and an operator-visible replay workflow. Replay creates a new signed job and audit event rather than editing the old message.

Broker results use the same principles: a signed manifest references pre-authorized scoped object keys, includes run ID, collector/rule version, page counts, total bytes, per-object SHA-256, start/end time, source account/partition/regions, and completion state. The control plane verifies the broker identity, manifest signature, checksums, scope, size limits, and run state before normalization.

### Inbound webhooks

Webhooks are outside the initial slice. Before adding them:

- Verify the provider's signature over the exact raw request bytes, not reserialized JSON.
- Require a signed timestamp inside a five-minute window and a unique provider event ID; persist replay decisions.
- Use a distinct secret per environment/provider/endpoint, support overlapping rotation, and compare signatures in constant time.
- Return success only after durable inbox storage; process asynchronously and idempotently.
- Enforce content type and body-size limits before parsing; reject unknown event types and schema versions.
- Never authorize a tenant solely from a payload tenant/customer field. Resolve a pre-registered endpoint/integration under server-side scope.
- Rate limit by endpoint/integration and alert on signature failures, replay attempts, and delivery storms.

## 8. CMDB and finding integrity

### Provenance and lifecycle

- A resource's stable key is `(org_id, customer_id, integration_id, partition, account_id, region_or_global, service, provider_resource_id)`. Preserve the original ARN separately; normalize only according to documented AWS rules.
- Every observation records `run_id`, `observed_at` from collection, `ingested_at` from the control plane, collector version, source account/region, content hash, and raw evidence reference/checksum.
- Collect into run-scoped staging. Promote a manifest atomically only when required collectors and pagination complete and all checksums pass. A partial run remains visible as partial but cannot mark unseen resources deleted.
- Use monotonic run generation/compare-and-swap so a late older run cannot overwrite a newer snapshot. At-least-once delivery must converge under idempotent upserts.
- Mark resources `not_seen` only after a complete run. Use a configurable grace period or multiple complete misses before `retired`; never hard-delete immediately. Preserve history needed to explain a finding.
- Relationships require both endpoints in the same scope. Reject or quarantine dangling and cross-scope edges.
- Store raw evidence as immutable objects. Corrections create a new version; they do not overwrite prior evidence. Object keys include non-guessable scoped IDs, and bucket listing/public access is disabled.

### Controls and findings

- Control definitions are versioned, reviewed source artifacts with immutable IDs, severity rationale, service/region applicability, evidence schema, and deterministic evaluator version.
- An evaluation records control version, resource content hash, input evidence hashes, result, reason, evaluated time, and evaluator version. Re-running identical inputs must produce the same result.
- A current finding is a projection over immutable evaluations, not mutable evidence. State transitions are append-only events.
- Suppressions are scoped to exact org/customer and an explicit control/resource selector. They require actor, reason, created time, optional ticket, expiry, and audit record. A broad wildcard suppression requires elevated permission and warning.
- Unsupported, inaccessible, throttled, or missing evidence yields `unknown`/`error`, never `pass`. Dashboards show coverage and collection gaps next to risk scores.
- Severity and score changes require a versioned rule release and audit. Do not silently recalculate historical results.
- Escape AWS strings in HTML. For CSV, prefix cells beginning with `=`, `+`, `-`, or `@` and quote correctly. Replace log control characters or keep values as structured fields.

Integrity monitors compare manifest totals to normalized counts, flag impossible account/partition changes, detect large deletion deltas, and sample raw-to-normalized hashes. An operator can quarantine a run and roll the current projection back to the last complete snapshot without deleting evidence.

## 9. Observability, audit, and SLOs

### Telemetry

Structured events include `request_id`, `trace_id`, internal actor ID, `org_id`, `customer_id`, integration ID, run/job ID, route/action, policy decision and reason code, latency, retry count, collector version, and outcome. Use internal opaque IDs; do not put resource names, tags, raw evidence, ExternalIds, credentials, tokens, or full provider errors in metric labels.

Audit events are separate from debug logs. They are append-only and record actor, effective role/scope, action, target, before/after hashes or safe diff, request/trace ID, time, source, outcome, and reason. Required events include sign-in/security changes, membership/invitation changes, support access, integration create/validate/rotate/disable, sync/replay/cancel, export/download, suppression, control publication, data deletion, and failed high-risk authorization. Export audit batches to immutable/WORM-capable storage with sequence and hash-chain verification; alert on gaps.

### Initial production SLOs

| Service indicator | Target | Window / note |
|---|---|---|
| Authenticated read API availability | 99.9% successful eligible requests | Rolling 30 days; exclude documented client errors |
| Authenticated write API availability | 99.5% successful eligible requests | Rolling 30 days; outbox persistence is part of success |
| Read API latency | p95 <= 750 ms, p99 <= 2 s | Server latency, per route class |
| Sync dispatch latency | 99% of accepted jobs claimed within 2 minutes | When queue and integration are healthy |
| Sync completion | 99% of eligible bounded-size accounts complete within 60 minutes | Publish account-size limits and separate AWS throttling |
| Inventory freshness | 99% of enabled healthy integrations have a complete snapshot < 24 hours old | Measured per integration; partial runs do not reset freshness |
| Finding freshness | 99% evaluated within 10 minutes of snapshot promotion | Per promoted run |
| Audit durability | 99.99% of accepted high-risk changes have durable audit/outbox records | Transactionally coupled; gaps page immediately |
| Recovery | RPO <= 15 minutes; RTO <= 4 hours for control plane state | Verify through restore exercises |

Authorization correctness and absence of cross-tenant disclosure are invariants, not availability SLOs: target 100%, with immediate incident response.

Use multi-window burn-rate alerts for availability/freshness. Page immediately for tenant-scope invariant violations, audit sequence gaps, broker signature failures above baseline, successful negative ExternalId probes, unexplained duplicate-account registration, secret canaries, or broad deletion deltas. Ticket rather than page for isolated customer IAM denial, expected throttling, and expiring optional suppressions. Dashboards need per-service health plus scoped customer diagnostics without leaking other customers' names or counts.

Run synthetic probes for sign-in, a tenant-scoped CMDB read, job enqueue/claim, fake-collector snapshot promotion, and R2 checksum verification. A separate AWS sandbox canary verifies the complete broker/STS path and both negative ExternalId probes.

## 10. CI/CD and release gates

### Every pull request

- Reproducible install from the lockfile; lint; formatting check; TypeScript `--noEmit`; production build.
- Unit and property tests for authorization policy, ARN parsing, ExternalId generation, signature canonicalization, cursor validation, idempotency, snapshot promotion, resource-key normalization, and finding evaluation.
- API contract tests and the generated tenant/RBAC isolation suite. Security-critical policy modules require 100% branch coverage; the repository overall should start at >= 80% line/branch coverage and ratchet upward.
- Migration validation against an empty database and a production-shaped fixture; constraints/indexes must include scope. Test forward migration and restore/rollback procedure.
- Secret scan of commit and repository history; dependency/SCA scan; license policy; static analysis. No unreviewed ignore/allowlist entry.
- IaC policy checks when CloudFormation/CDK/Terraform/Workers configuration changes: no public R2, wildcard deploy role, long-lived key, unencrypted queue/DLQ, unrestricted CORS, or debug binding.
- Build an SBOM and check that production dependencies are pinned through the lockfile. Critical known-exploited or reachable critical vulnerabilities block; high vulnerabilities require a time-limited signed exception.
- Tests must use fake credentials and isolated fixtures. Pull-request code from forks receives no secrets and cannot assume AWS roles.

### Merge and staging

- Protected main branch, required review, CODEOWNERS for auth/IAM/schema/crypto/IaC, resolved conversations, and no direct pushes.
- Deploy immutable artifact by digest with provenance. CI authenticates via OIDC to a narrowly scoped deploy role; no permanent cloud deploy keys.
- Run DAST/API authorization scan, browser CSP/XSS checks, accessibility smoke tests, queue retry/DLQ fault injection, backup restore, and real AWS sandbox contract tests.
- Real AWS tests assert the exact STS request fields, correct/omitted/wrong ExternalId outcomes, target `GetCallerIdentity`, temporary credential expiry, throttling behavior, and read-only policy. Test accounts contain no production data.
- Run load tests with high resource/tag/relationship cardinality and deliberate pagination duplication, truncation, out-of-order delivery, stale run completion, and large deletion delta.

### Production release

- Human approval for auth/IAM/schema/key-policy changes; reviewed migration and rollback/roll-forward plan; recent restore success; open security exception review.
- Progressive rollout with synthetic checks and automatic stop on error-budget burn, scope errors, audit gaps, or integrity alarms.
- Production configuration asserts `FAKE_COLLECTOR=false`, debug endpoints disabled, strict allowed origins, secure cookies, HSTS, CSP, no source maps containing secrets, private R2, and separate production signing/encryption keys.
- Independent penetration test before broad general availability and at least annually, plus focused review after material auth, broker, or tenant-model changes.

No release proceeds with a known cross-tenant leak, bypassable ExternalId, stored customer AWS key, unsigned broker protocol, unverified backup, or incomplete audit for privileged actions.

## 11. Acceptance-test matrix for the first runnable slice

`P0` blocks any production-like deployment. `P1` blocks a public beta but may be deferred for a clearly labeled local demo.

| ID | Area and test | Level | Expected result | Priority |
|---|---|---|---|---|
| AT-01 | Anonymous request to every private API/page | API/E2E | 401/redirect; no tenant metadata or counts in body/cache | P0 |
| AT-02 | Spoof identity headers at a directly reachable origin | Integration | Header is stripped/ignored; no authenticated session is created | P0 |
| AT-03 | User with membership in org A requests org B by path/body/query/cursor | Generated API | 404/deny with no existence leak; zero B rows returned or changed | P0 |
| AT-04 | Assigned analyst/customer user requests an unassigned customer in same org | Generated API | Denied for list, detail, search, counts, export, sync, findings, audit | P0 |
| AT-05 | Role matrix over invitations, integrations, sync, suppressions, exports, and audit | Policy/API | Only documented roles/actions succeed; suspended/revoked users fail | P0 |
| AT-06 | Revoke assignment while request/job is pending | Concurrency integration | Privileged action re-checks and aborts; audit records denial | P0 |
| AT-07 | Invitation expired/replayed/claimed by different authenticated email | E2E | Denied; no membership; attempt audited | P0 |
| AT-08 | Create AWS connection | API | Server generates unique high-entropy ExternalId; user cannot set it; pending state audited | P0 |
| AT-09 | Validate correctly configured sandbox role | AWS integration | Correct ExternalId succeeds; identity account/partition match; integration becomes active | P0 |
| AT-10 | Validate role with ExternalId omitted and wrong | AWS integration | Both negative probes fail as expected; if either succeeds, onboarding is rejected | P0 |
| AT-11 | Submit other tenant's role ARN / duplicate account | AWS integration | No inventory access; cross-org duplicate blocks and creates security signal | P0 |
| AT-12 | Capture STS request | Contract | Only registered role, server ExternalId, fixed duration, vendor read-only session policy, safe session/source identity; no user policy/tags | P0 |
| AT-13 | Search D1/R2/queue/log/trace/API response for STS canary values | Security integration | Access key, secret, and token are absent everywhere after memory disposal | P0 |
| AT-14 | Broker receives unsigned, altered, expired, replayed, or wrong-scope job | Broker integration | Rejects before STS; security metric/audit; no side effect | P0 |
| AT-15 | Duplicate valid job delivery | Job integration | One run/promotion; duplicate returns idempotent outcome; no duplicate findings | P0 |
| AT-16 | Disabled integration or stale run is delivered/retried | Job integration | No AssumeRole/promotion; message resolves safely or goes to DLQ | P0 |
| AT-17 | Complete paginated fake/AWS snapshot | Integration/E2E | Manifest/checksums validate; resources/edges/tags scoped and promoted atomically | P0 |
| AT-18 | Page missing, checksum mismatch, timeout, or collector denied | Fault injection | Run is partial/failed; last complete snapshot stays current; unknown is not pass | P0 |
| AT-19 | Older run completes after a newer run | Concurrency integration | Older run cannot overwrite current generation | P0 |
| AT-20 | Duplicate/out-of-order pages and at-least-once ingest | Property/integration | Stable normalized state; counts/hashes converge; no duplicate resources | P0 |
| AT-21 | Resource disappears in one complete vs partial run | Integration | Partial run never retires it; complete miss follows documented grace state | P0 |
| AT-22 | Relationship points across customer scope | DB/integration | Constraint or ingestion validation rejects/quarantines edge | P0 |
| AT-23 | AWS names/tags contain XSS, control chars, huge values, and CSV formulas | E2E/export | UI/log/CSV remains inert and bounded; original evidence retained safely | P0 |
| AT-24 | Deterministic control evaluated twice on identical evidence | Unit/property | Same status/reason/hash; evaluation records rule and evidence versions | P0 |
| AT-25 | Missing permission/throttled evidence | Integration | Control result is unknown/error with coverage gap, never pass | P0 |
| AT-26 | Suppression created by authorized vs unauthorized actor; expiry reached | API/job | Exact scoped finding hidden only while valid; unauthorized denied; full audit | P1 |
| AT-27 | CMDB/list/detail/findings cursors are swapped between customers | API | Cursor signature/scope validation fails; no data/count leak | P0 |
| AT-28 | R2 raw/export token copied to another user/customer or used after expiry | E2E | Access denied; private object remains undiscoverable; attempt logged | P0 |
| AT-29 | Cache warm under customer A then same route under B | E2E | B receives only B data; private responses not shared publicly | P0 |
| AT-30 | Queue retry exhaustion and DLQ replay | Fault injection | Bounded attempts; redacted DLQ record; explicit authorized replay creates new audit event | P1 |
| AT-31 | Audit/outbox write fails during high-risk mutation | Transaction integration | Mutation rolls back or remains safely uncommitted; API does not report success | P0 |
| AT-32 | Audit export sequence/hash verification | Integration | No gaps/tampering; altered event is detected | P1 |
| AT-33 | Account at published resource/page/tag limits | Load | Meets sync and API SLOs; beyond limit fails explicitly without corrupting state | P1 |
| AT-34 | Restore production-shaped encrypted backup to isolated environment | Recovery exercise | RPO/RTO met; scope constraints, manifests, and audit verification pass | P1 |
| AT-35 | Production configuration assertion | Release test | Fake collector/debug off, private R2, strict origin/cookies/CSP, unique prod keys | P0 |

### Slice exit criteria

The slice is production-shaped only when all P0 tests pass in CI/staging, no critical/high unresolved security defect lacks an approved expiry, real AWS broker tests pass in an isolated sandbox, an operator can diagnose a failed run without viewing credentials/raw sensitive values, and a restore exercise has succeeded. Until then the UI must label AWS results as simulated/demo data and must not accept a customer production role.

## 12. Security review cadence and ownership

- Threat model review for every new collector, write/remediation feature, identity provider, public API, webhook, custom rule language, or integration.
- IAM permission diff and data-flow review before enabling a new AWS service action or region/partition.
- Monthly dependency and access review; quarterly tenant-isolation suite review and support-access audit; semiannual restore and incident tabletop; annual independent penetration test.
- A security owner signs off on auth/IAM/crypto design. A data owner signs off on normalization and finding semantics. An SRE owner signs off on SLOs, paging, backup, and rollback.
- Maintain incident runbooks for cross-tenant exposure, leaked broker identity, unsafe customer trust policy, poisoned snapshot, audit gap, and queue replay storm. Cross-tenant exposure or broker compromise triggers containment, key/role revocation, evidence preservation, customer impact analysis, and notification under contractual/legal timelines.

## References

- [AWS: Access to AWS accounts owned by third parties](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_common-scenarios_third-party.html)
- [AWS: The confused deputy problem](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html)
- [AWS STS: AssumeRole API](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html)
- [AWS: Security best practices in IAM](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
- [AWS: Temporary security credentials](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp.html)
