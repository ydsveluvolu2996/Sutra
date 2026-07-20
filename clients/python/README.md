# Sutra Public API — Python client

A hand-written client for the Sutra Public API v1 that uses **only the Python
standard library** (`urllib`) — no third-party dependencies. Requires Python
3.8+ (for `typing.TypedDict` / `Literal`).

> Prefer `requests`? The HTTP surface lives entirely in `SutraClient._request`;
> swapping it for `requests.request(...)` is a few lines. Stdlib is the default
> so the client installs with zero dependencies.

The typed payloads (`sutra/types.py`) and endpoint surface mirror the OpenAPI
spec at `GET /api/public/v1/openapi.json`. The contract test
`tests/public-api-sdk-contract.test.ts` fails the build if this client and the
spec ever drift.

## Authentication

Mint a service-account token in the workspace **Settings → API tokens** panel.
The full secret (`sutra_pat_...`) is shown once — store it in a secret manager.
See [`docs/public-api-key-rotation.md`](../../docs/public-api-key-rotation.md)
for the rotation policy.

## Usage

```python
import os
import uuid

from sutra import SutraClient, SutraRateLimitError, SutraScopeError

client = SutraClient(
    base_url="https://app.sutra.example/api/public/v1",
    token=os.environ["SUTRA_TOKEN"],
)

# Single page (cursor pagination, default limit 50, max 100).
first = client.list_findings(limit=25)
print(len(first["data"]), "findings; next cursor:", first["page"]["next"])

# Iterate every page with the generator helper.
for page in client.paginate(lambda c: client.list_resources(cursor=c)):
    for resource in page["data"]:
        print(resource["resourceKey"], resource["service"])

# Or collect everything at once.
all_vulns = client.collect(lambda c: client.list_vulnerabilities(cursor=c))

# Non-paginated reads unwrap the {"data": ...} envelope for you.
snapshot = client.get_snapshots()
compliance = client.get_compliance()

# Idempotent write: the Idempotency-Key is required and replays are safe.
try:
    updated = client.update_case_status(
        "case_00000000000000000000000000000000",
        "investigating",
        idempotency_key=str(uuid.uuid4()),  # reuse to retry the same write safely
    )
    print("case now", updated["status"])
except SutraScopeError:
    print("token missing write:cases scope")
except SutraRateLimitError as error:
    print("retry after", error.retry_after_seconds, "s")
```

## Error handling

Every non-2xx response is raised as a typed exception carrying the API's stable
`{"error": {"code", "message"}}` envelope:

| Class | Status | Meaning |
| --- | --- | --- |
| `SutraBadRequestError` | 400 | Bad cursor/limit/body, or missing `Idempotency-Key` |
| `SutraAuthError` | 401 | Missing/unknown/revoked/expired token |
| `SutraScopeError` | 403 | Token lacks the required scope |
| `SutraRateLimitError` | 429 | Over 120 req/min; carries `retry_after_seconds` |
| `SutraApiError` | other | Base class (404, 409, 422, 5xx …) with `.status` + `.code` |

## Methods

| Method | HTTP | Scope required |
| --- | --- | --- |
| `list_resources` | `GET /resources` | `read:resources` |
| `list_findings` | `GET /findings` | `read:findings` |
| `list_cases` | `GET /cases` | `read:cases` |
| `update_case_status` | `PATCH /cases/{caseId}` | `write:cases` |
| `get_snapshots` | `GET /snapshots` | `read:snapshots` |
| `get_compliance` | `GET /compliance` | `read:compliance` |
| `list_vulnerabilities` | `GET /vulnerabilities` | `read:vulnerabilities` |
