# Customer onboarding permission pack `standard-2026-08.2`

`infrastructure/customer-onboarding-role-standard-2026-08.2.yaml` is an
immutable successor to `standard-2026-08.1`. It has not been published or
deployed, is not the mutable onboarding default, and is not referenced by the
production application.

## Exact capability delta

The template preserves the exact trust, parameters, standard metadata Allows,
role-attestation scope, seven Foundational add-on ceiling actions, and Cost
Anomaly source policy from `standard-2026-08.1`.

It adds only four actions to `DenyUnimplementedActions.NotAction`:

- `support:DescribeTrustedAdvisorCheckResult`
- `support:DescribeTrustedAdvisorChecks`
- `organizations:DescribeOrganization`
- `organizations:ListAccounts`

The ceiling does not grant an action. Effective access is owned by two new,
separately named inline policies:

- `SutraFinopsTrustedAdvisorStandardReadV1` grants exactly the two Trusted
  Advisor standard-check reads.
- `SutraFinopsOrganizationsTaxonomyReadV1` grants exactly the two
  Organizations taxonomy reads.

`SutraFinopsCostAnomalyReadV1` remains byte-for-byte equivalent to the
`standard-2026-08.1` source policy. The seven Foundational S3, KMS, and Data
Exports actions remain ceiling-only; their resource-scoped Allows continue to
belong exclusively to the immutable Foundational export add-on.

No policy grants AWS Organizations mutations, Trusted Advisor mutations, Cost
Anomaly mutations, S3 writes or deletes, KMS encryption or key management,
Data Exports mutations, wildcard actions, account-root trust, or wildcard
principal trust.

## Regional and partition boundary

The Trusted Advisor standard-check and Organizations taxonomy collectors are
intentionally limited to the commercial `aws` partition and the
`us-east-1` control region. This is enforced by the persisted FinOps source
contract parser before role assumption and repeated by the dedicated
Organizations broker route. A GovCloud or China binding, or any other region,
must fail closed; the system must not silently substitute an endpoint.

The CloudFormation role itself retains the established multi-partition trust
parameter so existing metadata and Foundational contracts remain portable.
Possessing this role in another partition does not make the advanced source
contract valid.

## Controlled release

Do not overwrite a previously published permission-pack object. Publication
must use the exact reviewed bytes at a new immutable, digest-verified,
versioned object URL. Do not replace
`infrastructure/customer-onboarding-role.yaml`,
`public/sutra-customer-onboarding-role.yaml`, or the production customer
template URL merely to publish this candidate.

Before activation, record and verify the immutable object version ID and
SHA-256 digest, redeploy the customer stack, attest the
`standard-2026-08.2` role tag and exact inline policies, persist server-owned
source bindings, and pass the durable Trusted Advisor organization workflow.
Until then, dashboards must report the source as unavailable rather than
fabricate live AWS evidence.
