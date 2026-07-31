# Sutra managed-production deployment

This directory is the production high-availability path. It is deliberately
separate from `deploy/ec2/cloudformation-single-node.yaml`, which remains the
private-beta/staging topology and is not mutated by this design.

`infrastructure/production-ha.yaml` provisions the managed workload boundary:

- an internet-facing TLS ALB whose security group accepts only an existing
  customer-managed prefix list;
- at least two Fargate application tasks across private subnets, deployment
  circuit breaking, health checks, CPU/memory autoscaling, and a private
  loopback background-job drain sidecar in each task;
- at least two private notification workers with a separate least-privilege
  role and CPU autoscaling;
- at least two private hosted-broker tasks behind a TLS internal ALB, with
  asymmetric request/response authentication and CPU autoscaling;
- an encrypted, private, deletion-protected Multi-AZ RDS PostgreSQL instance;
- retained Secrets Manager database credentials and a migration-first release;
- a retained KMS-encrypted, versioned S3 evidence bucket and retained AWS Backup
  vault with continuous RDS recovery points;
- KMS-encrypted application/worker/WAF logs, retained ALB access logs, RDS log
  exports, alarms, optional Container Insights, and optional AWS managed WAF
  rules;
- a GitHub OIDC role limited to one protected environment, four exact ECR
  repositories, three exact ECS services, the migration task family, and the
  release-evidence prefix.

No resource in this path has been deployed by repository validation.

## Managed network bootstrap

`infrastructure/production-network.yaml` is the reviewed network prerequisite
for this workload stack. It creates a dedicated VPC across two explicitly
different Availability Zones with:

- two public ALB subnets, two private application subnets, and two isolated
  database subnets, plus two dedicated public NAT-egress subnets and two
  dedicated Network Firewall subnets;
- one AWS Network Firewall endpoint and one public NAT gateway in each AZ. Each
  application default route targets its same-AZ firewall endpoint, each
  firewall subnet targets its same-AZ NAT, and the NAT subnet's return route
  for that application CIDR targets the same firewall endpoint. An AZ,
  endpoint, or NAT failure therefore fails that AZ closed instead of silently
  crossing AZs or bypassing inspection;
- a VPC-wide `TrafficType=ALL` Flow Log with one-minute aggregation, a retained
  customer-KMS-encrypted CloudWatch log group, explicit retention, and a
  confused-deputy-protected delivery role that cannot create other log groups;
- private, multi-AZ interface endpoints for ECR API/Docker, CloudWatch Logs,
  Secrets Manager, STS, KMS, the regional SES API, and SQS for durable SES
  feedback, plus an S3 gateway endpoint on both application route tables;
- a customer-managed Cloudflare IPv4 ingress prefix list; and
- a customer-managed HTTPS egress prefix list with 18 review-bound external
  CIDR slots, followed by a strict-order AWS Network Firewall application-layer
  allowlist containing exact `outbound.sutracmdb.com` and the commercial AWS
  API namespace `.amazonaws.com` for TLS SNI inspection. Plaintext HTTP Host
  matching is deliberately disabled. The
  application, notification-worker, and vulnerability-feed security groups
  permit external TCP 443 only to the reviewed prefix list. The hosted broker
  has a documented broker-only L3 TCP/443 exception because signed SDK calls
  span dynamic AWS service addresses and regions; its subnet has no direct NAT
  route, so that exception is forced through the strict application-layer
  firewall. The firewall drops established traffic that matches neither
  allowed target.
  PrivateLink traffic uses an explicit workload-security-group to
  endpoint-security-group rule and does not allow the surrounding application
  subnet CIDRs. The first
  external CIDR and a change-ticket identifier are mandatory, and every slot
  rejects `0.0.0.0/0`.

Its `VpcId`, `VpcCidr`, `PublicSubnetIds`, `PrivateAppSubnetIds`,
`PrivateDatabaseSubnetIds`, `AlbIngressPrefixListId`, and
`ApprovedHttpsEgressPrefixListId` outputs, plus `S3GatewayPrefixListId` and
`EndpointSecurityGroupId`, map one-for-one to parameters with the same names in
`infrastructure/production-ha.yaml`. The network stack also accepts and returns
the same `KmsKeyArn`, so the retained audit log and workload stack share the
approved customer-managed key. Review the ten default subnet CIDRs against peered,
VPN, Transit Gateway, and on-premises routes before creating a change set. The
template cannot prove that different textual CIDRs do not overlap a connected
network.

`FlowLogRetentionDays` defaults to 90 and must be selected explicitly through a
reviewed change set if the audit policy requires another allowed value. The KMS
key policy must allow the regional CloudWatch Logs service principal to use the
key for this exact log-group encryption context. A missing or overly narrow KMS
key policy causes Flow Log delivery to fail; do not remove encryption or widen
the delivery role as a workaround. After stack creation, require the Flow Log
to report `ACTIVE` and `DeliverLogsStatus=SUCCESS`, generate both accepted and
rejected test traffic, and prove both records arrive in
`VpcFlowLogGroupName`. Retention of the log group after stack deletion is
intentional; deleting retained audit evidence is a separate governed action.
The network change set requires `CAPABILITY_IAM` for the auto-named Flow Logs
delivery role. Inspect that role in every change set: it may write streams only
in the retained network log group, cannot create log groups, and uses the
AWS-required account-wide `DescribeLogGroups` metadata action only.

