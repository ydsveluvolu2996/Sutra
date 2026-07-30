# Sutra readiness tracker

**Status:** historical local-walkthrough snapshot, retained for private-beta
reproducibility. It is not the current managed-production release ledger.

This tracker separates the behavior verified for the original local walkthrough
from work that was then planned. Current hosted source status and live gates are in
[`hosted-production-foundation.md`](hosted-production-foundation.md) and
[`production-acceptance-evidence.md`](production-acceptance-evidence.md). Live AWS
results are never replaced with fabricated data; unavailable services are shown as
unavailable with the collected reason.

## Historical investor walkthrough

| Phase | Status | Walkthrough outcome |
| --- | --- | --- |
| Secure local platform foundation | Complete | Password login, TOTP MFA, RBAC, PostgreSQL, trusted-role onboarding, immutable snapshots and audit evidence |
| Live AWS CMDB and CSPM | Complete | Regional inventory, relationships, change history, deterministic findings, and bounded native GuardDuty/Security Hub/Inspector imports |
| Compliance workspace | Complete | 11-control evidence baseline, five-state outcomes, snapshot provenance, NIST CSF supporting mappings, and JSON/CSV evidence export |
| Resource 360 | Complete | Resource identity, configuration, tags, relationships, findings, changes and evidence provenance |
| Executive customer report | Complete | Customer-readable posture summary, priority recommendations, evidence hashes, and print/save-to-PDF workflow |
| AWS Cost and FinOps | Complete for live walkthrough | Real Cost Explorer ingestion, immutable cost evidence, six-month trends, service/account breakdown, forecast provenance, signals and explicit unavailable states; the first live snapshot is persisted |
| MSP Command Center | Complete | Cross-customer account, asset, workload, freshness and provenance view |
| Finding case management | Complete locally | Real finding-backed cases, assignees, priorities, due dates, SLA state, notes, lifecycle transitions, hash-linked activity and audit attribution |
| Compliance exception governance | Complete locally | Exact-finding requests, scoped owners, rationale, compensating controls, expiry, MFA-reviewed approval/rejection/revocation and report integration; exceptions never become passes |
| Security Events Lite | Complete locally; live activation pending | Bounded CloudTrail LookupEvents ingestion, normalized search, source coverage, 30-day retention, four explainable rules and audited acknowledge/reopen workflow; no fabricated events |
| Expanded AWS CMDB coverage | Complete in source; live activation pending | EBS, ENI, ALB/NLB, KMS, DynamoDB and ECR metadata plus bounded relationship mapping and partial-failure evidence; Lambda remains opt-in/off because its list response can contain environment values |
| Full regression and local database migration | Complete | Secret scan, both typechecks, lint, 250 application tests (247 passed, 3 environment-gated skips), 95 collector tests, real PostgreSQL migration/repository tests, production build and 4 protected-render tests passed; three additive live database migrations are applied |
| Live permission-pack `.2` activation | Pending explicit AWS approval | Publish the reviewed immutable template, update the existing customer role with ten additional read-only actions, re-attest the same role, then restart the verified build |
| GitHub milestone | Complete | Operations-wave source and the dynamic PostgreSQL CI-port hardening are committed and pushed to the existing draft pull request; GitHub CI passed |

## Production activation after the walkthrough

The repository now contains the managed HA app/worker/broker design, hosted
OIDC/SAML/SCIM boundaries, durable jobs, managed ITSM credentials, private evidence
storage and the protected three-image release workflow. Those are source
capabilities, not live acceptance.

Production remains gated on deployed two-tenant isolation, configured IdP/SCIM
lifecycles, a disposable AWS trust-role run, live ITSM/notification delivery,
agentless execution and teardown, S3/KMS evidence checks, backup/restore,
AZ/load/failure exercises and independent penetration testing. AWS Organizations/OU
bulk onboarding, billing-grade reconciliation, broad SIEM/PSA coverage,
white-labeling, subscriptions/metering and managed detection/response remain product
gaps.

## Walkthrough guardrails

- Use a disposable or approved read-only AWS account.
- Do not paste AWS credentials, MFA seeds or access keys into the application or repository.
- Enable AWS Cost Explorer before the walkthrough if live spend is required; first-time AWS activation may not be immediate.
- Treat compliance mappings as supporting evidence, not certification or an audit opinion.
- Treat missing or incomplete collector coverage as unknown, never as a pass.
