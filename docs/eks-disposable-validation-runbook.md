# Disposable EKS validation and customer install runbook

This runbook is the reviewed EKS-first path for validating Sutra's continuous
agent and optional Kubernetes security modules. Nothing in this document was
executed against AWS while it was authored.

## Fixed release inputs

The installer pins exact Helm chart versions. The chart indexes were checked
from the official publishers on 2026-07-17:

| Module | Chart | Application | Official index SHA-256 |
| --- | --- | --- | --- |
| Trivy Operator | `0.32.1` | `0.30.1` | `2dfb5c7f8a2b8cd338208c362b88e4eae607b24f199226c31a6f5bb76c7ace08` |
| Falco | `9.1.0` | `0.44.1` | `2a767d6aeccf2392c5e263ae1f5e0950520affe3a9908ff7986ac213649c45b4` |
| Kyverno | `3.8.2` | `1.18.2` | `f4fc787cf1d6781eefb9e9b45837edcddcfae984c872888289914e97207cc5de` |
| Cilium | `1.19.5` | `1.19.5` | `56b60445a2c650b387ce2edb13cfd8d83219a9da693b0523915dba8be451a29e` |

Changing any pin is a reviewed release. Trivy `0.32.1` is the chart version,
not the scanner application version.

## AWS safety envelope

Use a dedicated disposable cluster. Tag the cluster and all supported resources:

- `sutra:disposable=true`
- `sutra:expires-at=<exact UTC timestamp within 24 hours>`

Export only identifiers and configuration, never AWS keys:

```bash
export AWS_REGION=ap-south-1
export SUTRA_AWS_ACCOUNT_ID=738663485493
export SUTRA_EKS_CLUSTER_NAME=sutra-validation-YYYYMMDD
export SUTRA_KUBERNETES_CONTEXT=arn:aws:eks:ap-south-1:738663485493:cluster/sutra-validation-YYYYMMDD
export SUTRA_DISPOSABLE_EXPIRES_AT=2026-07-18T12:00:00Z
export SUTRA_DISPOSABLE_BUDGET_USD=40
export SUTRA_BUDGET_NOTIFICATION_EMAIL=<approved-address>
export SUTRA_ECR_REPOSITORY=sutra/kubernetes-agent
```

Review without making an AWS call:

```bash
node scripts/eks-disposable-guard.mjs plan
```

Only after an administrator has authenticated through SSO:

```bash
node scripts/eks-disposable-guard.mjs preflight --execute
node scripts/eks-disposable-guard.mjs budget --execute
```

The USD 40 budget sends alerts at 80% and 100%. AWS Budgets is an alert, not a
hard spending cap. The expiry tag and scheduled human/automation teardown are
still mandatory. Cost data can be delayed.

## EKS and ECR acceptance setup

Create the EKS cluster with public access restricted to the validator's address
or use a private network path. Enable control-plane audit logs. Use the smallest
supported managed node group that can run Falco, Trivy jobs, Kyverno, Cilium,
Hubble, and the Sutra agent. Do not use Spot for the first acceptance run.

Create the immutable ECR repository and GitHub OIDC role with
`infrastructure/github-ecr-release-role.yaml`. The account must already have the
GitHub OIDC provider. In GitHub, create a protected environment named exactly
`kubernetes-production-release`, require an independent reviewer, prevent
self-review, and restrict deployment branches. Configure environment variables:

- `AWS_REGION`
- `AWS_ROLE_ARN` from the template output
- `ECR_REPOSITORY`
- `NODE_IMAGE`, including an immutable `@sha256:` digest

The release workflow has no AWS key secrets. It assumes the narrowly scoped role
with OIDC, pushes a commit-tagged image, resolves the digest, blocks on Trivy
HIGH/CRITICAL findings, creates an SPDX SBOM, and keyless-signs and attests the
digest with Cosign.

## Customer module install

Install Helm 3 and kubectl on the administrator workstation. The orchestrator
never accepts kubeconfig content, Kubernetes tokens, signing keys, or AWS keys.

First inspect the exact plan:

```bash
node scripts/kubernetes-security-stack.mjs plan \
  --context "$SUTRA_KUBERNETES_CONTEXT" \
  --modules cilium,trivy,kyverno,falco
```

