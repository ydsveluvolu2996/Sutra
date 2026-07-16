# AWS collector credential boundary

This package is the vendor-side AWS credential broker and collector job boundary.
It resolves a customer's role ARN and External ID from a tenant-scoped server-side
registry, assumes the role with AWS STS, validates the resulting identity, and only
then hands temporary credentials to an internal inventory runner. The included
single-account runner inventories selected Regions plus global IAM configuration;
S3 buckets are retained only for their server-reported selected Region.

## Deployment requirement

**Run this as an AWS-hosted backend workload using AWS workload identity. Do not run
it in Cloudflare Workers, a browser, the dashboard process, or any client-accessible
runtime.** Suitable targets include ECS/Fargate task roles, EKS Pod Identity/IRSA,
or a Lambda execution role in the vendor security-tooling account.

`createWorkloadIdentityRoleBroker` intentionally creates the source STS client
without static credentials. In production, the AWS SDK default provider chain must
resolve the workload's task/pod/function role. Do not configure vendor access keys,
ship credentials in environment variables, or pass customer STS credentials across
an HTTP/queue boundary.

## Security invariants

- Untrusted job bodies contain exactly `jobId` and `connectionId`.
- Tenant scope is supplied separately by the authenticated queue/API execution layer.
- Role ARN and External ID are resolved only through `ScopedConnectionRegistry`.
- Registry results are rechecked for tenant, connection ID, account ID, ARN, state,
  External ID format, and STS session-name prefix.
- `AssumeRole` always includes the stored External ID for normal collection.
- `GetCallerIdentity` must match the ARN account, registered account, partition,
  role name, and exact generated role-session name before inventory runs.
- Onboarding performs a positive call plus missing-External-ID and wrong-External-ID
  probes. Both negative probes must return an authorization denial. A successful
  negative probe rejects onboarding as an unsafe trust policy; throttling/network
  errors make verification inconclusive rather than falsely safe.
- Temporary credentials are passed directly to `InventoryRunner.collect` in memory.
  Handler responses are constructed from an explicit scalar allowlist and never
  include credentials or the External ID.
- Raw AWS responses are projected into allowlisted `NormalizedAwsResource` and
  `NormalizedAwsEvidence` records. A small key allowlist of bounded tags is retained
  as tenant-confidential CMDB data; known credential formats, signed/credential
  URLs, long opaque tokens, RDS master usernames, raw SDK errors, and all AWS
  credentials are excluded. Tag filtering reduces accidental secret capture but
  does not make retained names or tags public or safe for telemetry.
- Pagination tokens are consumed with cycle/maximum-page guards. Service tasks use
  bounded concurrency and SDK standard retry mode with a bounded attempt count.
  Every AWS command has an abortable 15-second deadline and the complete one-host
  run has a shared five-minute deadline. A timeout is sanitized and published as
  partial coverage; it is never presented as a complete observation.
- A failed service/Region writes sanitized `COLLECTION_ERROR` evidence and makes the
  scan `PARTIAL`; it does not erase successfully observed resources.
- Errors intentionally omit the External ID, STS credential values, SDK request
  input, and original AWS error object. Logging code must maintain that property.

`markOnboardingVerified` must use a conditional database update so stale workers
cannot activate a connection that changed after verification.

The loopback server's connection-operation lock is intentionally a one-host demo
boundary. A hosted, horizontally scaled or multi-process deployment still requires
a durable queue, database-backed leases/fencing tokens, a staging snapshot store,
and atomic promotion of a complete manifest. Do not treat the in-memory lock or the
bounded signed-response snapshot as a substitute for that architecture.

## Runtime wiring

```ts
import { AwsCollectorJobHandler } from "./src/job-handler.js";
import {
  AwsSdkInventoryClientFactory,
  SingleAccountAwsInventoryRunner,
  StaticInventoryRegionSelector,
} from "./src/inventory-runner.js";
import { createWorkloadIdentityRoleBroker } from "./src/role-broker.js";

const broker = createWorkloadIdentityRoleBroker({
  registry,
  region: process.env.AWS_REGION,
  maxAttempts: 4,
});

const inventoryRunner = new SingleAccountAwsInventoryRunner({
  clients: new AwsSdkInventoryClientFactory({ maxAttempts: 4 }),
  sink: tenantScopedInventorySink,
  regionSelector: new StaticInventoryRegionSelector([
    "us-east-1",
    "us-west-2",
  ]),
  maxConcurrency: 4,
});

const handler = new AwsCollectorJobHandler({
  roleBroker: broker,
  registry,
  inventoryRunner,
});

// `scope` comes from trusted queue/auth context, not from `rawJob`.
const result = await handler.handleInventoryJob(scope, rawJob);
```

Never log `InventoryCollectionContext`: it intentionally contains the short-lived
credentials needed by AWS service adapters.

The current runner collects:

- EC2 instances, VPCs, subnets, and security groups/rules;
- S3 buckets and per-bucket public-access-block configuration;
- RDS DB instances;
- IAM account summary and account password policy;
- CloudTrail trail configuration and logging status;
- GuardDuty detector status and Region enablement evidence; and
- Security Hub Region enablement evidence.

`AwsInventorySink` must enforce the tenant/connection boundary when persisting
batches. The normalized records do not contain `tenantId` by design because the sink
is already selected from the trusted job scope; implementations must never route a
batch using user-supplied identifiers.

## Development

```bash
npm install
npm test
npm run typecheck
```

Tests use dependency-injected fake STS clients. They make no live AWS calls and need
no AWS credentials.
