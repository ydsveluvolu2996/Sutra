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
and all three durable app handlers are registered. Activation remains
fail-closed until the exact template bytes are published and attested, exact
server-owned source bindings are persisted, and the independent evidence key
is present in the active production secret version. It may call only
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
The template is an undeployed candidate and does not change either mutable
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
is not fanned out again. Transient provider failures rethrow into the durable
queue until the bounded final attempt. The deterministic finalizer is queued
only after a terminal account write observes that no pending/running members
remain; terminal replay repairs a crash between persistence and enqueue.
Finalization rejects any manifest with a pending or running member. Complete organization heads remain possible only when every
frozen account has complete accepted standard-check evidence; partial and
failed generations remain history-only under the existing repository guards.

## Merge record — 2026-08-06

Merged to `main` since this record was last updated (2026-08-05 15:01). Every
item below is source-only work that landed through review with CI green on the
merge commit — nothing more. No provider, live, two-tenant, or release evidence
is created by any of it.

**Maturity is unchanged (`PARTIAL_PIPELINE`) and no child-stage gate passed.** G7
fixed-tree, G8 controlled provider acceptance, G9 release and G10 deployment
remain unpassed for this row; no live acceptance, provider reconciliation, or
two-tenant acceptance is claimed.

- **New `aws_static_credentials` onboarding method — `6298f03` (PR #39).**
  Onboarding now offers an access key ID plus secret access key (with a session
  token required for temporary `ASIA` keys) as an alternative to the
  CloudFormation trust-role flow, which stays the recommended default. The
  credential material lives only in the collector's AES-GCM-encrypted registry
  document; the app database stores the `aws_static_credentials` source kind and
  nothing else. Static sessions carry **no STS inline session-policy ceiling and
  no role-contract attestation** — both are impossible without `AssumeRole`.
  **This row's connection prerequisite is unchanged: the FinOps per-source
  verticals still require the trust-role method.** The FinOps source guards were
  deliberately left trust-role-only, so an `aws_static_credentials` connection
  cannot satisfy the prerequisite recorded above. No permission ceiling,
  attestation, or role contract in this record is relaxed by it.
