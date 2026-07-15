# AWS integration slice: MSP CMDB and security posture platform

Status: implementation-ready design notes, 2026-07-15  
Companion onboarding template: `work/customer-role-template.yaml`

## 1. Outcome and hard boundary

The first production slice should be a cross-account, read-only inventory and
security-posture service. A customer deploys one IAM role in each AWS account. The
platform assumes that role with temporary STS credentials, collects configuration
metadata, builds a resource/relationship graph, runs deterministic posture rules,
and ingests findings from AWS security services that the customer has already
enabled.

The base role must not change resources, read S3 objects, read database rows,
decrypt KMS ciphertext, retrieve secret values, download Lambda/ECR code, execute
commands, or enable a billable AWS service. "Manage resources" belongs in a later,
separate remediation plane with its own role, executor, approval flow, and narrowly
scoped permissions. Do not add writes to the CMDB role.

This product can provide lower-cost configuration, exposure, identity-hygiene, and
governance checks. It must not be marketed as an equivalent replacement for:

- GuardDuty's managed threat intelligence, behavioral/anomaly models, and direct
  analysis of CloudTrail management events, VPC flow data, and Route 53 Resolver
  DNS activity.
- Inspector's purpose-built, continuous EC2, ECR image, and Lambda vulnerability
  scanning engine.
- Security Hub CSPM's AWS-managed standards, control engine, integrations, and
  aggregation behavior.

The platform should complement these services: show whether they are enabled,
ingest their findings when enabled, correlate those findings with the CMDB graph,
and offer transparent deterministic controls when a customer does not buy them.

## 2. Trust and credential model

### 2.1 Customer role trust policy

The customer role trusts the **exact ARN** of the vendor collector workload role,
not the vendor account root. Its trust policy requires both:

1. `sts:ExternalId` equal to a platform-generated value unique among MSP tenants.
2. `sts:RoleSessionName` matching `mspcmdb-*` so customer CloudTrail records are
   easy to identify.

AWS explicitly recommends an External ID for third parties that access multiple
customers, says the third party should generate/control it, and says it is not a
secret. Its purpose is confused-deputy prevention. Generate at least 128 random
bits, encode as UUID/ULID/base64url-safe text, enforce uniqueness in the database,
and never accept a customer-chosen value. A tenant-wide value is adequate for a
StackSet; a per-account connection value provides better revocation granularity.
Rotate it when an account changes tenant ownership or a connection is re-created.

Official references:

- [AWS: access to accounts owned by third parties](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_common-scenarios_third-party.html)
- [AWS: the confused deputy problem](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html)
- [AWS STS AssumeRole API](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html)

### 2.2 AssumeRole request contract

The credential broker, not a browser or public API handler, constructs this call
from a canonical connection record:

```text
RoleArn:        stored customer role ARN (never arbitrary request input)
ExternalId:     stored tenant/account External ID
RoleSessionName:mspcmdb-<scanJobUlid>       # <= 64 valid STS characters
DurationSeconds: 900-3600                   # template maximum is 3600
```

After the first successful call, immediately call `sts:GetCallerIdentity` with the
assumed credentials and require its account ID to equal the account parsed from the
registered role ARN and the expected onboarding account. Reject and quarantine any
mismatch. Record the assumed-role ARN and AWS request IDs in audit telemetry, but
never log an access key, secret key, session token, External ID, full SDK request,
or credentials-bearing error object.

Do not persist STS credentials. Keep them in worker memory, refresh close to expiry,
and terminate the job when the connection is disabled. If the vendor workload role
is itself an assumed role, remember that AWS role chaining caps the next session at
one hour.

### 2.3 Vendor-side isolation

Use a dedicated credential-broker/collector workload role in a security tooling AWS
account. It should have only `sts:AssumeRole` to the fixed customer role path/name,
for example:

```json
{
  "Effect": "Allow",
  "Action": "sts:AssumeRole",
  "Resource": [
    "arn:aws:iam::*:role/mspcmdb/MSPCMDBReadRole"
  ]
}
```

Use separate vendor accounts and collector roles for `aws`, `aws-us-gov`, and
`aws-cn`; AWS partitions do not share trust. If customers can choose a role name,
generate an exact-ARN allowlist or shard policies rather than widening to every IAM
role. Workers must receive a signed job envelope containing a connection ID; the
broker resolves role ARN/External ID server-side after checking tenant ownership.

