# Sutra enterprise Kubernetes private beta

## Release boundary

This release is an EKS-first, real-evidence private beta. It is designed for a
reviewed customer production account, but it is not yet a generally available,
independently penetration-tested or SLA-backed SaaS. Compliance views are
readiness mappings; they are not certifications or audit opinions.

The customer AWS role and the in-cluster agent are read-only. Sutra does not
store Kubernetes service-account tokens, Secrets, ConfigMap values, packet
payloads, DNS query contents, HTTP headers, raw Falco output, registry
credentials, signing private keys or temporary AWS credentials.

## Implemented product capabilities

| Capability | Implemented evidence path | Honest empty state |
| --- | --- | --- |
| Cluster onboarding | One-time digest-only bootstrap, exact tenant/customer/connection/cluster binding, rotating one-hour agent credential, immediate revocation | Agent offline or not enrolled |
| Inventory and KSPM | Scheduled Kubernetes API collection, immutable scan receipts, atomic promotion, deterministic posture controls | Missing and partial collectors remain unknown |
| Vulnerabilities and SBOM | Sutra-managed Trivy Operator (bundled by the chart, on by default) plus digest-bound Trivy/SBOM normalization and KEV/EPSS/CVSS enrichment | Scanner absent (managed scanner disabled and none brought) is not a clean scan |
| Software supply chain | Image digest, SBOM document digest, bounded Cosign identity/Rekor result and provenance evidence | Unsigned/unverified/not observed remain explicit |
| Attack paths | Only cited AWS, Kubernetes, IAM, RBAC, exposure and vulnerability edges | Missing relationships produce evidence gaps, not paths |
| Runtime detection | Signed, replay-resistant Falco event ingestion and heartbeat, normalized timeline | No heartbeat is not configured; no event is not proof of safety |
| Runtime response | Human-confirmed source-backed case creation and durable notification enqueue | No automatic containment or provider call in the web request |
| Admission governance | Audit-first Kyverno policy pack and bounded PolicyReport normalization | No report means admission evidence is not connected |
| Network visibility | Cluster-bound Hubble metadata upload and observed-only service map | No flow upload means not configured; old data becomes stale |
| Compliance | CIS Kubernetes, NSA/CISA and SOC 2 readiness mappings for implemented controls | No certification claim and licensed content remains external |
| Notifications | Tenant-scoped email, Slack and Teams destinations plus leased retry/dead-letter outbox | Missing managed-secret/SigV4 transports becomes `not_configured` |

## Customer-controlled cluster components

The reviewed installation orchestrator supports selectable modules:

- Trivy Operator for vulnerability, configuration and SBOM report evidence.
  Bundled and managed by the `sutra-visibility` chart by default
  (`scanner.managed=true`), so scanning works out of the box; set
  `scanner.managed=false` to run your own. Trivy performs the scanning — Sutra
  ships no scanner engine and never fabricates a clean scan.
- Falco and Falcosidekick with a separate signing-gateway contract for runtime
  events.
- Kyverno in audit mode plus Sutra's default audit policy pack.
- Cilium in AWS VPC CNI chaining mode with an internal TLS-enabled Hubble Relay.
- The outbound-only Sutra visibility agent.

Run `node scripts/kubernetes-security-stack.mjs plan` to render a no-mutation
plan. Apply and uninstall operations require explicit execution flags and
cluster checks. Cilium additionally requires a separate approval because a CNI
change has a larger connectivity blast radius.

## Disposable live-validation controls

The validation environment is limited to AWS account `738663485493`,
`ap-south-1`, a USD 40 budget and tagged disposable resources. The guard script
does not call AWS in plan mode. Creation and teardown require explicit execution
and exact account/tag/expiry checks; teardown also requires a typed
confirmation. The full sequence is documented in
`docs/eks-disposable-validation-runbook.md`.

Validation must prove:

1. The customer trust role accepts the exact vendor workload principal and
   External ID, while missing and wrong External IDs fail.
2. The agent can collect its allowlisted metadata but cannot read Secrets or
   ConfigMap values.
3. Trivy, Falco, Kyverno and Hubble report their real deployment health.
4. Evidence appears in the correct authorized customer and cluster only.
5. A deliberate disposable workload produces vulnerability, posture,
   admission, runtime and network evidence without fabricated records.
6. A human can create a runtime case and enqueue notifications without direct
   containment.
7. All temporary EKS, ECR, compute, log and test resources are removed and the
   cleanup is verified through AWS APIs.

## Remaining gates before general availability

- Deploy and exercise the AWS workload-identity broker and durable hosted job
  worker under load; do not place AWS keys in the web control plane.
- Inject a real managed-secret resolver, DNS-pinned HTTPS transport and
  workload-IAM SES signer into the notification worker.
- Complete multi-customer scale, failure, chaos, upgrade and rollback exercises.
- Complete backup/restore and the approved RPO 24h/RTO 4h recovery drill in the
  hosted environment.
- Close independent threat-model review and penetration-test findings.
- Finalize data processing, retention, support, incident response, SLA and
  customer security documentation.

Until these gates are complete, sell and describe Sutra as an AWS/EKS private
beta with real customer evidence, not as certified parity with mature CNAPP
vendors.
