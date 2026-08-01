# ADV-12 — Data Collection Monitor

Status: `PARTIAL_PIPELINE` locally; runtime activation is not claimed.

The existing generic source-job ledger is authoritative for Sutra collection
attempt lifecycle, but it is not equivalent to the official DCF module monitor.
This vertical therefore adds tenant-pinned Step Functions module execution
history: module/job state, generic safe errors, retries, latency, record
coverage, cadence freshness, immutable generations and validated console links.

Files: `lib/finops-dcf-execution-history.ts`,
`lib/finops-dcf-instrumentation-job.ts`, `db/finops-dcf-repository.ts`, SQLite
`0107`, PostgreSQL `0102`, same-tenant API and native monitor UI.

Security/evidence controls: arbitrary URLs are never accepted or stored; console
links are generated from validated same-partition/account/Region execution ARNs.
Raw Step Functions input/output and provider messages are excluded. Incomplete
captures remain immutable but cannot advance the complete head. Execution
success is not represented as downstream source reconciliation unless explicit
coverage/reconciliation evidence exists.

Live gaps: production scheduler target enumeration, Step Functions adapter and
job registration, real module/state-machine mapping, provider pagination and
retry validation, release migrations/PostgreSQL parity, signed-in two-tenant
visual review and live smoke evidence. The API reports
`DCF_STEP_FUNCTIONS_INSTRUMENTATION_NOT_REGISTERED`; activation remains false.
