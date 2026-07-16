import {
  getStoredConnectionSecret,
  LOCAL_ORG_ID,
  markConnectionNeedsAttention,
  markConnectionValidated,
  markConnectionValidating,
} from "../../../../../db/pilot-repository";
import { assertSameOrigin, decryptExternalId, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import {
  activateCollectorConnection,
  errorResponse,
  getCollectorHealth,
  getPilotSecrets,
  jsonResponse,
  registerCollectorConnection,
  requirePilotActor,
  safeValidationFailureCode,
  verifyCollectorConnection,
} from "../../../../../lib/pilot-server";
import { assertSessionCapability } from "../../../../../lib/api-auth";

export const dynamic = "force-dynamic";

function connectionIdFrom(value: unknown): string {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).length !== 1 || !("connectionId" in value) ||
    typeof (value as { connectionId?: unknown }).connectionId !== "string" ||
    !/^conn_[a-f0-9]{32}$/u.test((value as { connectionId: string }).connectionId)
  ) {
    throw Object.assign(new Error("The validation request is invalid"), { code: "INVALID_INPUT" });
  }
  return (value as { connectionId: string }).connectionId;
}

export async function POST(request: Request): Promise<Response> {
  let connectionId: string | null = null;
  let actorId: string | null = null;
  let validationClaimed = false;
  try {
    const actor = await requirePilotActor(request, "workspace:read");
    actorId = actor.id;
    assertSameOrigin(request);
    connectionId = connectionIdFrom(await readBoundedJson(request));
    const stored = await getStoredConnectionSecret(connectionId);
    assertSessionCapability(actor.authenticated, "connection:manage", stored.customerId);
    const health = await getCollectorHealth(stored.partition);
    if (health.mode !== "live") {
      throw Object.assign(new Error("AWS trust validation requires an explicitly enabled live collector"), { code: "INVALID_STATE" });
    }
    await markConnectionValidating(connectionId);
    validationClaimed = true;
    if (!stored.roleArn) {
      throw Object.assign(new Error("Register the customer IAM role before validation"), { code: "INVALID_STATE" });
    }
    const secrets = getPilotSecrets();
    const externalId = await decryptExternalId(
      { ciphertext: stored.externalIdCiphertext, keyVersion: stored.externalIdKeyVersion },
      secrets.connectionEncryptionKey,
      { orgId: LOCAL_ORG_ID, customerId: stored.customerId, connectionId },
    );
    await registerCollectorConnection({
      tenantId: LOCAL_ORG_ID,
      connectionId,
      accountId: stored.accountId,
      partition: stored.partition,
      roleArn: stored.roleArn,
      externalId,
      enabledRegions: stored.enabledRegions,
    });
    const verification = await verifyCollectorConnection({
      tenantId: LOCAL_ORG_ID,
      connectionId,
      jobId: `verify_${crypto.randomUUID().replaceAll("-", "")}`,
      accountId: stored.accountId,
      partition: stored.partition,
    });
    await markConnectionValidated(connectionId, actor.id);
    await activateCollectorConnection({
      tenantId: LOCAL_ORG_ID,
      connectionId,
      roleArn: stored.roleArn,
    });
    return jsonResponse({ verification, connectionId });
  } catch (error) {
    if (validationClaimed && connectionId !== null && actorId !== null) {
      try {
        await markConnectionNeedsAttention(connectionId, actorId, safeValidationFailureCode(error));
      } catch {
        // Preserve the original validation error; state transition errors are
        // intentionally not allowed to replace it.
      }
    }
    return errorResponse(error);
  }
}
