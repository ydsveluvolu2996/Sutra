# Sutra enterprise delivery and handoff plan

**Document purpose:** single source of truth for the remaining work required to
take Sutra from the current local/private-beta build to an enterprise-grade,
customer-ready platform.

**Current repository:** `agent/sutra-local-aws-pilot` in the Sutra GitHub
repository. The EKS validation cluster has been intentionally deleted to stop
AWS charges. The Kubernetes code, Helm values, policies, tests and runbooks are
preserved in GitHub. Compliance language in this document and in the product is
**readiness mapping**, not certification or an audit opinion.

## 1. Current state at a glance

| Area | Current state | Honest interpretation |
|---|---|---|
| Local application | Working through `pnpm morning:start`; PostgreSQL, migrations and health checks pass | Walkthrough-ready local runtime |
| AWS CMDB collector | Implemented with cross-account trust validation and bounded evidence collection | Requires a valid short-lived AWS profile for live use |
| Kubernetes inventory/KSPM | Implemented and previously live-tested on EKS | Requires a fresh disposable EKS cluster for another live run |
| Trivy/SBOM | Implemented; previous live run imported findings and CycloneDX evidence | Private-ECR and multi-namespace acceptance remains |
| Kyverno | Audit-first policies, reports and exception/promotion contracts implemented | Real EKS install and controlled blocking test remain |
| Falco | Signed/replay-resistant runtime ingestion contracts implemented | Live Falco/Falcosidekick event proof remains |
| Cilium/Hubble | AWS VPC CNI chaining and rollback implementation exists | Live install/connectivity/rollback must be rerun on a disposable cluster |
| Notifications | Email, Slack and Teams outbox/retry/dead-letter paths implemented | Real destinations and managed secrets remain |
| Compliance | CIS Kubernetes, NSA/CISA and SOC 2 readiness mappings implemented | Evidence review is required; no certification claim |
| Hosted SaaS | Security boundaries and infrastructure foundations exist | Hosted identity, broker, jobs, DR and isolation gates remain |
| Domain | `sutracmdb.com` is registered with Cloudflare | Do not point `app.sutracmdb.com` at the laptop/private beta |

## 2. Kubernetes enterprise track — complete this first

### 2.1 Kubernetes P0 acceptance gates

| ID | Workstream | Current status | Remaining task | Acceptance evidence | Dependencies |
|---|---|---|---|---|---|
| K8S-P0-01 | EKS onboarding and trust | Code implemented; previous account validation passed | Create a fresh disposable EKS cluster and onboard it through Sutra using the reviewed trust role and External ID | Correct trust succeeds; missing and incorrect External IDs fail; account/region/cluster binding is exact | AWS SSO profile, approved account, disposable budget |
| K8S-P0-02 | Continuous agent | Enrollment, rotating credentials, heartbeat, revocation and offline state implemented | Install the agent on a persistent test cluster and run a soak test | Scheduled evidence uploads, rotation, revocation and offline detection are visible in Sutra | Stable HTTPS control-plane endpoint |
| K8S-P0-03 | Inventory and KSPM | 18 collectors previously returned 302 resources and posture evidence | Test larger cluster, multiple namespaces and Kubernetes upgrade | Complete/partial/unknown states are correct; Secrets and ConfigMaps never collected | Test workloads and second namespace set |
| K8S-P0-04 | Trivy vulnerabilities | Previous live run produced 771 findings | Validate private ECR images, digest correlation and multiple namespaces | Image CVEs, configuration findings and workload links are real and searchable | Private ECR repository and test images |
| K8S-P0-05 | SBOM and licenses | 13 CycloneDX reports previously ingested | Add/validate SBOM history, component search and license-policy workflow | Component-to-workload history, policy decision and evidence digest are shown | Syft/CycloneDX fixtures and images |
| K8S-P0-06 | Workload 360/security graph | Evidence-based cloud, IAM, RBAC, exposure and vulnerability edges implemented | Generate complete multi-signal attack paths on a real cluster | Every edge cites evidence; blast-radius priority is explainable; no inferred reachability | K8S-P0-03 through P0-05 |
| K8S-P0-07 | Kyverno admission | Audit pack, PolicyReports, exceptions and promotion controls implemented | Install live; test audit mode; test blocking only in disposable namespace/cluster | Audit findings are imported; exception is scoped/expiring; blocking rollback is proven | Disposable workload/namespace |
| K8S-P0-08 | Falco runtime | Signed/replay-resistant event boundary implemented | Install Falco/Falcosidekick and signing gateway; create deliberate test event | Event heartbeat, signed event, timeline, case and notification receipt are linked | HTTPS endpoint, ECR image, notification destination |
| K8S-P0-09 | Cilium/Hubble | Chaining profile, bounded flow model and rollback logic implemented | Install live, validate connectivity, collect flows, uninstall and prove AWS VPC CNI recovery | Service map contains observed flows; rollback health gate passes | Explicit CNI approval; disposable cluster |
| K8S-P0-10 | Supply chain | Trivy, Syft, Cosign, immutable ECR and GitHub OIDC workflow implemented | Execute workflow against ECR and validate admission decisions | Immutable digest, scan, SBOM, signature and provenance are all linked | Protected GitHub reviewer; ECR |
| K8S-P0-11 | Notifications | Durable outbox, retries, leasing and DLQ implemented | Configure SES/email, Slack and Teams through managed secrets and deliver tests | Success, retry, lease expiry and DLQ evidence is visible | Sender identity and endpoints |
| K8S-P0-12 | Compliance reporting | CIS, NSA/CISA and SOC 2 readiness mappings implemented | Review evidence gaps and executive report wording with a sample customer | Report identifies readiness, evidence, exceptions and unknowns without certification language | Completed evidence from P0 |
| K8S-P0-13 | End-to-end walkthrough | Local UI and Kubernetes workspaces exist | Run fresh sequence from onboarding to teardown | Onboard → install → collect → prioritize → runtime → admission → notify → report → teardown | All preceding P0 gates |

