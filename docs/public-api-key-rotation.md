# Public API service-account token rotation policy

This is the operator policy for minting, rotating, and revoking the
service-account tokens that authenticate the Sutra Public API v1
(`/api/public/v1`). Tokens are the only credential the public API accepts
(`Authorization: Bearer sutra_pat_...`).

## Key facts

- **Secret shown once.** A minted token's full secret (`sutra_pat_<64 hex>`) is
  returned exactly once, at mint time, and only its SHA-256 is stored. There is
  no way to read a token back — if it is lost, revoke and re-mint.
- **Scoped strictly.** Every token is bound to one organization + customer and
  carries an explicit set of scopes:
  `read:resources`, `read:findings`, `read:cases`, `read:snapshots`,
  `read:compliance`, `read:vulnerabilities`, `write:cases`. Grant only the
  scopes a consumer needs.
- **Attribution.** Writes (`PATCH /cases/{caseId}`) are attributed to the user
  who minted the token — treat token custody as personally accountable.
- **Limits (enforced):**
  - **25 active (non-revoked) tokens per organization.** Minting the 26th is
    rejected with `LIMIT_EXCEEDED`. Revoke unused tokens before rotating.
  - **120 requests per minute per token** (sliding minute bucket). The request
    that crosses the limit is itself rejected with `429 RATE_LIMITED` and a
    `Retry-After: 60` header. Spread load across purpose-specific tokens rather
    than sharing one.

## Where to operate

Token administration lives in the workspace UI and its backing endpoints. Both
require an authenticated session with the `connection:manage` capability for the
customer (token management is workspace configuration, not a public-API action).

- **UI:** Settings → API tokens (`app/settings/api-tokens-panel.tsx`).
- **Endpoints** (`/api/v1/api-tokens`, session-authenticated, not part of the
  public API):
  - `GET /api/v1/api-tokens` — list tokens (metadata only: id, name, prefix,
    scopes, `expiresAt`, `createdBy`, `createdAt`, `lastUsedAt`, `revokedAt`).
    The secret is never returned here.
  - `POST /api/v1/api-tokens` — mint. Body: `{ name, scopes[], expiresAt? }`.
    Response `minted.token` is the one-time secret.
  - `DELETE /api/v1/api-tokens?id=pat_...` — revoke immediately.

## Minting

1. Decide the smallest scope set the consumer needs.
2. Set an **expiry** (`expiresAt`, ISO-8601, must be in the future). Prefer
   bounded lifetimes (e.g. 90 days) so a forgotten token self-expires. An
   expired token reads as an invalid credential (`401 INVALID_TOKEN`).
3. Give the token a descriptive `name` (owner + purpose, e.g.
   `ci-findings-export`).
4. Copy the one-time secret straight into your secret manager. Never paste it
   into source, tickets, or chat.

## Zero-downtime rotation (overlap method)

Because the secret cannot be recovered, rotation is always **mint-new →
cut-over → revoke-old**, never an in-place change. The old and new tokens are
valid simultaneously during the overlap window, so no request fails mid-switch.

1. **Mint** a new token with the *same scopes* as the one being rotated. Use a
   new name suffix (e.g. `-v2`) so both are distinguishable in the list.
2. **Distribute** the new secret to the consumer's secret store. Both tokens are
   now active (watch the 25-token/org cap — this temporarily uses two slots).
3. **Cut over** the consumer to the new token and redeploy/restart it.
4. **Verify** the old token is idle: in the list view, confirm the new token's
   `lastUsedAt` is advancing and the old token's `lastUsedAt` has gone stale
   (no traffic for at least one full deploy cycle).
5. **Revoke** the old token (`DELETE ...?id=pat_...`). Revocation takes effect
   immediately — the next request with it gets `401 INVALID_TOKEN`.

Recommended cadence: rotate every 90 days, and immediately on any suspected
exposure or personnel change for the accountable owner.

## Revocation

- Revoke immediately on suspected compromise, when a token's owner leaves, or
  when a consumer is decommissioned.
- Revocation is instantaneous and irreversible; a revoked token can never be
  reinstated — mint a fresh one if access is still needed.
- Revoked tokens still appear in the list (with `revokedAt` set) for audit, and
  they do not count against the 25-token active cap.

## Incident checklist (suspected leak)

1. Revoke the affected token first — do not wait to investigate.
2. Mint a replacement with a fresh secret and the minimal scopes.
3. Review `lastUsedAt` and application/audit logs for unexpected use.
4. Rotate any other tokens that shared the same storage or blast radius.
