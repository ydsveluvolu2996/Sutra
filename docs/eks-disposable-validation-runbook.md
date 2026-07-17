# Disposable EKS validation and customer install runbook

This runbook is the reviewed EKS-first path for validating Sutra's continuous
agent and optional Kubernetes security modules.

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

Resolve the validator's current public IPv4 address outside the repository and
restrict the EKS public endpoint to that exact `/32`. Only after an
administrator has authenticated through SSO:

```bash
export AWS_PROFILE=sutra-administrator
export SUTRA_VALIDATOR_CIDR=<approved-public-ip>/32

node scripts/eks-disposable-guard.mjs create --execute
node scripts/eks-disposable-guard.mjs preflight --execute
node scripts/eks-disposable-guard.mjs budget --execute
```

The guarded create path provisions Kubernetes 1.35 with one on-demand
`t3.large` managed node, an encrypted 20-GiB gp3 volume, no NAT gateway, no SSH,
IMDSv2, OIDC and all EKS control-plane log types with seven-day retention. The private EKS endpoint is enabled
for node-to-control-plane traffic; the public endpoint remains restricted to
the exact validator `/32`. The cluster and managed node group receive the
disposable and expiry tags. The generated eksctl configuration is mode `0600`,
used once and deleted immediately.

The USD 40 budget sends alerts at 80% and 100% against gross account cost before
credits and refunds. This is intentionally conservative because a newly created
allocation tag may not yet be usable. AWS Budgets is an alert, not a hard
spending cap. The expiry tag and scheduled human/automation teardown are still
mandatory. Cost data can be delayed.

## EKS and ECR acceptance setup

Create the EKS cluster with public access restricted to the validator's address
or use a private network path. Enable control-plane audit logs. Use the smallest
supported managed node group that can run Falco, Trivy jobs, Kyverno, Cilium,
Hubble, and the Sutra agent. Do not use Spot for the first acceptance run.

First list the account's IAM OIDC providers. If and only if the account does not
already have `token.actions.githubusercontent.com`, deploy
`infrastructure/github-oidc-provider.yaml` once at account level. The template
intentionally omits `ThumbprintList`: IAM retrieves the provider certificate
authority thumbprint. Do not paste a copied or historical thumbprint into the
stack. If the provider already exists, reuse its ARN instead of attempting to
create a duplicate.

Create the immutable ECR repository and repository-scoped GitHub OIDC role with
`infrastructure/github-ecr-release-role.yaml`, passing the exact, case-sensitive
`owner/repository` slug and the account-local provider ARN. The role trust
requires both the `sts.amazonaws.com` audience and the exact default GitHub
subject:

```text
repo:owner/repository:environment:kubernetes-production-release
```

The IAM subject contains the protected environment rather than the branch.
Therefore, in GitHub create an environment named exactly
`kubernetes-production-release`, require at least one independent reviewer,
prevent self-review, and allow only the protected `main` branch. Do not approve
a run from a changed or unreviewed release workflow. The workflow also fails
before requesting AWS credentials unless it is a manual run from protected
`main` in `ydsveluvolu2996/Sutra`.

Configure these environment variables; do not create AWS key secrets:

- `AWS_ACCOUNT_ID`, the exact 12-digit target account
- `AWS_REGION`
- `AWS_ROLE_ARN` from the template output
- `AGENT_ECR_REPOSITORY` from `AgentEcrRepositoryName`
- `FALCO_GATEWAY_ECR_REPOSITORY` from `FalcoGatewayEcrRepositoryName`
- `NODE_IMAGE`, set exactly to the reviewed
  `gcr.io/distroless/nodejs22-debian13:nonroot@sha256:a2723a2817c5b01b8e7b98d567bc8b5a6b0e713e25bfb0a82b6ade4b9db06f50`
  value enforced by the release workflow

Before the first release, independently review the environment configuration,
branch protection, workflow action pins, role trust policy, role permissions,
ECR immutability, scan-on-push setting, and repository URI. Keep environment
approval separate from the person who requested the release.

The release workflow has no AWS key secrets. It requests a 15-minute credential
session and verifies the exact AWS account plus both repository controls. It
builds the agent and Falco signing gateway from their separate Dockerfiles using
the same digest-pinned `NODE_IMAGE`, pushes each under the commit tag, and
resolves each immutable digest. Both images must pass Trivy HIGH/CRITICAL gates.
The workflow produces separate SPDX SBOM artifacts, then keyless-signs and
attests both digests with Cosign. A failed scan or attestation fails the release.
After both attestations, it retains a release manifest that binds the agent and
Falco gateway digest references to the exact commit, repository, workflow ref,
run ID, and run attempt.

The ECR role is limited to token retrieval and the read/push operations required
for the two explicit repository ARNs. Both repositories retain tagged images
and signature/SBOM evidence; their lifecycle policies remove only abandoned
untagged layers. Obtain `SUTRA_FALCO_GATEWAY_IMAGE` from the
`falcoSigningGateway` digest reference in the reviewed release-manifest artifact;
never deploy its mutable commit tag.

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

## Validation record — 2026-07-17

The disposable cluster `sutra-validation-20260717` in account `738663485493`,
region `ap-south-1`, was used for this acceptance run. No long-lived AWS access
key was created.

- EKS 1.35 and its single managed `t3.large` node became Ready.
- Trivy Operator 0.32.1 and Kyverno 3.8.2 passed the module health gate.
- The read-only collector imported 302 normalized resources, 771 Trivy
  findings and 13 CycloneDX SBOM reports. All 23 collectors succeeded. Secret
  and ConfigMap values were not collected.
- Three Sutra Kyverno policies were accepted in Audit mode and generated
  PolicyReport evidence.
- Cilium 1.19.5, Hubble Relay and the AWS VPC CNI chaining datapath passed the
  health gate. Hubble observed forwarded Kubernetes traffic. The Cilium release
  was then removed and the `aws-node`, CoreDNS and node readiness rollback gates
  all passed.
- The Falco signing-gateway Linux/amd64 image at digest
  `sha256:9b20e5377a934ad8ddd7bf321c4d810884e6b892f0a6d72d81b0e8f5c998557d`
  passed the ECR scan with no HIGH or CRITICAL findings. End-to-end runtime
  event delivery still requires the authenticated Sutra control plane to be
  reachable from the cluster over HTTPS.
- GitHub OIDC and immutable agent/gateway ECR repositories were created through
  CloudFormation. The release cannot run until the protected
  `kubernetes-production-release` environment has an independent reviewer.
- The USD 40 AWS Budget is an alert only. Credits are included and the new
  allocation tag was not yet active, so it must not be represented as a hard or
  gross-spend cap.

The acceptance cluster has an expiry tag, but expiry tags do not delete
resources. Complete the guarded teardown and the final orphan-resource audit in
the same validation session.
