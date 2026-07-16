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
| Full regression and local database migration | Complete | Secret scan, typecheck, lint, 225 application tests, 81 collector tests, PostgreSQL integration tests, production build and 4 protected-render tests passed; the additive live database migration is applied |
| Live runtime restart | Complete | The verified build is running locally with a fresh short-lived federated collector session, the reviewed immutable onboarding template, and the migrated PostgreSQL database |
| GitHub milestone | Complete | Verified source is committed and pushed to the existing draft pull request; GitHub CI passed |

## Explicitly after the investor demo

These are production SaaS programs and are not represented as overnight deliverables:

- Hosted tenant isolation and independent tenant-isolation penetration testing.
- Enterprise OIDC/SAML, SCIM, recovery administration and production identity lifecycle.
- AWS Organizations/OU discovery and StackSets-based bulk account onboarding.
- CUR 2.0 data lake ingestion, allocation rules, commitment optimization and billing-grade reconciliation.
- CloudTrail security-event ingestion, correlation, searchable retention and SIEM integrations.
- Jira, ServiceNow, PSA, email, webhook, Slack and Teams delivery workflows.
- Full security case management with assignments, SLA policies, comments and approval-controlled exceptions.
- Customer white-labeling, subscription controls, usage metering and billing.
- Managed queue/worker fleet, hosted observability/SLOs, HA, backup/DR exercises and penetration-test closure.
- Independent workload/package/container vulnerability scanning; Sutra currently imports native Inspector evidence when available.

## Demo guardrails

- Use a disposable or approved read-only AWS account.
- Do not paste AWS credentials, MFA seeds or access keys into the application or repository.
- Enable AWS Cost Explorer before the demo if live spend is required; first-time AWS activation may not be immediate.
- Treat compliance mappings as supporting evidence, not certification or an audit opinion.
- Treat missing or incomplete collector coverage as unknown, never as a pass.