### 2.2 Kubernetes P1 enterprise-hardening tasks

| ID | Task | Why a customer expects it | Definition of done |
|---|---|---|---|
| K8S-P1-01 | Persistent cluster-agent soak test | Shows reliability beyond a one-time scan | 24–72 hour heartbeat/upload/rotation run with restart and offline recovery |
| K8S-P1-02 | Version and distribution matrix | Customers run more than one EKS version | Tested EKS versions and documented unsupported Kubernetes versions |
| K8S-P1-03 | Helm/operator/DaemonSet installation choices | Matches Wiz/Orca/Prisma/Sysdig/Datadog expectations | Guided wizard presents selectable modules and health per installation method |
| K8S-P1-04 | Private registry support | Production images are commonly private | ECR and one private-registry path tested without storing registry credentials |
| K8S-P1-05 | Runtime policy library | Falco alone is an engine, not a product | Versioned rule packs, severity rationale, suppression/exception workflow and test cases |
| K8S-P1-06 | Admission policy lifecycle | Customers need safe rollout | Audit → exception → promotion → blocking in disposable scope, with rollback |
| K8S-P1-07 | Network graph scale | Large clusters create high flow volume | Bounded ingestion, retention, stale-flow handling and namespace/service filters |
| K8S-P1-08 | Upgrade and rollback automation | Security agents must not break workloads | Tested Helm upgrades, failed upgrades, rollback and AWS CNI recovery |
| K8S-P1-09 | Customer-facing remediation guidance | Findings must become action | Owner, fix, verification, due date and exception workflow per finding |
| K8S-P1-10 | Kubernetes RBAC least privilege review | Agent access is a major sales/security question | Published permission matrix and automated denial tests for Secrets/ConfigMaps |
| K8S-P1-11 | Evidence retention and export | Customers need audit-ready records | Retention policy, immutable evidence export, deletion workflow and audit trail |
| K8S-P1-12 | Load/chaos/backup drills | Enterprise buyers ask about failure behavior | Bounded load, worker restart, database restore, queue replay and RPO/RTO evidence |

### 2.3 Kubernetes launch sequence

Run locally first:

```bash
pnpm install --frozen-lockfile
pnpm morning:start
pnpm test:kubernetes
pnpm test:enterprise-security
```

For real EKS, use a fresh short-lived AWS SSO profile and review the plan before
any mutation:

```bash
pnpm eks:validation:plan
node scripts/eks-disposable-guard.mjs preflight --execute
node scripts/eks-disposable-guard.mjs create --execute
node scripts/kubernetes-security-stack.mjs plan
```

Apply modules only after reviewing the rendered plan. Cilium requires the
additional `--allow-cni-change` acknowledgement. After the walkthrough, use the
guarded teardown and verify that EKS, EC2, EBS, ENIs, VPC, log and budget
resources are gone. Expiry tags do not delete resources automatically.

## 3. Broader Sutra platform track — after Kubernetes P0

