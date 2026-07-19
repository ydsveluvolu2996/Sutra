import { getConnectionForOrg } from "../../../../db/pilot-repository";
import { LatencySampleRepository, type LatencySampleInput } from "../../../../db/latency-sample-repository";
import { assertSessionCapability } from "../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../lib/aws-pilot-security";
import { LATENCY_KINDS } from "../../../../lib/reachability-latency";
import { errorResponse, jsonResponse, requirePilotActor } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const KINDS = new Set<string>(LATENCY_KINDS);

function invalid(): never {
  throw Object.assign(new Error("The latency sample request is invalid"), { code: "INVALID_INPUT", status: 400 });
}

function parseSamples(value: unknown): LatencySampleInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) invalid();
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) invalid();
    const record = entry as Record<string, unknown>;
    const allowed = ["endpointRef", "kind", "milliseconds", "observedAtMs"];
    if (Object.keys(record).some((key) => !allowed.includes(key))) invalid();
    if (
      typeof record.endpointRef !== "string" ||
      typeof record.kind !== "string" || !KINDS.has(record.kind) ||
      typeof record.milliseconds !== "number" ||
      (record.observedAtMs !== undefined && typeof record.observedAtMs !== "number")
    ) invalid();
    return {
      endpointRef: record.endpointRef,
      kind: record.kind as LatencySampleInput["kind"],
      milliseconds: record.milliseconds,
      ...(record.observedAtMs === undefined ? {} : { observedAtMs: record.observedAtMs }),
    };
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const actor = await requirePilotActor(request, "workspace:read");
    const body = await readBoundedJson(request, 256 * 1024);
    if (typeof body !== "object" || body === null || Array.isArray(body)) invalid();
    const record = body as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["connectionId", "samples"].includes(key))) invalid();
    const connectionId = record.connectionId;
    if (typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId)) invalid();

    const connection = await getConnectionForOrg(actor.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(actor.authenticated, "connection:manage", connection.customerId);

    const samples = parseSamples(record.samples);
    const written = await new LatencySampleRepository().ingest(
      { orgId: actor.orgId, customerId: connection.customerId },
      connectionId,
      samples,
    );
    return jsonResponse({ ingested: written }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
