# Sutra Public API — TypeScript client

A hand-written, dependency-free client for the Sutra Public API v1. It uses the
global `fetch`, so it runs on Node 18+, Deno, Bun, Cloudflare Workers and the
browser with no install step beyond copying `src/`.

The types and endpoint surface mirror the OpenAPI spec served at
`GET /api/public/v1/openapi.json`. A contract test
(`tests/public-api-sdk-contract.test.ts`) fails the build if this client and the
spec ever drift.

## Authentication

Mint a service-account token in the workspace **Settings → API tokens** panel.
The full secret (`sutra_pat_...`) is shown once — store it in a secret manager.
See [`docs/public-api-key-rotation.md`](../../docs/public-api-key-rotation.md)
for the rotation policy.

## Usage

```ts
import { SutraClient, SutraRateLimitError, SutraScopeError } from "@sutra/public-api-client";

const client = new SutraClient({
  baseUrl: "https://app.sutra.example/api/public/v1",
  token: process.env.SUTRA_TOKEN ?? "",
});

// Single page (cursor pagination, default limit 50, max 100).
const firstPage = await client.listFindings({ limit: 25 });
console.log(firstPage.data.length, "findings; next cursor:", firstPage.page.next);

// Iterate every page with the async iterator helper.
for await (const page of client.paginate((p) => client.listResources(p))) {
  for (const resource of page.data) console.log(resource.resourceKey, resource.service);
}

// Or collect everything at once.
const allVulns = await client.collect((p) => client.listVulnerabilities(p));

// Non-paginated reads unwrap the { data } envelope for you.
const snapshot = await client.getSnapshots();
const compliance = await client.getCompliance();

// Idempotent write: the Idempotency-Key is required and replays are safe.
try {
  const updated = await client.updateCaseStatus(
    "case_00000000000000000000000000000000",
    "investigating",
    crypto.randomUUID(), // stable per logical write; reuse to retry safely
  );
  console.log("case now", updated.status);
} catch (error) {
  if (error instanceof SutraScopeError) console.error("token missing write:cases scope");
  else if (error instanceof SutraRateLimitError) console.error("retry after", error.retryAfterSeconds, "s");
  else throw error;
}
```

## Error handling

Every non-2xx response is thrown as a typed error carrying the API's stable
`{ error: { code, message } }` envelope:

| Class | Status | Meaning |
| --- | --- | --- |
| `SutraBadRequestError` | 400 | Bad cursor/limit/body, or missing `Idempotency-Key` |
| `SutraAuthError` | 401 | Missing/unknown/revoked/expired token |
| `SutraScopeError` | 403 | Token lacks the required scope |
| `SutraRateLimitError` | 429 | Over 120 req/min; carries `retryAfterSeconds` |
| `SutraApiError` | other | Base class (404, 409, 422, 5xx …) with `status` + `code` |

## Methods

| Method | HTTP | Scope required |
| --- | --- | --- |
| `listResources` | `GET /resources` | `read:resources` |
| `listFindings` | `GET /findings` | `read:findings` |
| `listCases` | `GET /cases` | `read:cases` |
| `updateCaseStatus` | `PATCH /cases/{caseId}` | `write:cases` |
| `getSnapshots` | `GET /snapshots` | `read:snapshots` |
| `getCompliance` | `GET /compliance` | `read:compliance` |
| `listVulnerabilities` | `GET /vulnerabilities` | `read:vulnerabilities` |
