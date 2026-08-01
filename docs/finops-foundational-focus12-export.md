# Foundational AWS FOCUS 1.2 customer add-on

`infrastructure/finops-foundational-focus12-export-v1.yaml` is an immutable,
separately reviewed source contract. It creates a customer-owned export of the
native AWS `FOCUS_1_2_AWS` table and a resource-scoped read policy for the
existing Sutra collector role.

This repository change does not publish the template, update the default or
public onboarding template, launch a customer stack, change an application
reference, or make FOCUS 1.2 production-accepted.

## Verified AWS contract

The contract was checked against the current AWS documentation on 2026-07-31:

- [AWS Data Exports overview](https://docs.aws.amazon.com/cur/latest/userguide/what-is-data-exports.html)
  lists “FOCUS 1.2 with AWS columns” as a standard export.
- [Data Exports quotas](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-quotas.html)
  gives its exact table identifier as `FOCUS_1_2_AWS`.
- [FOCUS 1.2 table and configurations](https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-focus-1-2-aws.html)
  defines the same case-sensitive table identifier and its
  `TIME_GRANULARITY` configuration with `HOURLY`, `DAILY`, and `MONTHLY` as the
  valid values. This contract selects `HOURLY`.
- [FOCUS 1.2 with AWS columns](https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-focus-1-2-aws-columns.html)
  is the authoritative current 60-column dictionary. The template selects
  every documented column, including the three AWS extension columns.
- [Creating a standard export](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-create-standard.html)
  documents gzip/text-CSV delivery. Its generic FOCUS configuration sentence
  is superseded for this exact table by the table-specific FOCUS 1.2 page
  above, which documents `TIME_GRANULARITY`.
- [AWS::BCMDataExports::Export](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bcmdataexports-export.html)
  is the native CloudFormation resource used by the template.
- [Data Exports query syntax](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-data-query.html)
  defines the supported `SELECT ... FROM <TABLE_NAME>` query form and states
  that table and column names are case-sensitive.
- [Understanding export delivery](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-export-delivery.html)
  defines the delivered `<prefix>/<export-name>/` namespace, manifests, and
  gzip/CSV chunk paths.
- [Data protection and default S3 encryption](https://docs.aws.amazon.com/cur/latest/userguide/data-protection.html)
  documents that Data Exports defaults to SSE-S3 and that SSE-KMS is applied
  through the destination bucket's default encryption configuration during
  object delivery.

AWS currently supports FOCUS 1.2 directly, so this is an active native template
contract rather than a guarded FOCUS 1.0 fallback. It must fail deployment if a
future AWS region does not expose `FOCUS_1_2_AWS`; operators must never replace
the query with `FOCUS_1_0_AWS` while retaining the 1.2 contract name.

AWS also publishes
[FOCUS 1.2 conformance gaps](https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-focus-1-2-aws-conformance.html).
Sutra must retain that provenance and must not imply that AWS-supplied nulls or
documented gaps were filled or inferred.

## Parser and delivery contract

The query projects the complete current AWS FOCUS 1.2 column dictionary without
aliases, filters, estimates, or row limits. Its required canonical fields
include `BillingAccountId`, `SubAccountId`, `ServiceName`, `ChargeCategory`,
`ChargePeriodStart`, `BilledCost`, and `BillingCurrency`. FOCUS 1.2-only fields
such as `BillingAccountType`, `SkuMeter`, and the pricing-currency columns make
the schema unambiguous to `lib/finops-cur.ts`.

The parser can accept provider extensions that are not in the current AWS
dictionary. This export intentionally does not query `InvoiceIssuerId`,
`CommitmentDiscountStartDate`, `CommitmentDiscountExpirationDate`, or
`x_CostCategories`; inventing those columns would cause AWS query validation
to fail and would misstate the native AWS FOCUS 1.2 schema.

The S3 output is:

- `HOURLY` FOCUS table granularity;
- `GZIP` compression;
- `TEXT_OR_CSV` format;
- `CUSTOM` output;
- `CREATE_NEW_REPORT` history so corrected deliveries are independently
  observable; and
- `SYNCHRONOUS` refresh cadence, the AWS Data Exports billing cadence value.

The application must ingest the AWS manifest, validate every listed object and
activate a generation atomically. A healthy export or a present object is not,
by itself, reconciliation evidence.

## Dedicated destination contract

With no existing bucket name, the stack creates a retained, update-retained,
versioned bucket and retained, rotating, symmetric customer-managed KMS key.
The bucket uses that exact key for default SSE-KMS encryption, has ACLs
disabled, and enables every S3 public-access block.

Existing-bucket mode is deliberately guarded. The operator must set
`ExistingBucketContract=dedicated-private-retained-cmk`, provide the exact full
customer-managed key ARN in `ExistingBucketKmsKeyArn`, and separately verify
that the named bucket and key:

- is dedicated to this export and private;
- is retained through customer lifecycle policy;
- have matching account, partition, and declared destination Region;
- have ACLs disabled, exact-key SSE-KMS default encryption, versioning, and all
  public-access blocks enabled;
- permit only the exact account-bound Data Exports delivery through S3 in the
  key policy; and
- has no independently managed bucket-policy statements.

`AWS::S3::BucketPolicy` owns the whole policy document; CloudFormation does not
merge unrelated policy state. Do not point this stack at a shared bucket.

The [AWS Data Exports bucket policy contract](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-s3-bucket.html)
requires the `bcm-data-exports.amazonaws.com` service principal and account/
source-ARN confused-deputy controls. This template further restricts
`s3:PutObject` to:

`s3://<bucket>/<ExportPrefix>/<ExportName>/*`

and restricts `aws:SourceArn` to the regional, account-owned export name:

`arn:<partition>:bcm-data-exports:<region>:<account>:export/<ExportName>-*`

AWS documents that Data Exports delivers through `s3:PutObject`; S3 default
bucket encryption applies SSE-KMS during that object delivery. For the created
destination, the key policy permits `bcm-data-exports.amazonaws.com` only
`kms:GenerateDataKey` and `kms:Decrypt` through S3, with the source account,
exact regional export-name ARN, and S3 encryption context constrained. It does
not grant the service direct KMS encryption, key management, or access outside
an S3 encryption context. The service principal cannot read or delete objects.

## Permanent collector contract

The immutable `standard-2026-08.1` base role deny ceiling is sufficient for this
add-on. It ceiling-permits the actions below without granting them. This
add-on owns the exact resource-scoped Allows:

- `s3:ListBucket` only for `<ExportPrefix>/<ExportName>` and descendants;
- `s3:GetBucketLocation` on the dedicated bucket;
- `s3:GetObject` and `s3:GetObjectAttributes` only below the exact export root;
- `kms:Decrypt` on only the exact destination CMK, constrained by
  `kms:ViaService` to S3 in the destination Region and by the exact export
  object encryption context; and
- `bcm-data-exports:GetExport` only on the one created export ARN.

AWS [GetExport](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_DataExports_GetExport.html)
returns the export definition plus `StatusCode`, `StatusReason`, and
`LastRefreshedAt`. Because the export ARN is a stack output and connection
configuration input, `ListExports`, `ListExecutions`, `GetExecution`,
`ListTables`, and `GetTable` are unnecessary for normal health collection and
are not granted.

The permanent collector never receives `CreateExport`, `UpdateExport`,
`DeleteExport`, tagging writes, `s3:PutObject`, `s3:DeleteObject`,
`kms:Encrypt`, `kms:GenerateDataKey`, key administration, or any remediation
permission. Customer-authorized CloudFormation deployment credentials—not the
collector—create and own the export.

## Activation and release gate

Do not launch or publish this source contract until all of the following pass:

1. Review, publish at an immutable digest-verified URL, deploy, and attest the
   separate `standard-2026-08.1` base collector role.
2. Contract-test these exact template bytes, publish them at a different
   immutable digest-verified URL, and deploy the add-on in the customer billing
   or management account.
3. Verify the stack outputs, FOCUS query, exact IAM policy, CMK ARN/key policy,
   SSE-KMS bucket default, bucket controls, bucket policy, export ARN, and the
   `FOCUS_1_2_AWS` table in `GetExport`.
4. Wait for an actual delivery. AWS says initial delivery can take up to
   24 hours; absence before delivery is a waiting state, not zero cost.
5. Validate a real manifest and every listed gzip/CSV object through the
   read-only collector. Confirm the parser reports `focus` / `1.2`, then
   reconcile and atomically promote the generation.
6. Only after tenant-isolation, source, reconciliation, rendered-dashboard,
   security, and production acceptance gates pass may an application reference
   or deployment be approved.

Until then the application must show configuration-required or waiting with the
exact missing evidence. It must not fall back to FOCUS 1.0, fixture data, or an
unreconciled estimate.
