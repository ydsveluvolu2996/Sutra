import { getConnection, setFindingWorkflowStatus } from "../../../../../db/pilot-repository";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse, requirePilotActor } from "../../../../../lib/pilot-server";
import { assertSessionCapability } from "../../../../../lib/api-auth";

export const dynamic = "force-dynamic";

function parseBody(value: unknown): {
  connectionId: string;
  fingerprint: string;
  status: "open" | "acknowledged" | "suppressed";
  note: string | null;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw Object.assign(new Error("The finding workflow request is invalid"), { code: "INVALID_INPUT" });
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["connectionId", "fingerprint", "status", "note"]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || !["connectionId", "fingerprint", "status"].every((key) => key in record)) {
    throw Object.assign(new Error("The finding workflow request contains unsupported fields"), { code: "INVALID_INPUT" });
  }
  if (typeof record.connectionId !== "string" || !/^conn_[a-f0-9]{32}$/u.test(record.connectionId)) {
    throw Object.assign(new Error("The connection identifier is invalid"), { code: "INVALID_INPUT" });
  }
  if (typeof record.fingerprint !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/#+=-]{0,127}$/u.test(record.fingerprint)) {
    throw Object.assign(new Error("The finding fingerprint is invalid"), { code: "INVALID_INPUT" });
  }
  if (record.status !== "open" && record.status !== "acknowledged" && record.status !== "suppressed") {
    throw Object.assign(new Error("The finding status is invalid"), { code: "INVALID_INPUT" });
  }
  if (record.note !== undefined && record.note !== null && typeof record.note !== "string") {
    throw Object.assign(new Error("The finding note is invalid"), { code: "INVALID_INPUT" });
  }
  const note = typeof record.note === "string" ? record.note.trim() : null;
  if (note !== null && (note.length > 500 || /[\u0000-\u001f\u007f]/u.test(note))) {
    throw Object.assign(new Error("The finding note must be 500 characters or fewer"), { code: "INVALID_INPUT" });
  }
  return { connectionId: record.connectionId, fingerprint: record.fingerprint, status: record.status, note };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requirePilotActor(request, "workspace:read");
    assertSameOrigin(request);
    const body = parseBody(await readBoundedJson(request));
    // Workflow authorization needs only tenant-scoped connection metadata. It
    // must not load AWS trust ciphertext, and simulated connections do not have
    // such a secret by design.
    const connection = await getConnection(body.connectionId);
    if (connection === null) {
      throw Object.assign(new Error("AWS connection not found"), { code: "NOT_FOUND" });
    }
    assertSessionCapability(actor.authenticated, "finding:manage", connection.customerId);
    await setFindingWorkflowStatus(body.connectionId, body.fingerprint, body.status, body.note, actor.id);
    return jsonResponse({ updated: true, fingerprint: body.fingerprint, status: body.status });
  } catch (error) {
    return errorResponse(error);
  }
}
