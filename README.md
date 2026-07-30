# Sutra

Sutra is a production-shaped foundation for a multi-tenant MSP AWS
configuration management database (CMDB) and cloud security posture management
(CSPM) service. The intended first release gives MSP teams and their customers a
read-only inventory, resource relationships, evidence-backed configuration checks,
and scoped access to findings.

> **Managed production:** see
> [`deploy/production/README.md`](deploy/production/README.md) for the
> high-availability application, worker, broker, PostgreSQL, evidence-storage and
> protected-release design. The checked-in stack and workflow are deployable source;
> repository validation is not evidence that they have been deployed or accepted in
> a live AWS account.
>
> **Legacy/private-beta paths:** [`DEPLOY.md`](DEPLOY.md) and
> [`deploy/ec2/README.md`](deploy/ec2/README.md) retain the single-host EC2 path for
> staging and private-beta use. They are not the managed-production topology.

> **Local pilot boundary:** the application supports one persistent local MSP
> workspace, local identities with enforced MFA/RBAC, and multiple deterministic
> simulated customer accounts. Simulation runs use a signed collector-owned fixture
> catalog, durable local jobs, strict result verification, explicit D1 publication,
> immutable CMDB snapshots, and finding/change-history workflows. Live mode remains
> separately gated for a disposable AWS sandbox trust role. Every screen labels the
> active evidence source; simulated results must never be represented as customer AWS
> observations.

This repository is an implementation foundation and an EKS-first private beta,
not a generally available, independently penetration-tested or SLA-backed
service. It does not replace Amazon Inspector, Amazon GuardDuty, AWS Security
Hub, an EDR agent, or human incident response. In addition to deterministic
configuration checks, the private beta now accepts bounded real evidence from
Trivy Operator, Falco, Kyverno and Cilium/Hubble through cluster-bound ingestion
paths. Missing telemetry is always reported as not configured, partial or stale.

The verified local walkthrough now also includes tenant-scoped Cost Explorer evidence;
CUR 2.0 and FOCUS 1.0 ingestion, allocation, budgets and anomaly signals; a
versioned, scoped public API v1; and signed bidirectional Jira/ServiceNow
synchronization. CMDB query/annotation workflows, finding-backed case management,
approval-controlled compliance exceptions, bounded CloudTrail LookupEvents
normalization/detections, and expanded metadata collectors for EBS, ENI, ALB/NLB,
KMS, DynamoDB, and ECR are also implemented. Lambda inventory remains off because
`ListFunctions` can expose environment-variable values. These local capabilities
do not clear the hosted production gates below and are not presented as a
CloudAware, GuardDuty, Inspector, Security Hub, SIEM, billing-reconciliation, or
vendor-certified ITSM replacement.

The hosted identity foundation includes OIDC PKCE, SAML 2.0 service-provider
federation, SCIM 2.0 user/group provisioning, passwordless invite-only membership,
MFA-sensitive administration, session revocation and tenant/customer authorization.
These are implemented and contract-tested in source. A hosted release still requires
the selected IdP and SCIM client to be configured and exercised, plus live
multi-tenant, recovery, rate-limit and broker acceptance evidence.

The verified `sutracmdb.com` Zoho mail aliases, Workers-compatible Zoho Mail
REST delivery, and optional Zoho OIDC configuration are documented in
[`docs/zoho-mail-and-sso.md`](docs/zoho-mail-and-sso.md). The live private-beta
password login is not automatically replaced during mail setup.

The Kubernetes private-beta capability matrix, validation sequence and remaining
general-availability gates are documented in
[`docs/enterprise-kubernetes-private-beta.md`](docs/enterprise-kubernetes-private-beta.md).

## Bounded first-release scope

The first production slice is intentionally read-only by default. The single exception is agentless disk scanning, which is off unless a customer enables it and, even then, can only create snapshots it tags itself — an explicit IAM deny blocks every delete.

Included in the target slice:

- MSP organizations, customer workspaces, memberships, invitations, and explicit
  customer-scoped roles.
- Per-account onboarding through a customer-owned IAM trust role, with a unique
  platform-generated ExternalId and the exact vendor collector principal.
- Normalized, timestamped AWS resource inventory, tags, relationships, changes,
  collection coverage, and data freshness.
