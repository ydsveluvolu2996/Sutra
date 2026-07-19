# Security Graph 2 evidence correlation

Sutra correlates the existing tenant-scoped CMDB, Kubernetes, Falco, Hubble,
and supply-chain evidence into explainable paths. This projection does not
perform a live probe, exploit a workload, infer missing reachability, or
automatically contain anything.

## Supported correlations

| Signal | Correlation boundary | Result |
|---|---|---|
| Falco | Exact namespace and workload/pod name with a single normalized workload match | Runtime event → workload → explicitly linked ServiceAccount/IAM/AWS resources |
| Hubble | `forwarded` or `audit` verdict and one exact workload identity | Observed world/workload or workload/workload edge |
| Supply chain | Exact repository and immutable image digest with a single workload match | Image evidence → deployed workload |
| Supply chain + Falco | Exact repository/digest also reported by the matched runtime event | Image evidence → runtime event → workload |
| CMDB/Kubernetes | Existing explicit relationships and supported exact configuration references | Exposure, RBAC and workload-identity paths |

Every signal edge cites its source type, immutable evidence SHA-256 and
timestamp. A path's displayed time range is computed only from cited edges
that actually carry timestamps. Configuration-only edges remain
snapshot-bound.

## Deliberate non-claims

- Observed Hubble flows are historical metadata observations and do not prove
  general or current reachability. Dropped flows never create reachable paths.
- A vulnerability or runtime event does not prove exploitability or compromise.
- An AWS resource in blast radius is not described as sensitive without
  separate data-classification evidence.
- Ambiguous workload, namespace, ServiceAccount, role or image matches stop
  correlation instead of choosing a likely candidate.
- Remediation breaks are operator guidance. They require validation and do not
  claim successful mitigation or containment.
- Sutra never reads Kubernetes Secret payloads for graph construction.

## Remaining P0 evidence gaps

Production validation still requires a real cluster with exact pod-owner
relationships so ephemeral pod names can be correlated to controllers without
name heuristics. Data sensitivity needs a separately governed classification
source. Effective AWS authorization and present network reachability require
dedicated evidence; neither is inferred by this graph.

