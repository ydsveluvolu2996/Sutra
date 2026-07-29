# Agentless scan infrastructure — deployed values and configuration state

Stack `sutra-agentless-scan`, account **738663485493**, region **ap-south-1**,
from `infrastructure/agentless-scan-account.yaml`
(sha256 `a16374eb692525d4079bc53acd9eabe1ac7887053ac18df0b2fad7a06d51696a`).
First deployed 2026-07-28; change set applied 2026-07-29 to move to the
EC2-per-scan compute model.

Single-account deployment into the control-plane account, chosen deliberately —
see the template's own comments for the trade and the IAM denies that stand in
for account separation.

## Outputs

| Output | Value |
|---|---|
| `ScanAccountId` | `738663485493` |
| `ScanKmsKeyArn` | `arn:aws:kms:ap-south-1:738663485493:key/828cff96-5281-44e9-b113-5e3c4b63ee7b` |
| `OrchestratorRoleArn` | `arn:aws:iam::738663485493:role/sutra/SutraAgentlessOrchestrator` |
| `ScannerInstanceProfileArn` | `arn:aws:iam::738663485493:instance-profile/sutra/sutra-agentless-scan-ScannerInstanceProfile-h7GgQ7VTUbnf` |
| `ScannerSecurityGroupId` | `sg-015790dfd771987fb` |
| `ScanSubnetIds` | `subnet-0a010828a2ca84cdd`, `subnet-02986439140ffcc13` |
| `FindingsBucketName` | `sutra-agentless-scan-findingsbucket-5at3eakxktgc` |
| `ScannerRepositoryUri` | `738663485493.dkr.ecr.ap-south-1.amazonaws.com/sutra/agentless-scanner` |
| `ScannerLogGroupName` | `/sutra/agentless-scanner` |

`ScanAccountId` is what a customer passes as `AgentlessScanAccountId` when they
enable `EnableAgentlessSnapshotScanning` in the customer-role stack.

## Why EC2 per scan and not Fargate

The original design used an ECS Fargate task. AWS settled it: mounting a
customer filesystem needs `CAP_SYS_ADMIN`, and `RegisterTaskDefinition` refuses
it outright —

> SYS_ADMIN is not allowed on Fargate

So the model is **one short-lived EC2 instance per scan**, which is also what
lets the snapshot be attached as a block device at all. The `ScanCluster`,
`ScannerTaskRole` and `TaskExecutionRole` resources were retired in the
2026-07-29 change set; `ScannerInstanceRole`, `ScannerInstanceProfile` and
`FindingsBucket` replaced them. Retiring them also fixed a latent SSE-KMS
`AccessDenied`: the scan CMK now grants the instance role `kms:GenerateDataKey`
with `s3` in `ViaService`, so writing findings to the bucket works.

## The two STS ceilings are deliberately asymmetric

Getting this backwards is the failure the code is written to prevent.

- **Customer account** — `agentlessSnapshotSessionPolicy`, which permits the
  snapshot verbs the read-only collection ceiling withholds and **denies every
  destructive verb**. Sutra creates snapshots in a customer account and can
  never delete anything there; a customer-owned DLM policy reaps them. This is
  a hard product constraint, not a default.
- **Sutra's scan account** — the orchestrator role with **no session policy**,
  because teardown here needs `ec2:Delete*`. Applying the customer ceiling here
  would not fail loudly: every scan volume and copied snapshot would be left
  behind billing forever while each scan still reported success.

The orchestrator role sits at `Path: /sutra/`. That path is load-bearing — the
control-plane instance role explicitly denies assuming anything outside it, so
a correct trust policy alone still left the assume at `explicitDeny`.

## Worker configuration — staged 2026-07-29

Eleven of the twelve `SUTRA_AGENTLESS_*` settings are set in
`/opt/sutra/.sutra/docker.env` (backup taken first; the file also holds
generated DB secrets and is not in git). They reach the Worker as
`env.SUTRA_AGENTLESS_*` via the three-layer path: compose `environment:`
allowlist → `AGENTLESS_VARS` in `scripts/setup-local-pilot.mjs` → `.dev.vars`.

