# Compute Optimizer export launch v1

This contract is a candidate only. It has not been published, deployed, or
made the production onboarding default.

This contract seals one daily, regional organization export attempt before any
AWS call. It launches exactly these actions once, sequentially, in the sealed
target order:

- `compute-optimizer:ExportAutoScalingGroupRecommendations`
- `compute-optimizer:ExportEBSVolumeRecommendations`
- `compute-optimizer:ExportEC2InstanceRecommendations`
- `compute-optimizer:ExportECSServiceRecommendations`
- `compute-optimizer:ExportIdleRecommendations`
- `compute-optimizer:ExportLambdaFunctionRecommendations`
- `compute-optimizer:ExportLicenseRecommendations`
- `compute-optimizer:ExportRDSDatabaseRecommendations`

AWS Compute Optimizer supports no resource ARN types, so these eight actions
and their matching `compute-optimizer:Get*` dependencies require `Resource: '*'`.
The launch add-on also grants only the documented union of dependencies:
`autoscaling:DescribeAutoScalingGroups`, `ec2:DescribeInstances`,
`ec2:DescribeVolumes`, `ecs:ListClusters`, `ecs:ListServices`,
`lambda:ListFunctions`, `lambda:ListProvisionedConcurrencyConfigs`,
`rds:DescribeDBClusters`, and `rds:DescribeDBInstances`.

`standard-2026-08.4` explicitly denies the export/dependency actions that it
does not list in its `NotAction` ceiling. An Allow in a separate policy cannot override that explicit Deny.
The new immutable `standard-2026-08.5` successor
therefore preserves every `.8.4` grant and opens only the 22 missing actions in
the complete 25-action launch/dependency set; the base pack still grants none
of those newly opened actions.

`finops-compute-optimizer-export-launch-v1.yaml` provisions one dedicated
CloudFormation-owned destination bucket and symmetric customer-managed KMS key
per Region. The bucket is private,
non-Requester-Pays by construction, retained on deletion/replacement,
versioned, Bucket Owner Enforced, protected by all four public-access blocks,
and encrypted with SSE-KMS (`aws:kms`) using the exact retained, rotation-enabled
regional key. The template does not accept or overwrite
an existing bucket policy.

Its destination policy grants the `compute-optimizer.amazonaws.com` service
principal exactly `s3:GetBucketAcl`, `s3:GetBucketPolicyStatus`, and
prefix-scoped `s3:PutObject`. Writes are restricted to
`<optional-prefix>compute-optimizer/<requester-account-id>/*` and constrained
by `bucket-owner-full-control`, exact requester `aws:SourceAccount`, and the
partition-correct regional Compute Optimizer `aws:SourceArn`. The collector
gets only `s3:GetObject` and `s3:GetObjectVersion` on that same provider prefix;
it gets no S3 list, delete, unrelated write, or object wildcard outside it.

The key policy grants the account root its normal IAM delegation boundary and
grants `compute-optimizer.amazonaws.com` only `kms:GenerateDataKey` and
`kms:Decrypt`, constrained by exact requester `aws:SourceAccount` and the
partition-correct regional Compute Optimizer `aws:SourceArn`. AWS managed KMS
keys are not used because Compute Optimizer recommendation exports do not permit
them. The separately attested object-read contract must carry this exact key ARN
and narrows runtime decrypt use through the same regional S3 boundary.

The launch response is not sufficient to create a materialization plan. In
particular, `ExportRDSDatabaseRecommendations` has no request `resourceType`.
Every successful launch therefore requires a fresh, exact
`DescribeRecommendationExportJobs` proof of the same job ID, family,
destination, request hash, `COMPLETE` status, actual provider resource type,
and canonical provider timestamps. Only the complete eight-target proof can be
adapted to the existing regional plan input. Partial attempts remain immutable
history and never advance a materialization head.

Authoritative AWS references (retrieved 2026-08-02):

- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_awscomputeoptimizer.html>
- <https://docs.aws.amazon.com/compute-optimizer/latest/ug/create-s3-bucket-policy-for-compute-optimizer.html>
- <https://docs.aws.amazon.com/compute-optimizer/latest/ug/using-encrypted-s3-buckets.html>
- <https://docs.aws.amazon.com/compute-optimizer/latest/ug/exporting-your-recommendations.html>
- <https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_RecommendationExportJob.html>
- <https://docs.aws.amazon.com/compute-optimizer/latest/APIReference/API_ExportRDSDatabaseRecommendations.html>

Onboarding must persist and attest the template outputs for contract/base-pack
version, exact collector role, partition, account, Region, bucket name/ARN,
launcher key prefix, effective provider prefix/object ARN bound, SSE-KMS mode,
exact customer-managed KMS key ARN,
versioning status, service principal, and attached IAM/bucket-policy identities.
The launcher must use that sealed destination and must never accept a browser-supplied destination.
