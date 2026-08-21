# Implementation roadmap

The goal is CloudAware-class AWS coverage with Sutra's own UX and stricter evidence/tenant boundaries. Do not build 978 collectors at once. Establish one catalog and one adapter framework, then ship verifiable service waves.

## Product architecture

```text
Google/work-email sign-in
        ↓
Tenant + customer/account scope
        ↓
AWS onboarding (Role recommended; keys feature-gated)
        ↓
Connection health + coverage contract
        ↓
AWS Navigator ── Global Search ── Resource 360
        ↓                 ↓                ↓
Inventory/graph      findings/cost     history/evidence
        ↓
Security · Compliance · FinOps · Monitoring · Backup · Tags · Automation
```

## Epic 0 — catalog, contracts, and UX foundation

- Add a versioned AWS category/service/resource-type catalog seeded from the captured inventories.
- Map every type to maturity: catalogued, adapter planned, implemented, externally accepted, unavailable.
- Define per-type permissions, scope, Regions/partitions, pagination, quotas, schema, relationships, freshness, and failure semantics.
- Build Navigator routes, breadcrumbs, counts, coverage badges, recent/pinned items, and global customer/account scope.
- Add indexed global search with tenant/customer/account filters.

Acceptance: a user can navigate all approved AWS services without false zeros; unsupported and permission-missing states are explicit; every response is tenant-scoped.

## Epic 1 — onboarding at organization scale

- Preserve the current single-account IAM-role flow as the secure default.
- Add Organizations management/delegated-admin onboarding.
- Generate StackSet artifacts and allow organization/OU targeting.
- Discover member accounts, select scope, validate every role/account, and reconcile account additions/removals.
- Keep access-key fallback separately feature-gated and unsupported for flows that require role attestation/session ceilings.

Acceptance: correct/wrong/missing External ID, suspended/moved/removed member accounts, OU changes, retry, and offboard pass real disposable-organization and two-tenant tests.

## Epic 2 — collector breadth waves

1. **Networking depth:** NAT/transit gateways, VPC endpoints, VPN, peering, route associations, Direct Connect, Route 53, CloudFront, Network Firewall, WAF, Global Accelerator.
2. **Compute and containers:** Auto Scaling, launch versions, ECS services/tasks, Lambda, Batch, Elastic Beanstalk, Lightsail, expanded EKS/Kubernetes inventory.
3. **Storage and databases:** RDS clusters/Aurora, ElastiCache, Redshift, OpenSearch, EFS, FSx, Storage Gateway, S3 metadata/policy/replication, Backup resources.
4. **Governance and identity:** IAM users/roles/groups/policies/access metadata, Organizations/OUs/SCPs, Config, CloudFormation, Service Catalog, SSM, License Manager, Secrets metadata, ACM/KMS/CloudHSM.
5. **Integration and analytics:** API Gateway, EventBridge, SNS/SQS, Step Functions, MQ, MWAA, Glue, Athena, Kinesis, MSK, EMR.
6. **AI/ML and specialist services:** Bedrock depth, SageMaker, Rekognition, Comprehend, Kendra, Lex, Transcribe, IoT, media, migration, and end-user computing.

Each adapter ships collector → normalization → relationships → immutable persistence → API → Navigator/Resource 360 → focused tests → controlled AWS evidence as one vertical.

## Epic 3 — relationship and change intelligence

- Expand typed edges alongside each adapter.
- Add an interactive topology canvas with evidence-labelled edges and bounded blast radius.
- Introduce applications/business services, ownership, environment, criticality, and service impact.
- Reconcile CloudTrail/EventBridge events against scheduled complete snapshots; never let events silently replace authoritative inventory.
- Support change subscriptions and audit-ready timelines.

## Epic 4 — operational modules

- Dedicated Tag Analyzer with required-tag policies, normalization, exceptions, coverage, spend impact, exports, and separately approved write actions.
- AWS Backup plans, vaults, selections, jobs, recovery points, restore testing, protected-resource coverage, retention, and orphan detection.
- Unified CloudWatch metrics/logs/alarms/service-health workspace, alert routing, escalation, dashboards, KPIs, and runbooks.
- Production collection schedules, cancellation, backoff, permission drift, service health, and per-adapter SLOs.

## Epic 5 — platform modules and ecosystem

- Deepen compliance policy packs, vulnerability prioritization, exceptions/SLAs, remediation cases, patch workflows, and evidence reports.
- Add connector framework and health for identity/PAM, SIEM/SOAR, observability, DevOps, data platforms, ITSM, and notifications.
- Mature API/OAuth/MCP credential administration, expiration, last-used, revocation, and audit.
- Add configurable dashboards, saved/team views, scheduled exports, and persona-specific start pages.

## Epic 6 — governed automation and AI

- Keep collection roles read-only.
- Add action-specific write roles only behind approval, dry-run, scope preview, rollback, and immutable audit.
- Expose a self-describing, tenant-scoped CMDB graph to Sutra's MCP/agent interfaces.
- Add resource-finding, inventory research, runbook assistance, and auto-documentation without giving models direct credential access.

## Release gates for every epic

- exact source and permission contract;
- bounded pagination, throttling, retry, deadline, and payload behavior;
- immutable persistence and last-good retention;
- authenticated server-derived tenant scope and cache isolation;
- explicit loading/configuration-required/empty/partial/stale/failed/complete UI states;
- responsive, keyboard-accessible, rendered UI evidence;
- real provider reconciliation, multi-account/Region coverage, and two-tenant negative tests;
- protected `develop → main` promotion, fixed-SHA CI, immutable image, migration/backup/canary/rollback, and post-deploy smoke evidence.

## Recommended first implementation slice

Start with the Navigator/catalog foundation plus one deep service slice: **VPC networking**. It exercises regional/global scope, pagination, dense relationships, security context, topology, change tracking, and resource counts. Once this vertical pattern is proven, EC2, IAM, RDS, S3, Lambda, and Backup can follow without rebuilding the platform contracts.