The ingress list is the complete IPv4 list retrieved from
`https://www.cloudflare.com/ips-v4` on 2026-07-30. Treat it as a checked-in,
auditable snapshot. Before every network change set:

1. retrieve that HTTPS resource from a trusted administrative host and compare
   its complete, CIDR-validated line set with `CloudflareIngressPrefixList`;
2. if it differs, replace the entire checked-in entry set and update
   `Metadata.CloudflareIpv4Snapshot.Retrieved` in the same reviewed pull
   request—never append an unverified range or pin a transient DNS answer;
3. run `pnpm lint:cloudformation`,
   `node --test tests/production-network-infrastructure.test.mjs`, and inspect a
   CloudFormation change set before execution; and
4. after execution, prove Cloudflare reaches the public health endpoint and a
   non-Cloudflare source cannot connect directly to the ALB.

The egress list has a different trust contract. Populate its external slots
only with a provider's published, stable service CIDRs or fixed private
addresses of an outbound control that the application is configured to use.
Do not copy S3 CIDRs into this custom list. Supply the selected region's
AWS-managed S3 prefix list as `S3GatewayPrefixListId`; the reusable template
intentionally contains no regional prefix-list ID. For the planned
`ap-south-1` deployment, the currently verified value is `pl-78a54011`.
Immediately before a change set, use
`aws ec2 describe-managed-prefix-lists --prefix-list-ids <id>` and require
`OwnerId=AWS`, `PrefixListName=com.amazonaws.<region>.s3`,
`AddressFamily=IPv4`, and `State=create-complete`. The protected release
workflow repeats that live validation before building or deploying images.
The four workload security groups allow port 443 to this AWS-managed list, and
the application route tables send those addresses through the S3 gateway
endpoint. Reconcile external-list removals and additions atomically through a
reviewed CloudFormation change set, retain the parameter file and change
ticket, and repeat the egress/AZ failure tests after each update.

The repository does not assert stable CIDR contracts for Zoho, CISA, FIRST,
NVD, Jira, ServiceNow, Slack, Teams, or PagerDuty. Treat each as FQDN-only
unless its provider or the customer's private service contract supplies
dedicated published ranges. Do not convert current A/AAAA answers into
long-lived prefix-list entries. The fixed-destination implementation in
`services/managed-outbound-gateway` covers Zoho India mail/OIDC, Turnstile,
CISA KEV, FIRST EPSS, bounded NVD, Slack, Teams Logic/Power Platform,
PagerDuty Events v2, Jira Cloud Automation, and ServiceNow API webhooks; the
corresponding application clients fail closed on a partial gateway
configuration. Do not activate those
integrations until the gateway, its Durable Object replay store, the Ed25519
client key, and every exact provider path have passed live acceptance.
Arbitrary customer webhooks are intentionally not routed through it.

If the AWS egress list contains shared Cloudflare ranges so tasks can reach the
Worker hostname, the prefix list remains only the IP-layer boundary. The
Network Firewall rule group is the independent destination-aware boundary: it
uses the TLS SNI observed on the flow and permits the
exact `outbound.sutracmdb.com` name. The route policy cannot be used to reach
another Cloudflare tenant by presenting a different SNI. Calls without a
visible matching application-layer hostname, including TLS without a matching
SNI, fail closed. The outbound client still signs every gateway request;
network inspection and application authentication are separate controls.

The broker is different from the fixed-destination integration clients. It
makes direct SigV4 AWS SDK calls to commercial-region EC2, ELBv2, KMS,
DynamoDB, ECR, EKS, S3, RDS, IAM, CloudTrail, GuardDuty, Security Hub,
Inspector2, SSM, Bedrock, Cost Explorer, and CloudWatch endpoints. Those
addresses and regions are dynamic, and AWS does not publish a practical
service-specific security-group prefix list for that complete set. The broker
therefore has the only workload `0.0.0.0/0` egress rule, restricted to TCP 443.
It is an L3 reachability rule, not an authorization grant: both AZs' private
route tables force it through Network Firewall, whose second domain target is
the leading-dot commercial namespace `.amazonaws.com`. AWS Network Firewall
domain-list semantics make that target match `amazonaws.com` and its
subdomains, not adjacent suffixes, China, or GovCloud. All non-AWS traffic
remains limited to exact `outbound.sutracmdb.com`. The broker task role,
tenant-scoped STS AssumeRole boundary, customer role/session policies, and
SigV4 validation remain the authorization boundary for what an allowed AWS API
endpoint can do. The other three workload security groups retain the reviewed
prefix-list boundary and have no broad L3 exception.

This is SNI filtering, not TLS interception: Network Firewall does not perform
an out-of-band DNS lookup or prove that the destination IP is owned by AWS.
Normal broker SDK clients must retain certificate and hostname validation. A
compromised client that deliberately disables TLS verification and presents an
allowed SNI could defeat a domain-only policy; eliminating that residual risk
requires a reviewed TLS-inspecting proxy/firewall trust chain or a maintained
AWS address contract. Treat disabled TLS verification in the broker as a
release-blocking finding.

The S3 gateway endpoint installs a more-specific route directly on both
application route tables, and interface endpoints use VPC-local routing and
security-group identity. Those AWS-service paths do not traverse Network
Firewall or NAT. DNS remains limited by each workload security group to the
VPC resolver. Do not add private AWS service CIDRs to the external prefix list.

