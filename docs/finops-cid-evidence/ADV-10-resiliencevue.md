# ADV-10 — ResilienceVue

Status: **PARTIAL_PIPELINE** (local vertical and permanent runtime binding contract complete; authenticated AWS adapter registration and deployed provider evidence are not active)

Official AWS Cloud Intelligence Dashboards scope rechecked 2026-08-01: ResilienceVue uses daily incremental AWS Resilience Hub assessments across AWS Organizations, linked accounts, Regions, and payer views to expose application resilience posture, RTO/RPO objectives and breaches, infrastructure recommendation trends, and outstanding operational recommendations.

## Implemented local evidence path

- `lib/finops-resilience-vue.ts` defines and fail-closed normalizes the bounded read-only Resilience Hub capture. It validates scope, ARN account/partition/Region binding, pagination, completeness, timestamps, duplicates, and provider-vs-Sutra inference labels.
- `lib/finops-resilience-vue-job.ts` adds a server-owned daily incremental job/adapter contract. The job payload accepts only a UTC collection window; account/partition/Region targets and incremental cursors are server-resolved. Four workers and the existing 15-minute collection bound constrain execution.
- `lib/finops-resilience-vue-runtime-binding.ts` closes the local permanent scheduler/handler boundary. The daily scheduler enumerates eligible connections from trusted server state and enqueues only `{ scheduledWindow }`; the durable handler reloads the tenant connection and every account/partition/Region target before any provider call. Each target receives a deterministic target/window request identity that remains stable if the incremental cursor advances during queue replay, the exact 14-operation read-only surface, a 100-item page size, 20,000-page ceiling, pagination-token replay rejection, required exhaustion evidence, archive-safe 11 MiB runtime capture ceiling, four-worker limit, and one 15-minute abort window.
- The runtime binding canonicalizes the exact provider request and capture, archives it as `finops_source_snapshot`, derives a content-addressed `fss_...` evidence generation, seals the object reference with tenant/customer/connection/source/generation AAD, and requires the application handoff to durably bind that immutable reference to the normalized `rvg_...` snapshot. An accepted request identity is replayed without another AWS call, archive, or persistence write. Provider messages and ARNs are never copied to durable failure metadata; only the bounded generic failure code is handed off.
- `drizzle/0093_finops_resilience_vue.sql` and `postgres/migrations/0088_finops_resilience_vue.sql` retain immutable generations and a monotonic accepted head per tenant, connection, account, partition, and Region. Incomplete/configuration generations remain in history and cannot displace a complete head. PostgreSQL revokes `PUBLIC` access.
- `db/finops-resilience-vue-repository.ts` validates the live AWS connection, normalizes captures against a trusted target, hashes the exact JSON, verifies it again on reads, and exposes tenant-scoped active targets and bounded history.
- `app/api/v1/finops/resilience-vue/route.ts` requires an authenticated session, resolves the connection inside the authenticated organization, checks `connection:read` for the connection customer, reads only accepted heads, supports bounded account/Region/application/posture/recommendation filters, and discloses freshness, newer incomplete attempts, provenance, and activation state.
- `app/costs/finops-resilience-vue-dashboard.tsx` is a native accessible visual with account/payer and Region filters, application search, policy posture and recommendation-kind filters, summary cards, daily evidence trends, application posture and RTO/RPO targets, policy breaches and drift, unimplemented recommendation drilldowns, formula-safe CSV, immutable evidence identifiers, and honest configuration/partial/stale/empty/failure states.

## Evidence and tests

- Existing `tests/finops-resilience-vue.test.ts` covers the 14-operation read-only surface, source normalization, tenant/account/partition/Region substitution, pagination replay, duplicate conflict, empty/configuration/partial/stale states, inference separation, bounds, freshness, and query-service source failures.
- `tests/finops-resilience-vue-vertical.test.mjs` covers immutable complete-only target heads, replay safety, cross-tenant isolation, incomplete-head protection, mutation guards, daily server-owned job inputs/cursors, authenticated route contracts, SQLite/PostgreSQL parity and revokes, and server-rendered visual coverage.
- `tests/finops-resilience-vue-runtime-binding.test.ts` covers identity-only trusted scheduling, exact operations and pagination/timeout/capture bounds, canonical immutable evidence archival and sealing handoff, deterministic at-least-once replay, explicit unregistered state, cross-tenant and capture substitution rejection, archive-hash rejection, and sanitization of raw provider failures.

## Activation and live gaps

The local vertical intentionally reports `RESILIENCE_VUE_AWS_ADAPTER_JOB_HANDLER_NOT_REGISTERED`, and `RESILIENCE_VUE_RUNTIME_BINDING.registeredInSharedRuntime` remains `false`.

Exact remaining provider/live gates:

1. Implement and register the authenticated credential-broker adapter for the declared 14 Resilience Hub reads, including AWS retry/throttling behavior within the frozen page, byte, concurrency, and 15-minute bounds.
2. Bind the server-owned eligible-connection resolver and Organizations-aware account/Region target resolver. Prove disabled/suspended accounts, unsupported Regions, partition routing, and incremental cursors cannot be supplied by a request body.
3. Implement the permanent immutable-handoff port so the archived/sealed `fss_...` evidence lineage and normalized `rvg_...` snapshot are committed atomically or recoverably under one deterministic request identity.
4. Register `finops-resilience-vue-daily-collect` in the shared durable handler registry and bind the daily scheduler, queue, evidence archive, key service, runtime role/session broker, and observability. Shared registry files were deliberately not changed by this isolated closure.
5. Run controlled live acceptance in every supported partition against representative accounts/Regions: exhaust multi-page applications, policies, assessments, components, recommendations, resources and drift; reproduce the retained record counts independently; prove token replay, timeout, cross-tenant, forged-scope and least-privilege denial behavior; retain signed evidence and exercise rollback.

Until those gates pass, this dashboard is **not** `LOCAL_VERIFIED`, `DEPLOYED`, or `LIVE_VERIFIED`; it must not claim actual tenant resilience posture.
