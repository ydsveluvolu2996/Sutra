// Endpoint latency ingest — PRODUCER CONTRACT.
//
// No producer for this endpoint exists anywhere in this repository (checked:
// clients/, services/, worker/, scripts/, app/). The only in-repo consumer is
// GET /api/v1/network-exposure, which reads whatever was ingested here. So in a
// stock deployment `latency_samples` is EMPTY, the network-exposure latency
// overlay reports `latencyMeasurement.available: false`, and the UI states that
// latency was not measured. That is deliberate: absence of a measurement is
// never rendered as 0ms, a dash, or an empty "no problems" table. The endpoint
// is kept because an out-of-repo collector may legitimately post to it; this
// comment is its integration contract.
//
// Request: POST application/json
//   {
//     "connectionId": "conn_<32 lowercase hex>",   // required, must belong to the caller's org
//     "samples": [                                  // required, 1..1000 entries
//       {
//         "endpointRef": "api.example.com:443",     // required, /^[A-Za-z0-9][A-Za-z0-9 ._:@\/#+-]{0,255}$/
//         "kind": "response" | "application" | "database",  // required
//         "milliseconds": 42,                       // required, finite, 0..3600000 (rounded to an integer)
//         "observedAtMs": 1750000000000             // optional epoch ms; defaults to now, max now+5min
//       }
//     ]
//   }
// No other top-level or per-sample keys are accepted (unknown keys -> 400).
// Body is capped at 256 KiB. Response: 202 { "ingested": <rows written> }.
//
// Auth (all required; there is no API-key path):
//   - a valid Sutra session cookie with MFA satisfied (requirePilotActor);
//   - an `Origin` header matching the app's own origin, and `Sec-Fetch-Site`
//     absent / `same-origin` / `none` (assertSameOrigin);
//   - the `connection:manage` capability on the customer owning `connectionId`.
// Tenancy is derived from the session and the resolved connection — orgId and
// customerId are never accepted from the request body — and the INSERT re-gates
// on customer ownership, so a scope the org does not own writes nothing and
// returns SCOPE_NOT_FOUND rather than silently succeeding.
//
// A collector therefore has to authenticate as a workspace principal and post
// same-origin (e.g. through the app origin with a session issued to a service
// account); a bare out-of-band cron with an API key will not work as written.
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