| Setting | Value |
|---|---|
| `SUTRA_AGENTLESS_SCAN_ACCOUNT_ID` | `738663485493` |
| `SUTRA_AGENTLESS_SCAN_AZ` | `ap-south-1a` |
| `SUTRA_AGENTLESS_KMS_KEY_ARN` | the `ScanKmsKeyArn` above |
| `SUTRA_AGENTLESS_SCANNER_IMAGE` | `…/sutra/agentless-scanner@sha256:7c525ef4a8deb23a3ea4d9f1a232244b3054241a2601c74e3fe32d1ed81fefc6` |
| `SUTRA_AGENTLESS_ORCHESTRATOR_ROLE_ARN` | the `OrchestratorRoleArn` above |
| `SUTRA_AGENTLESS_AMI_ID` | `ami-0884624fc54d115f3` (AL2023 x86_64) |
| `SUTRA_AGENTLESS_INSTANCE_TYPE` | `t3.medium` |
| `SUTRA_AGENTLESS_SUBNET_ID` | `subnet-0a010828a2ca84cdd` |
| `SUTRA_AGENTLESS_SECURITY_GROUP_ID` | `sg-015790dfd771987fb` |
| `SUTRA_AGENTLESS_INSTANCE_PROFILE_ARN` | the `ScannerInstanceProfileArn` above |
| `SUTRA_AGENTLESS_FINDINGS_BUCKET` | the `FindingsBucketName` above |

Two constraints those values satisfy, both of which fail at run time rather
than at validation if broken:

- `SUTRA_AGENTLESS_SUBNET_ID` must be in `SUTRA_AGENTLESS_SCAN_AZ`, because
  attaching an EBS volume is AZ-bound. `subnet-0a010828a2ca84cdd` is in
  `ap-south-1a`. The other subnet in `ScanSubnetIds` is **not**.
- The scanner image is pinned by **digest**, never a tag. A mutable tag would
  make a published finding unattributable, and the route refuses a tag.

### The twelfth setting is not ours to set

`SUTRA_AGENTLESS_LIVE_VALIDATED` is deliberately **unset**. It is an operator
attestation that the assembled scan path was validated against a live account,
and no code may set it for itself. Until an operator sets it,
`resolveAgentlessExecutorConfig` reports `available: false` with
`missing: ["SUTRA_AGENTLESS_LIVE_VALIDATED"]`, and both the Worker route and
`createAgentlessExecutor` refuse to execute — the collector refuses
independently rather than trusting its caller, because it is the process that
would actually spend money.

With the eleven values above and nothing else, the resolver reports exactly
that one missing name and **zero invalid** values. That is the current state.

## Still to do

1. **Nothing has executed end to end.** The individual EC2 call shapes were
   validated as an admin identity (see `agentless-snapshot-scanning-design.md`);
   the assembled path — assume, snapshot, copy, create volume, launch instance,
   mount, scan, upload, tear down — has never run. An empty findings list means
   **no scan has run**, never that a volume is clean.
2. **The first live scan must target a throwaway volume, not a customer's.**
   It needs a volume id chosen for the purpose and explicit confirmation.
3. Set `SUTRA_AGENTLESS_LIVE_VALIDATED=true` only **after** that scan succeeds
   and its resources are confirmed torn down.
4. Activate the `sutra:component` cost allocation tag in Billing, or the budget
   filter matches nothing and tracks the whole account instead.
5. The run registry is memory-only. A collector restart mid-scan loses the
   entry and a poll reports UNKNOWN — meaning "check AWS", not "it failed" and
   not "it finished clean". The instance's own shutdown trap and the snapshot
   TTL are what stop an orphan billing forever.

## Deploy note: the ECS service-linked role race

Kept because it will bite again in a fresh account, even though the cluster
itself is now retired: the first deploy failed on `ScanCluster` with

> Invalid request provided: CreateCluster Invalid Request: Unable to assume the
> service linked role. Please verify that the ECS service linked role exists.

ECS had never been used in the account, so `AWSServiceRoleForECS` did not
exist; the failed call itself triggered AWS to provision it asynchronously.
Deleting the `ROLLBACK_COMPLETE` stack and redeploying unchanged then
succeeded. A fresh account that needs ECS for any reason should run
`aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com`
first. It is deliberately not in a template: `AWS::IAM::ServiceLinkedRole`
fails when the role already exists, which would break every account that has
ever used ECS.
