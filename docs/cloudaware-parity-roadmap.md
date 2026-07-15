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
| **CMDB inventory** | Persistent D1 snapshots for selected EC2/VPC, subnet, security group, S3, RDS, IAM account posture, CloudTrail, GuardDuty coverage, and Security Hub coverage; normalized resources, provenance, coverage, relationships, freshness, JSON/CSV export | Durable collection jobs, retry/backoff/DLQ, authenticated ingestion, retention, backup/restore, quotas, atomic reconciliation under load | Broad AWS service and CI-type coverage, event-assisted change capture, dependency graph, history/diff, ownership, custom fields, reconciliation policies, search/query API | Production gate → planned expansion |
| **Configuration posture** | Nine deterministic configuration controls and two AWS-native service coverage signals, with evidence, severity, remediation text, complete-snapshot boundary, and acknowledge/reopen workflow | Reviewed control lifecycle, central authorization, false-positive process, suppression expiry, control-version migrations, regression fixtures and quality metrics | Larger AWS control catalog, custom policies, risk context, exception approvals, standards mappings and evidence reporting | Production gate → planned expansion |
| **Native AWS security findings** | Service enablement/coverage signals only. Sutra does **not** currently import Inspector, GuardDuty, or Security Hub findings | Authenticated, paginated import contract; provider identifiers; deduplication; update/archive lifecycle; least-privilege permission review | Inspector, GuardDuty and Security Hub finding correlation with resources, accounts, ownership, workflow, and export; preserve provider semantics and links | Planned expansion |
| **Change and resource management** | No mutation permissions and no remediation execution | Separate remediation-plane threat model, customer role, step-up authentication, approvals, dry-run/diff, idempotency and immutable audit evidence | Bounded human-approved actions, policy-driven workflows, rollback guidance, maintenance windows; never add write access to the CMDB collector | Planned expansion |
| **Hosted MSP tenancy and access** | One local workspace and local operator; schemas anticipate organizations/customers, but production tenant isolation is not claimed | Hosted OIDC sessions, MFA/step-up, invitations, server-side RBAC/ABAC, customer grants, route/job/cache/export isolation tests, audit administration | MSP portfolio views, customer portals, delegated roles, SAML/SCIM, custom roles, data-residency and enterprise administration | Production gate |
| **Collection orchestration and reliability** | Signed replay-resistant loopback protocol, encrypted local registry, synchronous manual runs, last-complete-snapshot publication | Durable outbox/queue, leases, idempotency, deadlines, cancellation, retry/backoff, DLQ, autoscaling, observability/SLOs and incident runbooks | Scheduled and event-driven collection fleets, regional resilience, fleet health, per-customer windows, high-scale reconciliation | Production gate |
| **Compliance evidence** | Versioned configuration evidence and immutable snapshot/audit foundations; no compliance certification or framework-compliance claim | Evidence retention policy, audit export, exception approvals, control ownership, testable report semantics | CIS/AWS FSBP/NIST/ISO/SOC mappings, continuous evidence packages, customer reports and auditor workflows; mappings do not equal certification | Planned expansion |
| **FinOps** | Not implemented. Resource tags are inventory context only; no billing or savings claim | Cost-data ingestion design, tenant-safe storage, currency/time-zone rules, reconciliation and cost-allocation model | CUR/Data Exports ingestion, allocation, budgets, anomaly signals, commitments, rightsizing recommendations, unit economics and customer reporting | Planned expansion |
| **ITSM and collaboration** | Local finding workflow plus JSON/CSV export; no outbound integration | Signed webhook and connector security model, delivery queue, retries, secrets, audit, field mapping and tenant scopes | ServiceNow, Jira, email, Slack/Teams and PSA/ticket synchronization with ownership, status and SLA workflows | Planned expansion |
| **SIEM and security ecosystem** | No SIEM export or bidirectional security workflow | Versioned event schema, bounded evidence payloads, export authorization, delivery reliability and redaction tests | Splunk, Microsoft Sentinel, Elastic and provider-neutral webhook/API integrations; finding links remain traceable to source | Planned expansion |
| **Public API and ecosystem** | Internal local pilot APIs only; they are not a supported public integration contract | Versioned tenant-authorized API, pagination, idempotency, quotas, service accounts, audit, SDK contract and deprecation policy | Integration marketplace, customer-defined automations and governed data export/import ecosystem | Planned expansion |
| **Azure, GCP and Kubernetes** | Not implemented; no provider parity claim | Common provider-neutral CI, relationship, evidence and coverage contracts proven without weakening AWS semantics | Azure subscriptions/resources/Defender signals, GCP projects/assets/SCC signals, and Kubernetes clusters/workloads/posture through separately secured collectors | Research horizon |

## Sequenced delivery plan

### Phase 0 — Working local AWS pilot (delivered locally)

The current repository demonstrates the complete local path: create a scoped
connection, hand off a one-time ExternalId, register a customer role, validate the
trust behavior, collect a selected inventory, publish an immutable complete snapshot,
browse the CMDB and graph edges, review findings, update finding workflow state, and
export the active projection. Fixture mode proves this flow without representing its
data as customer evidence.

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

### Phase 2 — AWS CMDB, change, posture, and native finding depth

Expand collectors only with pagination, throttling, partial-result, permission, region,
schema, and fixture tests. Add change history and diff, deeper relationships, ownership,
custom fields, reviewed controls, exception lifecycle, standards mappings, and actual
Inspector/GuardDuty/Security Hub finding imports. Coverage signals must never be
presented as imported findings or replacement detection.

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
redaction, and supportable failure handling. Add ticketing, messaging, SIEM, and PSA
connectors in measured order based on MSP demand.

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
[security-and-quality.md](security-and-quality.md), and [local-demo.md](local-demo.md)
for the detailed boundaries and validation procedures behind this roadmap.
