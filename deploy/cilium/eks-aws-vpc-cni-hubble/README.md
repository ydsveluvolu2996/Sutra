# EKS AWS VPC CNI chaining + Hubble validation profile

Status: reviewed planning asset; **not installed**.

This profile is pinned to the official Cilium Helm chart `1.19.5`. The official
AWS VPC CNI chaining guide specifies `cni.chainingMode=aws-cni`,
`cni.exclusive=false`, `enableIPv4Masquerade=false`, and
`routingMode=native`. It also warns that existing pods must be restarted before
chaining and policy enforcement apply to them:

- https://docs.cilium.io/en/v1.19/installation/cni-chaining-aws-cni/
- https://docs.cilium.io/en/v1.19/observability/hubble/

## Mandatory pre-change review

1. Confirm an EKS maintenance window, rollback owner and tested backup.
2. Confirm AWS VPC CNI is at least 1.11.2 and supported by the EKS version.
3. Inventory security groups for pods, custom networking, NetworkPolicy,
   existing CNIs, node taints and unmanaged pods.
4. Render the exact `1.19.5` chart and verify its provenance/digest through the
   customer-approved artifact process.
5. Review CNI chaining limitations, especially advanced L7 policy and
   transparent encryption constraints.
6. Keep Hubble Relay `ClusterIP`; do not expose it publicly.
7. Obtain a different authorized human's approval before installation.

## Customer-controlled installation plan

The following is documentation, not an action Sutra performs:

```sh
helm template cilium oci://quay.io/cilium/charts/cilium \
  --version 1.19.5 --namespace kube-system \
  --values deploy/cilium/eks-aws-vpc-cni-hubble/values.yaml > reviewed-render.yaml
```

After reviewing the render, the customer delivery system—not the Sutra
browser—may perform the approved Helm change.

## Required validation gates

- `cilium status --wait` reports Cilium, Operator and Hubble healthy.
- `cilium connectivity test` completes according to the approved test plan.
- Hubble Relay is reachable only inside the cluster and uses TLS.
- An observed test flow appears with source/destination identity, verdict and
  L4 metadata; payloads and DNS query contents do not enter Sutra.
- Existing application pods are restarted in controlled waves and every
  non-host-network pod receives a CiliumEndpoint.
- Roll back immediately for unresolved connectivity, DNS, policy, node
  readiness, or API-server webhook failures.

Sutra accepts only bounded aggregated flow metadata through the enrolled,
cluster-bound agent upload route. It does not retain packet payloads, HTTP
headers, DNS query contents, credentials, or arbitrary Hubble records.
