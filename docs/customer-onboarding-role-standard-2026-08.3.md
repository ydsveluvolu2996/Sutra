# Customer onboarding permission pack `standard-2026-08.3`

`infrastructure/customer-onboarding-role-standard-2026-08.3.yaml` is an
immutable successor to `standard-2026-08.2`. It has not been published or
deployed, is not the mutable onboarding default, and is not referenced by the
production application.

## Exact capability delta

The template preserves the exact trust, parameters, standard metadata Allows,
role-attestation scope, Foundational add-on ceiling, and the three source
policies from `standard-2026-08.2`.

It adds only three actions to `DenyUnimplementedActions.NotAction`:

- `compute-optimizer:DescribeRecommendationExportJobs`
- `compute-optimizer:GetEnrollmentStatus`
- `compute-optimizer:GetEnrollmentStatusesForOrganization`

The ceiling does not grant an action. Effective access is owned by one new
inline policy, `SutraFinopsComputeOptimizerExportReadV1`, which grants exactly
those three read operations. The policy can discover enrollment and recent
export-job identities. It cannot create, update, or delete an export job and it
cannot read an export object from S3.

The Cost Anomaly, Trusted Advisor standard-check, and Organizations taxonomy
policies remain unchanged. The seven Foundational S3, KMS, and Data Exports
actions remain ceiling-only; their resource-scoped Allows continue to belong
exclusively to the immutable Foundational export add-on.

No policy grants Compute Optimizer `Export*` operations, AWS Organizations
mutations, Trusted Advisor mutations, Cost Anomaly mutations, S3 writes or
deletes, KMS encryption or key management, Data Exports mutations, wildcard
actions, account-root trust, or wildcard principal trust.

## Regional and partition boundary

The Trusted Advisor standard-check and Organizations taxonomy collectors remain
limited to the commercial `aws` partition and the `us-east-1` control Region.
The Compute Optimizer discovery contract accepts only a Region in the same
partition as the attested connection. Its bounded collector derives the service
endpoint from that persisted Region and never accepts a browser-supplied AWS
endpoint, operation, destination bucket, or object key.

Discovery is not historical recommendation evidence. AWS documents that one
recommendations export represents one resource type and one Region, and that
multiple Regions require separate S3 buckets. The live materializer therefore
remains fail closed until a separate, server-owned, Region-specific export plan
binds every expected resource-type × Region pair to an exact completed job,
bucket, prefix, metadata object, and CSV object.

## Controlled release

Do not overwrite a previously published permission-pack object. Publication
must use the exact reviewed bytes at a new immutable, digest-verified, versioned
object URL. Do not replace `infrastructure/customer-onboarding-role.yaml`,
`public/sutra-customer-onboarding-role.yaml`, or the production customer
template URL merely to publish this candidate.

Before activation, record and verify the immutable object version ID and SHA-256
digest, redeploy the customer stack, attest the `standard-2026-08.3` role tag and
exact inline policies, and persist a server-owned Compute Optimizer source
binding. Before accepting recommendation history, also complete the separate
resource-scoped export-object binding, CSVW parser, resource-specific row mapper,
durable materializer, and live AWS acceptance gates. Until then, the dashboard
must report discovery and materialization independently and must not fabricate
recommendation evidence.