CloudFormation returns `AWS::NetworkFirewall::Firewall.EndpointIds` in no
defined order, so an index-based `Fn::Select` cannot safely associate an
endpoint with an Availability Zone. The stack therefore owns a small
least-privilege custom resource that waits for both endpoint attachments to
report `READY`, resolves `FirewallStatus.SyncStates` by the exact AZ name, and
creates four routes: two application defaults and two NAT-return routes. It
never selects by list position. If either exact endpoint cannot be resolved,
the network stack fails and no direct application-to-NAT default is created.
The resolver is control-plane-only, outside the workload data path. Its fixed
Lambda name means this template is a single managed-production network per
account/Region; change the name under review before creating a second isolated
production network.

Before executing the network change set:

1. confirm AWS Network Firewall is available in both selected AZs and that the
   account has capacity for one firewall, one policy, one stateful rule group,
   and two endpoints;
2. set `NetworkFirewallLifecyclePhase=rollback-safe-first-create` for the
   initial stack. This deliberately leaves only deletion protection off so
   CloudFormation can remove the firewall if endpoint creation, logging, or
   route resolution fails; the policy/subnet change protections remain on;
3. validate the rule group with the Network Firewall `CreateRuleGroup` dry-run
   API and retain that response with the change record;
4. ensure the customer KMS key policy lets the regional CloudWatch
   Logs/delivery service encrypt only the three retained
   `/sutra/production/network/...` firewall and resolver log groups;
5. create and inspect a change set with `CAPABILITY_IAM`; the custom resource
   role may describe only this firewall, mutate only the four stack-owned route
   tables, and write only its precreated log group; and
6. verify the resolved `FirewallEndpointIdA/B` outputs correspond to the
   intended AZs before activating workloads.

After the live route, logging, denial, and AZ acceptance checks below pass,
apply a second reviewed change set that changes only
`NetworkFirewallLifecyclePhase` to
`protected-after-live-route-validation`, and verify `DeleteProtection=true`.
Never start workloads while the first-create lifecycle phase remains in
effect. To replace or delete the firewall later, a governed change must first
return this parameter to the rollback-safe phase, remove routes/logging as
documented by AWS, and retain the approval evidence.

Acceptance must prove all of the following from each application subnet:

- HTTPS to `outbound.sutracmdb.com` succeeds through that subnet's own firewall
  endpoint and NAT gateway;
- another hostname resolving inside the same approved shared CIDR fails;
- direct signed broker SDK calls to required commercial
  `<service>.<region>.amazonaws.com` endpoints succeed, while
  `amazonaws.com.<untrusted-domain>`, China/GovCloud endpoint suffixes, absent
  SNI, plaintext HTTP, and every other non-AWS hostname fail;
- ECR, Logs, Secrets Manager, STS, KMS, SES API, and S3 still use their direct
  VPC endpoint routes;
- firewall ALERT and FLOW events arrive in their retained KMS-encrypted log
  groups, and the VPC Flow Log shows the same path; and
- taking either AZ's endpoint or NAT path out of service cannot reroute that
  AZ through the peer. Restore the resource after recording the expected
  fail-closed result.

