import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { errorResponse, requirePilotActor } from "../../../../../lib/pilot-server";
import { assertSessionCapability } from "../../../../../lib/api-auth";

export const dynamic = "force-dynamic";

function connectionIdFrom(value: unknown): string {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).length !== 1 || !("connectionId" in value) ||
    typeof (value as { connectionId?: unknown }).connectionId !== "string" ||
    !/^conn_[a-f0-9]{32}$/u.test((value as { connectionId: string }).connectionId)
  ) {
    throw Object.assign(new Error("The ExternalId rotation request is invalid"), { code: "INVALID_INPUT" });
  }
  return (value as { connectionId: string }).connectionId;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requirePilotActor(request, "workspace:read");
    assertSameOrigin(request);
    const connectionId = connectionIdFrom(await readBoundedJson(request));
    const current = await getConnectionForOrg(actor.orgId, connectionId);
    if (current === null) {
      throw Object.assign(new Error("AWS connection not found"), { code: "NOT_FOUND" });
    }
    assertSessionCapability(actor.authenticated, "connection:manage", current.customerId);
    throw Object.assign(
      new Error(
        "ExternalId rotation is disabled until Sutra can verify a two-phase customer trust-policy change without interrupting or widening AWS access",
      ),
      { code: "INVALID_STATE" },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
