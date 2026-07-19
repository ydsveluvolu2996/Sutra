# Kubernetes module validation

This runbook covers Sutra's Trivy/Syft/Cosign, Kyverno, Falco and
Cilium/Hubble validation paths. Local simulation proves input boundaries,
correlation, deterministic evidence generation, health reporting and cleanup
orchestration. It is not customer or live-cluster evidence.

## Local deterministic validation

```sh
node scripts/kubernetes-enterprise-demo.mjs validate
node scripts/kubernetes-enterprise-demo.mjs generate > /tmp/sutra-kubernetes-demo.json
```

The generated scenario correlates one workload across:

- an immutable image digest, Trivy summary, SBOM document hash, Cosign identity
  and provenance;
- an audit-only Kyverno PolicyReport failure;
- bounded Hubble flow metadata, including external egress and a denied
  database connection; and
- a Falco shell-execution event.

Raw scanner results, SBOM components, certificates, attestations, command
lines, environment data, PolicyReport messages, packet payloads, DNS query
contents and headers are intentionally discarded.

## Cluster plan and evidence

Planning never contacts or changes a cluster:

```sh
node scripts/kubernetes-security-stack.mjs plan \
  --context CUSTOMER_CONTEXT \
  --modules trivy,kyverno,falco
```

After an approved installation, produce machine-readable health evidence:

```sh
node scripts/kubernetes-security-stack.mjs health \
  --context CUSTOMER_CONTEXT \
  --modules trivy,kyverno,falco \
  --format json
```

For Cilium/Hubble, add `cilium` and `--allow-cni-change`. Health evidence then
requires the Cilium DaemonSet, Cilium operator and Hubble relay rollouts to
complete. Cilium remains AWS VPC CNI chained, non-exclusive and without
kube-proxy replacement.

## Cleanup and rollback

Cleanup is explicit, reverse-ordered and verified:

```sh
node scripts/kubernetes-security-stack.mjs uninstall \
  --context DISPOSABLE_CONTEXT \
  --modules cilium,trivy,kyverno,falco \
  --allow-cni-change \
  --execute \
  --format json
```

Before Cilium removal, the installer refuses to proceed unless every desired
`aws-node` pod is ready and none is unavailable. After removal, it waits for
the AWS VPC CNI rollout again. Cleanup evidence proves Helm releases, the Falco
gateway and Sutra Kyverno policies are absent. Namespaces are retained by
default; deleting them requires the separate `--delete-namespaces` flag.

Admission policies remain `Audit` with `failurePolicy: Ignore`. Signature and
provenance enforcement templates are excluded from the default policy bundle
until their trust identity is configured, tested and independently approved.
