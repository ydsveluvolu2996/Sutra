# Production acceptance evidence (AT-01 through AT-35)

Status date: 2026-07-30
Source of truth: `README.md` **Production hold: P0 gates** and
`docs/security-and-quality.md` **Acceptance-test matrix**.

This matrix is intentionally not a release approval. `CODE-PASSED` means the
named deterministic test passed against this source tree. `CODE+LIVE` means the
local/contract portion passed but the acceptance criterion still requires a
deployed environment, disposable AWS account, load run, recovery exercise, or
independent review. `GAP` means a required product path is not complete. Any P0
row that is not `CODE-PASSED` keeps the production hold in force.

| ID | Current evidence | Status and remaining acceptance work |
| --- | --- | --- |
| AT-01 | `private-page-proxy.test.ts`, `rendered-html.test.mjs`, `local-auth.test.ts`, `hosted-session-lifecycle.test.mjs`, `public-api.test.ts`, deployment boundary tests | **CODE+LIVE (P0):** the generated page inventory is deny-by-default behind durable session validation; forged cookies and dynamic-extension paths redirect with an empty no-store response, while private APIs retain their own authentication. Run the same generated anonymous page/API probes against the final deployment and compare bodies/cache headers for metadata leaks. |
| AT-02 | `api-auth-header-spoof.test.ts`, `deployment-security.test.ts` | **CODE-PASSED:** session auth accepts only the sealed session cookie; forwarded identity headers do not create a session. Final directly reachable origin probe remains part of AT-01. |
| AT-03 | `tenant-isolation.test.mjs`, `tenant-client-scope.test.mjs`, `enterprise-connection-scope-contract.test.mjs`, `hosted-broker-ingest-job.test.mjs` | **CODE-PASSED:** organization/customer lookup, route, job, and public-API connection selection are exact-scope and negative tested. |
| AT-04 | `tenant-client-scope.test.mjs`, `customer-scoped-membership.test.mjs`, `api-token-repository.test.mjs`, `saved-report-repository.test.mjs` | **CODE-PASSED:** same-org unassigned customer reads/writes and token/export sources are denied. Final browser matrix is covered by AT-01. |
| AT-05 | `local-auth.test.ts`, `customer-scoped-membership.test.mjs`, `recovery-administration-repository.test.mjs`, `finding-exception-repository.test.mjs` | **CODE+LIVE (P0):** central role/grant policy and high-risk repositories pass. Run the final generated route-by-role matrix, including suspended/revoked sessions, against the production artifact. |
| AT-06 | `scim-lifecycle.test.mjs`, `job-queue-connection-scope.test.mjs`, hosted broker scope tests | **CODE+LIVE (P0):** SCIM suspension revokes sessions atomically and scoped jobs reject ownership changes. Inject assignment revocation between claim/assume/promotion in the deployed broker. |
| AT-07 | `identity-invitation-contract.test.mjs`, `password-invitation-accept.test.mjs`, `hosted-session-lifecycle.test.mjs` | **CODE-PASSED:** expiry, exact email, one-time claim, invitation-only provisioning, and atomic membership are tested. |
| AT-08 | `aws-pilot-security.test.ts`, `local-operations-repository.test.mjs` | **CODE-PASSED:** 192-bit server ExternalId, client trust-field rejection, encrypted storage, and atomic pending audit pass. |
| AT-09 | `role-broker.test.ts`, `job-handler.test.ts` | **CODE+LIVE (P0):** exact positive STS/identity/role-attestation contract passes with fakes. Must pass in the designated disposable AWS sandbox from the deployed workload role. |
| AT-10 | `role-broker.test.ts` missing/wrong/prefix-wildcard probes | **CODE+LIVE (P0):** fail-closed negative-probe logic passes. Must capture correct/omitted/one-character-wrong outcomes against the sandbox role. |
| AT-11 | `aws-global-ownership.test.mjs`, D1 `0073`/PostgreSQL `0068`, account/partition and cross-tenant broker/job tests | **CODE-PASSED:** tenant-global live account and canonical role claims are unique under races; cross/same-org reuse returns a generic conflict, emits a requester-scoped security signal, and never mutates the pending foreign connection. |
| AT-12 | `role-broker.test.ts`, `job-handler.test.ts`, customer-role artifact/permission tests | **CODE-PASSED:** stored role/ExternalId, safe session identity, fixed duration/session policy, and no caller policy/tags are contract tested. |
| AT-13 | `fixture-inventory.test.ts`, `job-handler.test.ts`, repository secret scan, secret redaction tests | **CODE+LIVE (P0):** response/persistence fixtures exclude canaries. Search final D1/Postgres, evidence bucket, queue/DLQ, logs/traces, image, and support export after a real sandbox run. |
| AT-14 | `hosted-broker-request-security.test.ts`, `hosted-broker-ingest.test.mjs` | **CODE-PASSED:** unsigned/tampered/stale/future/replayed/wrong-scope/oversized requests fail before work; nonce reservation is atomic. |
| AT-15 | durable queue idempotency tests, `hosted-collector-job.test.mjs`, snapshot idempotency contracts | **CODE+LIVE (P0):** code paths converge. Redeliver the exact final queue message concurrently in staging and prove one STS run/head/finding projection. |
| AT-16 | `job-queue-connection-scope.test.mjs`, `local-operations-repository.test.mjs`, durable queue stale-lease tests | **CODE+LIVE (P0):** disabled/stale local jobs fail closed. Inject disablement and stale retry in the deployed queue/broker. |
| AT-17 | `pilot-boundary.test.ts`, `local-operations-repository.test.mjs`, collector pagination suites | **CODE+LIVE (P0):** complete fixture publication is checksum/scoped/atomic. Run a fully paginated real sandbox snapshot through the hosted evidence path. |
| AT-18 | `pilot-boundary.test.ts`, `local-operations-repository.test.mjs`, collector repeated-token/deadline/denial tests | **CODE-PASSED:** partial/failed evidence cannot replace the complete head and unknown is not pass. Hosted fault injection remains part of AT-17. |
| AT-19 | local CMDB publication and Kubernetes/DSPM older-head rejection tests | **CODE+LIVE (P0):** monotonic repository contracts pass. Race two real hosted completions in reverse order. |
| AT-20 | collector repeated-page/token tests, idempotent repositories, deterministic resource normalization | **CODE+LIVE (P0):** duplicate evidence converges locally. Run generated duplicate/out-of-order page property cases through hosted ingest. |
| AT-21 | `resource-retirement.test.mjs`, `aws-pilot-security.test.ts`, D1 `0074`/PostgreSQL `0069` | **CODE-PASSED:** partial/failed runs and rolled-back publication never increment misses; the first complete miss stays live as `retirement_pending` with its last observed immutable evidence/checksums; only the configured threshold retires it; reappearance resets it; stale completion cannot move the head/state or publish change history; public API, report, export, and dashboard projections expose the pending lifecycle under exact tenant scope. |
| AT-22 | `pilot-boundary.test.ts`, `cmdb-relationship-repository.test.mjs` | **CODE-PASSED:** dangling snapshot edges and cross-organization manual edges are rejected. |
| AT-23 | `safe-csv.test.ts`, `report-builder.test.ts`, snapshot input bounds, rendered/security-header tests | **CODE-PASSED:** every product CSV producer uses the shared formula-neutralizing RFC-4180 encoder; payload bounds and React/CSP output controls are tested. Final browser payload probe is included in AT-01. |
| AT-24 | `security-controls.test.ts`, compliance/control-engine determinism tests | **CODE-PASSED:** identical evidence produces stable status/reason and versioned control provenance. |
| AT-25 | `security-controls.test.ts`, collector denial/coverage tests, compliance partial-evidence tests | **CODE-PASSED:** missing/denied/throttled/partial evidence yields unknown/error/gap, never pass. |
| AT-26 | compliance/finding exception evaluator, repository, route, expiry and tenant-isolation tests | **CODE-PASSED (P1):** authorized exact-scope exception lifecycle and expiry are audited and negative tested. |
| AT-27 | `public-api.test.ts`, all paginated public routes, `tenant-client-scope.test.mjs` | **CODE-PASSED:** cursors are HMAC-bound to bearer token, organization, customer, and collection; swap/tamper attempts return `INVALID_CURSOR`. |
| AT-28 | `evidence-object-store.test.ts`, `evidence-repository.test.mjs`, `evidence-managed-contract.test.mjs`, D1 `0075`/PostgreSQL `0070` | **CODE-PASSED:** exact authenticated live snapshot bytes are archived before promotion; exports are canonical managed objects; production uses a private SSE-KMS S3 bucket with retention-aligned expiry and no list/delete/presign path; app-streamed grants are short-lived, digest-only, actor/org/customer/object/purpose-bound and atomically single-use; replay/wrong-scope/tampered-byte paths fail generically and are audited. |
| AT-29 | Worker forces `Cache-Control: no-store` for every API; shared JSON helpers and public API do the same | **CODE+LIVE (P0):** source contract prevents shared API caching. Warm the final CDN/origin under customer A and request as B to prove response/body isolation. |
| AT-30 | queue retry/DLQ tests and local outbox audited recovery/replay tests | **CODE+LIVE (P1):** bounded attempts and local audited recovery pass. Exercise hosted DLQ exhaustion and authorized replay with redacted provider records. |
| AT-31 | `local-operations-repository.test.mjs`, `security-event-persistence-contract.test.mjs`, recovery/customer-assignment atomic-audit tests | **CODE-PASSED:** forced audit failures roll back onboarding, role registration, disablement, trust-secret destruction, security-event publication, and governed scope mutations. |
| AT-32 | `audit-export-integrity.test.mjs`, D1 `0072`/PostgreSQL `0067`, owner-only `/api/v1/audit/export` | **CODE-PASSED (P1):** export writes its own event, verifies every digest/link, detects changed evidence/actor type/hash/gaps, is org scoped, and never caches. Legacy v1 rows remain explicitly identifiable/exportable; all new v2 hashes cover actor type. WORM replication is an operations gate. |
| AT-33 | bounded queue/body/inventory/report tests | **CODE+LIVE (P1):** limits fail explicitly in code. Execute published maximum-cardinality load and above-limit cases and retain SLO evidence. |
| AT-34 | `local-data-backup.test.mjs`, `backup-contract.test.mjs`, HA backup IaC contract, recovery-objective tests | **CODE+LIVE (P1):** encrypted/tamper-detecting local restore and production backup design pass. Perform an isolated production-shaped restore and record measured RPO/RTO plus chain/scope checks. |
| AT-35 | `deployment-security.test.ts`, `production-ha-infrastructure.test.mjs`, release workflow/security tests | **CODE+LIVE (P0):** deny-by-default hosted switches, strict origin/cookies/CSP, managed secrets, private encrypted storage and immutable digests are asserted in source. Run assertions against the final deployed task definition, bucket policy, edge, and distinct production key IDs. |

