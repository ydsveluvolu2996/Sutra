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
- a GitHub OIDC role limited to one protected environment, three exact ECR
  repositories, three exact ECS services, the migration task family, and the
  release-evidence prefix.

No resource in this path has been deployed by repository validation.

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
2. **Network.** Supply a VPC with at least two public ALB subnets, two private
   application subnets, and two isolated database subnets, each set spanning
   distinct AZs. Fargate tasks need HTTPS and DNS egress for ECR, CloudWatch,
   Secrets Manager, STS, SES, and approved notification
   endpoints. Interface/gateway endpoints reduce NAT use for supported AWS
   services, but arbitrary webhooks still require a
   reviewed egress path. Choose redundant NAT gateways or an inspected egress
   firewall explicitly; a single NAT gateway recreates a single-AZ dependency.
   Supply `ApprovedHttpsEgressPrefixListId` with the exact AWS endpoint, Zoho,
   SES, and approved notification-destination address ranges.
   Keep it synchronized or terminate outbound TLS through an approved egress
   control whose destination ranges can be represented by that list; tasks have
   no `0.0.0.0/0` security-group egress.
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
   - `SUTRA_OIDC_PROVIDERS`
   - `SUTRA_OIDC_TRANSACTION_KEY`
   - `SUTRA_BROKER_CLIENT_KEY_ID`
   - `SUTRA_BROKER_CLIENT_PRIVATE_KEY` (base64url Ed25519 PKCS8 DER)
   - `SUTRA_APP_PUBLIC_KEYS` (JSON map of app key IDs to base64url Ed25519 SPKI DER)
   - `SUTRA_BROKER_RESPONSE_KEY_ID`
   - `SUTRA_BROKER_RESPONSE_PRIVATE_KEY` (base64url Ed25519 PKCS8 DER)
   - `SUTRA_BROKER_RESPONSE_PUBLIC_KEY` (base64url Ed25519 SPKI DER)

   `SUTRA_OIDC_PROVIDERS` is always required, including in `federated` mode,
   so the approved Zoho OIDC connection is preserved. When the explicit
   `IdentityMode` stack parameter is `federated`, the same document must also
   contain `SUTRA_SAML_PROVIDERS` and `SUTRA_SAML_TRANSACTION_KEY`; ECS does not
   inject either SAML value in `oidc` mode.

   Values are shared by replicas and must be generated, escrowed, and rotated
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
7. **ECR.** Create immutable `sutra/app`, `sutra/notification-worker`, and
   `sutra/broker` repositories with retention, scanning, and encryption
   policies. Bootstrap the stack with previously scanned digest references;
   mutable tags are rejected.
8. **Email delivery.** Supply a verified SES domain/address identity in the
   selected region, move the account out of the SES sandbox where applicable,
   and approve sending limits, DKIM/SPF/DMARC, bounce/complaint handling, and
   the notification-destination secret lifecycle under
   `sutra/notifications/*`.
9. **GitHub controls.** Create the OIDC provider and protected
   `production-ha-release` environment. Require independent reviewers, prevent
   self-review, restrict deployment branches to protected `main`, and set
   `AWS_ACCOUNT_ID`, `AWS_REGION`, `AWS_ROLE_ARN`,
   `PRODUCTION_STACK_NAME`, `PUBLIC_ORIGIN`, and `CODEQL_ENABLED=true` as
   environment variables. Enable the repository's CodeQL entitlement and
   manually run `codeql.yml` for the exact main-branch SHA before releasing;
   a successful weekly run for another SHA is not accepted. The
   CloudFormation `GitHubRepository` and `GitHubReleaseEnvironment` parameters
   must exactly match those controls.
10. **Agentless scanner.** Supply the pinned scan-account AZ, CMK, digest-only
    scanner image, `/sutra/` orchestrator role and instance profile, AMI,
    subnet, security group, and findings bucket. The broker task—not the web
    app—receives these values. The orchestrator role must own the reviewed
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
    visible as teardown debt.
11. **Vulnerability feeds.** Managed production runs a strict daily private
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
12. **Paging.** Provide an SNS topic with subscribed and tested responders, or
    explicitly accept that alarms will exist without notifications.

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
  query/archival costs;
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

`.github/workflows/production-ha-release.yml` is one protected release for all
three images. It:

1. reruns source, infrastructure, build, and repository-secret gates;
2. requires a successful completed `codeql.yml` run for the exact release SHA;
3. builds app, worker, and hosted-broker candidates with SBOM/provenance;
4. scans the exact digests and promotes only those manifests;
5. registers a migration task revision and requires exit code zero;
6. registers and deploys all three service revisions;
7. waits for all services and verifies the public health endpoint serves the
   exact application digest;
8. rolls all services back to their previous task definitions on rollout or
   verification failure; and
9. checksum-verifies release metadata written to the KMS-encrypted evidence
   bucket before declaring success. A write/checksum failure rolls all three
   services back to the exact task definitions captured before deployment.

Database migrations must remain backward compatible with the previous service
revision. A service rollback cannot undo a destructive schema migration.
Infrastructure changes use a reviewed CloudFormation change set separately;
the release workflow does not update the stack.

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