- Initial collection for EC2 and VPC networking, security groups, load balancers,
  RDS, S3 configuration metadata, ECS/EKS, IAM metadata, CloudTrail, and related
  account-level posture signals. Each adapter must ship with pagination, throttling,
  permission, region, and partial-result tests before it is enabled.
- Versioned, deterministic CSPM controls with evidence, severity rationale,
  `pass`/`fail`/`unknown`/`error` results, findings, suppression expiry, and audit
  history.
- Optional read-only import of findings from native AWS security services that the
  customer has already enabled. Sutra does not enable or configure those
  billable services.
- Tenant-scoped public API access and Jira/ServiceNow case synchronization. The
  hosted managed-secret paths are implemented; live vendor-sandbox delivery,
  inbound-signature and operational recovery tests remain activation gates.

Explicitly outside the first slice:

- Resource changes, automatic remediation, shell access, `iam:PassRole`, credential
  creation, or any other mutation in customer accounts.
- Inspector-equivalent host/Lambda dependency coverage or managed vulnerability
  intelligence. Trivy image/configuration/SBOM evidence is available for enrolled
  Kubernetes clusters.
- GuardDuty-equivalent threat intelligence, anomaly detection or managed detection
  operations. Falco runtime events and bounded Hubble metadata are optional cluster
  evidence sources, not GuardDuty parity.
- Security Hub-equivalent standards coverage, delegated administration, ASFF
  federation, or cross-product normalization.
- Customer invoicing, marketplace metering, PSA integrations beyond the documented
  Jira/ServiceNow scope, data-residency selection, or per-customer managed keys.
  Local FinOps analytics and Jira/ServiceNow synchronization are implemented, but
  they are not billing-grade reconciliation or vendor-certified production
  integrations. Email, Slack and Teams notification configuration/outbox support
  exists; provider credentials and live delivery still require operator activation.

Future resource management must be a separate remediation plane with a different
customer role, narrowly scoped per-action permissions, dry-run/diff, approval,
step-up authentication, idempotency, rollback guidance, and immutable before/after
audit evidence. Write permissions must never be added to the CMDB collector role.

## Architecture

The managed-production design deliberately separates the internet-facing
application from AWS credentials and STS access:

```mermaid
flowchart LR
  U["MSP and customer users"] --> E["Approved edge / DNS"]
  E --> A["Public TLS ALB"]
  A --> C["HA application tasks<br/>UI, API, tenant authorization"]
  C --> D["Multi-AZ PostgreSQL<br/>tenant state, jobs and leases"]
  D --> W["HA notification and job workers"]
  C -->|"Ed25519 signed, scoped request"| B["HA private broker tasks<br/>workload IAM role"]
  B -->|"STS AssumeRole + unique ExternalId"| R["Customer-owned read-only IAM role"]
  R --> AWSAPI["AWS metadata APIs"]
  B -->|"signed manifests and normalized evidence"| C
  C --> O["Private KMS-encrypted S3<br/>immutable evidence"]
  C --> S["AWS Secrets Manager<br/>runtime and integration secrets"]
```

The application owns user interaction, tenant authorization, CMDB queries,
finding views and durable job coordination. PostgreSQL shares sessions, replay
state, broker operation leases, jobs and tenant state across replicas. Private
S3 objects are addressed through tenant/actor-bound, expiring, single-use grants;
checksums are verified on write and read. Managed ITSM and notification credentials
are referenced from the database and resolved from AWS Secrets Manager.

The private AWS broker uses a workload IAM role, resolves registered connections
server-side, obtains short-lived STS credentials, collects only allowlisted metadata,
and never returns credentials to the application or browser. Requests and responses
use separate Ed25519 keys with replay and scope enforcement. The repository also
contains a durable job-runner sidecar and the hosted agentless execution/reconciliation
path. Agentless execution has not completed a live end-to-end account test and must
remain disabled until its exact operator configuration and attestation pass.

This is the checked-in managed-production architecture, not a claim that it is
currently deployed. The D1/Cloudflare and single-host PostgreSQL paths remain useful
for local development and legacy private-beta operation.

## Trust-role onboarding

The intended onboarding contract is:

1. An authorized MSP administrator creates a pending connection. The server
   generates a high-entropy ExternalId unique to that connection.
