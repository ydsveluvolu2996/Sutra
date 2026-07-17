# Kubernetes onboarding wizard

`/kubernetes/onboard` provides a customer-reviewable seven-step workflow:

1. discover EKS records from an already published AWS snapshot;
2. select one exact observed cluster;
3. select Inventory/KSPM, Trivy, Kyverno, Falco, Cilium/Hubble and
   supply-chain modules;
4. review each module's privileges, exclusions and change risk;
5. register the tenant-scoped cluster and generate a pinned installation plan;
6. verify machine-readable health and import bounded inventory evidence; and
7. review pinned upgrades and reverse-ordered rollback.

The browser and plan API do not execute AWS, Helm or kubectl commands. The API
derives the organization and customer from an MFA-authenticated session,
resolves the connection server-side, verifies that the selected cluster is
active in that customer scope and rejects credentials, kubeconfigs and
caller-supplied tenant identifiers.

## Module safety

| Module | Default risk | Important boundary |
|---|---:|---|
| Inventory and KSPM | Low | Read-only metadata; no Secret payloads, ConfigMap values, logs or exec |
| Trivy | Low | Report metadata and sanitized evidence; no image layers stored in Sutra |
| Kyverno | Medium | Audit-first; blocking policies are not enabled by the wizard |
| Falco | Medium | Privileged node sensor; signed gateway and human-confirmed response |
| Cilium/Hubble | High | Never preselected; explicit CNI approval and AWS VPC CNI rollback proof |
| Supply chain | Medium | GitHub OIDC and immutable digests; no long-lived registry key |

Cilium plans include `--allow-cni-change`, an additional approval prerequisite
and reverse-ordered cleanup. The cluster orchestrator refuses Cilium cleanup
unless the AWS `aws-node` DaemonSet is fully ready.

## Health and lifecycle evidence

The generated health command emits
`sutra.kubernetes-module-health.v1`. A plan is labelled only as `planned`;
the UI does not infer installation, health, upgrade or rollback success from
the customer's selections. Those states require signed agent evidence or
machine-readable lifecycle output from the selected cluster.

## Remaining live-only validation

- execute the reviewed plan on a disposable EKS cluster;
- confirm every selected Helm release and node/module coverage;
- test Kyverno audit evidence and an approved disposable blocking policy;
- generate a deliberate Falco test event through the signed gateway;
- validate Cilium/Hubble connectivity and AWS VPC CNI rollback;
- run the GitHub OIDC/ECR/Cosign/Syft workflow; and
- soak-test upgrades, rollback and continuous agent heartbeats.
