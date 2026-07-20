# Sutra Cloud Operations Parity Roadmap

This roadmap describes the work required to evolve Sutra from its current local,
single-account AWS pilot into a broad MSP cloud-operations platform in the same
product category as Cloudaware. It is a sequencing document, not a parity claim,
release commitment, certification, or promise of feature equivalence.

The repository currently proves a narrow but real vertical slice. Anything marked
future below is not available to customers, even if a schema, design document, UI
concept, or IAM permission exists for it.

## Status definitions

| Status | Meaning |
| --- | --- |
| **Delivered locally** | Implemented and testable in this repository's one-customer, one-account local pilot. Fixture mode is the repeatable evaluation path; live mode is for a disposable AWS sandbox. |
| **Production gate** | Required before any production customer account or production MSP users are onboarded. This work has priority over feature breadth. |
| **Planned expansion** | Product work that can start only after the relevant production security, tenancy, job, and operational gates are proven. |
| **Research horizon** | A separate product or provider track with no delivery date and no current availability claim. |

“Local P0” means the current implementation slice, not that the production P0 gates
in the README have been satisfied. They have not.

## Delivered versus future capability matrix

| Capability area | Delivered locally today | Next production milestone | Broader parity target | Status |
| --- | --- | --- | --- | --- |
| **AWS trust onboarding** | One customer and one AWS account; platform-generated encrypted ExternalId; canonical role/account/partition binding; positive `AssumeRole`/`GetCallerIdentity` validation and missing/wrong-ExternalId negative probes; read-only CloudFormation role | Hosted AWS broker identity, managed secret/key service, connection disable/rotate/offboard lifecycle, multi-tenant authorization and negative isolation tests | AWS Organizations onboarding, delegated administration, account discovery, bulk lifecycle, regional/partition operating model | Production gate |
| **CMDB inventory** | Persistent AWS snapshots and normalized relationships with provenance, freshness, history and export; typed search/query, annotations and ownership, saved queries, change views and bounded CloudTrail-assisted change hints. Deterministic durable-job retry/DLQ, governed local retention, and a PostgreSQL dump wrapper are delivered locally. Lambda remains opt-in/off because `ListFunctions` can expose environment values. | Deploy queue workers and monitoring; prove backup restore, authenticated ingestion, quotas and atomic reconciliation under load | Broader AWS service coverage, custom fields, reconciliation policies and high-scale relationship traversal | Delivered locally → production gate |
| **Configuration posture** | Eleven versioned baseline controls with evidence, severity, remediation, complete-snapshot boundaries and finding workflow; exact-finding, time-bounded compliance exceptions require rationale, compensating control and MFA-reviewed approval before affecting reports | Reviewed control lifecycle, two-person production approval, central authorization, control-version migrations, regression fixtures and quality metrics | Larger AWS control catalog, custom policies, deeper risk context, licensed standards mappings and auditor workflows | Production gate → planned expansion |
| **Native AWS security findings** | Bounded, paginated, read-only import of existing Inspector, GuardDuty, and Security Hub findings when those services are enabled; account/Region scoping, sanitized evidence, provider identifiers and lifecycle are preserved; disabled services remain explicit coverage observations | Hosted ingestion authentication, tenant-isolation tests, durable scheduling/retries, least-privilege review, retention and lifecycle quality metrics | Deeper resource/account/ownership correlation, workflow and export while preserving provider semantics and links | Production gate → planned expansion |
| **Change and resource management** | No mutation permissions and no remediation execution | Separate remediation-plane threat model, customer role, step-up authentication, approvals, dry-run/diff, idempotency and immutable audit evidence | Bounded human-approved actions, policy-driven workflows, rollback guidance, maintenance windows; never add write access to the CMDB collector | Planned expansion |
| **Hosted MSP tenancy and access** | One local workspace and local operator; schemas anticipate organizations/customers, but production tenant isolation is not claimed | Hosted OIDC sessions, MFA/step-up, invitations, server-side RBAC/ABAC, customer grants, route/job/cache/export isolation tests, audit administration | MSP portfolio views, customer portals, delegated roles, SAML/SCIM, custom roles, data-residency and enterprise administration | Production gate |
| **Collection orchestration and reliability** | Signed replay-resistant loopback protocol, encrypted local registry, synchronous manual runs, last-complete-snapshot publication; tenant-scoped queue persistence, atomic leases, deterministic retry/backoff, DLQ decisions, local retention sweep and backup wrapper are delivered locally | Deploy workers; add cancellation, autoscaling, observability/SLOs, independently tested restore and incident runbooks | Scheduled and event-driven collection fleets, regional resilience, fleet health, per-customer windows, high-scale reconciliation | Production gate |
| **Compliance evidence** | Versioned evidence, immutable snapshot/audit foundations, custom framework composition, customer assignments, control ownership, trend, governed exceptions, checksummed exports and auditor sign-off. All mappings are readiness evidence, never certification or an audit opinion. | Hosted retention, externally reviewed control semantics, production approval policy and independently exercised evidence exports | Licensed mappings where required, continuous evidence packages and external auditor portal workflows | Delivered locally → production gate |
| **FinOps** | Tenant-scoped Cost Explorer evidence plus CUR 2.0 and FOCUS 1.0 ingestion, allocation rules, budgets, deterministic anomaly signals and workspace insights. Outputs disclose source, coverage and reconciliation limits; no guaranteed-savings claim. | Live CUR/Data Exports scheduling, invoice reconciliation, currency/time-zone policy, production retention and allocation ownership | Commitments, utilization-aware rightsizing, unit economics and MSP customer billing | Delivered locally → production gate |
| **ITSM and collaboration** | Finding-backed cases plus stored tenant-scoped Jira and ServiceNow connectors, explicit status mappings, HMAC-SHA256 verified inbound webhooks, idempotent dispatch, remote-newer-wins conflict notes and connector administration UI. Unknown remote states are rejected rather than guessed. | Managed connector secrets, deployed delivery workers/retries, vendor sandbox certification and operational monitoring | Email, Slack/Teams and PSA synchronization with escalation and broader bidirectional lifecycle | Delivered locally → production gate |
| **SIEM and security ecosystem** | Security Events Lite: real, bounded CloudTrail LookupEvents collection, normalized searchable management events, source coverage, 30-day local retention and four deterministic evidence-linked rules; not a log lake or behavioral SIEM | Scheduled tenant-scoped telemetry, delivery reliability, redaction/isolation tests, governed retention and export authorization | Centralized cloud telemetry, broader correlation and Splunk, Microsoft Sentinel, Elastic and provider-neutral integrations | Production gate → planned expansion |
| **Public API and ecosystem** | Versioned `/api/public/v1` resources, findings, cases, snapshots, compliance and vulnerability reads plus case updates; organization/customer token bounds, scopes, tamper-rejected cursor pagination, quotas, idempotency conflict protection, audit attribution, OpenAPI and token administration are delivered locally. | Hosted gateway controls, key rotation policy, load testing, SDK generation and published support/deprecation policy | Integration marketplace, customer-defined automations and governed data exchange | Delivered locally → production gate |
| **Azure, GCP and Kubernetes** | Kubernetes has a substantial local CNAPP evidence plane, including enrollment, inventory/KSPM, graph and attack paths, vulnerability/SBOM evidence, admission, runtime, network, supply-chain and compliance components. Registry catalog/tag/digest policy is validated against a live local Registry v2 instance. Azure and GCP are not implemented. | Persistent EKS soak/scale testing, multi-node agent authentication, live Trivy/Falco/Kyverno/Cilium validation and production operations | Azure subscriptions/resources/Defender signals and GCP projects/assets/SCC signals through separately secured collectors | Kubernetes delivered locally → production gate; Azure/GCP research horizon |

