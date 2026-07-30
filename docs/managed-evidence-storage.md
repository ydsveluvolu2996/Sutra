# Managed evidence storage

Sutra archives live AWS collection evidence before a snapshot can enter CMDB
staging. Push-ingest stores the exact signed request body. Pull collection
stores the exact UTF-8 response body authenticated by the broker response
signature. A storage failure therefore fails the run closed and no snapshot is
promoted. Manual live payloads without a broker envelope use canonical JSON
bytes. Managed JSON/CSV exports are also archived before a download grant is
issued.

Production uses the private, public-access-blocked `EvidenceBucket` declared in
`infrastructure/production-ha.yaml`. Every write requires the configured
customer-managed KMS key, checksum, conditional create, and the opaque
`evidence/v1/<64 hex>` server key. The application role can only get or put that
prefix; it cannot list or delete objects. S3 lifecycle expiration and database
`retention_until` use the same `EvidenceRetentionDays` setting. Production
startup fails unless the S3 backend, bucket, KMS key, and retention are present.
Only explicit local/development/test runtimes use the immutable D1 payload
table.

Metadata stores the tenant scope, run/snapshot binding, artifact kind, SHA-256,
byte size, status, and retention. Object identity and payload rows are
database-immutable. Neither list nor grant responses expose the S3 key.

Downloads use `/api/v1/evidence/download`; the browser never receives an S3
URL. The server returns a short-lived bearer grant once and stores only its
SHA-256 digest. The grant binds organization, customer, object, actor and
purpose. Consumption rechecks the actor's current customer capability and uses
one conditional update, so concurrent use produces exactly one winner.
Wrong-actor, wrong-tenant, expired, malformed, and replayed grants return the
same non-cacheable denial and do not disclose object existence. Attempts and
successful/failed downloads are written to the tamper-evident audit chain
without tokens or storage keys.

Before streaming, Sutra verifies S3 content metadata and computes SHA-256 over
the returned bytes locally. The response is application-streamed with
`no-store`, `nosniff`, a sandbox CSP, exact length, and the verified checksum.

Focused verification:

```bash
node --test --test-concurrency=1 \
  tests/evidence-object-store.test.ts \
  tests/evidence-repository.test.mjs \
  tests/evidence-managed-contract.test.mjs

pnpm typecheck
pnpm db:postgres:test
```
