export const dynamic = "force-dynamic";

// Hand-maintained spec for the v1 surface. Kept deliberately small and exact:
// every path listed here exists, and nothing exists that is not listed.
const SPEC = {
  openapi: "3.0.3",
  info: {
    title: "Sutra Public API",
    version: "1.0.0",
    description:
      "Tenant-scoped read access to the Sutra workspace plus case-status writes. " +
      "Authenticate with a service-account token (Authorization: Bearer sutra_pat_...). " +
      "Reads are cursor-paginated ({ data, page: { next } }); writes require an Idempotency-Key header. " +
      "Rate limit: 120 requests per minute per token.",
  },
  servers: [{ url: "/api/public/v1" }],
  components: {
    securitySchemes: { bearerToken: { type: "http", scheme: "bearer" } },
    parameters: {
      cursor: { name: "cursor", in: "query", required: false, schema: { type: "string" }, description: "Opaque cursor from page.next" },
      limit: { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } },
    },
  },
  security: [{ bearerToken: [] }],
  paths: {
    "/resources": { get: { summary: "List normalized resources from the published snapshot", parameters: [{ $ref: "#/components/parameters/cursor" }, { $ref: "#/components/parameters/limit" }], responses: { "200": { description: "Paged resources" } } } },
    "/findings": { get: { summary: "List posture findings from the published snapshot", parameters: [{ $ref: "#/components/parameters/cursor" }, { $ref: "#/components/parameters/limit" }], responses: { "200": { description: "Paged findings" } } } },
    "/cases": { get: { summary: "List finding cases", parameters: [{ $ref: "#/components/parameters/cursor" }, { $ref: "#/components/parameters/limit" }], responses: { "200": { description: "Paged cases" } } } },
    "/cases/{caseId}": { patch: { summary: "Transition a case's status (idempotent)", parameters: [{ name: "caseId", in: "path", required: true, schema: { type: "string" } }, { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["open", "investigating", "resolved", "accepted_risk"] } } } } } }, responses: { "200": { description: "Updated case" }, "409": { description: "Idempotency-Key reused with a different request" }, "422": { description: "Invalid status transition" } } } },
    "/snapshots": { get: { summary: "Active snapshot metadata, coverage and recent runs", responses: { "200": { description: "Snapshot status" } } } },
    "/compliance": { get: { summary: "Per-framework readiness summaries", responses: { "200": { description: "Framework summaries with disclaimers" } } } },
    "/vulnerabilities": { get: { summary: "List cloud vulnerability findings", parameters: [{ $ref: "#/components/parameters/cursor" }, { $ref: "#/components/parameters/limit" }], responses: { "200": { description: "Paged vulnerability findings" } } } },
  },
} as const;

export function GET(): Response {
  return new Response(JSON.stringify(SPEC, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
