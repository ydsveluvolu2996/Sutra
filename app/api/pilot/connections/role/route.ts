import {
  getStoredConnectionSecret,
  LOCAL_ORG_ID,
  setConnectionRole,
} from "../../../../../db/pilot-repository";
import {
  assertSameOrigin,
  decryptExternalId,
  parseIamRoleArn,
  readBoundedJson,
} from "../../../../../lib/aws-pilot-security";
import {
  errorResponse,
  getPilotSecrets,
  jsonResponse,
  registerCollectorConnection,
  requirePilotActor,
} from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

function parseBody(value: unknown): { connectionId: string; roleArn: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw Object.assign(new Error("The role request is invalid"), { code: "INVALID_INPUT" });
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 2 || !("connectionId" in body) || !("roleArn" in body)) {
    throw Object.assign(new Error("The role request contains missing or unsupported fields"), { code: "INVALID_INPUT" });
  }
  if (typeof body.connectionId !== "string" || !/^conn_[a-f0-9]{32}$/u.test(body.connectionId)) {
    throw Object.assign(new Error("The connection identifier is invalid"), { code: "INVALID_INPUT" });
  }
  if (typeof body.roleArn !== "string") {
    throw Object.assign(new Error("The IAM role ARN is invalid"), { code: "INVALID_INPUT" });
  }
  return { connectionId: body.connectionId, roleArn: body.roleArn };
}
export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requirePilotActor(request);
    assertSameOrigin(request);
    const body = parseBody(await readBoundedJson(request));
    const stored = await getStoredConnectionSecret(body.connectionId);
    const role = parseIamRoleArn(body.roleArn, {
      accountId: stored.accountId,
      partition: stored.partition,
    });
    const secrets = getPilotSecrets();
    const externalId = await decryptExternalId(
      { ciphertext: stored.externalIdCiphertext, keyVersion: stored.externalIdKeyVersion },
      secrets.connectionEncryptionKey,
      { orgId: LOCAL_ORG_ID, customerId: stored.customerId, connectionId: stored.connectionId },
    );
    await registerCollectorConnection({
      tenantId: LOCAL_ORG_ID,
      connectionId: stored.connectionId,
      accountId: stored.accountId,
      partition: stored.partition,
      roleArn: role.arn,
      externalId,
      enabledRegions: stored.enabledRegions,
    });
    const connection = await setConnectionRole(stored.connectionId, role.arn, actor.id);
    return jsonResponse({ connection, registered: true });
  } catch (error) {
    return errorResponse(error);
  }
}