The application database remains part of the authorization boundary: a wildcard
account number in the vendor IAM policy is scalable but means a compromised broker
can attempt every customer role. Mitigations are a fixed role path/name, exact
trusted vendor principal, tenant-unique External IDs, no interactive access to the
broker, short sessions, egress controls, workload identity, CloudTrail alerting, and
strong separation between public API and collector credentials.

Do not expose assumed credentials or AWS console federation URLs to MSP/customer
users. They access normalized CMDB data through SaaS RBAC. If customers need AWS
console access, implement that separately with their federation/IAM Identity Center.

## 3. Customer onboarding

### 3.1 Single account flow

1. Create an immutable tenant and connection record in `PENDING` state.
2. Generate the External ID and a short-lived signed onboarding nonce.
3. Render a CloudFormation Quick Create link pinned to a versioned template URL and
   SHA-256 digest. Pre-fill the exact vendor collector role ARN, External ID, tenant
   ID, and role name. Never put the External ID in template Outputs.
4. Customer reviews and creates the stack with `CAPABILITY_NAMED_IAM`.
5. Customer submits the stack's `CustomerReadRoleArn`, or an authenticated callback
   associates it with the pending nonce.
6. Broker calls `AssumeRole` plus `GetCallerIdentity`, verifies account/partition,
   then runs small probes (`DescribeRegions`, `GetResources`, one global API).
7. Store a capability matrix from real probe results. A permissions boundary, SCP,
   disabled Region, or service state can make the effective access narrower than
   the template.
8. Mark `ACTIVE` only after identity verification. Schedule a baseline scan.

Never mark onboarding successful just because a role ARN has valid syntax. AWS says
a third-party platform should not retain/use a role that can be assumed without the
correct External ID.

### 3.2 Template decisions

`customer-role-template.yaml` uses explicit versioned policies rather than attaching
AWS `ReadOnlyAccess`. It also avoids relying solely on the evolving AWS-managed
`SecurityAudit` policy. The template intentionally excludes data-plane and write
actions such as:

- `s3:GetObject`, `s3:ListBucket`
- `secretsmanager:GetSecretValue`, `ssm:GetParameter*`, `kms:Decrypt`
- `lambda:GetFunction`, `ecr:BatchGetImage`
- `ecs:DescribeTaskDefinition`, `ecs:DescribeTasks`, EC2 instance user-data APIs
- CloudWatch Logs event reads, SQS message reads, database query/data APIs
- all create/update/delete/put/start/stop/remediation actions

Modules are explicit:

| Module | Default | Reason |
| --- | ---: | --- |
| Core compute/network/storage/identity metadata | on | CMDB baseline |
| Existing GuardDuty/Security Hub/Inspector/Access Analyzer findings | on | Core security correlation; never enables services |
| Lambda configuration | off | `ListFunctions` can return environment-variable values |
| CloudFront configuration | off | `ListDistributions` can return origin custom-header values |
| SSM Inventory/compliance | off | Can reveal installed software and custom inventory values |
| Organizations discovery | off | Account metadata is sensitive and only works in management/delegated accounts |

The role accepts an optional customer permissions boundary. It is tagged with a
non-secret tenant ID and access mode. The External ID is `NoEcho`, but must still be
treated as non-secret because principals able to inspect the role trust policy can
see it.