## Supplemental P2 closure ledger

The authoritative AT-01 through AT-35 matrix defines only P0 and P1. The P2 IDs
below track non-blocking hardening and product-maturity work without reclassifying
or lowering any AT priority. `SOURCE-CLOSED` means the named deterministic
contracts passed in this source tree; `LIVE-OPEN` requires retained evidence from
the selected deployed environment or provider; `PRODUCT-GAP` is not part of the
bounded release and is not closed.

| ID | Scope and source evidence | Source state | External or remaining closure |
| --- | --- | --- | --- |
| P2-01 | Hosted navigation, real route wiring and truthful empty/simulated states: `navigation-config.test.ts`, `live-ui-contract.test.ts`, `portfolio-presentation.test.ts`, `alert-metrics.test.ts`, `public-marketing-evidence-contract.test.ts` | **SOURCE-CLOSED** | **LIVE-OPEN:** run the final deployed multi-role browser, accessibility and no-placeholder sweep. This does not replace AT-01, AT-05 or AT-29. |
| P2-02 | Optional provider plumbing for SAML, SCIM, managed ITSM credentials, current-version bidirectional ITSM evidence and durable notifications: `hosted-saml-contract.test.mjs`, `scim-migration-contract.test.mjs`, `itsm-managed-paths-contract.test.mjs`, `itsm-delivery-evidence-contract.test.mjs`, `notification-outbox-contract.test.mjs` | **SOURCE-CLOSED** | **LIVE-OPEN:** configure the selected IdP and vendor sandboxes; retain login/provisioning, delivery, inbound-signature, replay, rotation, retry and outage evidence. Any provider promised for launch remains subject to the higher applicable P0/P1 gate. |
| P2-03 | Opt-in agentless broker state, reconciliation and teardown ownership: `hosted-agentless-runtime-contract.test.mjs` | **SOURCE-CLOSED** | **LIVE-OPEN:** complete an approved AWS sandbox scan, validate findings and teardown, prove billable resources returned to zero, and retain operator attestation. |
| P2-04 | Retention-safe operational cleanup: `retention-policy.test.ts`, production backup/observability IaC and runbooks | **SOURCE-PARTIAL** | **LIVE-OPEN:** approve customer retention/deletion policy and exercise deletion, restore, alert response, support access and incident workflows in the selected environment. |
| P2-05 | Broader service depth, ecosystem integrations, billing-grade reconciliation, general remediation/DSPM and managed detection/response | **PRODUCT-GAP** | Tracked in the [cloud-operations capability roadmap](cloudaware-parity-roadmap.md); these capabilities must not be described as delivered or accepted by this release. |

