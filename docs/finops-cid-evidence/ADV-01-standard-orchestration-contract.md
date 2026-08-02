# ADV-01 standard-check organization orchestration contract

The app-side coordinator is implemented in
`lib/finops-trusted-advisor-standard-orchestration.ts`. It preserves the
existing account-local AWS Support collector contract:

- source: `trusted_advisor_standard_checks`;
- permission contract: `aws-trusted-advisor-standard-checks-read-v1`;
- endpoint Region: `us-east-1`;
- operations: `support:DescribeTrustedAdvisorChecks` and
  `support:DescribeTrustedAdvisorCheckResult`;
- Trusted Advisor Priority organization recommendations are not accepted as a
  substitute.

## Server-owned Organizations manifest

The browser supplies no account list. The activation job accepts only a fully
exhausted, maximum-10,000-account taxonomy capture with schema
`sutra.aws-organizations-taxonomy.signed.v1`. Its scope, commercial partition,
management account, AWS organization ID, collection time, exact operation set,
canonical account set, SHA-256 digest, signer identity, and
`AWS_KMS_RSASSA_PSS_SHA_256` signature are validated before persistence.

The credential-owning collector adapter and immutable
`standard-2026-08.2` least-privilege customer-role candidate are implemented
but intentionally not represented as active until the exact template bytes are
published and attested, server-owned source bindings are persisted, and durable
handlers are registered. Its stable activation reason remains
`AWS_ORGANIZATIONS_SIGNED_TAXONOMY_ADAPTER_NOT_REGISTERED`. It may call only
`organizations:DescribeOrganization` and `organizations:ListAccounts`, must
exhaust pagination, and must sign the canonical capture using the server-pinned
signer identity. Fabricated, browser-provided, stale, unsigned, partially paged,
cross-tenant, non-commercial-partition, or management-account-mismatched
captures fail closed.

The collector uses the fixed commercial Organizations endpoint, exhausts and
replay-checks at most 1,024 pages and 10,000 accounts, reads `Account.State`
rather than the retiring `Status` field, excludes provider names and email
addresses, canonicalizes the complete lifecycle-aware account set, and signs
its SHA-256 digest with a retained workload-account RSA-3072 KMS key. The
broker task can only `kms:Sign`; the application task can only `kms:Verify`;
both IAM grants are pinned to `DIGEST` plus `RSASSA_PSS_SHA_256`. The customer
assumed-role credentials are never supplied to KMS.

The successor role adds only the two Support and two Organizations reads to
the immutable `standard-2026-08.1` ceiling and grants them through the exact
`SutraFinopsTrustedAdvisorStandardReadV1` and
`SutraFinopsOrganizationsTaxonomyReadV1` inline policies. The advanced source
contract remains limited to the commercial `aws` partition and `us-east-1`.
The template is an unpublished candidate and does not change either mutable
onboarding default.

## Fan-out and evidence consumption

Only active accounts bound to unique live same-tenant AWS trust-role
connections are queued. Missing connections and non-active AWS accounts become
explicit `unconfigured` manifest members. Each account job requests only the
fixed standard-check source/contract/Region tuple and consumes verified bytes
from the exact immutable source generation. The generation scope, account,
job/attempt, hash, schema, watermark, sealed reference, standard-check source,
and Support API evidence shape are revalidated before an account snapshot is
accepted. Provider failures and rejected evidence use generic error codes; raw
provider errors are never persisted.

Manifest/account replay is idempotent: terminal accounts are not recollected,
queue identities are manifest/account-bound, and an existing terminal manifest
is not fanned out again. Finalization rejects any manifest with a pending or
running member. Complete organization heads remain possible only when every
frozen account has complete accepted standard-check evidence; partial and
failed generations remain history-only under the existing repository guards.
