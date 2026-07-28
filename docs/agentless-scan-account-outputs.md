# Agentless scan infrastructure — deployed values

Stack `sutra-agentless-scan`, deployed **2026-07-28** into account
**738663485493**, region **ap-south-1**, from
`infrastructure/agentless-scan-account.yaml`
(sha256 `ad529f43d2c235c33174045a8608c9bddb88ea8bed936e807c9bcd0f9fb40102`).

Single-account deployment into the control-plane account, chosen deliberately —
see the template's own description for the trade and the IAM denies that stand
in for account separation.

## Outputs

| Output | Value |
|---|---|
| `ScanAccountId` | `738663485493` |
| `ScanKmsKeyArn` | `arn:aws:kms:ap-south-1:738663485493:key/828cff96-5281-44e9-b113-5e3c4b63ee7b` |
| `ScanClusterArn` | `arn:aws:ecs:ap-south-1:738663485493:cluster/sutra-agentless-scan` |
| `ScannerRepositoryUri` | `738663485493.dkr.ecr.ap-south-1.amazonaws.com/sutra/agentless-scanner` |
| `ScanSubnetIds` | `subnet-0a010828a2ca84cdd`, `subnet-02986439140ffcc13` |
| `ScannerSecurityGroupId` | `sg-015790dfd771987fb` |
| `ScannerTaskRoleArn` | `arn:aws:iam::738663485493:role/SutraAgentlessScannerRole` |
| `TaskExecutionRoleArn` | `arn:aws:iam::738663485493:role/SutraAgentlessTaskExecutionRole` |
| `OrchestratorRoleArn` | `arn:aws:iam::738663485493:role/SutraAgentlessOrchestratorRole` |
| `ScannerLogGroupName` | `/sutra/agentless-scanner` |

`ScanAccountId` is what a customer passes as `AgentlessScanAccountId` when they
enable `EnableAgentlessSnapshotScanning` in the customer-role stack.

## Deploy note: the ECS service-linked role race

The first deploy FAILED on `ScanCluster`:

> Invalid request provided: CreateCluster Invalid Request: Unable to assume the
> service linked role. Please verify that the ECS service linked role exists.

ECS had never been used in this account, so `AWSServiceRoleForECS` did not
exist. The failed `CreateCluster` call itself triggered AWS to provision it
asynchronously — `iam get-role` afterwards showed a `CreateDate` three minutes
old, i.e. created *during* the failed attempt. Deleting the `ROLLBACK_COMPLETE`
stack and redeploying unchanged then succeeded.

So in a fresh account this template may need **two** runs. To avoid that, run
this once before the first deploy:

```
aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com
```

It is deliberately NOT in the template: `AWS::IAM::ServiceLinkedRole` fails when
the role already exists, which would break every account that has ever used ECS.
A one-line documented prerequisite is the lesser evil.

## Still to do

- Activate the `sutra:component` cost allocation tag in Billing, or the budget
  filter matches nothing and tracks the whole account instead.
- Push a scanner image to `ScannerRepositoryUri` (the repo is empty; the
  container is not built yet).
- Set `OrchestratorPrincipalArn` — currently unset, so `SutraAgentlessOrchestratorRole`
  trusts the account root, which grants nothing on its own. Nothing can assume it
  until an IAM principal is given explicit `sts:AssumeRole` permission.
