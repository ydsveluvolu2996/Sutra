# Sutra capability and gap analysis

This assessment compares the captured benchmark with current Sutra source at `develop` on 2026-08-21. It does not promote any release maturity or claim live acceptance.

## Strong existing foundations

| Area | Current Sutra capability | Source evidence |
| --- | --- | --- |
| Tenant isolation | Organization/customer roles, assigned-customer scope, server-derived authorization, scoped APIs, invitation and session controls. | `lib/auth-policy.ts`, `lib/api-connection-scope.ts`, `db/customer-assignment-repository.ts`, `db/portfolio-repository.ts` |
| AWS onboarding | IAM Role recommended; unique External ID; partition/account validation; CloudFormation quick launch and manual artifacts; feature-gated access-key fallback; lifecycle validation and offboard. | `app/onboard/onboard-account.tsx`, `lib/aws-cloudformation-quick-launch.ts`, `lib/aws-customer-role-artifacts.ts`, `lib/aws-pilot-security.ts` |
| Product shell | Capability-filtered groups for Overview, Onboarding, CMDB, Kubernetes, Security, Compliance, FinOps, and Operations. | `app/components/navigation-config.ts`, `app/components/app-shell.tsx` |
| CMDB core | Snapshot inventory, search/filter, Resource 360, changes, annotations, custom fields/assets, saved queries, dependencies/dependents/blast radius, manual relationships. | `app/cmdb/`, `lib/cmdb-query.ts`, `lib/cmdb-relationships.ts`, `db/cmdb-workspace-repository.ts` |
| Security/compliance | Posture findings, vulnerability and exploitability, exposure, flow logs, registry, IaC, agentless scan, detections, cases, frameworks, evidence and reports. | `app/components/navigation-config.ts`, `app/compliance-frameworks/`, `lib/compliance-engine.ts` |
| FinOps | Extensive AWS dashboard catalog and source-specific pipelines for cost, showback, allocation, budgets, anomalies, optimization, support/health, sustainability, and reports. | `lib/finops-dashboard-catalog.ts`, `app/costs/`, `app/api/v1/finops/` |
| Operations/integrations | Collection runs, alerts, notification routing, report builder, public API, Jira, ServiceNow, SCIM, and governance approvals. | `app/operations/`, `app/alerts/`, `app/reports/`, `app/settings/`, `docs/public-api-v1.md` |

## Partial capabilities

- **Inventory breadth:** the main AWS inventory runner collects a valuable but narrow slice: EC2/VPC primitives, ELBv2, S3, RDS instances, DynamoDB, KMS, ECR, EKS, IAM account posture, CloudTrail, GuardDuty, Security Hub, Inspector findings, SSM patch state, and Bedrock guardrails/posture. This is far below the captured 114 service destinations and 978 object types.
- **Navigator:** Sutra has a broad module rail and CMDB inventory, but no AWS category → service → resource-type Navigator with service counts and per-type coverage.
- **Search:** navigation search, inventory filtering, and saved structured queries exist, but there is no indexed cross-product search for resources, accounts, findings, reports, and settings.
- **Topology:** typed relationship traversal and blast radius exist, but the interface is list-based and relationship extraction follows the narrower collector surface.
- **AWS Organizations:** selected FinOps collectors read Organizations data, but general multi-account CMDB onboarding and member-account lifecycle are unavailable.
- **Automation:** alerts, notifications, scheduled FinOps reports, approvals, and durable jobs exist; general customer-controlled live inventory schedules remain incomplete.
- **Tag governance:** FinOps provides required-tag coverage and spend impact, but Sutra lacks a dedicated cross-service Tag Analyzer with policy, normalization, exceptions, and bulk workflows.
- **Monitoring:** platform collection health and metric alerts exist, but not a unified CloudWatch metrics/logs/alarms/service-health workspace.

## Major gaps

1. Canonical AWS service/object catalog and Navigator.
2. Broad collectors for serverless, containers, networking depth, storage, databases, integration, analytics, AI/ML, governance, and security metadata.
3. AWS Organizations/OU onboarding with StackSets and member lifecycle.
4. Indexed global search and service/resource landing pages.
5. Rich visual topology and business/application service modeling.
6. Near-real-time CloudTrail/EventBridge change reconciliation.
7. Dedicated Tag Analyzer, AWS Backup, CloudWatch monitoring/logs, and collection scheduling modules.
8. Broad connector catalog for observability, SIEM/SOAR, identity/PAM, DevOps, and notifications.
9. Subscription/licensing and mature API credential administration.
10. General remediation plane with separate write roles, approvals, dry runs, rollback, and blast-radius checks.

## Preserve these Sutra advantages

- server-derived tenant/customer/account scope;
- explicit empty/partial/stale/failed evidence states;
- immutable accepted snapshots and last-good retention;
- collector-owned AWS credentials and bounded signed provider routes;
- separate read collection from optional write/remediation permissions;
- fixed-SHA release, rollback, and two-tenant acceptance controls.
