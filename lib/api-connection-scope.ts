import { getConnectionForOrg } from "../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "./api-auth";
import type { Capability } from "./auth-policy";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

function invalidConnectionScope(): never {
  throw Object.assign(
    new Error("A valid connectionId is required for this customer-scoped request"),
    { code: "INVALID_INPUT" },
  );
}

/**
 * Resolve a customer-scoped API request from an explicit connectionId.
 *
 * Customer-scoped routes must never infer a customer from whichever connection
 * was created most recently. The selected connection is validated, resolved
 * inside the authenticated organization, and authorized against its customer.
 */
export async function requireConnectionScope(
  request: Request,
  capabilities: Capability | readonly Capability[],
) {
  const connectionId = new URL(request.url).searchParams.get("connectionId");
  if (connectionId === null || !CONNECTION_ID.test(connectionId)) {
    invalidConnectionScope();
  }

  const authenticated = await requireApiSession(request);
  const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
  if (connection === null) {
    throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
  }

  for (const capability of Array.isArray(capabilities) ? capabilities : [capabilities]) {
    assertSessionCapability(authenticated, capability, connection.customerId);
  }

  return {
    authenticated,
    connection,
    scope: {
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
    },
  };
}