Cilium is configured only for EKS AWS VPC CNI chaining:

- `cni.chainingMode=aws-cni`
- `cni.exclusive=false`
- native routing and no Cilium IPv4 masquerade
- kube-proxy replacement disabled
- Hubble and Hubble Relay enabled

The preflight refuses Cilium unless `aws-node` exists and node provider IDs are
AWS-backed. A CNI change can disrupt traffic; use a disposable cluster first.

For Falco, an approved signing-gateway image is required by immutable digest.
Before apply, an administrator must create in `sutra-falco`:

- ConfigMap `sutra-falco-gateway` with `controlPlaneUrl` and `clusterId`
- Secret `sutra-falco-signing` with `keyId` and `hmacKey`

Create the Secret through the customer's secret manager or from protected files
using `kubectl --from-file`; never put key material in a command argument,
terminal history, Helm value, Git repository, or log. The gateway image must
implement `deploy/kubernetes/security-stack/falco-signing-gateway.contract.yaml`:
bounded `/events`, `/readyz`, `/healthz`, HMAC signing headers, replay-safe
nonces, key ID rotation, no request-body logs, and outbound HTTPS only.

```bash
export SUTRA_FALCO_GATEWAY_IMAGE=<registry>/sutra-falco-gateway@sha256:<digest>

node scripts/kubernetes-security-stack.mjs preflight \
  --context "$SUTRA_KUBERNETES_CONTEXT" \
  --modules cilium,trivy,kyverno,falco \
  --allow-cni-change

node scripts/kubernetes-security-stack.mjs apply \
  --context "$SUTRA_KUBERNETES_CONTEXT" \
  --modules cilium,trivy,kyverno,falco \
  --allow-cni-change \
  --execute
```

Kyverno policies are installed only in Audit. Falco uses modern eBPF. Trivy
generates report CRDs and does not scan Secret values. Cilium remains chained
behind AWS VPC CNI. Each optional module can be selected independently.

## Acceptance evidence

Run the health gate:

```bash
node scripts/kubernetes-security-stack.mjs health \
  --context "$SUTRA_KUBERNETES_CONTEXT" \
  --modules cilium,trivy,kyverno,falco \
  --allow-cni-change
```

Record without Secret data:

1. chart releases and exact versions;
2. ready pod counts and rollout status;
3. `aws-node`, Cilium, and Hubble Relay readiness;
4. Trivy VulnerabilityReport, ConfigAuditReport, RBAC assessment, and SBOM
   object counts;
5. Kyverno PolicyReport counts and confirmation that every Sutra policy is
   Audit;
6. a synthetic Falco rule event arriving through the signed gateway;
7. Sutra enrollment, heartbeat, scan idempotency, module coverage, and customer
   portal projections;
8. an agent restart with no duplicate scan publication;
9. credential rotation and revocation;
10. ECR digest, Trivy result, SBOM, Cosign signature, and attestation.

Never export Kubernetes Secrets, ConfigMaps, service-account tokens, Falco HMAC
keys, webhook credentials, kubeconfigs, or raw workload environment variables.

## Reverse-order cleanup

Preview the cleanup by reviewing the install plan and selected modules. Remove
modules in reverse order:

```bash
node scripts/kubernetes-security-stack.mjs uninstall \
  --context "$SUTRA_KUBERNETES_CONTEXT" \
  --modules cilium,trivy,kyverno,falco \
  --allow-cni-change \
  --delete-namespaces \
  --execute
```

After verifying the exact disposable tags, the guard repeats module cleanup,
deletes managed node groups, waits, deletes the EKS cluster, optionally deletes
the disposable ECR repository, and removes the budget:

```bash
node scripts/eks-disposable-guard.mjs teardown \
  --confirm "$SUTRA_EKS_CLUSTER_NAME" \
  --execute
```

Finally inspect Resource Groups Tagging API, CloudFormation stacks, load
balancers, ENIs, EBS volumes, snapshots, log groups, NAT gateways, Elastic IPs,
ECR, and AWS Budgets. Teardown is incomplete until the tagged-resource query is
empty and the billing owner records the final cost.
