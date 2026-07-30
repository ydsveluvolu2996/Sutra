import { DspmRepository } from "../../../../db/dspm-repository";
import { getConnectionForOrg } from "../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import {
  DSPM_MAX_ASSETS,
  DSPM_MAX_BODY_BYTES,
  DSPM_SCHEMA_VERSION,
  DSPM_SOURCES,
  parseDspmPublishRequest,
} from "../../../../lib/dspm-posture";
import { assertSameOrigin, readBoundedJson } from "../../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const RUN_ID = /^dsr_[a-f0-9]{32}$/u;

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_INPUT", status: 400 });
}

async function authorizedConnection(
  request: Request,
  connectionId: string,
  capability: "connection:read" | "connection:manage",
) {
  const authenticated = await requireApiSession(request);
  const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
  if (connection === null) {
    throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 });
  }
  assertSessionCapability(authenticated, capability, connection.customerId);
  return { authenticated, connection };
}

/** Current or historical normalized data-security evidence for one connection. */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId" && key !== "runId")) {
      invalid("The DSPM query is invalid");
    }
    const connectionId = url.searchParams.get("connectionId");
    const runId = url.searchParams.get("runId");
    if (connectionId === null || !CONNECTION_ID.test(connectionId)) invalid("The connection identifier is invalid");
    if (runId !== null && !RUN_ID.test(runId)) invalid("The scan-run identifier is invalid");

    const { authenticated, connection } = await authorizedConnection(request, connectionId, "connection:read");
    const workspace = await new DspmRepository().workspace(
      { orgId: authenticated.subject.orgId, customerId: connection.customerId },
      connectionId,
      runId ?? undefined,
    );
    return jsonResponse({
      schemaVersion: DSPM_SCHEMA_VERSION,
      connection: { id: connection.id, customerId: connection.customerId, customerName: connection.customerName },
      workspace,
      privacy: {
        sensitiveValuesStored: false,
        evidence: "Classifications, category labels, control states and aggregate risk only.",
      },
      ingestion: {
        sources: DSPM_SOURCES,
        maxAssetsPerPublication: DSPM_MAX_ASSETS,
        automaticAwsMacieCollection: false,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Publish normalized evidence. Organization/customer scope is never accepted in
 * the body: org comes from the session and customer from Sutra's connection.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const authenticated = await requireApiSession(request);
    const body = await readBoundedJson(request, DSPM_MAX_BODY_BYTES);
    const parsed = parseDspmPublishRequest(body);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, parsed.connectionId);
    if (connection === null) {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 });
    }
    assertSessionCapability(authenticated, "connection:manage", connection.customerId);

    const published = await new DspmRepository().publish(
      { orgId: authenticated.subject.orgId, customerId: connection.customerId },
      parsed,
      { actorId: authenticated.subject.userId },
    );
    return jsonResponse({
      schemaVersion: DSPM_SCHEMA_VERSION,
      run: published.run,
      replayed: published.replayed,
      accepted: true,
      sensitiveValuesStored: false,
    }, { status: published.replayed ? 200 : 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
