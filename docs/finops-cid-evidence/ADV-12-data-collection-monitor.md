# ADV-12 — Data Collection Monitor

Status: `NATIVE_FUNCTIONAL_WITH_PROVIDER_GAPS`; runtime activation is not claimed.

Reviewed 2026-08-01 against the official AWS
[Data Collection Monitor](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/data-collection-monitor.html),
[Data Collection architecture](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/data-collection.html),
[ListExecutions API](https://docs.aws.amazon.com/step-functions/latest/apireference/API_ListExecutions.html),
and [DescribeExecution API](https://docs.aws.amazon.com/step-functions/latest/apireference/API_DescribeExecution.html).
AWS documents that the monitor is based on Step Functions execution
instrumentation, provides execution/error links, and treats recent API results
as eventually consistent. Those limits remain explicit in Sutra.

Pinned definition audit: CID framework commit
`f9e36d88c47709f10e8fa784ad11d5cc0e728021`,
<https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/blob/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/data-collection-monitor/data-collection-monitor.yaml>.
The repository publishes one dashboard-specific file. It contains the manifest,
the complete QuickSight definition as an embedded `data` block, the
`data_collection_logs` dataset template, and its SQL view query. There is no
separate definition file, dashboard changelog, or dashboard-specific deployment
template at this commit. Deployment uses the generic CID framework mechanisms.

| Published artifact | Extraction/hash basis | SHA-256 |
|---|---|---|
| `dashboards/data-collection-monitor/data-collection-monitor.yaml` | Raw file bytes | `20412bfd4552f844d866e95ebeb9e42b7586ead1df82ef6da7d97234477d8a29` |
| Embedded QuickSight definition `dashboards.DATA COLLECTION MONITOR.data` | Exact UTF-8 bytes of decoded YAML block scalar | `0d4f19541870585d84e1df8ec2ac9bfbed5f42199c6d19fbe6c3104fa2f3e943` |
| Embedded dataset template `datasets.data_collection_logs.data` | UTF-8 canonical JSON with recursively sorted object keys | `6e225a65e7c31a9337b8dc66256c5ab84a7035a0a863664e087c5c3956fadc10` |
| Embedded SQL view query `views.data_collection_logs.data` | Exact UTF-8 bytes of decoded YAML block scalar | `0bc9ff20a740dc1e2085e801443ede197f2b8c400ec92824f082fa1e07e0e6c9` |

The embedded definition is complete, so exact totals are available rather than
`null`: **2 sheets, 10 visuals, 4 parameter controls, 2 filter controls, 5
parameter declarations, 21 calculated fields, 15 filter groups, 1 column
configuration, and 1 dataset declaration**. The visual histogram is 2 bar
charts, 4 tables, 3 KPIs, and 1 pivot table.

| Official sheet | Exact visual inventory | Exact control placements | Native mapping / gap |
|---|---:|---|---|
| Main | 10: 2 bar, 4 table, 3 KPI, 1 pivot | Parameters: Status Category (List), Log Links Mode (List), Account ID (Dropdown), Days back (Slider). Filters: Module (Dropdown), Payer ID (Dropdown). | Module, status, time window, execution history, retries, latency, coverage, and validated Step Functions links are native. Account/payer remain server-pinned; raw parameters/logs and Lambda links are excluded; exact geometry is not reproduced. |
| About | 0 | None | Immutable artifacts, collection state, limitations, and source boundary are native. No screenshot inference is used. |

The official definition has **Main** and **About** sheets. Main controls include
Module, Payer ID, Status Category, Account ID, Days back and Log Links Mode.
Its visuals cover latest module execution state, status families, duration,
parameters and guarded Lambda/Step Functions log links. Sutra now provides
Module, Status Category, Days back and Log Links Mode controls over normalized
execution evidence; Payer/account scope remains server-pinned rather than a
client-selectable tenant boundary, and raw parameters/log payloads remain
excluded by design.

| Gate | Status | Evidence / remaining work |
|---|---|---|
| G1 official inventory | `VERIFIED` | Manifest and every embedded definition/dataset/query artifact are pinned and hashed; exact sheet/visual/control/parameter/calculated-field/filter-group/dataset counts are arithmetically tested. |
| G2 source contract | `LOCAL_COMPLETE` | Metadata-only, tenant-pinned Standard Step Functions execution evidence with bounded pagination. |
| G3 durable runtime | `LOCAL_COMPLETE_CONTRACT` | Hourly identity, leases, receipt verification and sanitized failures; shared registration/provider client remain open. |
| G4 persistence/API | `LOCAL_COMPLETE` | Immutable accepted history, authenticated same-tenant route, and frozen official audit in both successful API states. |
| G5 UI | `LOCAL_COMPLETE_WITH_EXPLICIT_GAPS` | Both official sheets, exact counts, published artifact hashes, control placements, module/status/time/link controls, health, retries, latency, coverage and validated links render. Exact visual geometry and Lambda-specific links remain open. |
| G6 acceptance | `PARTIAL` | Focused tests/lint/types pass locally; live provider and browser acceptance remain open. |

The existing generic source-job ledger is authoritative for Sutra collection
attempt lifecycle, but it is not equivalent to the official DCF module monitor.
This vertical therefore adds tenant-pinned Step Functions module execution
history: module/job state, generic safe errors, retries, latency, record
coverage, cadence freshness, immutable generations and validated console links.

Files: `lib/finops-dcf-execution-history.ts`,
`lib/finops-data-collection-monitor-official-definition.ts`,
`lib/finops-dcf-instrumentation-job.ts`,
`lib/finops-dcf-step-functions-adapter.ts`,
`lib/finops-dcf-durable-runtime-binding.ts`, `db/finops-dcf-repository.ts`,
SQLite `0107`, PostgreSQL `0102`, same-tenant API, native monitor UI, and
`tests/finops-data-collection-monitor-official-definition.test.ts`.

Security/evidence controls: arbitrary URLs are never accepted or stored; console
links are generated from validated same-partition/account/Region execution ARNs.
Raw Step Functions input/output and provider messages are excluded. Incomplete
captures remain immutable but cannot advance the complete head. Execution
success is not represented as downstream source reconciliation unless explicit
coverage/reconciliation evidence exists.

The new adapter accepts only an exact `SERVER_RESOLVED_DCF_STACK` boundary.
Every module state machine and returned execution must match the same tenant,
management account, partition, Region, and state-machine name. Each enabled
machine is required to be active and `STANDARD`; `EXPRESS` is reported as an
honest unsupported state rather than queried with an unsupported API. It calls
`ListExecutions` with the AWS maximum 1,000-item page bound and
`DescribeExecution` with `METADATA_ONLY`; only a provider-computed input digest
crosses the boundary. Opaque pagination tokens are sequence-checked, never
persisted, and discarded on failure. The collector is capped at 500 modules,
10,000 executions, 1,000 pages, 25,000 attempted requests, three attempts per
request, and 15 minutes. Retry delay is bounded exponential backoff. Repeated
tokens, duplicate executions, future timestamps, cross-scope ARNs, malformed
coverage, empty or fully disabled module sets, and unexpected provider shapes
fail closed instead of producing a false successful empty capture.

The registry-independent runtime schedules deterministic hourly jobs and uses a
16-minute durable lease. Exact jobs are claimed by a collision-safe tenant and
window idempotency key. Completed receipts and their SHA-256 digests are
verified before replay; successful writes re-normalize and re-hash the stored
snapshot before the immutable generation is acknowledged. Concurrent claims
return `IN_PROGRESS`, while claim, provider, repository, and secondary failure
details are reduced to stable codes. `READY` and `STALE` captures may advance;
`PARTIAL` and `UNAVAILABLE` captures remain immutable history only.

Focused verification: **14/14 tests passed** with zero failures, skips, or
cancellations using the official-definition, vertical-contract, execution-history,
and Step Functions activation suites. The suite covers the four pinned artifact
hashes, exact published object counts and controls, exact scope, pagination,
metadata-only reads, raw-data exclusion, cross-account rejection, token replay,
retries, cancellation, authorization state, deterministic scheduling, immutable
lineage, receipt replay, substitution, corrupt receipts, sanitized failures, and
native server-rendered evidence. Root TypeScript, targeted ESLint, and
`git diff --check` pass on the current tree.

Remaining production gates:

1. Register the new job handler and hourly eligible-connection tick in the
   shared runtime.
2. Bind the production durable replay store, server-owned DCF stack/module
   resolver, and least-privilege Step Functions provider client or signed broker.
3. Accept real DCF 3.11+ module mappings and AWS success, eventual-consistency,
   token-expiry, throttling, authorization, timeout, recovery, partition, and
   Standard/Express state-machine behavior.
4. Run retention, alert/observability, signed-in two-tenant visual, exact-tree
   CI/build, immutable-image, deployment, rollback, and browser acceptance.

The API continues to report
`DCF_STEP_FUNCTIONS_INSTRUMENTATION_NOT_REGISTERED`; activation remains false
until those bindings are registered. No live AWS or production claim is made.
