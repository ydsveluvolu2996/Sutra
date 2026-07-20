# Changelog

All notable changes to Sutra are recorded here. The current branch is a private
beta and has no production release tag.

## Unreleased — local private beta

### Benchmark-superiority program (P1–P7)

- Added tenant-scoped durable background jobs with atomic leases, bounded
  retry/backoff, dead-letter classification, governed retention sweeps, PostgreSQL
  backup tooling, and negative tenant-isolation tests.
- Added Public API v1 with seven versioned endpoints, organization/customer-scoped
  tokens, scopes and quotas, tamper-rejected cursor pagination, idempotent case
  updates, an OpenAPI contract, and token administration.
- Added signed bidirectional Jira and ServiceNow synchronization with explicit
  status maps, remote-newer-wins conflict handling, stored tenant-scoped
  connectors, verified inbound webhooks, dispatch routes, audit attribution, and
  administration UI.
- Added CMDB query, annotation, ownership, saved-query and resource-change
  workflows plus bounded CloudTrail event-assisted change hints.
- Added custom compliance frameworks, assignments, ownership, trend and auditor
  sign-off. Compliance outputs remain readiness mappings, not certifications.
- Added Registry v2 catalog, tag and manifest-digest inventory with deterministic
  latest/unpinned/stale-reference policy, validated against a disposable local
  `registry:2` instance. This validation does not claim image CVE scanning.
- Added CUR 2.0 and FOCUS 1.0 ingestion, allocation rules, budgets, anomaly signals,
  persistence, APIs, and a FinOps workspace. These capabilities are not
  billing-grade invoice reconciliation or guaranteed-savings advice.

### Kubernetes private beta

- Added EKS-first Kubernetes inventory, KSPM, Trivy, SBOM, Kyverno, Falco,
  Cilium/Hubble, supply-chain and compliance foundations.
- Added guarded disposable EKS creation, validation and teardown workflows.
- Added local PostgreSQL startup with `pnpm morning:start` and safe stop with
  `pnpm morning:stop`.
- Added enterprise backlog, acceptance gates and handoff guidance in
  `docs/enterprise-platform-pending-work.md`.

### Verification

- The P1–P7 gate discovered 1,238 tests. After repository-governance regression
  coverage was added, the complete `pnpm verify` gate discovered 1,252 tests:
  1,249 passed, three were intentionally skipped, and none failed. TypeScript,
  ESLint, PostgreSQL integration, the production build and rendered-route checks
  completed without errors. See `docs/benchmark-superiority-final-report.md` for
  the program evidence and claims boundary.

### Release limitations

- The EKS validation cluster is deleted when not in use.
- Hosted identity rollout, deployed broker/job workers, managed secrets, restore
  drills, monitoring, isolation-under-load, HA/DR, penetration testing and SLA
  operations are not complete.
- Compliance views are readiness mappings, not certifications.
