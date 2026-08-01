# ADV-11 — AWS End User Computing

Status: **PARTIAL_PIPELINE (local vertical)**. This change adds a permanent-job
contract, immutable accepted-head persistence, authenticated same-tenant API,
and a native accessible dashboard. It does not claim a deployed AWS adapter or
live customer evidence.

## Official dashboard coverage

| Official UI area | Local implementation | Honest gap |
|---|---|---|
| Three-month service/cost summary and top accounts | Current accepted CUR2 cost bases by service/currency, resource totals, billing lineage, and immutable snapshot history | Rolling three-month daily/monthly cost facts and cost-ranked accounts are not materialized yet |
| WorkSpaces insights | Point-in-time state, running mode, connection state, bundles, account/Region resources, and canonical cost/usage evidence | Protocol and OS dimensions are absent from the accepted source contract and are not guessed |
| WorkSpaces usage/logons | Connected/disconnected/unknown/missing and AlwaysOn review signals | Per-user last logon, low-use, never-used, and named-user views are excluded by the current privacy boundary |
| Optional CloudWatch metrics | Observed/partial/stale/unknown evidence for every metric in the engine, with sample/window lineage retained | CPU, memory, disk, and uptime need approved AWS dimensions if not present in the current contract |
| AppStream 2.0 overview | Fleet/stack inventory, capacity, aggregate active/pending/expired and connected/not-connected sessions, metrics, and costs | No user, session, instance, IP, or raw provider object crosses the broker |
| Cost optimization opportunities | Clearly labeled review queues for AlwaysOn/disconnected WorkSpaces and stopped fleets | Signals are not savings estimates; authoritative recommendation ingestion remains separate |

## End-to-end assets

- Pure fail-closed evidence engine: `lib/finops-end-user-computing.ts`
- Credential-free signed-broker job contract:
  `lib/finops-end-user-computing-collector-job.ts`
- Immutable repository: `db/finops-end-user-computing-repository.ts`
- SQLite migration: `drizzle/0094_finops_end_user_computing.sql`
- PostgreSQL migration: `postgres/migrations/0089_finops_end_user_computing.sql`
- Same-tenant API: `app/api/v1/finops/end-user-computing/route.ts`
- Native UI: `app/costs/finops-end-user-computing-dashboard.tsx`

The active head advances only for a newer `READY` snapshot. Partial, stale,
and unavailable generations remain immutable history and cannot replace the
last accepted complete head. Stored JSON is hashed and rebound to generation,
tenant, connection, partition, capture, state, observation time, and bounded
record counts when materialized.

The API resolves the connection from the authenticated organization and checks
`connection:read` for the connection customer. It accepts no organization or
customer identifier. Account and Region filters are validated again by the
engine against the persisted server boundary.

## Privacy and source separation

The job request hard-codes all privacy flags false for user, session, instance,
network, and raw-provider data. AppStream activity is aggregated before the
broker. WorkSpaces user names and last-user timestamps are not accepted. The
UI therefore renders the official logon views as explicitly unavailable
instead of manufacturing user classifications.

Inventory/activity is AWS control-plane evidence, performance is CloudWatch
evidence, and cost is one active exactly reconciled CUR2 generation. The engine
sets `crossSourceInference: false`; a disconnected resource is not called
unused and a missing metric is never displayed as zero.

## Activation gates still open

1. Register SQLite 0094 and PostgreSQL 0089 in shared runtime migration lists.
2. Register PostgreSQL 0089 in the deployment migrator.
3. Wire the component and catalog maturity in the shared FinOps navigation.
4. Deploy a signed temporary-credential AWS broker implementing the eight
   bounded read operations and live-simulate unavoidable wildcard permissions.
5. Bind canonical CUR2 EUC classification and schedule collection.
6. Add the rolling three-month aggregate store and approved privacy-preserving
   protocol/OS/logon aggregate contract (or retain the explicit unavailable UI).
7. Run multi-account/Region live acceptance, including pagination, throttling,
   denied optional metrics, empty fleets, stale evidence, and tenant attacks.

Until those gates pass, `collection.providerAdapterAvailable` is `false` with
reason `EUC_SIGNED_BROKER_ADAPTER_NOT_DEPLOYED`; this vertical must not be
reported as locally verified or live.
