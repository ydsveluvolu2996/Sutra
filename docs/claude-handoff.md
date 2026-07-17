# Sutra — Claude/Codex Handoff

This document is the current source of truth for continuing Sutra work in another coding agent. Read it before changing code.

## Repository

- GitHub: https://github.com/ydsveluvolu2996/Sutra
- Default branch: `main`
- Active development branch: `agent/sutra-local-aws-pilot`
- Open draft PR: https://github.com/ydsveluvolu2996/Sutra/pull/1
- Latest pushed governance commit: `1e740a6`
- Repository is private.
- Working tree was clean and synchronized with origin at handoff.

## Product scope

Sutra is an EKS-first AWS CMDB and cloud-security posture platform for MSP demonstrations. The intended customer flow is:

`onboard AWS account → verify trust/external ID → install Kubernetes modules → collect inventory/evidence → prioritize findings and attack paths → show runtime/admission/supply-chain evidence → notify → executive report → teardown`

This is a private-beta/demo baseline, not yet a hosted, penetration-tested, SLA-backed production SaaS.

## Implemented capabilities

1. AWS onboarding with IAM trust role and external-ID validation.
2. Continuous cluster agent enrollment, rotating credentials, heartbeat, revocation, evidence upload, and offline detection.
3. Kubernetes inventory and KSPM collectors with tenant scoping and secret/ConfigMap exclusion.
4. Trivy vulnerability and configuration evidence with workload correlation.
5. CycloneDX SBOM ingestion.
6. Cloud/Kubernetes/IAM/RBAC/exposure/vulnerability relationships and risk prioritization.
7. Kyverno audit-first admission policies, PolicyReport ingestion, exceptions, and promotion controls.
8. Falco runtime event ingestion with replay resistance, timelines, confirmed cases, and notification queue.
9. Cilium/Hubble flow normalization and service-map evidence model (live CNI deployment remains pending).
10. Supply-chain workflow scaffolding for Trivy, Syft, Cosign, ECR, and GitHub OIDC.
11. Email, Slack, and Teams notification configuration with durable outbox/retry/dead-letter behavior.
12. CIS Kubernetes, NSA/CISA, and SOC 2 readiness mappings. These are readiness mappings, not certifications.
13. PostgreSQL migrations, bounded APIs, audit trails, and immutable evidence records.
14. Local Docker/PostgreSQL demo stack and Kubernetes workspaces.

## GitHub hardening already added

- `.github/CODEOWNERS`
- `.github/dependabot.yml`
- `.github/pull_request_template.md`
- `.github/ISSUE_TEMPLATE/bug_report.yml`
- `.github/ISSUE_TEMPLATE/feature_request.yml`
- `.github/workflows/codeql.yml`
- `CHANGELOG.md`
- `docs/repository-release-readiness.md`

Repository metadata/topics were updated for AWS, CMDB, CSPM, EKS, FinOps, Kubernetes, and MSP.

## Verified checks

The latest GitHub runs passed:

- CI: typecheck, lint, unit/integration tests, AWS collector tests, CloudFormation validation, PostgreSQL tests, build, rendered-route tests.
- Kubernetes and supply-chain security workflow.
- Local secret scan across the source tree.

CodeQL is configured but currently skipped because the private repository does not have GitHub Advanced Security enabled. Do not describe this as a passing security scan.

## Known limitations / remaining work

### Highest priority before a customer demo

- Run one complete live EKS sequence in the approved AWS account `738663485493`, region `ap-south-1`.
- Validate customer onboarding with an isolated role and external ID.
- Install and test Trivy Operator, Kyverno, Falco/Falcosidekick, and Cilium/Hubble on a disposable EKS cluster.
- Generate deliberate test evidence for vulnerability, admission denial/audit, runtime detection, network flow, SBOM, and notification delivery.
- Validate private ECR image scanning, Cosign provenance/signature decisions, and GitHub OIDC.
- Configure real SES identity, Slack webhook/app, and Teams webhook using managed secrets; never commit credentials.
- Produce and review the executive/readiness report, then tear down temporary AWS resources.

### Production-grade backlog

- Durable hosted broker/worker deployment and queue observability.
- Load, chaos, backup/restore, disaster-recovery, and penetration testing.
- Tenant-isolation tests, RBAC/MFA/SSO, subscription controls, usage metering, support/SLA procedures.
- Broader AWS relationship coverage, change history, exceptions, ticketing integrations, and customer portal polish.
- Enable GitHub branch protection, native secret scanning, and CodeQL after GitHub plan/Advanced Security is available.
- Split the large draft PR into reviewable feature PRs; current PR is approximately 515 files and 138k additions.
- Decide and add an appropriate commercial/open-source license before public distribution.

## Safe operating rules

- Do not create or leave paid AWS resources running without explicit approval and a budget cap.
- Prefer disposable EKS clusters for blocking admission, CNI changes, and runtime experiments.
- Do not store AWS keys, MFA seeds, webhook URLs, kubeconfigs, customer data, or secrets in GitHub.
- Preserve existing migrations and tenant boundaries; review database changes before applying them.
- Run tests before every commit and inspect `git diff --check`.
- Keep changes on `agent/sutra-local-aws-pilot` unless the owner explicitly requests another branch.
- Do not merge PR #1 automatically; first split or obtain explicit approval.

## Local commands

```bash
pnpm install --frozen-lockfile
pnpm morning:start
pnpm security:secrets
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Use the repository's existing Docker/PostgreSQL scripts and `.env.example`; keep real values in an untracked `.env.local` only.

## GitHub continuation commands

```bash
git fetch origin
git switch agent/sutra-local-aws-pilot
git pull --ff-only origin agent/sutra-local-aws-pilot
gh pr view 1 --repo ydsveluvolu2996/Sutra
gh run list --repo ydsveluvolu2996/Sutra --branch agent/sutra-local-aws-pilot
```

Before editing, inspect `docs/enterprise-kubernetes-private-beta.md`, `docs/eks-disposable-validation-runbook.md`, `docs/demo-day-runbook.md`, and `docs/repository-release-readiness.md`.

## Handoff objective

Continue by completing and verifying the live EKS private-beta demo path, recording evidence and teardown results. Make small, reviewable commits, push them to the existing branch, and update the draft PR. Report any permission, billing, security, or missing-credential blocker instead of simulating success.
