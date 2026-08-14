import {
  getStoredConnectionSecretForOrg,
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
import { assertAwsStaticCredentialsOnboardingEnabled } from "../../../../../lib/aws-static-credentials-feature";

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
  let orgId: string | null = null;
  let validationClaimed = false;
  try {
    const actor = await requirePilotActor(request, "workspace:read");
    actorId = actor.id;
    orgId = actor.orgId;
    assertSameOrigin(request);
    connectionId = connectionIdFrom(await readBoundedJson(request));
    const stored = await getStoredConnectionSecretForOrg(actor.orgId, connectionId);
    assertSessionCapability(actor.authenticated, "connection:manage", stored.customerId);
    if (stored.sourceKind === "aws_static_credentials") {
      assertAwsStaticCredentialsOnboardingEnabled();
    }
    const health = await getCollectorHealth(stored.partition);
    if (health.mode !== "live") {
      throw Object.assign(new Error("AWS trust validation requires an explicitly enabled live collector"), { code: "INVALID_STATE" });
    }
    await markConnectionValidating(connectionId, actor.orgId);
    validationClaimed = true;
    if (!stored.roleArn) {
      throw Object.assign(new Error("Register the customer IAM role before validation"), { code: "INVALID_STATE" });
    }
    const secrets = getPilotSecrets();
    const externalId = await decryptExternalId(
      { ciphertext: stored.externalIdCiphertext, keyVersion: stored.externalIdKeyVersion },
      secrets.connectionEncryptionKey,
      { orgId: actor.orgId, customerId: stored.customerId, connectionId },
    );
    await registerCollectorConnection({
      tenantId: actor.orgId,
      connectionId,
      accountId: stored.accountId,
      partition: stored.partition,
      roleArn: stored.roleArn,
      externalId,
      enabledRegions: stored.enabledRegions,
      roleProvisioningMode: stored.roleProvisioningMode,
      expectedRolePath: stored.expectedRolePath,
      expectedRoleName: stored.expectedRoleName,
    });
    const verification = await verifyCollectorConnection({
      tenantId: actor.orgId,
      connectionId,
      jobId: `verify_${crypto.randomUUID().replaceAll("-", "")}`,
      accountId: stored.accountId,
      partition: stored.partition,
      roleArn: stored.roleArn,
      sessionNamePrefix: "sutra-",
    });
    await markConnectionValidated(connectionId, actor.id, verification, actor.orgId);
    await activateCollectorConnection({
      tenantId: actor.orgId,
      connectionId,
      roleArn: stored.roleArn,
    });
    return jsonResponse({ verification, connectionId });
  } catch (error) {
    if (validationClaimed && connectionId !== null && actorId !== null && orgId !== null) {
      try {
        await markConnectionNeedsAttention(
          connectionId,
          actorId,
          safeValidationFailureCode(error),
          orgId,
        );
      } catch {
        // Preserve the original validation error; state transition errors are
        // intentionally not allowed to replace it.
      }
    }
    return errorResponse(error);
  }
}
