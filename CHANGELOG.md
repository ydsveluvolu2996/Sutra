# Changelog

All notable changes to Sutra are recorded here. The current branch is a private
beta and has no production release tag.

## Unreleased — Kubernetes private beta

- Added EKS-first Kubernetes inventory, KSPM, Trivy, SBOM, Kyverno, Falco,
  Cilium/Hubble, supply-chain and compliance foundations.
- Added guarded disposable EKS creation, validation and teardown workflows.
- Added local PostgreSQL demo startup with `pnpm morning:start` and safe stop with
  `pnpm morning:stop`.
- Added enterprise backlog, acceptance gates and handoff guidance in
  `docs/enterprise-platform-pending-work.md`.

### Release limitations

- The EKS validation cluster is deleted when not in use.
- Hosted identity, distributed broker/jobs, managed secrets, DR, penetration
  testing and SLA operations are not complete.
- Compliance views are readiness mappings, not certifications.
