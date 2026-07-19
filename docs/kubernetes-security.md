# Sutra Kubernetes security module

Sutra's Kubernetes private-beta module performs credential-free inventory and
evidence-based configuration posture analysis against a live Kubernetes API.
It uses a customer-approved read-only service account and does not read
Kubernetes Secrets, ConfigMaps, annotations, container environment variables,
commands, or volume contents.

## Current capability

- Cluster, namespace, node, workload, pod, service, ingress, NetworkPolicy and
  RBAC inventory
- Bounded, paginated, GET-only API collection
- Pod Security Standards posture checks
- Privileged container, privilege escalation, Linux capability, seccomp,
  host namespace and hostPath checks
- Image digest and `latest` tag hygiene checks
- CPU/memory request and limit checks
- Liveness and readiness probe checks
- Public service and ingress TLS checks
- RBAC wildcard and escalation-verb checks
- Namespace Pod Security label and default-deny NetworkPolicy checks
- Per-API collector coverage and `UNKNOWN` results when evidence is absent
- Tenant-scoped cluster registration, encrypted trust data, immutable scan
  history and promoted complete-scan evidence
- Trivy Operator vulnerability, misconfiguration and CycloneDX SBOM evidence
  import with source coverage and artifact-integrity metadata
- Kubernetes assurance in the customer-facing executive report

The module claims image/package CVEs and SBOM coverage only when a connected
scanner supplied that evidence. It does **not** claim runtime threat detection,
Kubernetes audit-log detections, or admission-control enforcement unless those
independent evidence sources are installed and connected.

The first live AWS validation used a temporary EKS cluster and Trivy Operator.
The reproducible results and teardown proof are recorded in
`docs/live-kubernetes-validation-2026-07-17.md`.

## Onboard a cluster

Use a Kubernetes administrator session only to install the reviewed read-only
identity:

```bash
kubectl --context <customer-context> apply -f infrastructure/kubernetes-readonly.yaml
```

Confirm the exact access before scanning:

```bash
kubectl --context <customer-context> auth can-i --as=system:serviceaccount:sutra-system:sutra-readonly list pods --all-namespaces
kubectl --context <customer-context> auth can-i --as=system:serviceaccount:sutra-system:sutra-readonly get secrets --all-namespaces
```

The first command must return `yes`; the Secret check must return `no`.

Run the scanner:

```bash
pnpm kubernetes:scan --context <customer-context> --cluster-id <stable-id> --cluster-name "<display name>"
```

The command uses the existing `kubectl` login to mint a 10-minute
`sutra-readonly` service-account token. The token stays in process memory and
is never printed or written. The resulting mode-0600 JSON artifact contains
only normalized inventory, coverage and posture results under
`.sutra/kubernetes/`.

## Operational and security boundaries

- API calls have per-request and total timeouts, response-size limits,
  pagination limits and a total-resource ceiling.
- HTTPS is mandatory except for an exact loopback address used by local tests.
- Kubeconfigs with exec plugins, auth providers, credential files, client
  certificates or insecure TLS are rejected by the collector boundary.
- Provider errors are converted to controlled messages before persistence.
- A failed API family remains visible as failed coverage and must not be
  interpreted as a clean control result.
- The checked-in ClusterRole contains no mutation verbs, resource wildcards,
  non-resource URLs, Secret access or ConfigMap access.

## Enterprise completion gates

Before general availability, Sutra still requires:

1. Kubernetes audit-log and runtime sensor integrations
2. Admission policy assessment/enforcement workflows
3. CIS benchmark mapping with licensed content review where applicable
4. Scheduled collection, drift, exceptions and case-routing workflows
5. Multiple representative live-cluster validations, scale tests and chaos tests
6. Independent penetration testing and hosted-production runbooks

These are explicit release gates, not implied current functionality.
