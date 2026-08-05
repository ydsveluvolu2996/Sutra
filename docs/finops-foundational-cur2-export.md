# Foundational CUR 2.0 customer add-on

`infrastructure/finops-foundational-cur2-export-v1.yaml` is a separately
versioned, customer-owned CloudFormation add-on. It is source only: this
repository change does not publish the template, update the default onboarding
template, launch a customer stack, or activate an application feature.

AWS now documents `AWS::BCMDataExports::Export` as a native CloudFormation
resource. Its `Export` property contains the data query, S3 destination, and
refresh cadence. The add-on therefore uses the native resource and does not use
a Lambda-backed custom resource or give the permanent Sutra collector export
write permissions.

Authoritative AWS contracts:

- [AWS::BCMDataExports::Export](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bcmdataexports-export.html)
- [CUR 2.0 table and configurations](https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-cur2.html)
- [Data Exports query syntax](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-data-query.html)
- [Data Exports S3 bucket policy](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-s3-bucket.html)
- [Data protection and default S3 encryption](https://docs.aws.amazon.com/cur/latest/userguide/data-protection.html)
- [Data Exports IAM actions and resource types](https://docs.aws.amazon.com/service-authorization/latest/reference/list_bcm-data-exports.html)

## Deliberate activation block

Do not launch the add-on against the superseded `standard-2026-07.4` onboarding
role, retained immutably as
`infrastructure/customer-onboarding-role-standard-2026-07.4.yaml`. That role has
an explicit `DenyUnimplementedActions` `NotAction` ceiling. The following actions
are absent from that ceiling, so an Allow in a separate add-on policy cannot make
them effective:

- `s3:ListBucket`
- `s3:GetBucketLocation`
- `s3:GetObject`
- `s3:GetObjectAttributes`
- `kms:Decrypt`
- `bcm-data-exports:ListExports`
- `bcm-data-exports:GetExport`

The add-on's CloudFormation rule rejects `standard-2026-07.4`. It accepts only
the separately reviewed `standard-2026-08.1` base-role contract. That base
template must add exactly the seven actions above to its explicit deny ceiling
without granting broad S3 access, export mutation access, or any other
data-plane read. The scoped Allows remain owned by this add-on.

The deployable default (`infrastructure/customer-onboarding-role.yaml` and
`public/sutra-customer-onboarding-role.yaml`) now pins `standard-2026-08.12`,
which satisfies that ceiling requirement exactly: all seven actions appear in its
`DenyUnimplementedActions` `NotAction` allowlist and none of them is granted by
any Allow in the base role.

Open conflict, not yet resolved: this add-on's
`BaseCollectorPermissionPackVersion` still enumerates only `standard-2026-07.4`
and `standard-2026-08.1`, so a customer role tagged `standard-2026-08.12` cannot
launch it — CloudFormation refuses the parameter value. The add-on template is an
immutable, separately reviewed source contract and is deliberately not edited
here. Accepting `standard-2026-08.12` requires a successor add-on revision with
its own review, published under the publish-before-application order below.
Until that successor exists, the CUR 2.0 and FOCUS 1.2 foundational exports
cannot be launched against the current default role.

The parameter is an acknowledgement, not AWS-side discovery. Before launching
the add-on, the operator must attest that the existing `/sutra/` role has the
expected permission-pack tag and reviewed ceiling. Do not overwrite the base
stack's inline policy from this stack; CloudFormation stacks must not compete
for ownership of one IAM policy name.

## Customer-owned resources and access

The add-on either creates a retained, versioned, public-blocked S3 bucket and a
retained, rotating, symmetric customer-managed KMS key, or accepts the name of
a dedicated existing bucket plus its exact customer-managed KMS key ARN. In
existing-bucket mode, set
`ExistingBucketContract=dedicated-private-retained-cmk`; the named key must be
in the declared bucket Region, account, and partition and its key policy must
permit this exact account-bound Data Exports delivery. This stack owns that
bucket's bucket policy. Use a bucket dedicated to this export with no unrelated
bucket-policy statements; CloudFormation does not merge a new
`AWS::S3::BucketPolicy` with policy state owned elsewhere.

AWS documents that Data Exports delivers through `s3:PutObject` and that
SSE-KMS is triggered through the S3 bucket's default encryption during object
delivery. The created-bucket path therefore sets `SSEAlgorithm=aws:kms` with
the ARN of the stack-created CMK. The key policy lets only
`bcm-data-exports.amazonaws.com` request `kms:GenerateDataKey` and
`kms:Decrypt` through S3, with the source account and exact regional export-name
ARN enforced. It does not grant that service direct KMS encryption, key
management, or access outside an S3 encryption context.

The Data Exports service principal can write only:

`s3://<bucket>/<ExportPrefix>/<ExportName>/*`

The service Allow is constrained by the customer's account ID and the
regional Data Export ARN. There is no public Allow. A newly created bucket also
has all four S3 public-access-block settings enabled and ACLs disabled.

The permanent collector receives only:

- bucket listing for the exact export root through an `s3:prefix` condition;
- `GetBucketLocation` on the dedicated bucket;
- `GetObject` and `GetObjectAttributes` on the exact export root;
- `kms:Decrypt` on only the exact destination CMK, constrained by
  `kms:ViaService` to S3 in the destination Region and by the exact export
  object encryption context;
- `ListExports`, which AWS documents as not supporting resource-level scope;
- `GetExport` on the one export ARN created by this stack.

It never receives `CreateExport`, `UpdateExport`, `DeleteExport`,
`cur:PutReportDefinition`, `s3:PutObject`, `s3:DeleteObject`, `kms:Encrypt`,
`kms:GenerateDataKey`, key administration, or any remediation write.
CloudFormation deployment credentials—not the permanent collector—must be
authorized by the customer to create the native export and satisfy AWS's
additional CUR creation permission.

## Publish-before-application release order

The order is a release gate, not an optional runbook:

1. Review and contract-test a new version-pinned base onboarding template that
   carries the `standard-2026-08.1` ceiling described above.
2. Publish that base template at an immutable, digest-verified URL. Update and
   attest the customer role before touching this add-on.
3. Review this add-on, publish its exact tested bytes at a separate immutable
   URL, and deploy it in the customer's billing or management account. Do not
   substitute the mutable default onboarding URL.
4. Verify the stack outputs and the exact IAM policy, CMK ARN/key policy,
   SSE-KMS bucket default, bucket policy, export ARN, query, and prefix. AWS
   says initial export delivery can take up to 24 hours;
   absence before delivery is a waiting state, not zero spend.
5. Observe and validate a real manifest and its listed GZIP CSV objects through
   the read-only collector. Reconcile the accepted active generation before
   enabling any Foundational dashboard.
6. Only after the source and ingestion acceptance evidence passes may the
   application image that exposes the corresponding live UI/API be approved
   and deployed.

If the future base-role release, immutable template publishing, customer stack
update, first AWS delivery, or active-generation reconciliation has not passed,
the application must continue to show configuration-required or waiting state.