The sensitive-field decisions above follow the documented response shapes for
[Lambda ListFunctions](https://docs.aws.amazon.com/lambda/latest/api/API_ListFunctions.html)
and [CloudFront ListDistributions](https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_ListDistributions.html).

IAM resources are global within an account. Deploy this onboarding stack **once per
account in one chosen StackSet Region**, not into every Region. The collector, not
the IAM stack, fans out across enabled Regions.

### 3.3 Organization onboarding

`organizations:ListAccounts` can be called only from the Organizations management
account or a delegated administrator. It is paginated; AWS warns that a `List*`
operation can return an empty page with a non-null `NextToken`, so continue until
the token is null. Use the account `State` field, not the deprecated `Status` field,
before AWS's documented 2026-09-09 retirement milestone.

Organization discovery does **not** grant inventory access to member accounts.
Deploy the customer read role into every target account. Recommended flow:

1. Customer enables trusted access for CloudFormation StackSets.
2. From the management account or a registered StackSets delegated administrator,
   create a service-managed StackSet targeting selected OUs.
3. Use one deployment Region because the template creates global IAM resources.
4. Enable automatic deployment for accounts that join those OUs.
5. Deploy a separate stack directly to the management account; service-managed
   StackSets do not deploy stack instances to the management account.
6. On every org refresh, add new `ACTIVE` accounts, suspend collection for
   `SUSPENDED`/closing accounts, and never infer deletion from a partial page.

Delegated StackSets administrators can deploy broadly across an organization; make
that customer-side privilege and its implications clear in onboarding documentation.

Official references:

- [AWS Organizations ListAccounts API](https://docs.aws.amazon.com/organizations/latest/APIReference/API_ListAccounts.html)
- [CloudFormation StackSets with service-managed permissions](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stacksets-orgs-associate-stackset-with-org.html)
- [CloudFormation StackSets and Organizations](https://docs.aws.amazon.com/organizations/latest/userguide/services-that-can-integrate-cloudformation.html)

### 3.4 Offboarding

1. Set connection state to `DISABLING`; stop enqueueing and revoke worker leases.
2. Customer deletes the CloudFormation stack or removes the role trust.
3. Broker verifies `AssumeRole` is denied, then sets `DISABLED`.
4. Expire caches and raw snapshots immediately. Retain normalized inventory,
   findings, and audit data only for the contracted retention period, then erase.
5. Keep a non-sensitive tombstone (tenant, account ID, timestamps, reason) so the
   same role ARN cannot be silently rebound to a different tenant.

## 4. Collector and fan-out architecture

### 4.1 Work hierarchy

```text
tenant scan
  -> connection/account scan
       -> global-service tasks (once per account)
       -> enabled Region tasks
            -> service adapter + pagination pages
                 -> normalize resources/edges
                 -> evaluate rules whose facts are complete
```

Every task includes `tenant_id`, `connection_id`, `account_id`, `partition`,
`region`, `service`, `scan_id`, `attempt`, and an absolute deadline. Use a queue with
visibility leases and deterministic task IDs so retries are idempotent. Apply
weighted fair scheduling so one large MSP/customer cannot starve smaller tenants.

### 4.2 Region discovery

Call `ec2:DescribeRegions(AllRegions=true)` once per assumed account session. Scan
only Regions whose `opt-in-status` is `opt-in-not-required` or `opted-in`; record
`not-opted-in` as explicit coverage state. Do not maintain a hard-coded Region list.
The API can return response elements in varying order, so sort/deduplicate by Region
name and do not attach semantic meaning to response order.

Global/one-per-account adapters: IAM, Organizations, Route 53, opt-in CloudFront,
and S3 bucket enumeration. Regional adapters: EC2/VPC, ELB, RDS, EFS, DynamoDB, ECS,
EKS, ECR, opt-in Lambda, CloudTrail configuration, Config, GuardDuty, Inspector,
Security Hub, Logs, CloudWatch, Backup, and the Resource Groups Tagging API. Some
nominally global services have regional control planes or global-event behavior;
encode scope on each adapter rather than relying on the service name.

Reference: [EC2 DescribeRegions API](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeRegions.html).

### 4.3 Adapter contract

Each service adapter should implement:

```ts
interface AwsInventoryAdapter {
  id: string;
  scope: "GLOBAL" | "REGIONAL";
  requiredActions: string[];
  collect(ctx: ScanContext, cursor?: string): AsyncIterable<InventoryPage>;
  normalize(raw: unknown, ctx: ScanContext): NormalizedFactBatch;
  redact(raw: unknown): unknown;
}
```

`InventoryPage` carries `nextCursor`, AWS request IDs, item count, API latency, and
coverage/error metadata. All list/describe operations must consume every pagination
token. Never delete resources based on a page, adapter, Region, or scan that ended
with `AccessDenied`, throttling exhaustion, expired credentials, timeout, or an
unknown error.

Use the Resource Groups Tagging API only as a tag/enrichment source. `GetResources`
returns tagged or previously tagged resources in a Region; it is not a complete
inventory and does not enumerate every supported service or reliably find untagged
resources. It has pagination and a service rate limit. Native list/describe APIs are
the source of truth for discovery.

Reference: [Resource Groups Tagging API GetResources](https://docs.aws.amazon.com/resourcegroupstagging/latest/APIReference/API_GetResources.html).

### 4.4 Initial API coverage

| Domain | Primary calls | Important notes |
| --- | --- | --- |
| Account/Region | STS `GetCallerIdentity`, EC2 `DescribeRegions` | Verify identity before fan-out |
| VPC/EC2 | instances, ENIs, VPCs, subnets, route tables, IGWs/NAT, SGs and SG rules, NACLs, endpoints, flow logs, volumes, snapshots | Do not request instance user data or launch-template version payloads |
| Load balancing | ELBv2/classic load balancers, listeners, rules, target groups/health, attributes | Build inbound path edges |
| RDS/EFS/DynamoDB | describe/list resource/configuration metadata | No log downloads, table scans, or data calls |
| S3 | bucket list and bucket-level security/config APIs | No object listing/read |
| IAM/KMS/Secrets | account authorization, credential report, policies, keys and secret metadata | No secret values or decrypt; policy documents require tenant isolation |
| ECS/EKS/ECR | clusters/services, node groups, access config, repositories/images/scan status | Exclude ECS task definitions/tasks by default because env overrides can contain secrets |
| Lambda | opt-in list/config metadata | Drop `Environment.Variables` and error messages before persistence; never `GetFunction` |
| CloudFront | opt-in distribution/config metadata | Drop `Origins.Items[].CustomHeaders.Items[].HeaderValue` before logs, queues, or persistence |
| Governance | CloudTrail status/selectors, Config recorder/rule status, Backup plans/vaults | Do not enable or mutate services |
| AWS security | list/get existing GuardDuty, Inspector, Security Hub, Access Analyzer status/findings | `ResourceNotFound`/not enabled is a coverage state, not a retry storm |
| Tags | Resource Groups Tagging API plus native tag APIs | Enrichment, never sole discovery source |

AWS Config is an optional accelerator when the customer already records the needed
resource types. An aggregator can collect configuration/compliance data from many
accounts and Regions, and `SelectAggregateResourceConfig` can query it efficiently.
Do not create a recorder or aggregator from the base role: enabling/configuring AWS
Config is customer-owned, mutable, and potentially billable. Fall back to direct APIs
whenever Config is absent, stale, or incomplete.

Reference: [AWS Config multi-account, multi-Region aggregation](https://docs.aws.amazon.com/config/latest/developerguide/aggregate-data.html).

## 5. CMDB model and reconciliation

Use a stable provider key, not display names:

```text
resource_uid = sha256(partition + account_id + region_scope + service + type + native_id)
```

Recommended core tables/collections:

```text
aws_connections
  tenant_id, connection_id, account_id, partition, role_arn, external_id_ciphertext,
  status, template_version, module_flags, verified_at, last_success_at

scan_runs
  scan_id, tenant_id, connection_id, started_at, completed_at, status,
  coverage_json, api_calls, throttles, permission_gaps

resources
  tenant_id, resource_uid, account_id, region, availability_zone, service,
  resource_type, native_id, arn, name, lifecycle_state, tags_json,
  config_json_sanitized, config_hash, first_seen_at, last_seen_at, deleted_at

resource_edges
  tenant_id, from_uid, relation, to_uid, evidence_json, first_seen_at, last_seen_at

findings
  tenant_id, finding_uid, source, rule_id, rule_revision, resource_uid, severity,
  confidence, status, evidence_json_sanitized, first_seen_at, last_seen_at, resolved_at
```

Every primary/unique/index key that can cross customers starts with `tenant_id`.
Enforce tenant predicates through application authorization plus database row-level
security where supported. Encrypt connections, raw job payloads, and CMDB data with
separate production KMS keys; audit every user read/export of security data.

Upserts are idempotent. Set `last_seen_at` only for facts observed in a successful
adapter task. Mark a resource deleted only after a complete authoritative scan no
longer contains it; two consecutive complete misses are safer for eventually
consistent APIs. Never cascade-delete relationships/findings after a partial scan.
Store a canonical sanitized JSON hash so unchanged assets do not create noisy
history rows.

### 5.1 Security group and reachability graph

Normalize each `DescribeSecurityGroupRules` result as an independent directional
rule with protocol, port range, and exactly one source/destination kind: IPv4 CIDR,
IPv6 CIDR, prefix list, or security-group reference. Preserve rule ID and tags.

Do not label a resource "internet exposed" merely because an SG allows
`0.0.0.0/0`. Reachability requires a graph path combining:

- a public IP, internet-facing ELB, or public endpoint;
- subnet route to an internet gateway (and the correct route table association);
- ENI/target attachment;
- SG rule intersection with protocol/port;
- NACL allow path in both directions; and
- service-level public-access configuration.

Return the path as evidence, for example:

```text
internet -> igw-1 -> rtb-1 -> subnet-1 -> eni-1 -> sg-rule-123 -> tcp/22 -> i-123
```

This evidence makes recommendations reviewable and reduces false positives.

## 6. Security control engine

### 6.1 Deterministic control definition

Version rule code and evidence semantics independently of UI text:

```yaml
id: AWS.EC2.NETWORK.SSH_INTERNET_REACHABLE
revision: 3
scope: resource
severity: HIGH
required_facts: [eni, subnet, route_table, internet_gateway, security_group_rule, nacl]
finding_key_fields: [resource_uid, protocol, from_port, to_port, path_hash]
```

Finding ID must be deterministic, for example:

```text
sha256(tenant_id, account_id, region, rule_id, rule_revision,
       resource_uid, stable_evidence_identity)
```

Track `OPEN`, `RESOLVED`, and `SUPPRESSED`, plus first/last seen, severity,
confidence, complete evidence, customer exception owner/reason/expiry, remediation
text, and authoritative AWS documentation links. A rule runs only when all required
adapter coverage is complete; otherwise report `NOT_EVALUATED`, never `PASS`.

### 6.2 High-value checks for the first release

- Internet reachability to administrative/database ports with a full network path.
- Public S3 policy/block posture, encryption, versioning, logging, and replication.
- Public snapshots; unencrypted EBS/RDS/EFS; account-level EBS encryption default.
- EC2 IMDSv2 requirement, public IPs, flow-log coverage, and overly broad egress.
- IAM root MFA signal, stale access keys, console users without MFA, unused roles,
  wildcard/trust policies, and external principals. Treat last-access data as
  delayed/advisory, not proof of no use.
- CloudTrail logging/multi-Region/log-file validation and Config recorder coverage.
- Missing backup coverage/retention for supported data services.
- Public RDS/EKS endpoints and risky EKS access entries.
- ECR mutable tags, public repository policies, missing/stale scan results.
- Lambda unsupported/deprecated runtimes when the sensitive Lambda module is opted in.
- GuardDuty, Inspector, Security Hub, and Access Analyzer enablement/coverage gaps.
- Correlation of native AWS findings to resource owners, tags, network paths, and
  change history.

Without a package inventory or image/package scanner, do not create CVE findings.
At most report `scan unavailable`, `native scan disabled`, `runtime deprecated`, or
`image scan stale`. SSM Inventory can supply installed-package facts when the
customer has configured it and opted in, but a package name/version comparison feed
still needs licensed/maintained vulnerability intelligence and rigorous matching.

### 6.3 Native service integration

GuardDuty is Regional and AWS recommends organization management through a delegated
administrator across Regions. Inspector and Security Hub also have their own
administrator/member relationships; one service's relationship does not implicitly
configure another. The platform should read each Region's status/findings or use the
customer's existing aggregation Region/administrator account where configured.

Normalize native findings into an internal schema while preserving source finding
ID, product ARN, account, Region, resource IDs, source severity, timestamps, workflow
state, and the unmodified source reference. Store sanitized source JSON only if the
customer's retention/data-residency terms allow it.

Official references:

- [GuardDuty foundational data sources](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_data-sources.html)
- [GuardDuty multi-account management](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_accounts.html)
- [What is Amazon Inspector?](https://docs.aws.amazon.com/inspector/latest/user/what-is-inspector.html)
- [Security Hub CSPM administrator-account recommendations](https://docs.aws.amazon.com/securityhub/latest/userguide/securityhub-account-restrictions-recommendations.html)
- [AWS Security Finding Format and findings](https://docs.aws.amazon.com/securityhub/latest/userguide/securityhub-findings.html)

If customers later request exporting this product's findings into Security Hub,
implement a **separate opt-in write role** and ASFF adapter. `BatchImportFindings`
requires Security Hub to be enabled, accepts findings for the associated account (or
an allow-listed partner), and has provider/update restrictions. The base read role
must never receive `BatchImportFindings` or `BatchUpdateFindings`.

Reference: [Security Hub BatchImportFindings requirements](https://docs.aws.amazon.com/securityhub/latest/userguide/finding-update-batchimportfindings.html).

### 6.4 Event/threat detection expansion

A future event plane can accept customer-forwarded EventBridge/CloudTrail events,
VPC Flow Logs, DNS query logs, or findings through dedicated customer-managed
destinations. That requires a different CloudFormation template, explicit data
access, ingestion authentication, abuse controls, regional routing, retention and
data-residency choices, and an honest cost model. Do not quietly add log bucket reads
to the CMDB role. Even with logs, rules-based detection is not equivalent to
GuardDuty's managed intelligence and anomaly models.

## 7. Throttling, retries, and failure semantics

Use the AWS SDK's **standard** retry mode explicitly, with 3-4 total attempts for
interactive probes and 4-5 for deadline-tolerant background pages. Standard mode
uses exponential backoff with jitter and a retry quota. AWS's current cross-SDK
reference says the updated 2026 behavior requires `AWS_NEW_RETRIES_2026=true` until
it becomes the default; pin the SDK version, set retry mode/max attempts explicitly,
and test the actual runtime behavior in CI.

Do not put a second generic retry loop around the SDK and accidentally multiply
attempts. Application-level requeue is for an entire idempotent page/task after the
SDK exhausts its bounded attempts. Preserve the page cursor and use an absolute job
deadline.

Adaptive retry mode can delay initial requests and rate-limits an entire SDK client.
Do not share an adaptive client across tenants, accounts, Regions, or throttling
dimensions. Consider it only for an isolated account+Region+service client with a
known hot resource and latency-tolerant work.

Reference: [AWS SDK retry behavior](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html).

Layer these controls above SDK retries:

- Global queue capacity and per-tenant weighted fairness.
- Per-account semaphore (start near 8 concurrent API requests, tune from metrics).
- Per-account+Region+service semaphore/token bucket (start at 1-2 for low-quota
  APIs; service adapters own overrides).
- Randomized scan start times to avoid top-of-hour bursts.
- Circuit breaking when a service/Region has sustained throttles or 5xx failures.
- Metrics by tenant/account/Region/service/operation/error code: calls, latency,
  pages, retries, throttles, access denied, partial scans, and age of last success.

Failure classification:

| Failure | Behavior |
| --- | --- |
| throttling, retryable network error, eligible 5xx | Let SDK retry; then requeue page with jitter if deadline/attempt budget remains |
| `AccessDenied` / unauthorized operation | Do not retry; record a permission gap and mark affected controls `NOT_EVALUATED` |
| not-enabled detector/hub/recorder | Record service state; do not retry as an outage |
| `ExpiredToken` near expected expiry | Refresh credentials once and retry the idempotent page |
| role cannot be assumed / trust changed | Set connection `DEGRADED`, alert tenant admin, stop fan-out after bounded confirmation |
| Region disabled/not opted in | Record coverage state and skip |
| malformed cursor/validation error | Code/data defect; dead-letter with sanitized context |
| partial pagination | Keep observed upserts but mark adapter incomplete; perform no delete reconciliation |

## 8. Resource-management/remediation plane

When mutation is added, create `MSPCMDBRemediationRole` separately. It should trust a
different vendor executor role, require the tenant External ID/session-name prefix,
and attach only action-specific policies. Recommended transaction:

1. Rule proposes a desired change with exact resource ARN, before/after diff, impact,
   rollback plan, and required AWS actions.
2. Customer policy decides whether it is manual, two-person, maintenance-window, or
   pre-approved.
3. Executor obtains a just-in-time job grant and assumes the remediation role for a
   short session with a restrictive session policy where supported.
4. Re-read current state and fail on drift.
5. Prefer CloudFormation change sets for stack-managed resources; do not mutate a
   stack-owned resource invisibly.
6. Apply one idempotent change, verify state, write an immutable audit event, and
   enqueue a CMDB refresh.

Never offer a generic shell, arbitrary SDK proxy, customer credential download, or
`AdministratorAccess`. Security-group changes require explicit group ARN/rule intent,
reachability impact, and rollback. Deny remediation when the CMDB snapshot is stale.

## 9. Key production risks and controls

| Risk | Required control |
| --- | --- |
| Cross-tenant confused deputy | Vendor-generated unique External ID, exact vendor role principal, canonical connection lookup, account verification |
| Vendor collector compromise | Dedicated account/role, fixed customer role path, no public-path credentials, short STS sessions, egress and CloudTrail monitoring |
| Customer configuration contains secrets | Field allowlists and redaction before logs/queues/storage; Lambda, CloudFront, and SSM opt-in; exclude code, object, task-definition, user-data, secret-value APIs |
| Tenant data leak in SaaS | Tenant-prefixed keys, row-level controls, RBAC, export audit, negative multi-tenant tests, per-tenant encryption/retention where required |
| Policy or template drift | Versioned immutable templates, SHA-256, periodic capability probes, drift alert, sandbox deploy test on every release |
| API/service evolution | Adapter-owned action manifest, contract fixtures, unknown-field tolerance, automated docs/release review |
| Eventual consistency/partial scans | Coverage ledger, two-complete-scan delete policy, no deletes after partial fan-out |
| False-positive security claims | Required-fact gating, evidence paths, confidence, rule revisions, suppressions with expiry, explicit capability limits |
| Unplanned customer charges | Base role never enables services; disclose Config/security-service/log-ingestion costs; rate-limit discovery |
| Organizations/Region churn | Token-complete org pagination, account `State`, StackSet auto-deploy, dynamic Region discovery |
| Data residency and sensitive findings | Region-aware ingestion/storage options, minimized raw retention, encryption, deletion workflow, subprocessor documentation |
| AWS partition mismatch | Separate vendor collectors and templates per partition; validate role ARN partition before STS |
| Customer role deletion/recreation | Verification probes, degraded state, audit; exact role principal trust intentionally fails closed when vendor role identity changes |

## 10. Acceptance criteria for this slice

- Customer can deploy the template in a sandbox and the platform verifies the
  account solely with AssumeRole + External ID + GetCallerIdentity.
- Wrong/missing External ID, wrong role ARN, cross-tenant role ARN substitution, and
  mismatched account ID all fail closed.
- A complete baseline scan inventories the declared core services in every enabled
  Region plus global services exactly once.
- Every adapter exhausts pagination and exposes coverage/permission gaps.
- No base policy action can mutate resources, retrieve secret values, decrypt data,
  read S3 objects/database rows/log events, execute commands, or download code.
- Raw Lambda environment-variable and CloudFront origin custom-header values are
  never persisted or logged; Lambda, CloudFront, and SSM modules remain off unless
  explicitly enabled.
- One throttled/failed Region cannot cause assets in another Region to be deleted.
- Security findings show deterministic evidence and `NOT_EVALUATED` when required
  facts are incomplete.
- UI/product copy clearly distinguishes posture recommendations from Inspector or
  GuardDuty threat/vulnerability detection.
- Offboarding stops new assumes immediately and enforces contracted data deletion.

## 11. Verification still required before production

The draft YAML has been parsed locally and individual IAM managed-policy documents
are below the 6,144-character managed-policy limit. Before publishing it:

1. Run `cfn-lint` and `aws cloudformation validate-template` in CI.
2. Deploy to a disposable AWS account with every option combination.
3. Run positive API contract tests for every declared adapter/action and negative
   tests proving excluded data/write APIs are denied.
4. Inspect actual Lambda, DNS, CloudFront, IAM, and CloudFormation responses for
   customer-supplied sensitive fields; finalize the persistence allowlist.
5. Test an SCP, permissions boundary, disabled Region, missing security service,
   wrong partition, throttling, expired session, and role deletion.
6. Generate a customer-readable permission diff and template digest for every
   release; require review for any newly granted action.

## 12. Primary AWS references

- [AWS managed SecurityAudit policy](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/SecurityAudit.html)
- [AWS STS AssumeRole API](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html)
- [Third-party cross-account role guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_common-scenarios_third-party.html)
- [EC2 DescribeRegions API](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeRegions.html)
- [Resource Groups Tagging API GetResources](https://docs.aws.amazon.com/resourcegroupstagging/latest/APIReference/API_GetResources.html)
- [AWS Config aggregation](https://docs.aws.amazon.com/config/latest/developerguide/aggregate-data.html)
- [AWS SDK retry behavior](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html)
- [GuardDuty data sources](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty_data-sources.html)
- [Amazon Inspector overview](https://docs.aws.amazon.com/inspector/latest/user/what-is-inspector.html)
- [Security Hub findings/ASFF](https://docs.aws.amazon.com/securityhub/latest/userguide/securityhub-findings.html)
