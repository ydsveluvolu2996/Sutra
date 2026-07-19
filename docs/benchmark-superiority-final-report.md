# Sutra benchmark-superiority program — final local report

Status: completed locally on 2026-07-19.

This report records implementation and test evidence for program P1–P7. It is a
local capability benchmark, not a claim of production maturity, certified
compliance, vendor feature parity, availability, scale, or security assurance.

## Delivered capability evidence

| Program | Delivered locally | Evidence commits | Remaining production gate |
| --- | --- | --- | --- |
| P1 — production foundations | Tenant-scoped durable jobs, atomic leases, bounded exponential retry, DLQ classification, governed retention selection, tenant-safe pruning, PostgreSQL backup wrapper and negative isolation tests | `fe35117` | Deploy workers; managed secrets; restore drill; monitoring/SLOs; load/chaos tests; HA/DR; penetration test |
| P2 — public API v1 | Seven versioned endpoints, scoped tokens, quotas, tamper-rejected cursors, idempotent case writes, OpenAPI contract and token administration | `e3f1a12`, `deaa3a5` | Hosted gateway controls, rotation policy, load testing, SDKs and support/deprecation operations |
| P3 — bidirectional ITSM | Explicit Jira/ServiceNow mappings, signed inbound verification, remote-newer-wins conflict handling, connector storage, inbound and dispatch routes, audit attribution and administration UI | `140d0b8`, `4d79d8a` | Managed secret store, deployed delivery workers/retries, vendor sandbox certification and alerting |
| P4 — CMDB depth | Typed query engine, tenant-scoped annotations/ownership and saved queries, workspace APIs/UI and resource change views | `6db32e8`, `c9e47d3`, `c8d9c61` | Scale/latency testing, broader services and production reconciliation operations |
| P5 — event-assisted changes | Bounded CloudTrail evidence normalization and honest resource change hints | `300a41d` | Durable live ingestion and wider event/resource correlation |
| P6 — registry coverage | Registry v2 catalog, tag and manifest digest inventory; deterministic latest/unpinned/stale policy; disposable live `registry:2` validation | `cfbec1c` | Verified Trivy runtime for CVEs, authenticated/private registry adapters and scheduled ingestion |
| P7 — FinOps | CUR 2.0 and FOCUS 1.0 ingestion, allocation, budget and anomaly logic, persistence, APIs and workspace | `3814328`, `7fea507` | Scheduled live exports, billing reconciliation, commitment/rightsizing evidence and production governance |
| Compliance superiority | Custom frameworks, assignments, ownership, trend and auditor sign-off | `e662235` | External control review, licensed mappings where required and production approval procedures |

## Conservative capability re-score

Scores use a five-point internal rubric: 1 is a concept, 3 is a coherent local
workflow, and 5 is a broad production-proven capability. They deliberately exclude
unproven scale, availability, external assurance and competitor-private behavior.

| Area | Before | After local program | Why the score changed | Why it is not 5/5 |
| --- | ---: | ---: | --- | --- |
| CMDB | 3.5 | 4.5 | Search/query, ownership/annotations, saved queries and event-assisted change context now form an integrated workspace | Production scale, broader service depth and reconciliation operations are not proven |
| Compliance | 3.5 | 4.5 | Custom frameworks, assignments, ownership, trend and auditor sign-off complete a stronger evidence workflow | Readiness mappings are not certifications; external semantic review remains |
| FinOps | 2.5 | 4.0 | CUR/FOCUS ingestion, allocation, budgets, anomalies and persisted insights materially deepen cost management | Live billing reconciliation, commitment optimization and proven savings accuracy remain |
| ITSM | 2.0 | 3.5 | Signed bidirectional Jira/ServiceNow contracts, conflict policy, connector persistence and administration are functional | Vendor sandboxes, managed secrets and deployed retry workers remain operational gates |
| Public ecosystem | 2.0 | 4.0 | A scoped, versioned, documented and idempotent public API now exists | SDKs, production gateway/load evidence and marketplace operations remain |
| Kubernetes registry security | 2.5 | 3.5 | Live Registry v2 inventory and digest/tag policy validation is repeatable | This does not prove image CVE scanning or private-registry production integrations |

## Verification gate

The complete release chain passed with serialized Node test workers to avoid a
macOS/Miniflare ephemeral-loopback exhaustion condition:

```text
pnpm typecheck
pnpm test
pnpm test:phase2
pnpm test:enterprise-security
pnpm test:kubernetes
pnpm --dir services/aws-collector test
pnpm lint
```

The original P1–P7 gate discovered 1,238 tests: 1,235 passed, 3 were intentionally
skipped and 0 failed. The subsequent GitHub release-hardening gate added immutable
Action-pin, safe workflow-input and read-only CI-container regressions; the complete
`pnpm verify` run then discovered 1,252 tests: 1,249 passed, 3 intentionally skipped
and 0 failed. TypeScript, ESLint, PostgreSQL integration, the production build and
rendered-route checks completed successfully. Test worker serialization changes only
test execution and does not reduce application concurrency.

## Claims boundary

Sutra can be demonstrated as a real local private-beta capability suite. Before
accepting a customer's production account, the hosted identity, managed-secret,
worker, restore, monitoring, isolation-under-load, incident response, HA/DR,
penetration-testing and support/SLA gates must be independently exercised and
approved. SOC 2 mappings are readiness mappings; they are not a SOC 2 examination.