| Priority | Workstream | Current state | Remaining work | Customer-facing acceptance |
|---|---|---|---|---|
| P0 | Identity and access | Local password/TOTP, sessions, RBAC and audit implemented | Hosted OIDC/Cognito adapter, MFA step-up, recovery, rate limits and session administration | Invite, login, MFA, revoke and recover users with tenant isolation |
| P0 | MSP multitenancy | Tenant/customer/connection scoping contracts implemented | Hosted organization lifecycle, isolation tests, customer assignment and support roles | Two organizations cannot read or mutate each other’s data |
| P0 | AWS onboarding | Trust role, External ID and read-only collector implemented | Hosted broker/worker, durable jobs and managed key rotation | Customer deploys reviewed role and receives first complete snapshot |
| P0 | CMDB/change history | Immutable snapshots, relationships and change history implemented | Broader AWS service coverage, retention/deletion and evidence export | Resource inventory, relationships and add/change/remove history are explainable |
| P0 | CSPM/security findings | Security controls, findings and workflow foundations implemented | Broader control catalog, exceptions, remediation ownership and SLA tracking | Findings have severity, evidence, owner, remediation and audit history |
| P0 | Native security integrations | Kubernetes integrations implemented; AWS service imports are bounded | Security Hub, GuardDuty and Inspector import adapters with cost controls | Native findings are clearly sourced, deduplicated and correlated |
| P0 | FinOps/cost | Cost views and boundary contracts exist | Cost Explorer ingestion, budgets, anomaly detection, rightsizing and showback | Customer sees account/tenant cost, trend, forecast and recommendation |
| P1 | Notifications/workflows | Outbox/retries/DLQ implemented | SES/Slack/Teams managed transports, workflow rules and ticketing adapters | Finding creates notification/case with delivery receipt and retry evidence |
| P1 | Customer portal | Workspace and navigation exist | Customer-facing onboarding, reports, exports, subscription and usage views | Customer can self-serve permitted account/report access |
| P1 | Reliability | Local migrations, bounded APIs and audit trails exist | Hosted workers, monitoring, backup/restore, DR, load and chaos testing | Published RPO 24h/RTO 4h drill and incident runbook |
| P1 | Domain/hosting | Domain registered; DNS intentionally not pointed to laptop | Hosted deployment, TLS, WAF, `SUTRA_PUBLIC_ORIGIN`, monitoring and release promotion | `https://app.sutracmdb.com` login works with secure cookies and strict origin checks |
| P1 | Assurance and selling | Private-beta documentation exists | Threat model, penetration test, privacy/DPA, support/SLA and customer security pack | Sales claims match evidence; no unsupported certification/parity claims |

## 4. Walkthrough definition of done

The enterprise-feature Kubernetes walkthrough is ready when all of the following are
true:

| Gate | Required proof |
|---|---|
| Onboarding | Customer-owned role, exact External ID and trust denial tests pass |
| Visibility | Inventory, KSPM, vulnerability, SBOM and relationships are real |
| Prioritization | Workload 360 and attack paths cite cloud/Kubernetes/IAM/network evidence |
| Runtime | Deliberate Falco event is signed, stored, displayed and linked to a case |
| Admission | Kyverno audit evidence is present; blocking was tested only in disposable scope |
| Network | Hubble service map shows observed flow and AWS VPC CNI rollback passes |
| Supply chain | Immutable image, scan, SBOM, Cosign signature and provenance are linked |
| Notifications | Email plus configured Slack/Teams delivery receipts are recorded |
| Compliance | CIS/NSA-CISA/SOC 2 readiness report includes evidence gaps and exceptions |
| Teardown | Temporary AWS resources are deleted and orphan-resource audit is empty |
| Claims | Walkthrough labels private-beta limitations and does not claim certification or GA SaaS |

## 5. Handoff for another Claude/Codex session

Give the next agent this repository context:

```text
Continue Sutra from branch agent/sutra-local-aws-pilot. Read
docs/enterprise-platform-pending-work.md first. Complete Kubernetes P0 tasks
before broader platform work. Use real functionality and evidence only. Do not
create AWS resources without an explicit current approval. The prior disposable
EKS cluster was deleted; recreate only through scripts/eks-disposable-guard.mjs
after reviewing the plan. Never commit secrets, MFA material, AWS profiles,
database files or customer evidence. Keep the walkthrough local unless hosted
deployment is explicitly approved.
```

Local start command:

```bash
pnpm morning:start
```

Local stop command:

```bash
pnpm morning:stop
```

Relevant code and runbooks:

- `docs/enterprise-kubernetes-private-beta.md`
- `docs/eks-disposable-validation-runbook.md`
- `docs/kubernetes-security.md`
- `docs/live-kubernetes-validation-2026-07-17.md`
- `deploy/kubernetes/security-stack/`
- `deploy/policies/kyverno/`
- `scripts/kubernetes-security-stack.mjs`
- `scripts/eks-disposable-guard.mjs`

## 6. Change control rules

1. Do not represent simulated evidence as live customer evidence.
2. Do not store AWS access keys, SSO caches, MFA secrets, webhook URLs or
   database files in GitHub or chat.
3. Do not enable admission blocking on a customer production cluster during the
   walkthrough milestone.
4. Treat Cilium changes as high-risk and prove rollback.
5. Treat missing evidence as UNKNOWN or NOT CONFIGURED, never PASS.
6. Keep the disposable AWS budget as an alert, not a hard spending cap.
7. Re-run tests and push each verified milestone to the feature branch.
8. Merge to `main` only after review of the documented acceptance evidence.