## Sequenced delivery plan

### Phase 0 — Working local AWS pilot (delivered locally)

The current repository exercises the complete local path: create a scoped
connection, hand off a one-time ExternalId, register a customer role, validate the
trust behavior, collect a selected inventory, publish an immutable complete snapshot,
browse the CMDB and graph edges, review findings, update finding workflow state, and
export the active projection. Fixture mode proves this flow without representing its
data as customer evidence.

Live collection also imports existing findings from enabled Amazon Inspector,
GuardDuty, and Security Hub services through bounded, paginated, account/Region-scoped
read-only adapters. It preserves provider identity and lifecycle, sanitizes evidence,
and reports disabled or partial service coverage explicitly. It does not enable those
services or reproduce their vulnerability, threat-detection, or standards engines.

Exit evidence already present is useful engineering evidence, not production release
approval. The local control plane, operator model, loopback broker, synchronous jobs,
and single-account database scope are intentional limitations.

### Phase 1 — Hosted security, tenancy, and job foundation

This is the mandatory production gate. Deliver hosted identity and sessions,
organization/customer authorization, negative tenant-isolation tests, a deployed AWS
broker workload identity, managed encryption and signing keys, durable jobs,
authenticated ingestion, monitoring, backup/restore, retention/deletion, incident
response, quotas, and environment separation. No production customer data should be
accepted before the P0 evidence in the README is independently reviewed and approved.

