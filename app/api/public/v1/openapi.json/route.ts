export const dynamic = "force-dynamic";

// Hand-maintained spec for the v1 surface. Kept deliberately small and exact:
// every path listed here exists, and nothing exists that is not listed. The
// component schemas mirror the real handler outputs field-for-field — when a
// handler's response shape changes, this spec must change with it.
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
    responses: {
      BadRequest: { description: "Malformed request (bad cursor, limit, body or missing Idempotency-Key)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      Unauthorized: { description: "Missing or invalid service-account token", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      Forbidden: { description: "The token lacks the required scope", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      NotFound: { description: "No cloud connection (or target case) is available to this token", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      RateLimited: { description: "The token exceeded 120 requests in the current minute", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: { type: "string", description: "Stable machine-readable error code" },
              message: { type: "string", description: "Human-readable explanation" },
            },
          },
        },
      },
      PageInfo: {
        type: "object",
        required: ["next"],
        properties: {
          next: { type: "string", nullable: true, description: "Opaque cursor for the next page, or null when the last page is reached" },
        },
      },
      Resource: {
        type: "object",
        required: ["resourceKey", "service", "resourceType", "region", "name", "state", "arn", "nativeId", "tags"],
        properties: {
          resourceKey: { type: "string" },
          service: { type: "string" },
          resourceType: { type: "string" },
          region: { type: "string" },
          name: { type: "string", nullable: true },
          state: { type: "string" },
          arn: { type: "string", nullable: true },
          nativeId: { type: "string" },
          tags: { type: "object", additionalProperties: { type: "string" } },
        },
      },
      Finding: {
        type: "object",
        required: ["fingerprint", "resourceKey", "controlKey", "controlVersion", "severity", "status", "title", "summary", "remediation", "evidence", "evaluatedAt"],
        properties: {
          fingerprint: { type: "string" },
          resourceKey: { type: "string", nullable: true },
          controlKey: { type: "string" },
          controlVersion: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "informational"] },
          status: { type: "string", enum: ["open", "acknowledged", "resolved", "suppressed"] },
          title: { type: "string" },
          summary: { type: "string" },
          remediation: { type: "string" },
          evidence: { type: "object", additionalProperties: true },
          evaluatedAt: { type: "string", format: "date-time" },
        },
      },
      CaseAssignee: {
        type: "object",
        required: ["membershipId", "userId", "displayName", "email", "role"],
        properties: {
          membershipId: { type: "string" },
          userId: { type: "string" },
          displayName: { type: "string" },
          email: { type: "string" },
          role: { type: "string" },
        },
      },
      CaseActivity: {
        type: "object",
        required: ["id", "caseId", "kind", "actorId", "actorName", "occurredAt", "detail", "previousHash", "eventHash"],
        properties: {
          id: { type: "string" },
          caseId: { type: "string" },
          kind: { type: "string", enum: ["created", "status_changed", "assignment_changed", "priority_changed", "due_date_changed", "note_added"] },
          actorId: { type: "string" },
          actorName: { type: "string" },
          occurredAt: { type: "string", format: "date-time" },
          detail: { type: "object", additionalProperties: { type: "string", nullable: true } },
          previousHash: { type: "string", nullable: true },
          eventHash: { type: "string" },
        },
      },
      Case: {
        type: "object",
        required: [
          "id", "caseNumber", "orgId", "customerId", "connectionId", "findingFingerprint",
          "findingSnapshotId", "findingSeverity", "title", "status", "priority", "assignee",
          "dueAt", "resolvedAt", "closedAt", "createdAt", "updatedAt", "slaState", "activities",
        ],
        properties: {
          id: { type: "string" },
          caseNumber: { type: "string" },
          orgId: { type: "string" },
          customerId: { type: "string" },
          connectionId: { type: "string" },
          findingFingerprint: { type: "string" },
          findingSnapshotId: { type: "string" },
          findingSeverity: { type: "string" },
          title: { type: "string" },
          status: { type: "string", enum: ["open", "investigating", "resolved", "closed"] },
          priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
          assignee: { nullable: true, allOf: [{ $ref: "#/components/schemas/CaseAssignee" }] },
          dueAt: { type: "string", format: "date-time" },
          resolvedAt: { type: "string", format: "date-time", nullable: true },
          closedAt: { type: "string", format: "date-time", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          slaState: { type: "string", enum: ["on_track", "due_soon", "overdue", "met", "missed"] },
          activities: { type: "array", items: { $ref: "#/components/schemas/CaseActivity" } },
        },
      },
      CoverageEntry: {
        type: "object",
        required: ["collectorKey", "region", "status", "itemsObserved", "pagesObserved"],
        properties: {
          collectorKey: { type: "string" },
          region: { type: "string" },
          status: { type: "string", enum: ["succeeded", "partial", "failed", "skipped"] },
          itemsObserved: { type: "integer" },
          pagesObserved: { type: "integer" },
          errorCode: { type: "string" },
          message: { type: "string" },
        },
      },
      SyncRun: {
        type: "object",
        required: ["id", "connectionId", "status", "coverageState", "totals", "startedAt", "finishedAt", "createdAt"],
        properties: {
          id: { type: "string" },
          connectionId: { type: "string" },
          status: { type: "string", enum: ["queued", "running", "partial", "succeeded", "failed", "cancelled"] },
          coverageState: { type: "string", enum: ["complete", "partial", "unknown"] },
          totals: { type: "object", additionalProperties: true },
          startedAt: { type: "string", format: "date-time", nullable: true },
          finishedAt: { type: "string", format: "date-time", nullable: true },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      ActiveSnapshot: {
        type: "object",
        required: ["id", "collectedAt", "coverageState", "snapshotSha256", "origin"],
        properties: {
          id: { type: "string" },
          collectedAt: { type: "string", format: "date-time" },
          coverageState: { type: "string", enum: ["complete", "partial"] },
          snapshotSha256: { type: "string" },
          origin: {
            type: "object",
            required: ["kind", "fixtureId", "fixtureVersion"],
            properties: {
              kind: { type: "string", enum: ["unknown", "simulated_fixture", "aws_sandbox"] },
              fixtureId: { type: "string", nullable: true },
              fixtureVersion: { type: "string", nullable: true },
            },
          },
        },
      },
      SnapshotStatus: {
        type: "object",
        required: ["activeSnapshot", "coverage", "syncRuns"],
        properties: {
          activeSnapshot: { nullable: true, allOf: [{ $ref: "#/components/schemas/ActiveSnapshot" }] },
          coverage: { type: "array", items: { $ref: "#/components/schemas/CoverageEntry" } },
          syncRuns: { type: "array", items: { $ref: "#/components/schemas/SyncRun" } },
        },
      },
      ReadinessScope: {
        type: "object",
        required: ["tenantId", "collectionId", "collectedAt"],
        properties: {
          tenantId: { type: "string", nullable: true },
          collectionId: { type: "string", nullable: true },
          collectedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
      ReadinessStateCounts: {
        type: "object",
        required: ["PASS", "FAIL", "UNKNOWN", "NOT_COLLECTED"],
        properties: {
          PASS: { type: "integer" },
          FAIL: { type: "integer" },
          UNKNOWN: { type: "integer" },
          NOT_COLLECTED: { type: "integer" },
        },
      },
      FrameworkSummary: {
        type: "object",
        required: ["id", "title", "summary", "disclaimer"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          summary: { $ref: "#/components/schemas/ReadinessStateCounts" },
          disclaimer: { type: "string" },
        },
      },
      ComplianceReport: {
        type: "object",
        required: ["scope", "frameworks"],
        properties: {
          scope: { $ref: "#/components/schemas/ReadinessScope" },
          frameworks: { type: "array", items: { $ref: "#/components/schemas/FrameworkSummary" } },
        },
      },
      Vulnerability: {
        type: "object",
        required: [
          "id", "findingKey", "resourceKey", "resourceKind", "cveId", "packageName",
          "installedVersion", "fixedVersion", "severity", "cvssScore", "source",
          "status", "firstSeenMs", "lastSeenMs",
        ],
        properties: {
          id: { type: "string" },
          findingKey: { type: "string" },
          resourceKey: { type: "string" },
          resourceKind: { type: "string" },
          cveId: { type: "string", nullable: true },
          packageName: { type: "string", nullable: true },
          installedVersion: { type: "string", nullable: true },
          fixedVersion: { type: "string", nullable: true },
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "unknown"] },
          cvssScore: { type: "number", nullable: true },
          source: { type: "string" },
          status: { type: "string", enum: ["open", "resolved"] },
          firstSeenMs: { type: "integer", format: "int64" },
          lastSeenMs: { type: "integer", format: "int64" },
        },
      },
      ResourceList: {
        type: "object",
        required: ["data", "page"],
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/Resource" } },
          page: { $ref: "#/components/schemas/PageInfo" },
        },
      },
      FindingList: {
        type: "object",
        required: ["data", "page"],
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/Finding" } },
          page: { $ref: "#/components/schemas/PageInfo" },
        },
      },
      CaseList: {
        type: "object",
        required: ["data", "page"],
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/Case" } },
          page: { $ref: "#/components/schemas/PageInfo" },
        },
      },
      VulnerabilityList: {
        type: "object",
        required: ["data", "page"],
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/Vulnerability" } },
          page: { $ref: "#/components/schemas/PageInfo" },
        },
      },
      CaseResponse: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/Case" } },
      },
      SnapshotResponse: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/SnapshotStatus" } },
      },
      ComplianceResponse: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/ComplianceReport" } },
      },
    },
  },
  security: [{ bearerToken: [] }],
  paths: {
    "/resources": { get: { summary: "List normalized resources from the published snapshot", parameters: [{ $ref: "#/components/parameters/cursor" }, { $ref: "#/components/parameters/limit" }], responses: { "200": { description: "Paged resources", content: { "application/json": { schema: { $ref: "#/components/schemas/ResourceList" } } } }, "400": { $ref: "#/components/responses/BadRequest" }, "401": { $ref: "#/components/responses/Unauthorized" }, "403": { $ref: "#/components/responses/Forbidden" }, "404": { $ref: "#/components/responses/NotFound" }, "429": { $ref: "#/components/responses/RateLimited" } } } },
    "/findings": { get: { summary: "List posture findings from the published snapshot", parameters: [{ $ref: "#/components/parameters/cursor" }, { $ref: "#/components/parameters/limit" }], responses: { "200": { description: "Paged findings", content: { "application/json": { schema: { $ref: "#/components/schemas/FindingList" } } } }, "400": { $ref: "#/components/responses/BadRequest" }, "401": { $ref: "#/components/responses/Unauthorized" }, "403": { $ref: "#/components/responses/Forbidden" }, "404": { $ref: "#/components/responses/NotFound" }, "429": { $ref: "#/components/responses/RateLimited" } } } },
    "/cases": { get: { summary: "List finding cases", parameters: [{ $ref: "#/components/parameters/cursor" }, { $ref: "#/components/parameters/limit" }], responses: { "200": { description: "Paged cases", content: { "application/json": { schema: { $ref: "#/components/schemas/CaseList" } } } }, "400": { $ref: "#/components/responses/BadRequest" }, "401": { $ref: "#/components/responses/Unauthorized" }, "403": { $ref: "#/components/responses/Forbidden" }, "404": { $ref: "#/components/responses/NotFound" }, "429": { $ref: "#/components/responses/RateLimited" } } } },
    "/cases/{caseId}": { patch: { summary: "Transition a case's status (idempotent)", parameters: [{ name: "caseId", in: "path", required: true, schema: { type: "string" } }, { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["open", "investigating", "resolved", "accepted_risk"] } } } } } }, responses: { "200": { description: "Updated case", content: { "application/json": { schema: { $ref: "#/components/schemas/CaseResponse" } } } }, "400": { $ref: "#/components/responses/BadRequest" }, "401": { $ref: "#/components/responses/Unauthorized" }, "403": { $ref: "#/components/responses/Forbidden" }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "Idempotency-Key reused with a different request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }, "422": { description: "Invalid status transition", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }, "429": { $ref: "#/components/responses/RateLimited" } } } },
    "/snapshots": { get: { summary: "Active snapshot metadata, coverage and recent runs", responses: { "200": { description: "Snapshot status", content: { "application/json": { schema: { $ref: "#/components/schemas/SnapshotResponse" } } } }, "401": { $ref: "#/components/responses/Unauthorized" }, "403": { $ref: "#/components/responses/Forbidden" }, "404": { $ref: "#/components/responses/NotFound" }, "429": { $ref: "#/components/responses/RateLimited" } } } },
    "/compliance": { get: { summary: "Per-framework readiness summaries", responses: { "200": { description: "Framework summaries with disclaimers", content: { "application/json": { schema: { $ref: "#/components/schemas/ComplianceResponse" } } } }, "401": { $ref: "#/components/responses/Unauthorized" }, "403": { $ref: "#/components/responses/Forbidden" }, "404": { $ref: "#/components/responses/NotFound" }, "429": { $ref: "#/components/responses/RateLimited" } } } },
    "/vulnerabilities": { get: { summary: "List cloud vulnerability findings", parameters: [{ $ref: "#/components/parameters/cursor" }, { $ref: "#/components/parameters/limit" }], responses: { "200": { description: "Paged vulnerability findings", content: { "application/json": { schema: { $ref: "#/components/schemas/VulnerabilityList" } } } }, "400": { $ref: "#/components/responses/BadRequest" }, "401": { $ref: "#/components/responses/Unauthorized" }, "403": { $ref: "#/components/responses/Forbidden" }, "404": { $ref: "#/components/responses/NotFound" }, "429": { $ref: "#/components/responses/RateLimited" } } } },
  },
} as const;

export function GET(): Response {
  return new Response(JSON.stringify(SPEC, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
