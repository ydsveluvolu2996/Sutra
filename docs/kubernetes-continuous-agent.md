# Sutra continuous Kubernetes visibility agent

The EKS-first private-beta agent replaces manual JSON upload as the normal
operating path. It runs one hardened pod in the customer cluster, reads only the
reviewed metadata/report APIs, and makes outbound HTTPS requests to Sutra. It
opens no listener, Service, webhook or admission endpoint.

## Enrollment and credential boundary

An MSP creates a short-lived, single-purpose bootstrap value in the Sutra
control plane and gives it to the customer through an approved secret-delivery
channel. The customer creates a Kubernetes Secret themselves; Helm receives
only its name:

```bash
kubectl create namespace sutra-system
kubectl -n sutra-system create secret generic sutra-agent-enrollment \
  --from-literal=bootstrap='<short-lived-bootstrap-value>'

helm upgrade --install sutra-visibility ./deploy/charts/sutra-visibility \
  --namespace sutra-system \
  --set agent.enabled=true \
  --set agent.image.repository='<registry>/sutra-kubernetes-agent' \
  --set agent.image.digest='sha256:<reviewed-digest>' \
  --set agent.controlPlane.url='https://app.example.sutra.invalid' \
  --set agent.cluster.id='<stable-cluster-id>' \
  --set agent.cluster.name='<display-name>' \
  --set agent.enrollment.existingSecret='sutra-agent-enrollment'
```

The agent exchanges that value over HTTPS for a short-lived rotating agent
credential. It saves the rotating credential and any pending normalized upload
to its mode-0600 state file on the agent PVC. The bootstrap value is never
copied into state. Kubernetes service-account tokens and kubeconfigs remain
inside the customer cluster and are never sent to or persisted by Sutra.

The server-side channel must implement:

- `POST /v1/kubernetes/agents/enroll`
- `POST /v1/kubernetes/agents/{agentId}/rotate`
- `POST /v1/kubernetes/agents/{agentId}/heartbeat`
- `POST /v1/kubernetes/agents/{agentId}/scans`

Enrollment and rotation return `{agentId, token, expiresAt}`. Server storage
must retain only an authentication-safe digest of the agent token. Scan
submission uses `x-sutra-idempotency-key`; the server must bind the agent to the
exact tenant/customer/cluster and reject a key replay with different content.

## Continuous operation

- Scan interval is bounded from 5 minutes through 24 hours.
- Failed work uses capped exponential backoff with jitter.
- The exact normalized upload and idempotency key are persisted before delivery,
  so a pod restart retries the same operation.
- A complete upload is cleared only after the control plane acknowledges it.
- Heartbeats include agent version, capability versions, deployment identity,
  last successful scan and module health.
- Trivy, Kyverno, Falco and Cilium health uses API discovery only. No Falco
  events are collected by this channel.
- Trivy findings/SBOMs are sent only when official report CRDs supplied them.

Collection has existing request, response, page, resource and total deadline
limits. The outbound channel adds a 10 MiB scan request limit, 256 KiB response
limit and 20-second request timeout.

## Data exclusions

The ClusterRole cannot read Secrets or ConfigMaps. The collector does not
project annotations, environment variables, commands, volume contents, Secret
data or ConfigMap values. The only mounted Secret is the customer-created
short-lived enrollment value; it is consumed only by the enrollment client.

The agent does not claim:

- CVEs without connected Trivy evidence;
- Falco runtime events or detections;
- Kyverno enforcement decisions;
- Cilium flow visibility;
- complete module health when discovery is denied or unavailable.

Those states are reported as `DEGRADED`, `NOT_CONFIGURED` or `UNKNOWN`.

## Upgrade, health and uninstall

```bash
helm upgrade sutra-visibility ./deploy/charts/sutra-visibility \
  --namespace sutra-system --reuse-values \
  --set agent.image.digest='sha256:<new-reviewed-digest>'

kubectl -n sutra-system rollout status deployment/sutra-visibility-agent
kubectl -n sutra-system get pod -l app.kubernetes.io/component=visibility-agent

helm uninstall sutra-visibility --namespace sutra-system
```

The PVC is retained by default so an accidental Helm uninstall does not discard
a pending idempotent upload or rotating credential. After Sutra offboarding
revokes the agent, delete the customer-owned enrollment Secret and retained PVC
explicitly.

## Integration gate

The agent and chart are self-contained, but end-to-end hosted activation remains
blocked until the control plane implements the four authenticated endpoints,
tenant-scoped agent-token digest storage, scan-to-Kubernetes-repository
publication, heartbeat persistence and revocation. The local manual scanner
remains a troubleshooting tool, not the private-beta onboarding path.
