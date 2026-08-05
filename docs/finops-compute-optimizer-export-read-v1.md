# Compute Optimizer export-object read contract v1

This contract is a candidate only. It has not been published, deployed, or
made the production onboarding default.

## Immutable artifacts

- `customer-onboarding-role-standard-2026-08.4.yaml` is an immutable successor
  to `standard-2026-08.3`. It preserves every existing Allow and adds only
  `s3:GetObjectVersion` and `kms:GenerateDataKey` to the explicit-deny ceiling.
  A ceiling is not a grant: the base role still grants no S3 object or KMS data
  access.
- `finops-compute-optimizer-export-read-v1.yaml` is a separate add-on attached
  to the existing `/sutra/` collector role. One stack binds one partition,
  account, Region, existing bucket, and derived effective prefix:
  `<base>compute-optimizer/<requester-account-id>/`.

The add-on permanently grants only `s3:GetObject` and
`s3:GetObjectVersion` below that sealed prefix. It grants neither bucket
listing nor bucket metadata, object attributes, writes, deletes, or Compute
Optimizer `Export*` operations. In SSE-KMS mode it additionally names one exact
customer-managed key and permits only `kms:Decrypt` and
`kms:GenerateDataKey`, conditioned on regional Amazon S3 via
`kms:ViaService`. CloudFormation cannot inspect an existing key's key spec, so
the input contract requires an explicit attestation that the ARN is a
symmetric customer-managed key in the same partition, account, and Region;
deployment automation must verify that attestation with `DescribeKey` before
launch.

AWS documents that Compute Optimizer writes a CSV and a JSON metadata file to
an existing S3 bucket, and that KMS-encrypted export buckets require a symmetric
customer-managed key with `Decrypt` and `GenerateDataKey` in the applicable key
policy:

- [Exporting AWS Compute Optimizer recommendations](https://docs.aws.amazon.com/compute-optimizer/latest/ug/exporting-recommendations.html)
- [Using encrypted S3 buckets for your recommendations export](https://docs.aws.amazon.com/compute-optimizer/latest/ug/using-encrypted-s3-buckets.html)

## Prefix policy intersected with one-object sessions

The prefix policy is only the permanent upper bound. For every CSV or metadata
read, Sutra assumes the customer role with a generated inline STS session
policy naming exactly one planned object ARN and exactly one read mode:

- current object: `s3:GetObject`;
- pinned version: `s3:GetObjectVersion`.

For SSE-KMS, the same session policy names the attested key and retains the
regional `kms:ViaService` condition. AWS evaluates the session as the
intersection of the role's identity policy and the session policy; the session
cannot add access that the role does not already have. Therefore a job ID,
neighboring key, bucket listing, or unplanned prefix cannot be reached by using
the session policy alone.

- [Amazon S3 API operations and required policy actions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html)
- [AWS STS `AssumeRole` session policy intersection](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html)
- [AWS KMS `kms:ViaService`](https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html#conditions-kms-via-service)

## Why one add-on is required per Region

AWS does not allow Compute Optimizer recommendations from multiple Regions to
be exported to one S3 bucket. Every regional plan therefore owns a distinct
bucket and this distinct add-on stack. The stack asserts that its declared
partition, requester account, and export Region equal CloudFormation's stack
context, and derives the provider prefix from that account instead of accepting
the suffix from a browser or operator.

- [Compute Optimizer regional export restrictions](https://docs.aws.amazon.com/compute-optimizer/latest/ug/exporting-your-recommendations.html)

Persist and attest the outputs `ContractVersion`,
`RequiredBasePermissionPackVersion`, `CollectorRoleArn`, `StackPartition`,
`RequesterAccountId`, `ExportRegion`, `ExistingBucketName`, `EffectivePrefix`,
`ObjectArnPrefix`, `KmsMode`, `KmsKeyArn`, and `AttachedPolicyName` before any
export object is accepted as evidence.
