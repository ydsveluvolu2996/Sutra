# ADV-10 — ResilienceVue

Status: **PARTIAL_PIPELINE** (local vertical complete; permanent AWS adapter and deployed provider evidence are not active)

Official AWS Cloud Intelligence Dashboards scope rechecked 2026-08-01: ResilienceVue uses daily incremental AWS Resilience Hub assessments across AWS Organizations, linked accounts, Regions, and payer views to expose application resilience posture, RTO/RPO objectives and breaches, infrastructure recommendation trends, and outstanding operational recommendations.

## Implemented local evidence path

- `lib/finops-resilience-vue.ts` defines and fail-closed normalizes the bounded read-only Resilience Hub capture. It validates scope, ARN account/partition/Region binding, pagination, completeness, timestamps, duplicates, and provider-vs-Sutra inference labels.
- `lib/finops-resilience-vue-job.ts` adds a server-owned daily incremental job/adapter contract. The job payload accepts only a UTC collection window; account/partition/Region targets and incremental cursors are server-resolved. Four workers and the existing 15-minute collection bound constrain execution.
- `drizzle/0093_finops_resilience_vue.sql` and `postgres/migrations/0088_finops_resilience_vue.sql` retain immutable generations and a monotonic accepted head per tenant, connection, account, partition, and Region. Incomplete/configuration generations remain in history and cannot displace a complete head. PostgreSQL revokes `PUBLIC` access.
- `db/finops-resilience-vue-repository.ts` validates the live AWS connection, normalizes captures against a trusted target, hashes the exact JSON, verifies it again on reads, and exposes tenant-scoped active targets and bounded history.
- `app/api/v1/finops/resilience-vue/route.ts` requires an authenticated session, resolves the connection inside the authenticated organization, checks `connection:read` for the connection customer, reads only accepted heads, supports bounded account/Region/application/posture/recommendation filters, and discloses freshness, newer incomplete attempts, provenance, and activation state.
- `app/costs/finops-resilience-vue-dashboard.tsx` is a native accessible visual with account/payer and Region filters, application search, policy posture and recommendation-kind filters, summary cards, daily evidence trends, application posture and RTO/RPO targets, policy breaches and drift, unimplemented recommendation drilldowns, formula-safe CSV, immutable evidence identifiers, and honest configuration/partial/stale/empty/failure states.

## Evidence and tests

- Existing `tests/finops-resilience-vue.test.ts` covers the 14-operation read-only surface, source normalization, tenant/account/partition/Region substitution, pagination replay, duplicate conflict, empty/configuration/partial/stale states, inference separation, bounds, freshness, and query-service source failures.
- `tests/finops-resilience-vue-vertical.test.mjs` covers immutable complete-only target heads, replay safety, cross-tenant isolation, incomplete-head protection, mutation guards, daily server-owned job inputs/cursors, authenticated route contracts, SQLite/PostgreSQL parity and revokes, and server-rendered visual coverage.

## Activation and live gaps

The local vertical intentionally reports `RESILIENCE_VUE_AWS_ADAPTER_JOB_HANDLER_NOT_REGISTERED`. A real credential-broker adapter still must implement and provider-validate the declared read operations, Organizations account/Region target enumeration, retries/throttling, scheduler registration, and runtime secrets/role binding. Until a deployed job produces signed provider evidence, this dashboard is **not** `LOCAL_VERIFIED`, `DEPLOYED`, or `LIVE_VERIFIED`; it must not claim actual tenant resilience posture.
