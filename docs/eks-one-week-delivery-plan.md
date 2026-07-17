# Sutra EKS one-week delivery lock

## Objective

Within one week, deliver and verify an EKS-first enterprise-feature private
beta. The target is a real, customer-demonstrable product with bounded
cross-account access, Kubernetes evidence, runtime and admission signals,
notifications, reports, operational safeguards and repeatable teardown.

This milestone is not described as independently penetration-tested,
SLA-backed production GA. Those assurance gates remain mandatory before an
unrestricted enterprise sale.

## Fixed scope

| Workstream | One-week acceptance outcome |
| --- | --- |
| AWS/EKS onboarding | Discover and register EKS through a customer-owned IAM trust role with External ID; no permanent customer keys |
| Continuous agent | One-time enrollment, heartbeat, scheduled metadata upload, offline state, credential rotation and revocation |
| Inventory and KSPM | Workloads, services, ingress, namespaces, nodes, RBAC, policies and bounded configuration evidence |
| Vulnerabilities | Trivy workload and image findings, private ECR validation, namespace correlation and fixed-version guidance |
| SBOM and licenses | CycloneDX ingestion, component search/history foundation, workload correlation and license policy evidence |
| Workload 360 | Workload, image, service account, RBAC, exposure, vulnerability, runtime and network context |
| Security graph | Evidence-cited cloud, EKS, IAM, RBAC, network, image and runtime relationships without inferred reachability |
| Admission | Kyverno Audit evidence, governed exceptions and blocking proof only in a disposable namespace or cluster |
| Runtime | Falco/Falcosidekick through the signed gateway, deliberate test event, timeline and human-confirmed case |
| Network | Cilium/Hubble AWS VPC CNI chaining, flow evidence, service map and proven rollback |
| Supply chain | GitHub OIDC, immutable ECR images, Trivy gate, Syft SBOM, Cosign signature and provenance attestation |
| Compliance | CIS Kubernetes, NSA/CISA and SOC 2 readiness mappings, evidence gaps, exceptions and executive report |
| Notifications | Real SES email plus configured Slack and Teams paths with durable retries and dead-letter behavior |
| Fleet foundation | Multiple cluster data model, customer/cluster filtering and installation/health states |
| Reliability | Restart, retry, idempotency, timeout, upgrade/rollback, backup/restore and bounded-load evidence |
| Demonstration | Onboard → collect → prioritize → runtime/admission/network evidence → notify → report → teardown |

## Parallel execution plan

| Day | Platform and onboarding | Security evidence | Product and operations | Exit gate |
| --- | --- | --- | --- | --- |
| Day 1 | Authenticate live Sutra, synchronize AWS, register EKS, publish scan | Confirm Trivy/Kyverno evidence | Confirm live UI and tenant scope | Real cluster visible in Sutra |
| Day 2 | Install/soak continuous agent | Private ECR, SBOM and vulnerability validation | Agent health, rotation and revocation UI | Repeatable scheduled evidence |
| Day 3 | Configure reachable HTTPS control plane | Install Falco and generate deliberate event | Runtime case and email delivery | Signed runtime event in Sutra |
| Day 4 | Revalidate Cilium/Hubble install and rollback | Flow ingestion, Workload 360 and attack paths | Service map and evidence timestamps | Multi-signal evidence path |
| Day 5 | Protected GitHub release environment | Build, scan, SBOM, sign and attest images | Release manifest and admission decision | Immutable reviewed release |
| Day 6 | Second account/cluster onboarding if available | CIS/NSA-CISA/SOC 2 report review | Backup/restore, restart and bounded-load tests | Private-beta acceptance report |
| Day 7 | Full fresh onboarding rehearsal | Runtime, admission and network demonstrations | Notifications, executive report and teardown | Recorded end-to-end demo |

## Required user dependencies

| Dependency | Deadline | Effect if missing |
| --- | --- | --- |
| Complete live Sutra MFA login | Day 1 | Blocks product-side AWS/EKS onboarding |
| Second customer AWS account and administrator for role deployment | Day 2 | Limits proof to one account |
| Independent GitHub reviewer username | Day 2 | Blocks protected production release |
| Stable HTTPS endpoint for `sutracmdb.com` | Day 2 | Blocks real Falco/agent delivery from EKS |
| Slack endpoint stored through a protected secret path | Day 3 | Slack remains implemented but unverified |
| Teams endpoint stored through a protected secret path | Day 3 | Teams remains implemented but unverified |
| Agreed scale target | Day 3 | Prevents meaningful load-test acceptance |
| Prompt approval for genuinely new paid AWS resources | As encountered | Blocks only the affected live validation |

Secrets, access keys, MFA codes and webhook URLs must not be pasted into source
control, GitHub issues or chat. Use the approved local or managed-secret path.

## Current verified baseline

- EKS 1.35 and one managed node reached Ready.
- The collector normalized 302 resources, 771 Trivy findings and 13 CycloneDX
  SBOMs with all 23 collectors successful.
- Trivy and Kyverno health gates passed.
- Cilium/Hubble observed real forwarded flows.
- Cilium removal was corrected to use its official CNI cleanup setting; fresh
  CoreDNS pods proved AWS VPC CNI recovery.
- Falco signing-gateway and notification-worker images scan with zero
  HIGH/CRITICAL findings.
- The integrated repository verification passed with zero failures.
- GitHub OIDC and immutable ECR release foundations exist.

## Non-negotiable acceptance rules

1. Simulated evidence is never presented as live evidence.
2. Missing evidence becomes UNKNOWN or NOT CONFIGURED, never PASS.
3. Every attack-path edge cites stored evidence.
4. No customer AWS access key is accepted or stored.
5. Secret and ConfigMap values are never collected.
6. Admission blocking is not enabled on a customer production cluster during
   this milestone.
7. CNI changes require explicit approval, health checks and rollback proof.
8. Every image deployed by Sutra is immutable, scanned and attributable.
9. Every customer-facing result is tenant and customer scoped.
10. Temporary AWS resources are torn down and audited for residual resources.

## Definition of done

The one-week milestone is complete only when the full demonstration succeeds
from a fresh onboarding path, the evidence and notification receipts are
stored, automated verification is green, the acceptance report records all
limitations, the code is pushed through the reviewed GitHub workflow and the
temporary validation infrastructure is removed.

## Deferred enterprise-GA gates

The following cannot responsibly be compressed into the one-week milestone:

- independent penetration testing and remediation;
- multi-week scale, upgrade and failure soak testing;
- contractual SLA and 24x7 incident-response readiness;
- independently reviewed tenant-isolation assurance;
- disaster-recovery drills across a hosted production environment;
- legal, privacy, DPA and customer security-review completion;
- broad Kubernetes distribution/version compatibility beyond the tested EKS
  matrix.

These gates determine production GA. The one-week result is an
enterprise-feature EKS private beta suitable for controlled design partners.