2. The customer reviews and deploys a versioned CloudFormation template. Its trust
   policy names the exact vendor collector workload-role ARN and requires the
   generated ExternalId. It must not trust the vendor account root or `*`.
3. The AWS broker—not the browser—resolves the stored role ARN and ExternalId, calls
   `AssumeRole`, then requires `GetCallerIdentity` to match the registered account
   and partition.
4. Validation must also prove that assumption fails when the ExternalId is omitted
   and when it is wrong. A role that passes either negative probe is rejected.
5. Temporary STS credentials stay only in collector memory. They are never written
   to D1/R2, queues, logs, traces, browser responses, or support artifacts.
6. Only a complete, authenticated, checksummed collection can replace the current
   CMDB snapshot. Partial or failed runs cannot retire unseen resources.

The templates in `infrastructure/customer-role.yaml` and
`infrastructure/customer-onboarding-role.yaml` are versioned, contract-tested source
artifacts. They are not evidence that a customer's role was deployed correctly or
that the live broker, negative ExternalId probes and offboarding workflow passed.

## Production hold: P0 gates

**Do not deploy the customer-role template into a production AWS account, register a
live production role ARN, or onboard production customer data until every P0 gate is
implemented, independently tested, and approved.** Use synthetic/sample data or a
disposable sandbox while this hold is in place.

The minimum P0 exit gates are:

| Area | Required evidence before production AWS access |
| --- | --- |
| Identity | Selected OIDC/SAML provider and SCIM client configured; session lifecycle, MFA/step-up, CSRF, invitation expiry/revocation, provisioning and deprovisioning accepted live |
| Tenant isolation | Central server authorization plus negative tests across at least two organizations and customers for every route, job, cache, object, and export |
| AWS broker | Deployed AWS workload identity, authenticated/replay-resistant broker protocol, fixed action/role allowlists, short STS sessions, and no long-lived AWS keys |
| Trust validation | Canonical ARN/account/partition checks, restrictive STS session policy, fetched role/trust-policy attestation, `GetCallerIdentity`, identical-field correct/missing/wrong ExternalId probes, disable, and truthful local offboarding tests. Rotation is rejected until a two-phase AWS-side workflow is implemented. |
| Job integrity | Durable outbox/queue, scoped opaque payloads, leases, idempotency, retries/backoff, deadlines, cancellation, DLQ, and audited replay |
| CMDB integrity | Paginated collectors, schema/size validation, manifests/checksums, atomic complete-run promotion, provenance, partial coverage, and safe retirement behavior |
| Secrets and privacy | Managed encryption and key rotation, environment separation, allowlist logging/redaction tests, retention/deletion behavior, and canary credential scans |
| Control quality | Versioned deterministic rules, fixtures, permission contracts, `unknown` on missing evidence, false-positive notes, and remediation review |
| Operations | Monitoring/SLOs, audit export, backup/restore and recovery drills, quotas, incident response, compromised-role revocation, and customer offboarding runbooks |
| Release assurance | Required CI, dependency/IaC/secret scanning, staging and sandbox acceptance tests, threat-model review, penetration-test closure, and explicit release approval |

The complete architecture and acceptance criteria are in
[`docs/architecture.md`](docs/architecture.md),
[`docs/aws-integration.md`](docs/aws-integration.md), and
[`docs/security-and-quality.md`](docs/security-and-quality.md).

## Local development

Prerequisites:

