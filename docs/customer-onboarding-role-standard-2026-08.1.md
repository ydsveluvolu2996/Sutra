# Customer onboarding permission pack `standard-2026-08.1`

`infrastructure/customer-onboarding-role-standard-2026-08.1.yaml` is a
version-pinned successor to the current onboarding role source. It is not the
default template, is not referenced by the application, and has not been
published or deployed.

## Security contract

The successor preserves the current exact-role trust, per-connection external
ID, bounded role-session name, `/sutra/` path, tenant tag, optional permissions
boundary, one-hour maximum session, metadata collector Allows, trust
attestation scope, and explicit `DenyUnimplementedActions` ceiling.

The only actions added to that ceiling are:

- `s3:ListBucket`
- `s3:GetBucketLocation`
- `s3:GetObject`
- `s3:GetObjectAttributes`
- `bcm-data-exports:ListExports`
- `bcm-data-exports:GetExport`

Adding an action to the ceiling does not grant it. This base template contains
no Allow for any of those six actions. The separately versioned
`foundational-cur2-export-v1` add-on remains the sole owner of their effective
resource-scoped Allows:

- bucket listing is conditioned on exactly
  `<ExportPrefix>/<ExportName>` and `<ExportPrefix>/<ExportName>/*`;
- bucket location is limited to the one dedicated destination bucket;
- object reads are limited to
  `arn:<partition>:s3:::<bucket>/<ExportPrefix>/<ExportName>/*`;
- `ListExports` uses `Resource: '*'` because AWS does not support resource-level
  authorization for that action;
- `GetExport` is limited to the exact ARN returned by the add-on's
  `AWS::BCMDataExports::Export` resource.

Neither contract grants Data Exports mutations, S3 writes or deletes, wildcard
object reads, public access, account-root trust, or wildcard principal trust.

## Controlled release order

This source artifact must remain separate from
`infrastructure/customer-onboarding-role.yaml` and
`public/sutra-customer-onboarding-role.yaml` until the combined base/add-on
contract, source ingestion, tenant-isolation, and release gates have passed.

When approved, publish the exact reviewed bytes at a new immutable,
digest-verified, versioned object URL. Do not overwrite a previously published
object version and do not replace the mutable default URL as part of
publication. Attest the `standard-2026-08.1` tag and deny ceiling on the
customer role before launching `finops-foundational-cur2-export-v1.yaml`.

The role update by itself must still fail all six Foundational billing reads.
Only after the separate add-on stack succeeds may the effective permission set
read the exact customer-owned export root.