This path has material recurring cost even at zero application traffic: two
Network Firewall endpoint-hours, Network Firewall data processing, two NAT
gateway/EIP paths (subject to AWS's current service-chain pricing treatment),
seven interface endpoint services in two AZs, CloudWatch Logs ingestion and
retention, Lambda invocations, and KMS requests/grants. Confirm the current
`ap-south-1` prices in the AWS Pricing Calculator immediately before approval;
no price is hardcoded here. The relevant default service quotas include five
firewalls per account/Region and 100 Gbps per firewall AZ, while rule-group
capacity is fixed at creation. This template reserves capacity 100 for one
exact external gateway plus one commercial AWS namespace; increasing or
replacing it requires a reviewed change. The
firewall has delete, policy-change, and subnet-change protection enabled.
CloudFormation logging configurations also allow only one destination-object
change per update, so add/remove/change ALERT and FLOW destinations in
separate change sets. Retained log groups and protection must never be disabled
as an automated rollback shortcut.

The hosted path does not launch the local HMAC collector. Application tasks
sign every broker request with Ed25519, verify the broker's signed response,
and address a private DNS name backed by the internal broker ALB. Broker
connection, replay, and operation-lease state is shared in PostgreSQL and
encrypted before insertion. The file registry and fixture queue remain
available only when `SUTRA_LOCAL_MODE=true`.

The general `background_jobs` queue is drained every 15 seconds by the
`background-job-runner` sidecar. It calls the token-authenticated internal
endpoint over the task's loopback interface; the public ALB returns 404 for
`/api/internal/*`. The app process has self-ticking disabled in managed
production, so the sidecar is the sole cadence owner while PostgreSQL leases
make multiple application replicas safe.

## Application integrations included in the hosted path

The stack wires the production backends required by the application; these
statements describe checked-in code and configuration, not completed live
acceptance:

- `oidc` mode enables the hosted OIDC PKCE/session boundary. `federated` mode
  preserves OIDC and additionally injects SAML 2.0 provider and transaction
  configuration. SCIM 2.0 Users/Groups and customer assignments use
  organization-bound connector credentials created by an authorized
  administrator.
- The application task runs a separate private job-runner sidecar. Durable job,
  retry, dead-letter, broker replay and operation-lease state resides in
  PostgreSQL rather than process memory.
- Jira/ServiceNow connector credentials use the
  `aws-secrets-manager` backend under `sutra/production/itsm/`; database rows
  retain only tenant-scoped secret references. Both outbound dispatch and
  inbound signature verification resolve the managed value.
- Raw evidence and generated exports use the private S3 bucket with SSE-KMS,
  immutable writes and checksums. Downloads require an expiring,
  tenant/actor/purpose-bound, digest-only, single-use grant and verify the bytes
  returned by S3.
- The hosted broker contains the agentless execute and terminal-state
  reconciliation path. CloudFormation requires explicit agentless parameters
  and operator approval; source readiness is not proof that a complete scan and
  teardown succeeded in the selected live account.

Before production approval, exercise each enabled IdP/SCIM client, ITSM vendor,
notification provider, evidence bucket/KMS policy and agentless sandbox
end-to-end. See
[`../../docs/hosted-production-foundation.md`](../../docs/hosted-production-foundation.md)
and
[`../../docs/production-acceptance-evidence.md`](../../docs/production-acceptance-evidence.md).

## Required external prerequisites

The stack intentionally does not guess or purchase these items:

1. **Region, availability, and recovery objective.** Select the primary region,
   acceptable RPO/RTO, maintenance windows, and whether a separate-region or
   separate-account recovery stack is required. Multi-AZ RDS protects against
   an AZ failure; it is not regional disaster recovery.
2. **Network.** Review and deploy `infrastructure/production-network.yaml`, or
   supply an independently reviewed network satisfying the same output and
   failure-isolation contract. Fargate tasks need HTTPS and DNS egress for ECR,
   CloudWatch, Secrets Manager, STS, S3, SES, SQS, and approved notification
   endpoints. Interface/gateway endpoints reduce NAT use for supported AWS
   services, but arbitrary webhooks and FQDN-only services still require a
   reviewed destination-aware egress path. A single NAT gateway is not
   acceptable because it recreates a single-AZ dependency. Supply
   `ApprovedHttpsEgressPrefixListId` from the network stack only after the
   enabled external destination paths pass the maintenance and live acceptance
   procedure above. Supply `S3GatewayPrefixListId`,
   `EndpointSecurityGroupId`, and `NetworkFirewallArn` from the same network
   stack. The first two identify the only HTTPS routes from workload security
   groups to regional S3 and the interface endpoints; the ARN binds the
   application release to the inspected egress path. Only the broker has
   `0.0.0.0/0` security-group egress, limited to TCP 443 and forced through the
   strict domain firewall for its dynamic, multi-region AWS SDK calls. The
   application, worker, and feed tasks remain prefix-list bounded. No workload
   can use the external prefix list to reach arbitrary peer ENIs in an
   application subnet. Supply the approved `KmsKeyArn` before creating the
   network so VPC Flow Logs cannot fall back to an unencrypted log group.
   Bootstrap and every later release live-query the exact firewall and refuse
   to proceed unless deletion, policy,
   and subnet protections are enabled and both AZ attachments report `READY`.
3. **Edge and DNS.** Provide an ACM certificate in the stack region, canonical
   HTTPS origin, DNS record, and a managed prefix list containing only the
   intended CDN/edge and synthetic-monitor source ranges. Automate updates when
   the edge provider publishes IP changes. Select `WafClientIpHeader` to match a
   header that this edge overwrites rather than merely forwards; the rate rule
   trusts that value only because direct ALB internet access is not open to
   `0.0.0.0/0`.
4. **Encryption.** Provide a customer-managed symmetric KMS key. Its key policy
   must authorize the CloudFormation execution principal and the AWS services
   used here: RDS, Secrets Manager, CloudWatch Logs, AWS Backup, and S3. Decide
   key administrators, rotation, break-glass recovery, and cross-account
   recovery access before stack creation.
   Set `ResourceRetirementCompleteMisses` explicitly if the documented
   production default of `2` is not appropriate. CloudFormation and the runtime
   both reject values below `2` or above `30`; only successful complete
   inventory runs advance this counter.
   Set `EvidenceRetentionDays` to the approved evidence-retention period
   (30–3650 days). The database download boundary and S3 current-version
   expiration use the same value; versioned bytes are removed on the following
   lifecycle pass.
5. **Runtime secret.** Create one KMS-encrypted Secrets Manager JSON document at
   `sutra/production/runtime-*` containing all of:

   - `SUTRA_AUTH_ENCRYPTION_KEY`
   - `SUTRA_CONNECTION_ENCRYPTION_KEY`
   - `SUTRA_REGISTRY_ENCRYPTION_KEY`
   - `SUTRA_JOB_RUNNER_TOKEN`
   - `SUTRA_TURNSTILE_SITE_KEY`
   - `SUTRA_TURNSTILE_SECRET_KEY`
   - `SUTRA_CONTACT_RECIPIENT`
   - `SUTRA_CONTACT_FROM`
   - `SUTRA_INVITATION_FROM`
   - `SUTRA_ZOHO_DATACENTER`
   - `SUTRA_ZOHO_MAIL_ACCOUNT_ID`
   - `SUTRA_ZOHO_CLIENT_ID`
   - `SUTRA_ZOHO_CLIENT_SECRET`
   - `SUTRA_ZOHO_REFRESH_TOKEN`
   - `SUTRA_MANAGED_OUTBOUND_URL`
   - `SUTRA_MANAGED_OUTBOUND_APP_KEY_ID`
   - `SUTRA_MANAGED_OUTBOUND_APP_PRIVATE_KEY`
   - `SUTRA_MANAGED_OUTBOUND_WORKER_KEY_ID`
   - `SUTRA_MANAGED_OUTBOUND_WORKER_PRIVATE_KEY`
   - `SUTRA_MANAGED_OUTBOUND_FEED_KEY_ID`
   - `SUTRA_MANAGED_OUTBOUND_FEED_PRIVATE_KEY`
   - `SUTRA_OIDC_PROVIDERS`
   - `SUTRA_OIDC_TRANSACTION_KEY`
   - `SUTRA_BROKER_CLIENT_KEY_ID`
   - `SUTRA_BROKER_CLIENT_PRIVATE_KEY` (base64url Ed25519 PKCS8 DER)
   - `SUTRA_APP_PUBLIC_KEYS` (JSON map of app key IDs to base64url Ed25519 SPKI DER)
   - `SUTRA_BROKER_RESPONSE_KEY_ID`
   - `SUTRA_BROKER_RESPONSE_PRIVATE_KEY` (base64url Ed25519 PKCS8 DER)
   - `SUTRA_BROKER_RESPONSE_PUBLIC_KEY` (base64url Ed25519 SPKI DER)

   Before CloudFormation, again immediately before migration, and again in the
   separately protected activation job, the workflow streams this JSON
   document directly from Secrets Manager into
   `scripts/validate-production-runtime-secret.mjs`. The validator checks every
   key referenced by the HA task definitions, the exact Sutra Zoho aliases and
   India endpoints/provider shape, canonical Ed25519 formats and app/broker key
   pair relationships, distinct workload IDs/private keys, and the selected
   identity mode's conditional SAML shape. It accepts the document only on
   stdin and never writes or reports values. Prepare records the exact
   `AWSCURRENT` VersionId as a non-secret workflow output; activation refuses
   if `AWSCURRENT` moved after migration. Steady releases repeat the semantic
   validation and refuse a rotation between preflight and their migration.

   `SUTRA_OIDC_PROVIDERS` is always required, including in `federated` mode,
   so the approved Zoho OIDC connection is preserved. When the explicit
   `IdentityMode` stack parameter is `federated`, the same document must also
   contain `SUTRA_SAML_PROVIDERS` and `SUTRA_SAML_TRANSACTION_KEY`; ECS does not
   inject either SAML value in `oidc` mode.

   The app, notification worker, and vulnerability-feed identities must use
   distinct key IDs and distinct Ed25519 private keys; the gateway authorizes
   each identity for only its exact target set. Values are shared only by
   replicas of the same workload and must be generated, escrowed, and rotated
   under an approved key-rotation procedure. Do not place them in GitHub.
   The runtime fixes both contact and invitation delivery providers to `zoho`;
   no Resend fallback is injected.
6. **Identity and broker approval.** Choose `BrokerHostName`, create a private
   Route 53 alias from it to the stack's `BrokerLoadBalancerDnsName` output,
   and ensure `CertificateArn` covers the public application and broker names.
   The template requires the literal hosted-release and
   hosted-runtime-architecture approval parameters, requires an explicit
   `IdentityMode` of `oidc` or `federated`, and keeps password login and
   self-service signup disabled.
7. **ECR.** Create immutable `sutra/app`, `sutra/notification-worker`,
   `sutra/broker`, and `sutra/agentless-scanner` repositories with the same
   retention, scan-on-push, and encryption policies. Do not bootstrap the
   workload stack with a placeholder or an older release. The protected
   first-deployment workflow builds each final image once, scans its immutable
   digest, and supplies those same digests to the dormant stack; mutable tags
   are rejected. The scanner gate includes unfixed High and Critical findings.
   Bootstrap and steady-state builds both use the lifecycle-covered
   `candidate-` prefix for unpromoted manifests.
8. **Email delivery.** Supply a verified SES domain/address identity in the
   selected region, move the account out of the SES sandbox where applicable,
   and approve sending limits, DKIM/SPF/DMARC, bounce/complaint handling, and
   the notification-destination secret lifecycle under
   `sutra/notifications/*`. The stack creates
   `sutra-production-security-notifications`, an SES EventBridge destination,
   and retained customer-KMS-encrypted SQS feedback and dead-letter queues, but
   `NotificationSesActivation` defaults to
   `disabled-ses-production-access-denied`. In that state the configuration set
   cannot send, its event destination/rule are disabled, the worker receives
   neither the configuration-set name nor queue URL, and its role has neither
   `ses:SendEmail` nor SQS polling permission.
9. **Customer onboarding artifact.** Set the required
   `CustomerRoleTemplateUrl` stack parameter to the versionId-qualified
   `ap-south-1` regional S3 URL for
   `templates/standard-2026-07.4/1f08f008ab024bc9c440340340e7a7cfbad7ed394e6704c3df7173766f727fc8.yaml`.
   Bootstrap rejects another region, path, hash, an unversioned URL, or
   `versionId=null`. The exact reviewed URL is injected into the app as
   `SUTRA_CUSTOMER_ROLE_TEMPLATE_URL`; the production entrypoint requires it,
   so live customer quick-create can never silently fall back to a missing
   artifact.
10. **GitHub controls.** Create the OIDC provider and three protected
   environments: `production-ha-bootstrap`, `production-ha-activation`, and
   `production-ha-release`. Require independent reviewers, prevent
   self-review, and restrict every environment to protected `main`. The first
   two use a separately provisioned, first-deployment-only OIDC role and
   CloudFormation execution role. Set `AWS_ACCOUNT_ID`, `AWS_REGION`,
   `AWS_BOOTSTRAP_ROLE_ARN`, `CFN_EXECUTION_ROLE_ARN`, `CFN_TEMPLATE_BUCKET`,
   `PRODUCTION_STACK_NAME`, and `PUBLIC_ORIGIN` in both; additionally set
   `CODEQL_ENABLED=true` and the `PRODUCTION_HA_PARAMETERS_JSON` environment
   secret in `production-ha-bootstrap`. The steady-state
   `production-ha-release` environment uses `AWS_ROLE_ARN` from the workload
   stack's `GitHubProductionReleaseRoleArn` output rather than the bootstrap
   role. Enable the repository's CodeQL entitlement and manually run
   `codeql.yml` for the exact main-branch SHA before either first deployment or
   a later release; a successful run for another SHA is not accepted. The
   CloudFormation `GitHubRepository` and `GitHubReleaseEnvironment` values are
   release-controlled and fixed to this repository and
   `production-ha-release`.
   Before the first deployment, provision
   `infrastructure/production-ha-bootstrap-iam.yaml` once in account
   `738663485493`, in the same region as the workload, using the exact workload
   stack name `sutra-production-ha`, exact production VPC, protected
   `sutra-production-egress-inspection` Network Firewall ARN, runtime-secret
   ARN, KMS-key ARN, and account-local GitHub OIDC provider. Its outputs are the
   only supported values for `AWS_BOOTSTRAP_ROLE_ARN`,
   `CFN_EXECUTION_ROLE_ARN`, and `CFN_TEMPLATE_BUCKET`. The retained,
   versioned, public-blocked bucket holds the exact checksum-verified workload
   template because `production-ha.yaml` exceeds CloudFormation's inline
   template-body limit; the GitHub role may upload only the release template
   prefix and read it only as required for `CreateChangeSet`; the execution
   role may only read that same prefix through S3/KMS. The template
   trusts only the
   `production-ha-bootstrap` and `production-ha-activation` environment
   subjects in `ydsveluvolu2996/Sutra`; after successful activation, disable
   or remove that bootstrap trust while retaining the CloudFormation execution
   role for controlled stack operations.
   The execution role uses the standard
   `cloudformation.amazonaws.com` service-role trust. Exact-stack enforcement
   is on the calling role's CloudFormation resource ARNs and
   `cloudformation:RoleArn` condition, plus the execution policies' named
   workload resources; do not add a stack `aws:SourceArn` condition to the
   service-role trust because that context is documented for CloudFormation
   registry extensions, not ordinary stack service-role assumptions.
11. **Agentless scanner.** Supply the pinned scan-account AZ, CMK,
    `/sutra/` orchestrator role and instance profile, AMI, subnet, security
    group, and findings bucket. The scanner digest is release-controlled by
    the workflow and must not be stored in `PRODUCTION_HA_PARAMETERS_JSON`.
    The broker task—not the web app—receives these values. The orchestrator
    role must own the reviewed
    EC2/ECR/S3 permissions and narrowly scoped `iam:PassRole`; the broker task
    may only assume roles under `/sutra/`. Leave
    `AgentlessLiveValidationApproval=not-approved` until the assembled path has
    completed an isolated live end-to-end validation including failure cleanup.
    In that state plans remain available but the signed broker readiness is
    `canExecute=false`. Only after retaining that evidence may an operator set
    the exact literal
    `approved-after-live-end-to-end-agentless-validation`. Broker run, resource,
    lease, and restart-recovery state is durable in PostgreSQL; customer-owned
    snapshots are lifecycle handoffs and scan-account cleanup failures remain
    visible as teardown debt. The pinned scanner host resolves the attached disk
    from the exact EBS volume ID, grants only the selected block device read-only
    to a networkless container, and never binds the host's complete `/dev` tree.
12. **Vulnerability feeds.** Managed production runs a strict daily private
    Fargate task for the complete FIRST EPSS bulk feed; the in-app durable job
    separately refreshes bounded CISA KEV and NVD windows. The approved HTTPS
    egress path/prefix list must permit `epss.cyentia.com`, `www.cisa.gov`, and
    `services.nvd.nist.gov` plus the private AWS endpoints needed for ECR,
    Secrets Manager, and CloudWatch Logs. DNS resolution/NAT or inspected
    egress must be redundant. Strict mode exits nonzero if EPSS retrieval or
    the PostgreSQL transaction fails; read-only local artifact writes remain
    best-effort. Verify the EventBridge target after every release—the protected
    workflow updates and rolls back the scheduled task revision with the same
    immutable app digest.
13. **Paging.** Provide an SNS topic with subscribed and tested responders, or
    explicitly accept that alarms will exist without notifications.

## SES security-notification acceptance

SES security email is a separately activated production capability. A 2xx
`SendEmail` response is recorded as `provider_accepted`, not delivered. The
worker attaches the opaque outbox correlation tag `sutra_delivery_id`; only a
validated, durable SES `Delivery` event can transition that exact email job to
`delivered`. `Bounce`, `Complaint`, `Reject`, and `Rendering Failure` transition
it to `delivery_failed`; `DeliveryDelay` remains accepted but degraded. The
feedback ledger stores the EventBridge event ID, provider message ID, event
type/time, tenant scope derived from the internally matched outbox row, and a
SHA-256 of the original envelope. It does not trust tenant identifiers from
the provider event. Duplicate event IDs are content-checked and reconciled
idempotently.

The SES event destination can target only the default EventBridge bus. The rule
therefore additionally matches the exact
`ses:configuration-set=sutra-production-security-notifications` event tag
before it can reach the exact queue. The queue policy accepts `SendMessage`
only from that exact rule and account. Both the queue and DLQ use `KmsKeyArn`,
retain messages for 14 days, deny plaintext transport, and are retained on
stack deletion. Invalid, forged, future-dated, cross-account, cross-region,
wrong-configuration-set, or unmatched messages are never deleted by the
worker; five receives move them to the DLQ and the zero-tolerance alarm pages.
The worker uses ten-second SQS long polling and may only receive/delete from
the main queue.

Before creating this change set, extend the external customer KMS key policy to
allow `events.amazonaws.com` `kms:Decrypt` and `kms:GenerateDataKey` for the
exact account and `sutra-production-ses-feedback` rule. Retain the worker
role's key access through regional SQS only. The production network must expose
the regional SQS PrivateLink endpoint to the worker security group; do not add
dynamic public SQS addresses to the external prefix list.

Activation is allowed only after all of these checks have evidence attached to
the change record:

1. `sesv2 get-account` in the stack region reports
   `ProductionAccessEnabled=true`; the denied sandbox account is not accepted.
2. The exact sender identity is verified and DKIM, SPF, DMARC, account
   suppression for bounce/complaint, sending quotas, and reputation metrics
   have been reviewed.
3. The configuration-set destination, default-bus rule, encrypted queue,
   redrive policy, KMS policy, SQS endpoint, queue-age/DLQ alarms, and SES
   bounce/complaint reputation alarms all pass a change-set and live
   inspection.
4. SES mailbox simulator cases prove delivery, bounce, complaint, suppression,
   malformed/duplicate feedback, and an unmatched correlation ID. The database
   must show one tenant-scoped ledger row per provider event, no cross-tenant
   update, `provider_accepted` before feedback, and the correct terminal state
   afterward.
5. Only then set
   `NotificationSesActivation=active-after-production-access-and-feedback-validation`
   through a separately reviewed production change. Do not add this value to
   `PRODUCTION_HA_PARAMETERS_JSON`; first-deployment bootstrap rejects it and
   always injects the disabled value.

Rollback sets `NotificationSesActivation` back to
`disabled-ses-production-access-denied`, which removes the worker's send/poll
permissions and environment values, disables configuration-set sending and
the EventBridge route, and preserves the queues/feedback ledger for audit.
Investigate and drain or governed-redrive the DLQ before any reactivation.

## Cost-bearing decisions

Approval is required for the following before a stack change set is executed:

- Fargate app, notification worker, and broker CPU/memory plus minimum and
  maximum task counts;
- the durable notification-backlog metric and target used for worker
  autoscaling (the template's CPU target is only a resource-pressure fallback);
- RDS PostgreSQL engine version/parameter family, instance class, storage, and
  storage autoscaling ceiling;
- one redundant NAT gateway per served AZ versus VPC endpoints and inspected
  egress;
- WAF managed rules and per-request charges;
- Container Insights, application/WAF log volume, ALB access-log retention, and
  VPC Flow Log volume/retention, and query/archival costs;
- Performance Insights retention and enhanced-monitoring volume;
- RDS/AWS Backup retention, whether to enable Backup Vault Lock (which becomes
  immutable after its grace period), cross-region or cross-account backup
  copies, and restore-test frequency;
- S3 evidence retention, Object Lock/legal-hold requirements, replication, and
  CloudTrail data-event logging;
- SES volume and external synthetic monitoring.

The current template expires evidence at `EvidenceRetentionDays` and removes
the resulting noncurrent version on the next lifecycle pass. It does not enable
Object Lock or cross-region replication because those cannot be added or
costed safely without a governance decision.

## Release and rollback contract

`.github/workflows/production-ha-bootstrap.yml` is the only supported first
deployment path. It uses the same concurrency boundary as subsequent releases
and has two independently protected jobs:

1. The `production-ha-bootstrap` job requires an exact-main successful CodeQL
   run, builds app, notification-worker, broker, and agentless scanner exactly
   once, scans the immutable digests, uploads the exact source template with a
   verified SHA-256 checksum to the protected template bucket, and creates or
   updates the stack from that S3 URL with
   `ReleaseActivation=inactive-before-first-migration`.
2. Inactive means application, worker, and broker desired counts are all zero,
   their autoscaling resources do not exist, and the vulnerability-feed
   schedule is disabled. The job proves that state before and after the
   one-off migration and enables stack termination protection.
3. The job publishes the public and internal ALB DNS names. Before approving
   `production-ha-activation`, an independent reviewer must verify the
   Cloudflare origin points at the public ALB, the private broker DNS alias
   points at the internal ALB, and the approved certificate covers both.
4. The activation job revalidates the exact task images and successful
   migration task, changes only `ReleaseActivation` to
   `active-after-successful-migration`, requires at least two healthy tasks for
   each service, verifies the feed target and exact public release-image
   header, and then signals the stack's one-use CloudFormation wait condition.
   The stack update cannot complete active before that success signal.
5. A failed post-activation check returns the CloudFormation parameter to its
   inactive value, which scales all services to zero and disables the feed.
   Interrupt and termination handlers send a failure signal. If the runner is
   forcibly lost before it can do so, the 30-minute wait-condition timeout
   makes CloudFormation roll the update back automatically. If rollback itself
   fails, the workflow reports that immediate operator intervention is
   required. KMS-encrypted, checksum-verified bootstrap evidence is written
   only after CloudFormation confirms the signaled update completed.

`PRODUCTION_HA_PARAMETERS_JSON` is a JSON object of CloudFormation parameter
names to scalar values. It must contain every parameter without a template
default except the workflow-controlled `SutraAppImage`,
`SutraMigrationImage`, `NotificationWorkerImage`, `HostedBrokerImage`,
`AgentlessScannerImage`, `ApplicationRuntimeSecretVersionId`,
`ReleaseActivation`, `PublicOrigin`,
`GitHubRepository`, `GitHubReleaseEnvironment`, and
`NotificationSesActivation`. `NetworkFirewallArn`
remains a protected operator-supplied parameter because it identifies the
separately deployed prerequisite. `CustomerRoleTemplateUrl` is also required
and bootstrap accepts only the exact reviewed, versionId-qualified
`ap-south-1` S3 path described above. The workflow injects those
eleven values and rejects attempts to override them. Bootstrap always injects
`NotificationSesActivation=disabled-ses-production-access-denied`; SES
activation requires a later, separately reviewed change after AWS grants
production access and the feedback acceptance procedure passes. Keep the configuration
object in the protected environment secret so account identifiers, topology,
capacity, and approval selections cannot be changed by an unreviewed workflow
dispatch.

The external bootstrap OIDC role must trust only the two bootstrap environment
subjects and should be permissioned only for the four exact ECR repositories,
this stack's change sets/termination protection, `iam:PassRole` of the exact
CloudFormation execution role only to `cloudformation.amazonaws.com`, and the
deterministically named `sutra-production-ha-migration-execution` role only to
`ecs-tasks.amazonaws.com`. The latter is the sole additional pass-role
permission required by the direct, exact-family ECS migration launch; the
migration task definition has no task role. The role also permits only the
prepared ECS migration task, stack/service and stack-resource verification,
`secretsmanager:GetSecretValue` for the exact runtime secret (plus its exact
KMS decrypt permission), and the release-evidence prefix. The prepare job
streams the exact `AWSCURRENT` document into the shared semantic validator and
passes only its VersionId between jobs. Every application-runtime ECS secret
reference is pinned to that immutable version, and the task-definition checks
fail if any non-database secret points anywhere else. Secret values are never
placed in a command argument, temporary file, log, or workflow output. The
CloudFormation execution role owns the resource-creation permissions; do not
grant its permissions directly to the GitHub role. Remove or disable the
bootstrap trust after first activation. Future releases use only the narrower
role created by the stack.

`.github/workflows/production-ha-release.yml` is one protected release for all
four images. It:

1. reruns source, infrastructure, build, and repository-secret gates;
2. requires a successful completed `codeql.yml` run for the exact release SHA;
3. builds app, worker, hosted-broker, and agentless-scanner candidates with
   SBOM/provenance;
4. scans the exact digests and promotes only those manifests; the scanner scan
   does not ignore unfixed High or Critical findings;
5. semantically validates one runtime-secret version, pins every new
   application-runtime task reference to it, and rechecks the immutable
   references before migration;
6. registers a migration task revision and requires exit code zero;
7. registers and deploys all three service revisions and pins the broker's
   scanner environment to the exact new scanner digest;
8. waits for all services and verifies the public health endpoint serves the
   exact application digest;
9. rolls all services back to their previous task definitions on rollout or
   verification failure, restoring and verifying the prior broker scanner
   digest; and
10. checksum-verifies release metadata written to the KMS-encrypted evidence
   bucket before declaring success. Both the current and prior scanner digests
   are retained in that evidence. A write/checksum failure rolls all three
   services back to the exact task definitions captured before deployment.

Database migrations must remain backward compatible with the previous service
revision. A service rollback cannot undo a destructive schema migration.
Infrastructure changes use a reviewed CloudFormation change set separately;
the release workflow does not update the stack.

The pull-request and direct-push CI gate also builds the complete scanner
Dockerfile for `linux/amd64` once and scans the loaded image without vulnerability
ignores. A successful source-only test run is therefore not sufficient to
release the scanner image.

## Validation and operational acceptance

Run the offline checks with:

```bash
bash deploy/production/validate-ha.sh
```

Before the first production release, operators must additionally complete and
retain evidence for:

- a CloudFormation change-set review and termination protection;
- an ALB/WAF/DNS reachability test that also proves direct-origin access is
  denied;
- a VPC Flow Log delivery test proving `TrafficType=ALL`, KMS encryption,
  accepted/rejected record arrival, retention, and alarmed delivery failure;
- an AZ-failure/capacity test for app, worker, database, and egress;
- a background-job drain test proving the public internal path is denied,
  loopback token authentication succeeds, a worker restart reclaims an expired
  lease, and `hosted.collector.collect` settles both success and failure;
- an agentless live test covering success, broker refusal, mid-run broker
  restart, cross-tenant poll refusal, customer-snapshot lifecycle handoff, and
  scan-account instance/volume/snapshot recovery before recording the exact
  approval literal;
- a worker-backlog alarm/autoscaling test using the approved durable queue
  metric;
- an RDS point-in-time restore into an isolated recovery environment, including
  application smoke tests and measured RPO/RTO;
- a secret and KMS-key rotation exercise;
- alert delivery and responder acknowledgement;
- a failed-deployment rollback exercise; and
- a cross-tenant authorization test against the live managed-production stack.

Passing repository checks validates the deployable design; it does not replace
these account-specific acceptance and recovery drills.
