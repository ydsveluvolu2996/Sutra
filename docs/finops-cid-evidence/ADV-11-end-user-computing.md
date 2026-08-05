# ADV-11 — AWS End User Computing

Status: **PARTIAL_PIPELINE (local vertical)**. This vertical has a permanent-job
contract, failure-isolated scheduler facade, immutable accepted-head
persistence, authenticated same-tenant API, and a native accessible dashboard.
It does not claim a deployed AWS adapter or live customer evidence.

## Official dashboard coverage

The exact pinned AWS CID definition at commit
`f9e36d88c47709f10e8fa784ad11d5cc0e728021` contains 7 sheets, 82 visuals,
and 24 controls. The complete sheet/control/visual title inventory and local
mapping is recorded in
[`ADV-11-official-definition-audit.md`](ADV-11-official-definition-audit.md).

The configuration-required and report-bearing API responses return the same
frozen definition. The UI validates its schema, commit, artifact hash, counts,
and seven-sheet inventory, then renders it independently during disconnected,
loading, configuration-required, failed, and report states without inventing
EUC inventory, activity, performance, cost, or savings evidence.

| Official UI area | Local implementation | Honest gap |
|---|---|---|
| Three-month service/cost summary and top accounts | Current accepted CUR2 cost bases by service/currency plus server-side linked-account and Region cost breakdowns, resource totals, billing lineage, and immutable snapshot history | Rolling three-month daily/monthly cost facts, payer aliases, and account names are not materialized yet |
| WorkSpaces insights | Point-in-time state, running mode, connection state, and complete server-side account/Region/bundle aggregates independent of resource paging | Protocol and OS dimensions are absent from the accepted source contract and are not guessed |
| WorkSpaces usage/logons | Connected/disconnected/unknown/missing and AlwaysOn review signals | Per-user last logon, low-use, never-used, and named-user views are excluded by the current privacy boundary |
| Optional CloudWatch metrics | Observed/partial/stale/unknown evidence for every metric in the engine, with sample/window lineage retained | CPU, memory, disk, and uptime need approved AWS dimensions if not present in the current contract |
| WorkSpaces Applications summary | Fleet/stack inventory, capacity, aggregate active/pending/expired and connected/not-connected sessions, fleet type/state/account/Region aggregates, metrics, and costs | No user, session, instance, IP, or raw provider object crosses the broker |
| Cost optimization opportunities | Clearly labeled review queues for AlwaysOn/disconnected WorkSpaces and stopped fleets | Signals are not savings estimates; authoritative recommendation ingestion remains separate |

## End-to-end assets

- Pure fail-closed evidence engine: `lib/finops-end-user-computing.ts`
- Pinned official inventory: `lib/finops-end-user-computing-official-definition.ts`
- Credential-free signed-broker job contract:
  `lib/finops-end-user-computing-collector-job.ts`
- Permanent server runtime/scheduler binding:
  `lib/finops-end-user-computing-runtime-binding.ts`
- Exact-byte Ed25519 transport:
  `lib/finops-end-user-computing-signed-broker.ts`
- Immutable runtime attempt ledger:
  `db/finops-end-user-computing-runtime-attempt-repository.ts`,
  `drizzle/0110_finops_euc_runtime_attempts.sql`, and
  `postgres/migrations/0105_finops_euc_runtime_attempts.sql`
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

The runtime queue contains only a scheduler-owned window. The app reloads the
exact tenant, connection, partition, account/Region boundary, and active CUR2
lineage from server state. The signed request pins the CUR2 generation,
manifest, billing period, row counts, and SHA-256 of the ordered
privacy-minimized EUC cost projection. When CUR2 is unavailable, the response
must contain null billing evidence and no cost rows; unavailable is never
converted into zero cost. Broker responses are verified over their exact bytes
before parsing and normalized again before immutable publication.

The scheduler validates the entire eligible boundary inventory before any
enqueue, rejects duplicate connection scope, sorts deterministically, caps the
tick at 10,000 connections, and uses bounded concurrency. A queue rejection for
one connection does not suppress other tenant submissions; only aggregate
submitted/rejected counts leave the detailed scheduler boundary. Discovery and
queue adapter detail are reduced to generic runtime outcomes.

Focused verification result: **22/22 tests passed**, with zero failures,
skips, or cancellations. Full TypeScript checking, scoped ESLint, and exact
diff hygiene also passed on this local tree.

## Activation gates still open

1. Register `finops.end-user-computing.collect`, the durable handler factory,
   and six-hour scheduler. Until then the binding reports
   `EUC_SIGNED_BROKER_RUNTIME_NOT_REGISTERED`.
2. Provision the managed HTTPS broker origin, application signing key, broker
   response verification key, replay store, and rotation identifiers.
3. Deploy a signed temporary-credential AWS broker implementing the eight
   bounded read operations and live-simulate unavoidable wildcard permissions.
4. Bind and acceptance-test the active reconciled CUR2 EUC projection loader,
   including its ordered cost digest and unavailable state.
5. Add the rolling three-month aggregate store and approved privacy-preserving
   protocol/OS/logon aggregate contract (or retain the explicit unavailable UI).
6. Run multi-account/Region live acceptance, including pagination, throttling,
   denied optional metrics, empty fleets, stale evidence, and tenant attacks.

Until those gates pass, the existing API and runtime binding remain honestly
unavailable with `EUC_SIGNED_BROKER_RUNTIME_NOT_REGISTERED`. This vertical must
not be reported as deployed or live verified.
