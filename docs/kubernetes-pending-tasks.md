# Sutra Kubernetes Enterprise Walkthrough — Pending Tasks

This is the execution backlog for the next coding agent. Complete tasks in priority order, keep evidence of every result, and do not claim live validation until it has actually run.

## Current baseline

Implemented in code: EKS onboarding/trust validation, cluster-agent lifecycle, inventory/KSPM collectors, Trivy evidence model, SBOM ingestion, workload/attack-path relationships, Kyverno audit workflows, Falco event model, Cilium/Hubble flow model, supply-chain workflow scaffolding, notifications, compliance readiness mappings, PostgreSQL persistence, and Kubernetes UI workspaces.

The EKS cluster is disposable and must not be left running. AWS account: `738663485493`; preferred region: `ap-south-1`; temporary validation budget cap: `$40`.

## Priority backlog

| Priority | Task | Done when | Cost/safety gate |
|---|---|---|---|
| P0 | Create disposable EKS validation cluster | Cluster, node group, OIDC, and Sutra trust role are created and recorded | Confirm budget and teardown time; use smallest supported node group |
| P0 | Validate customer onboarding | Correct external ID succeeds; missing/wrong external ID fails; tenant/account identity is persisted | Read-only customer role only; no long-lived keys |
| P0 | Install continuous Sutra agent | Enrollment, rotating credential, heartbeat, evidence upload, revocation, and offline state are observed | Use generated short-lived enrollment token; revoke after test |
| P0 | Install Trivy Operator | RESOLVED — the `sutra-visibility` chart now bundles and manages Trivy Operator by default (`scanner.managed=true`), so vulnerability, config, RBAC, infra, compliance, and SBOM reports reach Sutra with no separate install. `scanner.managed=false` for bring-your-own. | Never ingest Secret or ConfigMap contents. Global-secret access stays OFF always; exposed-secret detection is OFF by default and available as an opt-in (`--set trivy-operator.operator.exposedSecretScannerEnabled=true`) that ingests sanitized finding metadata only — the matched secret value is dropped at collection and rejected at persistence |
| P0 | Test private ECR scanning | Push a non-sensitive test image, scan it, display CVEs, and remove image/repository after validation | Tag all resources `sutra-sample=true`; delete after test |
| P0 | Install Kyverno audit mode | Policies and PolicyReports appear in Sutra with namespace/workload context | Audit only on customer-like cluster |
| P0 | Test disposable blocking policy | A deliberately invalid test deployment is denied; valid deployment succeeds; policy is reverted | Blocking is allowed only in disposable namespace/cluster |
| P0 | Install Falco/Falcosidekick | A deliberate test event is detected, signed/validated, stored in timeline, and routed to notification queue | Generate harmless test event; no destructive commands |
| P0 | Configure and test notifications | SES/email, Slack, and Teams deliveries succeed; retry and dead-letter behavior is visible | Store endpoints in managed secrets, never Git |
| P1 | Install Cilium/Hubble safely | Connectivity remains healthy; bounded flow evidence and service map appear in Sutra | Highest-risk change; snapshot/rollback plan required. Code complete 2026-07-17: the agent reads the Cilium hubble-export file and uploads aggregated flow metadata; live-cluster validation remains |
| P1 | Validate network rollback | CNI rollback restores pod/service connectivity and Sutra records the event | Run only on disposable EKS |
| P1 | Run Cosign/Syft/GitHub OIDC workflow | Image has SBOM, signature, attestation, ECR evidence, and admission decision | Use ephemeral test repository/image |
| P1 | Validate attack paths | Cloud, IAM, RBAC, exposure, network, and vulnerability signals produce explainable ranked paths | Evidence links must point to stored observations |
| P1 | Compliance report validation | CIS Kubernetes, NSA/CISA, and SOC 2 readiness report renders with evidence and timestamps | Label as readiness mapping, not certification. Code complete 2026-07-17: framework readiness renders in the compliance workspace and executive report; validation against live evidence remains |
| P1 | Upgrade and multi-namespace test | Repeat collectors and integrations across multiple namespaces and a version upgrade | Capture before/after inventory and failures |
| P2 | Agent soak test | Agent remains healthy through restarts, temporary network loss, credential rotation, and replayed evidence | Run bounded duration; monitor local resources. Complete 2026-07-17: `pnpm kubernetes:agent:soak` runs the deterministic fault-injection harness with seven asserted invariants |
| P2 | Walkthrough teardown automation | One command deletes EKS, node group, ECR test assets, IAM role/policies, and temporary notifications | Teardown must print remaining tagged resources. Code complete 2026-07-17: guarded teardown deletes tag-verified role stacks, disposable notification secrets, and the control-plane log group, then fails until the sutra:disposable tag query is empty; final live run remains |
| P2 | Customer-facing runbook | Screenshots, prerequisites, least-privilege policy, onboarding steps, evidence interpretation, and teardown are documented | Remove account-specific secrets and identifiers. Drafted 2026-07-18 as `docs/customer-onboarding-runbook.md` (prerequisites, least-privilege AWS/RBAC, onboarding, module install, evidence interpretation, teardown); screenshots pending a live UI capture |
| P2 | Reliability validation | Backup/restore, load, chaos, monitoring, and recovery objectives are tested | Required before claiming production SaaS |