The supplemental P2 ledger is therefore **not fully closed**: source contracts are
closed only where stated, while live activation and product-gap rows remain open.
An unspecified P2 request must first receive an owner, measurable acceptance
criterion and evidence location before it can be marked closed.

## Focused verification commands

Run from the repository root:

```bash
node --test --test-concurrency=1 \
  tests/tenant-isolation.test.mjs \
  tests/tenant-client-scope.test.mjs \
  tests/customer-scoped-membership.test.mjs \
  tests/api-auth-header-spoof.test.ts \
  tests/api-token-repository.test.mjs \
  tests/public-api.test.ts \
  tests/audit-export-integrity.test.mjs \
  tests/evidence-object-store.test.ts \
  tests/evidence-repository.test.mjs \
  tests/evidence-managed-contract.test.mjs \
  tests/resource-retirement.test.mjs \
  tests/local-operations-repository.test.mjs \
  tests/security-event-persistence-contract.test.mjs \
  tests/safe-csv.test.ts

pnpm --dir services/aws-collector test

node --test \
  tests/deployment-security.test.ts \
  tests/production-ha-infrastructure.test.mjs \
  tests/backup-contract.test.mjs \
  tests/local-data-backup.test.mjs \
  tests/recovery-objectives.test.ts
```

The release pipeline must additionally pass typecheck, lint, build, secret/SCA,
IaC/image scans, database migrations, real PostgreSQL tests, and the external
acceptance work above. A passing source suite does not substitute for AWS
sandbox probes, a restore exercise, load testing, CDN isolation testing, or an
independent penetration test.
