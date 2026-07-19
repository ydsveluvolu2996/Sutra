# Sutra customer onboarding runbook

This runbook is written for the customer administrator who will connect an AWS
account and an EKS cluster to Sutra. It has no account-specific secrets or
identifiers. Replace every `<placeholder>` with your own values at run time.

## What Sutra is (and is not)

Sutra is an EKS-first AWS CMDB and cloud-security posture platform delivered as
a reviewed private beta with real customer evidence. Compliance views are
**readiness mappings, not certifications or audit opinions**. Sutra reports
only what its authorized, read-only collectors actually observe; missing data
is shown as `not configured` or `unknown` and is never treated as passing or
synthesized into findings.

Sutra never collects or stores Kubernetes Secret values, ConfigMap values,
service-account tokens, pod logs, exec sessions, packet payloads, DNS query
contents, HTTP headers, raw Falco output, registry credentials, signing private
keys, kubeconfigs, or long-lived AWS credentials.

## Prerequisites

1. An AWS account containing the EKS cluster you want to onboard.
2. Administrator access to that account through your own SSO — Sutra never asks
   for AWS access keys.
3. `kubectl` and Helm 3 on the administrator workstation for the optional
   in-cluster security modules.
4. The ability to create one read-only IAM role and one read-only Kubernetes
   RBAC binding (both templates are provided and reviewable).

## Least-privilege model

Everything Sutra uses is read-only and reviewable before you apply it.

### AWS trust role

Deploy `infrastructure/customer-role.yaml`. It creates a role that Sutra's
vendor collector principal may assume **only** with the exact External ID that
Sutra generates for your tenant. Review before applying:

- the trust policy names Sutra's exact collector principal and requires the
  External ID condition (wrong or missing External ID is rejected);
- the attached permissions are read/describe/list only.

The onboarding screen generates a one-time CloudFormation quick-create link that
carries the External ID in the URL fragment only, so it is not sent to the
Sutra server or the AWS console endpoint.

### In-cluster RBAC

Deploy `infrastructure/kubernetes-readonly.yaml`. It binds a `get`/`list`-only
ClusterRole over namespaces, nodes, workloads, services, ingresses, RBAC roles
and bindings, and related metadata. It intentionally grants **no** access to
Secret values or ConfigMap values and **no** mutating verbs
(`create`/`update`/`patch`/`delete`/`watch`/`impersonate`/`bind`/`escalate`).

### Continuous agent

The optional outbound-only visibility agent (Helm chart
`deploy/charts/sutra-visibility`, disabled by default) enrolls with a one-time
bootstrap token, holds a rotating one-hour credential, runs non-root with a
read-only root filesystem, and can be revoked immediately from Sutra. It uploads
bounded normalized evidence over outbound HTTPS and opens no inbound ports.

## Onboarding steps

Use `/kubernetes/onboard` (the seven-step wizard):

1. **Discover EKS** from your most recent authorized AWS snapshot.
2. **Select** the exact observed cluster.
3. **Select modules**: Inventory/KSPM, Trivy, Kyverno, Falco, Cilium/Hubble,
   supply chain. Cilium changes the cluster datapath and is never preselected.
4. **Review access**: each module lists its exact privileges, exclusions, and
   change risk.
5. **Generate the installation plan**: Sutra registers the tenant-scoped
   cluster and returns a pinned, non-executing command plan. The browser and
   plan API never execute AWS, Helm, or kubectl commands and never accept a
   kubeconfig.
6. **Verify health and import evidence**: read machine-readable module health,
   then confirm agent deployment health on the same screen or on the fleet
   health page (below).
7. **Review lifecycle**: pinned, atomic upgrades and reverse-order rollback.

## Installing the optional security modules

The reviewed installer pins exact chart versions (Trivy `0.32.1`, Falco
`9.1.0`, Kyverno `3.8.2`, Cilium `1.19.5`). Always render the plan first:

```bash
node scripts/kubernetes-security-stack.mjs plan \
  --context "<your-kube-context>" \
  --modules trivy,kyverno,falco
```

`preflight` validates the cluster without mutating it; `apply --execute`
installs; `health` returns machine-readable status; `uninstall --execute`
removes modules in reverse order. Kyverno installs in **Audit** mode only.
Cilium requires the explicit `--allow-cni-change` flag and a separate approval
because a CNI change has a larger connectivity blast radius; validate it on a
disposable cluster first.

For Hubble network-flow evidence, set the agent chart's
`agent.hubble.exportFile.enabled=true` with your Cilium hubble-export path and
exact version; the agent then uploads bounded, aggregated flow metadata
(identity, direction, verdict, protocol, destination port only).

## Interpreting the evidence

| Sutra view | What it shows | How to read it |
| --- | --- | --- |
| Fleet health (`/kubernetes/fleet`) | Every registered cluster's agent state and module health from signed heartbeats | A cluster with no heartbeat is `not enrolled` or `offline`, never assumed healthy. Module state is the worst across a cluster's online agents. |
| Cluster overview / inventory | Normalized resources, namespaces, workloads, RBAC, exposure | Counts reflect only collected evidence; gaps appear in Coverage. |
| Images & vulnerabilities | Trivy Operator CVE/config/RBAC/SBOM evidence correlated to workloads | A missing scanner is shown as not configured, not a clean scan. |
| Attack paths & security graph | Explicit cloud/Kubernetes/identity/RBAC/exposure/vulnerability edges | Every hop links to stored evidence; missing or reversed links stop a path. Cycles are drawn as dashed back-edges. |
| Triage worklist (risk queue) | Attack paths, failing posture controls, and scanner findings ranked by severity and blast radius | Priority is a transparent triage aid, not proof of exploitability. Export to CSV/JSON for ticketing. |
| Compliance | CIS Kubernetes, NSA/CISA, and SOC 2 readiness mappings | Readiness mapping only; controls without evidence stay `NOT_COLLECTED`. |
| Runtime | Signed, replay-resistant Falco events with Kubernetes context | No heartbeat means not configured; no event is not proof of safety. |

## Teardown

1. Uninstall in-cluster modules in reverse order:

   ```bash
   node scripts/kubernetes-security-stack.mjs uninstall \
     --context "<your-kube-context>" \
     --modules trivy,kyverno,falco --execute
   ```

2. Revoke the Sutra agent from the cluster workspace; the credential is rejected
   immediately.
3. Delete the read-only RBAC binding and the AWS trust role stacks you created.
4. Confirm no Sutra-created resource remains. If you used the disposable
   validation guard, run its teardown, which finishes with a tagged-resource
   audit that fails until no `sutra:disposable` resource remains (see
   `docs/eks-disposable-validation-runbook.md`).

## Limitations

Until the general-availability gates in
`docs/enterprise-kubernetes-private-beta.md` are complete, treat Sutra as an
AWS/EKS private beta with real customer evidence — not certified parity with a
mature CNAPP vendor, and not an audit, penetration test, or proof that threats
are absent.
