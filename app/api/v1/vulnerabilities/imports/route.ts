// Operator-facing ingest for third-party vulnerability scanner exports. ONE route
// with a discriminated `source` field covers every importer, because they all end in
// the same two already-normalized stores the unified KEV/EPSS/SLA queue reads:
//   qualys | rapid7 | grype | osv -> cloud_vulnerability_findings   (source-scoped replace)
//   registry (`trivy image`)      -> registry_vulnerability_findings (image-scoped replace)
// GET /api/v1/cloud/vulnerabilities then composes both into the ranked queue, so an
// import needs no new table, no migration, and no new read path.
//
// This is attack surface, so the tenant is resolved server-side ONLY: the session
// gives the org, the connection row gives the customer, and a WRITE capability is
// asserted against that customer before anything is stored. The accepted body has no
// org/customer/tenant field at all — parseVulnerabilityImportBody rejects any
// unexpected key — so a caller cannot even propose the tenant its rows land in.
//
// The payload is operator-supplied and bounded; there is deliberately NO "fetch the
// report from this URL" mode, so the route cannot be turned into an SSRF probe.
// Nothing from the report is logged, and only structured, scrubbed reject locators
// are echoed back.
import { CloudVulnerabilityRepository } from "../../../../../db/cloud-vulnerability-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { RegistryVulnerabilityRepository } from "../../../../../db/registry-vulnerability-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { authorize } from "../../../../../lib/auth-policy";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";
import {
  MAX_VULNERABILITY_IMPORT_BYTES,
  MAX_VULNERABILITY_IMPORT_FINDINGS,
  VULNERABILITY_IMPORT_OPERATION,
  VULNERABILITY_IMPORT_SOURCES,
  disclosedRejects,
  normalizeVulnerabilityImport,
  parseVulnerabilityImportBody,
} from "../../../../../lib/vulnerability-import";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_INPUT", status: 400 });
}

type ImportSession = Awaited<ReturnType<typeof requireApiSession>>;

// The tenant scope is derived here and nowhere else: org from the session subject,
// customer from the connection row that org actually owns.
async function authorizedScope(
  authenticated: ImportSession,
  connectionId: string,
  capability: "connection:read" | "connection:manage",
) {
  const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
  if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 });
  assertSessionCapability(authenticated, capability, connection.customerId);
  return {
    connection,
    scope: { orgId: authenticated.subject.orgId, customerId: connection.customerId },
  };
}

/** The import contract an operator UI needs: accepted sources, hard limits, permission. */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId")) invalid("The import query is invalid");
    const connectionId = url.searchParams.get("connectionId");
    if (connectionId === null || !CONNECTION_ID.test(connectionId)) invalid("The connection identifier is invalid");
    const authenticated = await requireApiSession(request);
    const { connection } = await authorizedScope(authenticated, connectionId, "connection:read");
    return jsonResponse({
      schemaVersion: "sutra.vulnerability-import.v1",
      operation: VULNERABILITY_IMPORT_OPERATION,
      sources: VULNERABILITY_IMPORT_SOURCES,
      limits: {
        maxBodyBytes: MAX_VULNERABILITY_IMPORT_BYTES,
        maxFindings: MAX_VULNERABILITY_IMPORT_FINDINGS,
      },
      permissions: {
        canImport: authorize(authenticated.subject, {
          orgId: authenticated.subject.orgId,
          capability: "connection:manage",
          customerId: connection.customerId,
        }).allowed,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    // Authenticate before the body is read at all, so an unauthenticated caller
    // never gets a parse performed on its behalf.
    const authenticated = await requireApiSession(request);
    const raw = await readBoundedJson(request, MAX_VULNERABILITY_IMPORT_BYTES);
    const parsed = parseVulnerabilityImportBody(raw);
    const { scope } = await authorizedScope(authenticated, parsed.connectionId, "connection:manage");

    const normalized = normalizeVulnerabilityImport(parsed);
    const collectedAtMs = Date.now();
    const imported = normalized.target === "registry"
      ? await new RegistryVulnerabilityRepository().replaceForImage(
        scope,
        parsed.connectionId,
        normalized.resourceKey,
        normalized.findings,
        collectedAtMs,
      )
      : await new CloudVulnerabilityRepository().replaceForSource(
        scope,
        parsed.connectionId,
        normalized.source,
        normalized.findings,
        collectedAtMs,
      );

    return jsonResponse({
      source: normalized.source,
      target: normalized.target,
      imported,
      // Rejected records are disclosed, never silently dropped: kind + a scrubbed,
      // bounded locator so the operator can fix the export.
      rejected: disclosedRejects(normalized.rejects),
      rejectedCount: normalized.rejects.length,
      coverage: normalized.coverage,
      disclaimer: normalized.disclaimer,
    }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
