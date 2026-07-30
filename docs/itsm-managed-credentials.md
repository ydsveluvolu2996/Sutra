# ITSM managed credential lifecycle

Jira and ServiceNow connector HMAC credentials use AWS Secrets Manager in every
non-local deployment. The application database stores connector metadata plus a
immutable
`secret://itsm/<connector-id>/versions/<version-id>` reference; it never stores
the HMAC value. Legacy unversioned references remain readable for cutover but
are never created by new writes. Local loopback development remains compatible with the original local
storage path and is visibly reported as `local`, not production-ready.

## Runtime contract

The application task requires:

- `SUTRA_ITSM_SECRET_BACKEND=aws-secrets-manager`
- `SUTRA_ITSM_SECRET_PREFIX=sutra/production/itsm/`
- `SUTRA_ITSM_SECRET_KMS_KEY_ARN=<production customer-managed KMS key ARN>`

The managed production template grants the app task only create, read, and
scheduled-delete operations in
`sutra/production/itsm/*`. The Secrets Manager records must carry the
`sutra:purpose=itsm-hmac` tag and use the production KMS key.

The supplied KMS key policy must allow the application task role through IAM,
and private application subnets must reach the regional Secrets Manager
endpoint (prefer a VPC interface endpoint; otherwise include it in the approved
HTTPS egress path). The approved egress policy must also include the exact Jira
or ServiceNow hostnames used for delivery.

## Scope and failure behavior

Every stored document binds the secret to its immutable organization, customer,
and connector identifiers. Dispatch, durable retry, and inbound signature
verification resolve through that tuple and reject a missing, malformed, or
scope-mismatched document. There is no database or environment-secret fallback
in a managed runtime.

Creating or editing a connector creates a separate immutable, version-addressed
secret before the managed reference is persisted. The database update compares
the connector version it originally read; a concurrent rotation loses that
compare-and-swap, cleans only its staged secret and cannot overwrite the winner.
A failed metadata write likewise cleans only the staged version, so the
database's prior reference still resolves the prior credential. If that
immediate staged cleanup fails, the failure is persisted as a tenant-scoped
`itsm-secret-cleanup` job with at most ten attempts; it is never silently
discarded.

A successful rotation compare-and-swaps the database reference first and
atomically records cleanup debt for the replaced version. Deleting a managed
connector likewise compare-and-swap deletes its database row first and
atomically records cleanup debt. The background worker rechecks that no live
connector references the exact immutable version before requesting a seven-day
recoverable Secrets Manager deletion. A transient Secrets Manager failure is
retried by the durable queue; after ten failed attempts the job is visibly
dead-lettered for operator investigation. A failed database transaction rolls
back both the metadata change and cleanup debt, and makes no Secrets Manager
delete request, so the live connector and credential remain usable.
Cross-customer edits and deletes are rejected.

Each connector also stores `last_outbound_success_at` and
`last_authenticated_inbound_at`. The outbound timestamp advances only after the
vendor returns a successful response, including a successful durable retry. The
inbound timestamp advances only after HMAC verification and validation against
a scoped Sutra case. Enterprise readiness requires both timestamps to be
strictly later than `updated_at` for every enabled connector. Editing metadata
or rotating the secret advances `updated_at`, so old delivery proof
automatically becomes stale without deleting its audit value.

## Activation and rotation

1. Deploy migrations `0071_itsm_managed_secrets` and
   `0076_itsm_delivery_evidence` (D1), or `0066_itsm_managed_secrets` and
   `0071_itsm_delivery_evidence` (PostgreSQL).
2. Deploy the app task IAM policy and runtime variables from
   `infrastructure/production-ha.yaml`.
3. Re-enter each legacy/local connector secret through Settings. This writes it
   to Secrets Manager and changes the connector posture to `managed`.
4. Run one outbound ticket delivery, one signed inbound state update, and one
   forced durable retry for each connector.
5. Confirm Enterprise readiness reports managed storage and current
   bidirectional proof for every enabled connector. A legacy/local connector or
   either missing/stale direction keeps the domain in attention.

Do not copy legacy `shared_secret` database values into release logs, support
artifacts, or migration output. Migration is intentionally operator-mediated so
the value crosses only the authenticated settings request and Secrets Manager
API.
