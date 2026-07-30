# Sutra cloud-operations capability roadmap

**Status:** delivered-source versus external-acceptance and product-gap ledger
**As of:** 2026-07-30
**Claim boundary:** this document does not claim CloudAware parity, certification,
production deployment or a release date.

CloudAware is used only as a category benchmark for mature cloud management
platforms. Sutra's current product boundary is an AWS-first, read-only-by-default
CMDB/CSPM platform with opt-in, tightly bounded agentless snapshot scanning.
Breadth across additional clouds is deliberately excluded from this comparison;
even within AWS, feature count is not the same as operational maturity.

## Status definitions

| Status | Meaning |
| --- | --- |
| Implemented in source | Runtime code, migrations and automated contract tests are present. |
| External activation | Code exists, but a real AWS account, IdP, vendor, network or operator decision must be configured and tested. |
| Product gap | The capability is absent, intentionally bounded, or materially narrower than a mature cloud-management platform. |

## Implemented in source

| Capability | Current Sutra boundary |
| --- | --- |
| Tenant model | Organization and customer boundaries, scoped memberships, invite-only onboarding, customer assignments, centralized authorization and negative isolation tests. |
| Hosted identity | OIDC PKCE and SAML 2.0 federation with server sessions, MFA-sensitive administration and replay protection. Password login and public signup are disabled in hosted mode. |
| Enterprise provisioning | SCIM 2.0 Users/Groups, customer-group assignment, suspension and session revocation with tenant-scoped credentials. |
| AWS onboarding | Versioned role templates, unique ExternalId, account/partition identity checks, trust-policy attestation and correct/omitted/wrong ExternalId probes. |
| AWS inventory and CMDB | Normalized resource inventory, relationships, tags, provenance, freshness, immutable snapshots, partial coverage and multi-complete-run retirement protection. |
| CSPM and compliance | Versioned deterministic controls, `pass`/`fail`/`unknown`/`error`, finding lifecycle, suppressions/exceptions, evidence packs and compliance views. |
| Durable collection | PostgreSQL-backed jobs, leases, idempotency, retry/dead-letter behavior, hosted collector jobs and a production drain sidecar. |
| Hosted broker | Private HA service design, workload IAM, Ed25519 request/response authentication, replay protection and shared PostgreSQL state. |
| Private evidence | Immutable, checksummed, KMS-encrypted S3 object path with scoped metadata and tenant/actor/purpose-bound single-use download grants. |
| Public API and exports | Versioned tenant-scoped API, API-key rotation, bounded exports and CSV formula neutralization. |
| ITSM | Jira and ServiceNow connector lifecycle, outbound dispatch and signed inbound updates using AWS Secrets Manager references. |
| Notifications | Durable outbox and worker paths for email and approved Slack/Teams/webhook destinations. |
| FinOps | Cost Explorer evidence, CUR 2.0/FOCUS 1.0 ingestion, allocation, budgets, anomaly and rightsizing-oriented views; not billing reconciliation. |
| Kubernetes evidence | Bounded Trivy, Falco, Kyverno and Cilium/Hubble ingestion plus posture, graph, compliance and risk workflows for enrolled clusters. |
| DSPM normalization | Tenant-scoped normalized posture/evidence ingestion and reporting; no autonomous broad data-store discovery claim. |
| Agentless scanning | Approved-plan execution and durable broker reconciliation are wired in source with teardown ownership and a restrictive write ceiling. No full live-account execution has been accepted. |
| Managed-production delivery | HA app/worker/broker, Multi-AZ PostgreSQL, private evidence storage, managed secrets, backups/observability and one protected three-image release workflow are defined in source. |

## External activation required

| Area | Evidence still required |
| --- | --- |
| Managed production | Review and deploy the AWS change set; verify exact task definitions, IAM/KMS/bucket/database policies, immutable image digests and release evidence. |
| Identity and provisioning | Configure the chosen OIDC/SAML IdP and SCIM client; pass login, MFA/step-up, recovery, assignment, suspension, deprovisioning and replay tests. |
| Tenant isolation | Run the full two-organization/two-customer matrix against the deployed application, workers, broker, cache, exports and private objects. |
| Customer AWS trust | Use a disposable sandbox to prove correct, missing and wrong ExternalId behavior, collection scope, interruption recovery and offboarding. |
| Agentless scanning | Complete a real end-to-end scan, validate findings and cleanup, confirm billable resources return to zero and retain the operator attestation. |
| ITSM and notifications | Exercise real vendor sandboxes and providers, including credential rotation, inbound/outbound signatures, replay, retry, dead-letter and outage recovery. |
| Evidence lifecycle | Test the deployed S3/KMS policies, checksum failure, grant expiry/reuse denial, retention, deletion and restore behavior. |
| Reliability and security | Complete load, AZ failure, worker backlog, restore, key rotation, rollback, alert-response and independent penetration testing. |
| Commercial operations | Approve support, incident response, privacy/retention, RPO/RTO, capacity, cost and service-level policies. |

## Product gaps relative to a mature cloud-management platform

The following are product gaps even after the external activation items pass:

- Broader AWS service and relationship depth, including continuous validation of
  every collector under pagination, throttling, permission drift and regional edge
  cases.
- Near-real-time, event-driven inventory and change intelligence; Sutra's primary
  model remains scheduled/manual snapshots plus bounded event evidence.
- Mature business-service/application dependency mapping, ownership workflows and
  service-impact modeling across cloud, Kubernetes, identity and external systems.
- A separate, generally available remediation plane with action-specific write
  roles, approvals, dry runs, rollback and blast-radius controls. Sutra intentionally
  does not add write privileges to its collector.
- Broad PSA/ITSM/chat/SIEM/SOAR/observability ecosystem coverage and vendor-certified
  integrations beyond the documented Jira, ServiceNow and notification paths.
- Billing-grade chargeback, invoice reconciliation, marketplace metering,
  commitment purchasing/execution and contract-aware optimization.
- General-purpose data discovery/classification, sensitive-data lineage and
  autonomous DSPM collection across arbitrary stores.
- General-purpose endpoint, host, package and serverless vulnerability coverage;
  Kubernetes/container/SBOM and opt-in disk evidence are narrower capabilities.
- Managed threat intelligence, 24x7 detection/response operations, behavioral
  analytics and incident-response service commitments.
- Customer-selected data residency, per-customer keys, regional disaster recovery,
  formal compliance certifications, independently verified SLA history and
  enterprise support operations.

## Release sequence

1. Close every P0 live gate in
   [`production-acceptance-evidence.md`](production-acceptance-evidence.md).
2. Activate one disposable AWS sandbox and two synthetic tenants; retain failure,
   recovery and isolation evidence.
3. Run the protected single-release workflow only after the exact commit, image
   digests, migrations and infrastructure change set are independently approved.
4. Keep unsupported features visibly unavailable or marked as not configured;
   empty data must never be presented as a successful scan or a clean environment.
5. Expand service and integration breadth only after current reliability,
   isolation, privacy and support limits are measured in production.
