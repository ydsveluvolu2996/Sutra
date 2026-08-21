# Product shell and navigation

## Entry and global shell

**Observed:** CloudAware first presents a Control Hub with entitled applications. The trial exposed CloudAware CMDB and CloudAware Support. Inside CMDB, a persistent top bar provided:

- a Tabs Menu and multi-tab workspace;
- organization branding;
- global CMDB object search;
- Applications, Documentation, Setup, and User Profile menus;
- refresh, copy-link, pin, close, and new-tab controls;
- online support and trial-state messaging.

The workspace preserved several open product tabs at once, such as Navigator, Admin Console, Backup, and Tag Analyzer. This is a useful operator pattern: switching tasks does not discard context.

## Application launcher

**Observed:** the Applications menu exposed:

- CloudAware CMDB
- Reports & Dashboards
- Analytics Studio
- Data Manager
- Command Center
- Security Center
- Policy Center

**Documented:** the Control Hub can also launch module-specific experiences such as Conflux for logs, Wazuh for intrusion detection, legacy Zabbix monitoring, connected SSO applications, advanced analytics, and licensed partner services.

## Tabs Menu information architecture

**Observed:** the Tabs Menu contained these top-level areas:

- CMDB
- Admin
- Backup
- Tag Analyzer
- Analytics Studio
- Reports

It also grouped objects and links under Applications, Classic Infrastructure, Compliance & Security, Referenced Objects, Compliance Engine 2.0, Patching, CloudAware CIs, and tenant custom objects.

## CMDB Navigator

**Observed:** Navigator uses a left tree and a service landing panel. Its persistent affordances include Home, provider/service search, help, Recent items, provider groups, integration groups, resource counts, breadcrumbs, and service-to-resource list-view tiles.

The provider tree included AWS, Azure, Google Cloud, Oracle, Alibaba, VMware, Kubernetes, identity, security, monitoring, DevOps, device-management, and data-platform sources. On the AWS home panel, the trial highlighted Accounts, EC2 Instances, RDS Instances, RDS Clusters, S3 Buckets, and DynamoDB Tables.

Opening `AWS / Compute / EC2` showed a service page of count-bearing resource destinations rather than one generic inventory table. Examples included EBS snapshots and volumes, capacity reservations, Elastic IPs, images, instances, host facts, mount points, status events, key pairs, launch templates and versions, placement groups, reserved and spot capacity, security groups and rules, packages, repositories, OS services/users, runtime environments, vulnerability scans, and virtualized services.

**Documented:** list views support column presets, quick filters, saved views, export, tagging, assignment, and bulk actions. Detail views combine properties, relationships, history/audit, findings, alerts, and actions. Global search finds configuration items by name, ID, IP, or tag and supports recent/pinned access.

## Admin, setup, and personal controls

**Observed:** Admin Console has three local destinations: Clouds & Integrations, API Credentials, and Subscriptions. The Setup menu exposed Developer Console, Setup, and UI Settings. User Profile exposed profile, My Settings, and logout. Sensitive identity values are intentionally omitted from this research pack.

## Sutra product implication

**Inference:** Sutra should use one coherent shell with:

- a global customer/account scope switcher;
- a searchable AWS category → service → resource-type Navigator;
- preserved workspace context through tabs or recents/pins;
- capability-filtered module launchers;
- resource counts and collection health at every level;
- global search across accounts, resources, findings, reports, and settings;
- tenant-scoped personal settings separated from organization administration.

An unavailable service must remain visible with an explicit `not collected`, `permission required`, or `not yet supported` state. A zero count must mean a complete successful collection, not missing coverage.