## Local functionality completed on 2026-07-17 (no AWS calls made)

These were built and verified with local tests only; nothing below claims live
AWS validation.

1. Guarded teardown completion: tag-verified IAM role-stack deletion,
   disposable `sutra/notifications/` secret deletion, control-plane log-group
   deletion, resumable operation when the cluster is already gone, and a final
   Resource Groups Tagging API audit that fails until zero `sutra:disposable`
   resources remain (`scripts/eks-disposable-guard.mjs`).
2. CIS Kubernetes / NSA-CISA / SOC 2 readiness rendering with evidence counts
   and timestamps in the Kubernetes compliance workspace and the executive
   report (`lib/kubernetes-compliance-readiness.ts`).
3. Deterministic agent soak harness with fault injection
   (`pnpm kubernetes:agent:soak`).
4. Real Hubble flow collection: the agent reads a bounded tail of the Cilium
   hubble-export file and uploads aggregated flow metadata through the
   authenticated agent route; the simulated flow is no longer the only flow
   producer (`services/kubernetes-collector/src/hubble-flow-source.ts`).
5. Falco signing-gateway liveness reported as a `falco-gateway` module state in
   agent heartbeats (`SUTRA_FALCO_GATEWAY_HEALTH_URL`).
6. Interactive attack-path security graph with per-entity evidence inspection
   (`/kubernetes/attack-paths`).
7. Agent chart options for the read-only hubble-export mount and the gateway
   health URL, both off by default and render-validated.
8. Operator-visible agent deployment health: `GET /api/v1/kubernetes/agents`
   lists heartbeat module states per enrolled agent and the onboarding wizard
   renders them.

Known deferred item: per-node DaemonSet agent coverage requires per-node
enrollment; the one-time bootstrap design cannot authenticate multiple pods.

## Required evidence for the walkthrough

Capture these artifacts without secrets:

1. Account onboarding success and rejected wrong external ID.
2. Cluster-agent enrollment, heartbeat, rotation, and revocation timeline.
3. Inventory/resource count and KSPM findings.
4. Trivy CVE/configuration result linked to a workload.
5. SBOM component search and license-policy result.
6. Kyverno audit report plus disposable blocking-policy result.
7. Falco event with Kubernetes context and notification delivery.
8. Hubble flow/service map and rollback result.
9. Signed image/provenance verification and admission decision.
10. Executive readiness report and complete teardown output.

## Execution rules for Claude

- Start by reading `docs/claude-handoff.md`, `docs/enterprise-kubernetes-private-beta.md`, and `docs/eks-disposable-validation-runbook.md`.
- Inspect existing implementation before adding new collectors or routes; avoid duplicate features.
- Run `pnpm security:secrets`, focused Kubernetes tests, and `git diff --check` after each logical change.
- Use small commits on `agent/sutra-local-aws-pilot`; push each verified milestone.
- Prefer mocked/replay evidence tests when AWS access is unavailable, but clearly mark them as simulated.
- Stop and request approval for any permission expansion, paid AWS service, public exposure, destructive operation, or budget risk.
- Always tear down temporary AWS resources after validation and record the result.

## Definition of walkthrough-ready

Sutra is walkthrough-ready when the complete sequence runs against one disposable EKS customer-like account, all ten evidence artifacts above are visible in the UI/report, notifications work, no secrets are exposed, and teardown confirms no temporary paid resources remain.
