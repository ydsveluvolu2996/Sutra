# Sutra post-benchmark program (Tracks B–F) — capability report

Status: completed locally on 2026-07-20 on branch `agent/sutra-benchmark-superiority`.

This follows `docs/benchmark-superiority-final-report.md`. It records the six
tracks that turned "engines that pass tests" and "dormant plumbing" into shipping,
data-fed features. It is a local capability report, **not** a claim of production
maturity, certified compliance, vendor parity, availability, scale, or security
assurance. Every honesty and tenancy invariant from the prior program is preserved:
tri-state/unknown states, disclosed coverage, no fabricated data, tenant-gated
writes with cross-org negative tests.

## What shipped

| Track | Delivered | Evidence commits | Still gated (not delivered) |
| --- | --- | --- | --- |
| **B — durable worker runtime** | The `background_jobs` queue is now actually drained: a pure `runDueBackgroundJobs` orchestrator + cross-org `leaseNext` (with expired-lease reclaim), a token-gated internal drain endpoint, retention-sweep + ITSM-dispatch handlers, an idempotent retention producer, and a ticker in `start-pilot`. ITSM dispatch now enqueues a durable retry on failure. | `31c40d1`, `f3cf143` | Deployed queue workers on managed infra, autoscaling, observability/SLOs, cancellation, HA/DR. The ticker drives an in-app drain — not yet a horizontally-scaled worker fleet. |
| **A — CNAPP engine wiring** | 6 dormant engines wired end-to-end (exploitability-ranked vulns, finding-exceptions, registry-inventory, cloud-detection, collection-schedule status, IaC real-ingest) + server API routes for IAM-CIEM and supply-chain-trust. Each is fed by data the app already collects and surfaces honest unknown/zero-coverage/single-source states. | `3ee09b9`, `796d3c2`, `5bfd27e`, `f7fa5db`, `dbd713c`, `2710e0d`, `4201e77` | Multi-source CDR ingest (GuardDuty/K8s-audit) is still uncollected, so cloud-detection is CloudTrail-only by disclosure. Broader collectors and scale/latency work remain. |
| **C — registry image CVE scanning** | A `trivy-image` unified `VulnSource` + pure normalizer, a dedicated tenant-scoped `registry_vulnerabilities` table, a trivy-gated scanner runner, and merge into the same unified vulnerability queue as cloud/K8s findings. | `7ed7821` | Requires a verified Trivy runtime to produce findings (gated, never fabricated); authenticated/private-registry adapters and scheduled ingestion remain. |
| **D — FinOps commitment + rightsizing** | CUR-fed commitment (RI/Savings-Plan) candidates with an explicitly-disclosed assumed discount rate, and rightsizing candidates. | `cb13870` | Rightsizing savings are always null (per-resource utilization is not collected — disclosed). Live billing reconciliation and verified savings accuracy remain. |
| **E — public API SDKs** | Typed `components.schemas` on the OpenAPI spec ($ref'd from every response), hand-written typed TypeScript and Python client SDKs, a key-rotation policy doc, and a spec↔SDK drift-guard test. | `3263e95` | Published/versioned package distribution, load testing, and a hosted gateway remain. |
| **F — multi-node DaemonSet agent auth** | Node-scoped enrollment: each DaemonSet pod authenticates with a reusable node-scoped bootstrap and obtains its own node-scoped rotating credential; default single-pod Deployment mode is unchanged. Migration adds a node dimension and replaces the per-cluster singleton index. | `d950f94` | Live-cluster scale/soak/chaos validation across many real nodes is ops-gated. |

## Conservative capability re-score (delta from the prior report)

Same 1–5 rubric (3 = coherent local workflow, 5 = broad production-proven). These
deltas reflect that capabilities are now data-fed and reachable in the product, not
that production, scale, or external assurance exist.

| Area | Prior | Now | Why it moved | Why it is not higher |
| --- | ---: | ---: | --- | --- |
| Kubernetes registry security | 3.5 | 4.0 | Real image CVE scanning normalizes into the unified queue (Track C) | Gated on a verified Trivy runtime; private-registry + scheduled ingestion absent |
| Public ecosystem | 4.0 | 4.5 | Typed schemas + TS/Python SDKs + rotation policy (Track E) | No published packages, hosted gateway, or load evidence |
| FinOps | 4.0 | 4.3 | Commitment recommendations with disclosed assumptions (Track D) | Rightsizing is candidate-only (no utilization); no live reconciliation |
| CNAPP breadth / usability | — | +  | 6 engines + 2 routes are now shipping, data-fed features, not test-only libs (Track A) | Some sources single-source by disclosure; scale untested |
| Production foundations (P1) | local | local+ | Durable jobs now actually execute on a schedule with retry/dead-letter (Track B) | Not a deployed, scaled, monitored worker fleet; HA/DR ops-gated |
| Kubernetes agent coverage | single-node | multi-node (code) | Per-node authenticated DaemonSet enrollment (Track F) | Live multi-node scale/soak is ops-gated |

## Verification gate (this branch)

`security:secrets` (918 files), `typecheck` (app + collector), `lint`, and the
production `build` all clean. Test suites, run serialized:

```
test                    386 pass / 3 skip
test:phase2             570 pass
test:kubernetes          52 pass
test:enterprise-security 256 pass
test:collector           95 pass
```

~1,359 tests pass, 0 failures (skips are Docker/Postgres-URL-gated and exercised by
the container migrate step at deploy). New dual-dialect migrations `0032`/`0026`
(finding_exceptions), `0033`/`0027` (registry_vulnerabilities), and `0034`/`0028`
(kubernetes_agent_nodes) are registered in all three places with parity-contract tests.

## Claims boundary

Unchanged from the prior report: this is a real local private-beta capability suite.
Hosted identity, managed secrets, deployed/scaled workers, restore drills, monitoring,
isolation-under-load, incident response, HA/DR, penetration testing, vendor-sandbox
certification, and multi-source CDR collection must be independently exercised and
approved before any production customer account. SOC 2 mappings remain readiness
mappings, not an examination.
