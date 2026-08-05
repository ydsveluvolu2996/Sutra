# FinOps AWS policy artifacts

`lib/finops-aws-policy-artifact.ts` turns a validated FinOps permission plan
into deployable IAM JSON documents without generating CloudFormation. It emits
three independent artifacts:

1. the permanent read-only collector;
2. the one-time provisioner, only when requested by the plan; and
3. the short-lived action policy, only when its exact actions have current,
   attributable approvals.

Every artifact has its own version and SHA-256 attestation. The digest covers
the role boundary, IAM document, tenant/customer/connection, AWS
partition/account/Region, capability and source IDs, exact ordered resource
references, and approved-action evidence. The verifier rebuilds the expected
artifact from the validated plan and fails closed for missing, extra,
reordered, widened, expired, or cross-tenant content. A self-consistent policy
copied from another tenant is therefore still invalid.

IAM actions must be explicit; wildcard actions and unresolved template
substitutions are rejected. Literal IAM resource patterns required by AWS APIs
are retained exactly and are attested per statement. Provisioner and approved
action statements cannot be merged into the collector because each boundary
has a dedicated role name, statement namespace, version, digest, and exact-plan
verification.
