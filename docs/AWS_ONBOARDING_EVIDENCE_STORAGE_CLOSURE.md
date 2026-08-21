# AWS onboarding evidence-storage repair closure worksheet

This worksheet constrains the private-beta onboarding repair prompted by a live
first-inventory failure. The visible UI error is a redacted consequence, not the
root cause: `EvidenceRepository` requires managed object storage for the
network-reachable `staging` runtime, while the single-node EC2 stack neither
provisions nor propagates `SUTRA_EVIDENCE_*` configuration.

## Identity and starting state

| Field | Value |
|---|---|
| Repair | Single-node AWS onboarding snapshot publication |
| Starting branch / SHA | `develop` / `6757939c106fbfed891b95f383dad91f34625aaa` |
| User-visible symptom | Trust or static credentials validate, then the first inventory reports a generic collection failure and no authoritative CMDB snapshot is promoted. |
| Reproduced contract gap | `createRuntimeEvidenceObjectStore({ SUTRA_DEPLOYMENT_ENV: "staging" })` rejects missing S3/KMS configuration, while `deploy/ec2/compose.prod.yaml` and the EC2 CloudFormation template contain no evidence configuration. |
| Customer AWS impact | None. The repair changes only Sutra-owned deployment source. No live AWS, customer role, customer keys, or customer account is mutated in this checkpoint. |
| Primary implementer | Codex `/root`; no subagents |
| Node | `v22.23.2` |

## Existing-asset reuse inventory

| Surface | Existing asset | Classification | Decision |
|---|---|---|---|
| Evidence persistence | `EvidenceRepository` and `S3EvidenceObjectStore` | `REUSE_AS_IS` | Preserve fail-closed archive-before-staging and checksum/conditional-create semantics. |
| Managed-production S3 contract | `EvidenceBucket`, bucket policy, and application-role grants in `infrastructure/production-ha.yaml` | `REUSE_AS_PATTERN` | Apply the same private, versioned, KMS-bound, lifecycle-managed, no-list/no-delete contract to the single-node stack. |
| Single-node CloudFormation | `deploy/ec2/cloudformation-single-node.yaml` | `REPAIR` | Add a dedicated retained CMK and evidence bucket, exact instance-role grants, a non-secret SSM runtime descriptor, and outputs. Do not broaden customer-role IAM. |
| Runtime propagation | EC2 Compose and `scripts/setup-local-pilot.mjs` | `REPAIR` | Require and validate the four evidence variables and materialize them into the Worker runtime file. |
| Host configuration | `.env.ec2.example`, bootstrap/redeploy/release tooling | `REPAIR` | Synchronize the exact CloudFormation-owned descriptor without printing values; reject duplicates or malformed configuration. |
| Sync API and UI | `/api/pilot/connections/sync`, onboarding presentation | `REUSE_AS_IS` | Preserve redaction and no-false-success behavior. Fix the failing prerequisite rather than claiming collection succeeded. |
| Database and migrations | Existing evidence tables and CMDB snapshot transaction | `REUSE_AS_IS` | No schema or registry change is required. |
| Customer onboarding roles | All `customer-onboarding-role-standard-*` templates | `REUSE_AS_IS` | Frozen. The defect is in Sutra host evidence storage, not customer permissions. |

## Frozen and bounded edit sets

Frozen:

```text
app/api/pilot/connections/sync/route.ts
db/evidence-repository.ts
lib/evidence-object-store.ts
services/aws-collector/**
infrastructure/customer-onboarding-role-standard-*.yaml
db/runtime-migrations.ts
db/postgres-runtime-migrations.ts
scripts/postgres-migrate.mjs
```

Allowed to change:

```text
deploy/ec2/cloudformation-single-node.yaml
deploy/ec2/compose.prod.yaml
deploy/ec2/.env.ec2.example
deploy/ec2/bootstrap.sh
deploy/ec2/redeploy.sh
deploy/ec2/release-update.sh
deploy/ec2/sync-evidence-runtime.sh
deploy/ec2/validate-ops.sh
deploy/ec2/README.md
.trivyignore.yaml
scripts/setup-local-pilot.mjs
tests/evidence-managed-contract.test.mjs
tests/private-beta-runtime-config.test.mjs
tests/aws-onboarding-evidence-storage.test.mjs
docs/AWS_ONBOARDING_EVIDENCE_STORAGE_CLOSURE.md
docs/CLOUDAWARE_AWS_IMPLEMENTATION_LEDGER.md
```

No other file may change unless this worksheet records the proven requirement
first.

`.trivyignore.yaml` entered the allowed set after the repository IaC gate was
inspected: Trivy rule `AWS-0132` cannot resolve the single-node bucket's
`Fn::GetAtt` CMK ARN, the same documented false positive already accepted for
the managed-production evidence bucket. The exception is path- and rule-scoped;
the template tests and cfn-lint still require the exact CMK encryption wiring.

## Security and truth decisions

| Question | Decision |
|---|---|
| Storage boundary | Dedicated Sutra-owned S3 bucket and customer-managed KMS key; public access blocked, TLS required, versioning enabled, retained on stack deletion/replacement. |
| Runtime permissions | Instance role may only `GetObject` and `PutObject` under `evidence/v1/*`; no list or delete. KMS use is limited to the exact key through regional S3. |
| Immutability | Keep application checksum verification and `If-None-Match: *`; bucket versioning and lack of delete permission provide an additional deployment boundary. |
| Configuration | Bucket name, key ARN, backend, and retention are non-secret. CloudFormation publishes one exact SSM descriptor; host tooling validates and copies it without logging values. |
| Credentials | No AWS credentials enter the UI, repository, descriptor, or evidence metadata. Workload identity remains the only Sutra-host AWS credential source. |
| Failure behavior | Missing/malformed storage configuration or failed archive remains a failed collection with no promoted snapshot. Startup/release must detect the missing contract earlier. |
| Rollout | Source, tests, and `develop` checkpoint only. Updating the live CloudFormation stack or deploying the application requires separate current authorization. |

## Verification and handoff

| Gate | Result |
|---|---|
| Focused regression and configuration tests | 18 storage/private-beta contract tests plus 61 existing evidence, tenant-negative, onboarding, sync-truth, and collector-boundary tests passed; 0 failed. |
| CloudFormation lint and infrastructure contracts | All 28 templates passed cfn-lint with 42 existing documented Bedrock catalog suppressions; EC2 operations validation and isolated Compose/Caddy/Tunnel runtime verification passed. Trivy is unavailable locally; the existing rule-specific `AWS-0132` false-positive record now includes the exact single-node CMK intrinsic and CI remains authoritative for the scan. |
| Typecheck, lint, secret scan, build/render | Root and collector typechecks passed; affected and full ESLint passed; secret scan passed for 2,669 files; production build and 4/4 rendered-route checks passed. |
| Migration diff | Passed / not applicable; no schema, migration, registry, or migrator changed. |
| Feature commit / exact CI | Pending |
| External rollout | Pending explicit authorization; no live infrastructure change in this checkpoint |