The repository now delivers the code-shaped local pieces for durable jobs,
retry/backoff/DLQ, retention decisions, tenant-scoped pruning, and PostgreSQL backup.
Hosted OIDC workload identity, managed secrets, SOC 2 examination, penetration testing,
high availability and disaster recovery remain **OPS-GATED**. Code and local tests do
not close those operational gates.

### Phase 2 — AWS CMDB, change, posture, and native finding depth

Expand collectors only with pagination, throttling, partial-result, permission, region,
schema, and fixture tests. Add change history and diff, deeper relationships, ownership,
custom fields, reviewed controls, exception lifecycle, standards mappings, and deeper
correlation and workflow for imported Inspector, GuardDuty, and Security Hub findings.
Coverage signals must never be presented as imported findings, and imported findings
must never be presented as replacement detection.

Any resource-management capability belongs to a separate, opt-in remediation plane
with a distinct role and approval boundary. It is not an extension of the read-only
collector.

### Phase 3 — FinOps

Establish a reconciled cost model before presenting savings. Ingest AWS CUR or Data
Exports, handle account/currency/time-zone corrections, allocate shared cost, preserve
invoice traceability, and measure recommendation quality. Then add budgets, anomaly
signals, commitment coverage/utilization, rightsizing, and MSP/customer reporting.

### Phase 4 — ITSM, SIEM, PSA, and collaboration integrations

Build a reliable connector platform before individual logos: tenant-scoped secrets,
signed webhooks, delivery queues, retries, idempotency, schema versioning, audit,
redaction, and supportable failure handling. A SIEM capability additionally requires
tenant-safe security-event and log ingestion, normalization, correlation, governed
retention, and detection operations; none of that is delivered by the current native-
finding imports. Add ticketing, messaging, SIEM, and PSA connectors in measured order
based on MSP demand.

### Phase 5 — Azure, GCP, and Kubernetes

Treat each provider as a separate security and data-quality program. First prove a
provider-neutral CMDB contract that still preserves provider-specific identity,
regions, hierarchy, relationships, coverage, and evidence. Then ship independently
tested Azure, GCP, and Kubernetes collectors and posture packs. “Multi-cloud” should
not mean shallow tag-only discovery.

## Release rules for every phase

1. A UI, schema, permission, design, or fixture is not a delivered capability by
   itself.
2. Every collector publishes explicit coverage and preserves the last complete good
   snapshot when a run is partial or fails.
3. Missing permission or unavailable evidence becomes `unknown`/`error`, never a
   silent pass.
4. Provider-native findings keep their source identifier, timestamps, lifecycle, and
   source link; Sutra does not relabel them as proprietary detections.
5. Customer-impacting actions require a separately reviewed authorization and audit
   boundary.
6. No compliance, savings, detection, scale, availability, or parity claim ships
   without measurable acceptance evidence.

See [architecture.md](architecture.md), [aws-integration.md](aws-integration.md),
[security-and-quality.md](security-and-quality.md), and [local-walkthrough.md](local-walkthrough.md)
for the detailed boundaries and validation procedures behind this roadmap.
