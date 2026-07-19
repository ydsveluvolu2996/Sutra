# Sutra Public API v1

Base URL: `/api/public/v1` · Spec: `GET /api/public/v1/openapi.json`

## Authentication
Create a service-account token under **Settings → Public API tokens** (capability
`connection:manage`). The secret (`sutra_pat_…`) is shown **once** and stored only as a
SHA-256 hash. Send it as `Authorization: Bearer sutra_pat_…`. Tokens are bound to one
organization + customer; revocation and expiry take effect immediately.

## Contract
- **Pagination:** reads return `{ "data": [...], "page": { "next": "<cursor>" } }`.
  Pass `?cursor=` to continue; `page.next` is `null` on the last page. `?limit=` 1–100 (default 50).
- **Idempotency:** writes require an `Idempotency-Key` header. Replaying the same key with
  the same request returns the stored response (`idempotency-replayed: true`); the same key
  with a **different** request is `409 IDEMPOTENCY_CONFLICT` — never a silent re-execution.
- **Quota:** 120 requests/minute per token → `429` with `retry-after: 60`.
- **Errors:** `{ "error": { "code", "message" } }` with 400/401/403/404/409/422/429.

## Endpoints
| Method | Path | Scope |
|---|---|---|
| GET | `/resources` | `read:resources` |
| GET | `/findings` | `read:findings` |
| GET | `/cases` | `read:cases` |
| PATCH | `/cases/{caseId}` (`{"status": "open"|"investigating"|"resolved"|"accepted_risk"}`) | `write:cases` |
| GET | `/snapshots` | `read:snapshots` |
| GET | `/compliance` | `read:compliance` |
| GET | `/vulnerabilities` | `read:vulnerabilities` |

Write actions are attributed to the user who minted the token. Data reflects the published
head snapshot — the API never exposes another tenant's rows: every query is bound to the
token's organization and customer.
