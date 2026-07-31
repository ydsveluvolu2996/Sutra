import {
  ScimConnectorRepository,
  validateScimRoleMappings,
  type ScimSubjectSource,
} from "../../../../db/scim-repository";
import { LocalAuthError, requireRecentMfa } from "../../../../db/auth-repository";
import {
  authorizeMembershipManagementRequest,
  isHostedOidcRuntime,
} from "../../../../lib/api-auth";
import {
  assertAuthMutation,
  authErrorResponse,
  boundedInputString,
  exactInputObject,
  readAuthJson,
} from "../../../../lib/auth-http";
import {
  hostedIdentityProviderSummaries,
  resolveHostedIdentityProviderIssuer,
} from "../../../../lib/hosted-identity-provider-directory";
import { jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const CONNECTOR_ID = /^scimc_[a-f0-9]{32}$/u;

async function requireOrgAdministrator(request: Request) {
  const authorized = await authorizeMembershipManagementRequest(request);
  if (authorized.scope.mode !== "org") {
    throw new LocalAuthError(403, "AUTHORIZATION_DENIED", "Only organization administrators can manage SCIM");
  }
  return authorized.actor.authenticated;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const authenticated = await requireOrgAdministrator(request);
    return jsonResponse(
      {
        connectors: await new ScimConnectorRepository().list(authenticated.subject.orgId),
        identityProviders: isHostedOidcRuntime()
          ? hostedIdentityProviderSummaries(request)
          : [],
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertAuthMutation(request);
    const authenticated = await requireOrgAdministrator(request);
    requireRecentMfa(authenticated);
    const body = exactInputObject(
      await readAuthJson(request, 16 * 1024),
      ["name", "identityProvider", "subjectSource"],
      ["roleMappings", "expiresAt"],
    );
    const subjectSource = boundedInputString(
      body.subjectSource,
      { label: "SCIM subject source", maximum: 32 },
    ) as ScimSubjectSource;
    const expiresAt =
      body.expiresAt === undefined || body.expiresAt === null
        ? null
        : boundedInputString(body.expiresAt, { label: "SCIM token expiry", maximum: 64 });
    const repository = new ScimConnectorRepository();
    const minted = await repository.mint({
      orgId: authenticated.subject.orgId,
      actorId: authenticated.subject.userId,
      name: boundedInputString(body.name, { label: "SCIM connector name", maximum: 64 }),
      identityIssuer: resolveHostedIdentityProviderIssuer(request, body.identityProvider),
      subjectSource,
      roleMappings: validateScimRoleMappings(body.roleMappings),
      expiresAt,
    });
    return jsonResponse(
      { minted, connectors: await repository.list(authenticated.subject.orgId) },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    assertAuthMutation(request);
    const authenticated = await requireOrgAdministrator(request);
    requireRecentMfa(authenticated);
    const body = exactInputObject(await readAuthJson(request, 1024), ["connectorId", "operation"]);
    const connectorId = boundedInputString(body.connectorId, { label: "SCIM connector identifier", maximum: 64 });
    const operation = boundedInputString(body.operation, { label: "SCIM connector operation", maximum: 32 });
    if (!CONNECTOR_ID.test(connectorId) || operation !== "rotate") {
      throw new LocalAuthError(400, "INVALID_INPUT", "The SCIM connector rotation request is invalid");
    }
    const repository = new ScimConnectorRepository();
    const minted = await repository.rotate(
      authenticated.subject.orgId,
      authenticated.subject.userId,
      connectorId,
    );
    return jsonResponse(
      { minted, connectors: await repository.list(authenticated.subject.orgId) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertAuthMutation(request);
    const authenticated = await requireOrgAdministrator(request);
    requireRecentMfa(authenticated);
    const body = exactInputObject(await readAuthJson(request, 1024), ["connectorId"]);
    const connectorId = boundedInputString(body.connectorId, { label: "SCIM connector identifier", maximum: 64 });
    if (!CONNECTOR_ID.test(connectorId)) {
      throw new LocalAuthError(400, "INVALID_INPUT", "The SCIM connector revocation request is invalid");
    }
    const repository = new ScimConnectorRepository();
    const revoked = await repository.revoke(
      authenticated.subject.orgId,
      authenticated.subject.userId,
      connectorId,
    );
    return jsonResponse({
      revoked,
      connectors: await repository.list(authenticated.subject.orgId),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return authErrorResponse(error);
  }
}
