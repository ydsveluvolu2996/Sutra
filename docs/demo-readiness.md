# Sutra demo readiness tracker

This tracker separates verified product behavior from work that is merely planned. A phase is marked complete only after the relevant local checks pass. Live AWS results are never replaced with fabricated data; unavailable services are shown as unavailable with the collected reason.

## Tomorrow's investor demo

| Phase | Status | Demo outcome |
| --- | --- | --- |
| Secure local platform foundation | Complete | Password login, TOTP MFA, RBAC, PostgreSQL, trusted-role onboarding, immutable snapshots and audit evidence |
| Live AWS CMDB and CSPM | Complete | Regional inventory, relationships, change history, deterministic findings, and bounded native GuardDuty/Security Hub/Inspector imports |
| Compliance workspace | Complete | 11-control evidence baseline, five-state outcomes, snapshot provenance, NIST CSF supporting mappings, and JSON/CSV evidence export |
| Resource 360 | Complete | Resource identity, configuration, tags, relationships, findings, changes and evidence provenance |
| Executive customer report | Complete | Customer-readable posture summary, priority recommendations, evidence hashes, and print/save-to-PDF workflow |
| AWS Cost and FinOps | Complete for live demo | Real Cost Explorer ingestion, immutable cost evidence, six-month trends, service/account breakdown, forecast provenance, signals and explicit unavailable states; the first live snapshot is persisted |
| MSP Command Center | Complete | Cross-customer account, asset, workload, freshness and provenance view |
| Finding case management | Complete locally | Real finding-backed cases, assignees, priorities, due dates, SLA state, notes, lifecycle transitions, hash-linked activity and audit attribution |
| Compliance exception governance | Complete locally | Exact-finding requests, scoped owners, rationale, compensating controls, expiry, MFA-reviewed approval/rejection/revocation and report integration; exceptions never become passes |
| Security Events Lite | Complete locally; live activation pending | Bounded CloudTrail LookupEvents ingestion, normalized search, source coverage, 30-day retention, four explainable rules and audited acknowledge/reopen workflow; no fabricated events |
| Expanded AWS CMDB coverage | Complete in source; live activation pending | EBS, ENI, ALB/NLB, KMS, DynamoDB and ECR metadata plus bounded relationship mapping and partial-failure evidence; Lambda remains opt-in/off because its list response can contain environment values |
| Full regression and local database migration | Complete | Secret scan, both typechecks, lint, 250 application tests (247 passed, 3 environment-gated skips), 95 collector tests, real PostgreSQL migration/repository tests, production build and 4 protected-render tests passed; three additive live database migrations are applied |
| Live permission-pack `.2` activation | Pending explicit AWS approval | Publish the reviewed immutable template, update the existing customer role with ten additional read-only actions, re-attest the same role, then restart the verified build |
| GitHub milestone | Pending | Commit and push this verified operations wave to the existing draft pull request, then confirm GitHub CI |

## Explicitly after the investor demo

These are production SaaS programs and are not represented as overnight deliverables:

- Hosted tenant isolation and independent tenant-isolation penetration testing.
- Enterprise OIDC/SAML, SCIM, recovery administration and production identity lifecycle.
- AWS Organizations/OU discovery and StackSets-based bulk account onboarding.
- CUR 2.0 data lake ingestion, allocation rules, commitment optimization and billing-grade reconciliation.
- Scheduled/event-driven CloudTrail ingestion, long-term log-lake retention, broader correlation and SIEM integrations beyond the bounded manual LookupEvents workspace.
- Jira, ServiceNow, PSA, email, webhook, Slack and Teams delivery workflows.
- Production workflow automation, escalation calendars, external ticket synchronization and two-person exception approval beyond the local case/exception workflows.
- Customer white-labeling, subscription controls, usage metering and billing.
- Managed queue/worker fleet, hosted observability/SLOs, HA, backup/DR exercises and penetration-test closure.
- Independent workload/package/container vulnerability scanning; Sutra currently imports native Inspector evidence when available.

## Demo guardrails

- Use a disposable or approved read-only AWS account.
- Do not paste AWS credentials, MFA seeds or access keys into the application or repository.
- Enable AWS Cost Explorer before the demo if live spend is required; first-time AWS activation may not be immediate.
- Treat compliance mappings as supporting evidence, not certification or an audit opinion.
- Treat missing or incomplete collector coverage as unknown, never as a pass.
