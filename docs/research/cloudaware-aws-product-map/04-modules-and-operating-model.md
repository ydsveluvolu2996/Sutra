# Modules and operating model

## Product modules

**Documented:** CloudAware organizes its platform around:

- CMDB
- Cost Management
- Compliance Engine
- Vulnerability Management
- Patch Management
- Intrusion Detection
- Log Management
- Unified Monitoring
- Backup & Replication

The common foundation is the CMDB: normalized objects, attributes, relationships, ownership, tags, ingestion provenance, customization, history, search, queries, list views, reports, and actions.

## CMDB workflows

**Documented:** core CMDB capabilities include:

- Navigator, global search, object list views, record-detail tabs, and KPI tiles;
- queries, browsing, reports, exports, and scheduled distribution;
- custom objects, calculated attributes, enrichment/classification rules, fact-derived fields, and page-layout extensions;
- Tag Analyzer and Virtual Applications;
- change events, retained history/audit, alerts, and notifications;
- RBAC through baseline profiles, additive permission sets, record scoping/sharing, SSO/MFA, and periodic access review.

## Cost Management

**Documented:** billing ingestion feeds allocation and business mapping, shared-cost rules, budgets, forecasting, anomaly detection, KPIs, dashboards, exports, rightsizing, commitment analysis, waste reduction, alerts, showback, and chargeback. CMDB tags, ownership, application, and environment context enrich financial views.

## Security and compliance

**Documented:** Compliance Engine evaluates policy packs and custom policy language, creates findings/output objects, routes remediation, and provides operational reports and dashboards. Vulnerability Management combines CloudAware scanning, cloud-native scanners, and third-party tools with prioritization, exceptions/SLAs, remediation tasks, ITSM, dashboards, and playbooks. Intrusion Detection uses Wazuh-oriented host telemetry, rules, alerts/watchers, file-integrity monitoring, triage, and audits.

## Monitoring, logs, patching, and backup

**Documented:** Unified Monitoring combines cloud-native metrics/events, agent telemetry, and third-party tools with policies, thresholds, routing, escalation, notifications, webhooks, dashboards, KPIs, and runbooks. Log Management covers sources, ingestion, search/analysis, dashboards, retention, alerting, playbooks, APIs, and webhooks. Patch Management adds agent coverage, package inventory, baselines, maintenance/blackout windows, reboot policies, scheduled jobs, approvals, verification, rollback, exceptions, and compliance reporting.

**Observed:** Backup has an account filter, dashboard, AWS policy areas for EC2 instances and replication, RDS instances/clusters, S3 buckets, and account defaults, plus Google disk policies. Empty-state cards deep-link to each resource's backups.

**Documented:** backup coverage also includes tag-driven policy, retention, vaults, status, orphan management, S3 backup, replication, and audit/compliance reporting.

## Tag Analyzer

**Observed:** Tag Analyzer is provider-filtered and searchable, presents one resource-type table with pagination and page-size control, and exposes hundreds of taggable AWS types. This is a dedicated operational module, not only a FinOps chart.

## Analytics, automation, and AI

**Documented:** Advanced Analytics provides event/metric ingestion, data preparation and health, a governed data model, KPIs, dashboards, warehouse integrations, operations, and limits. Reports and dashboards support filters, drill-through, personal/team sharing, scheduling, exports, and standardized KPIs.

Automation & Extensibility includes APIs, connections, webhooks/events, and the Breeze Agent. The MCP Server presents the CMDB as a self-describing graph, can expose governed BigQuery export access, supports bring-your-own-LLM, and targets resource finding, navigation, research, developer automation, and auto-documentation.

## Integrations

**Observed and documented:** the catalog spans cloud/infrastructure, billing, identity/PAM, data platforms, security/vulnerability, endpoint management, monitoring/observability, logging, DevOps/SDLC/AppSec, ITSM/collaboration/notification, webhooks/APIs, and connectivity agents. Examples include AWS Billing, Kubernetes/OpenCost, Active Directory, Okta, CyberArk, Snowflake, CrowdStrike, Qualys, Tenable, Datadog, New Relic, Splunk, GitHub, GitLab, Terraform, Jira, ServiceNow, PagerDuty, Slack, and SNS.

## Persona model

**Documented:** the major operating personas are administrators, cloud engineers/SREs, security and compliance analysts, developers/platform teams, FinOps, and executives. Each receives a role-specific quick start and constrained module access.

**Inference:** Sutra should keep one tenant-safe data plane while offering persona-specific navigation, saved views, dashboards, and permissions. A customer user should see only that customer's accounts and settings; organization-wide administration must require explicit organization capabilities.