- A current Node.js 22 LTS patch (`>=22.13.0` is the package engine floor)
- pnpm 11.13.1 (the repository's canonical install input is `pnpm-lock.yaml`)

```bash
corepack enable
corepack prepare pnpm@11.13.1 --activate
pnpm install --frozen-lockfile
pnpm pilot:setup
pnpm dev:pilot
```

Open `http://localhost:3000/login`, create the first local owner with the one-time
token from `pnpm local:bootstrap-token`, and enroll MFA. Then open
`http://localhost:3000/operations` to run and publish a signed simulated account
snapshot. Setup creates permission-restricted secrets in ignored `.dev.vars` and
durable local state under ignored `.sutra/`. Fixture mode is the default and requires
no AWS account. See
[`docs/local-walkthrough.md`](docs/local-walkthrough.md) for the reliable sales walkthrough flow and the
separate live AWS sandbox procedure. The `DB` D1 binding is declared in
`.openai/hosting.json` and simulated locally by the development stack.

For a laptop walkthrough backed by a real persistent PostgreSQL database, Docker Desktop
can run the web application, collector, and PostgreSQL together:

```bash
pnpm docker:up
```

The command generates ignored high-entropy owner/runtime database secrets, applies migrations,
and waits for the complete stack to become healthy. See
[`docs/local-postgres.md`](docs/local-postgres.md) for restart persistence,
integration testing, backup, restore, and reset procedures. Database volumes,
runtime secrets, backups, AWS inventory, and customer evidence are deliberately
excluded from Git; GitHub stores the source and migrations, never live customer data.

Never use a production AWS access key locally. Real broker development must use an
isolated sandbox AWS account, workload identity or short-lived developer federation,
and separate non-production roles and keys. Do not paste a real RoleArn, ExternalId,
session token, customer inventory, or finding evidence into `.env`, fixtures, tests,
screenshots, logs, issues, or pull requests.

## Repository layout

| Path | Purpose and current status |
| --- | --- |
| `app/` | vinext/React control plane, real local onboarding, dashboard, CMDB, findings, cases, security events, compliance, FinOps and exports |
| `lib/` | Domain types, cryptographic/request boundaries, payload validation, and control definitions |
| `db/` | Drizzle/D1/PostgreSQL connection, sync, immutable snapshot, relationship, finding, case, exception, security-event, cost and audit repositories |
| `infrastructure/` | Customer role artifacts plus the managed-production HA CloudFormation design |
| `deploy/production/` | Managed-production validation and one-release operating contract |
| `services/aws-collector/` | Local and hosted brokers, PostgreSQL-backed replay/lease state, fixture/live runners, STS trust validation, agentless execution and AWS adapters |
| `docs/` | Production architecture, AWS integration, threat model, quality gates, and acceptance criteria |
| `tests/` | Deterministic domain, API, repository, tenant-isolation, collector, Kubernetes and rendered-route tests; targeted negative isolation tests exist, but production isolation-under-load and independent assurance remain gates |
| `public/` | Static assets and a downloadable copy of the customer-role template |
| `worker/`, `build/` | Cloudflare/vinext worker and local hosting integration |

## Verification

Run the same checks as CI:

```bash
pnpm security:secrets
pnpm typecheck
pnpm typecheck:collector
pnpm lint
pnpm test
pnpm test:kubernetes
pnpm test:enterprise-security
pnpm test:phase2
pnpm test:collector
pnpm db:postgres:test
pnpm build
pnpm test:rendered
```

`pnpm verify` runs that complete sequence.

CI intentionally follows the checked-in scripts and frozen pnpm lockfile. Passing
these checks proves only that the current code compiles, lints, builds, and passes
its current control-engine and rendered-route tests; it does not satisfy the
production P0 gates above.

## Deployment posture

`pnpm build` creates a deployable web artifact; it does not authorize a production
release. The protected
`.github/workflows/production-ha-release.yml` workflow builds, scans and promotes
the application, notification-worker and broker images as one release, runs the
migration task, verifies the deployed application digest and rolls services back
together on failure. It uses short-lived GitHub OIDC and a protected production
environment. Its presence—and a passing repository test—does not prove that an AWS
environment, IdP, customer trust role, evidence bucket or vendor integration has
passed live acceptance.

Development, staging and production must use separate AWS accounts/principals,
broker identities, encryption/signing keys, secrets and data stores. Infrastructure
change sets remain separately reviewed; migrations must be backward compatible with
the previous service revision.

Until the P0 hold is cleared, use fixture mode or an isolated sandbox AWS account.
A polished dashboard, successful role validation, or one-account scan is not proof
of multi-tenant production readiness.

## Roadmap

See the detailed [cloud operations capability roadmap](docs/cloudaware-parity-roadmap.md)
for a delivered-source, external-activation and product-gap matrix covering identity,
CMDB, CSPM, compliance, FinOps, Kubernetes evidence, DSPM normalization, public API,
ITSM, evidence storage, agentless scanning and managed production. It is a sequencing
document, not a CloudAware-parity, certification, production-acceptance or
release-date claim.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before changing tenant, IAM, collector,
control, or deployment boundaries. Report security issues through the private
process in [`SECURITY.md`](SECURITY.md).
