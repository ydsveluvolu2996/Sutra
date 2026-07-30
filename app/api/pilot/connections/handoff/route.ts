import {
  appendAuditEvent,
  getConnectionForOrg,
  getStoredConnectionSecretForOrg,
} from "../../../../../db/pilot-repository";
import { assertSessionCapability } from "../../../../../lib/api-auth";
import {
  AWS_CUSTOMER_ROLE_TEMPLATE_URL_ENV,
  withVerifiedPublicCustomerRoleTemplate,
} from "../../../../../lib/aws-cloudformation-quick-launch";
import {
  assertSameOrigin,
  decryptExternalId,
  readBoundedJson,
} from "../../../../../lib/aws-pilot-security";
import {
  errorResponse,
  getCollectorHealth,
  getPilotSecrets,
  jsonResponse,
  requirePilotActor,
} from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

function connectionIdFrom(value: unknown): string {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !("connectionId" in value)
    || typeof (value as { connectionId?: unknown }).connectionId !== "string"
    || !/^conn_[a-f0-9]{32}$/u.test((value as { connectionId: string }).connectionId)
  ) {
    throw Object.assign(new Error("The onboarding handoff request is invalid"), { code: "INVALID_INPUT" });
  }
  return (value as { connectionId: string }).connectionId;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requirePilotActor(request, "workspace:read");
    assertSameOrigin(request);
    const connectionId = connectionIdFrom(await readBoundedJson(request, 1024));
    const stored = await getStoredConnectionSecretForOrg(actor.orgId, connectionId);
    assertSessionCapability(actor.authenticated, "connection:manage", stored.customerId);
    if (stored.status !== "pending" || stored.roleArn !== "") {
      throw Object.assign(
        new Error("The one-time onboarding handoff closed when the customer role was registered"),
        { code: "INVALID_STATE" },
      );
    }
    const connection = await getConnectionForOrg(actor.orgId, connectionId);
    if (connection === null || connection.customerId !== stored.customerId) {
      throw Object.assign(new Error("AWS connection not found"), { code: "NOT_FOUND" });
    }
    const health = await getCollectorHealth(stored.partition);
    if (health.mode !== "live" || !health.principalArn) {
      throw Object.assign(
        new Error("AWS onboarding requires the approved live collector"),
        { code: "INVALID_STATE" },
      );
    }
    const secrets = getPilotSecrets();
    const externalId = await decryptExternalId(
      {
        ciphertext: stored.externalIdCiphertext,
        keyVersion: stored.externalIdKeyVersion,
      },
      secrets.connectionEncryptionKey,
      {
        orgId: actor.orgId,
        customerId: stored.customerId,
        connectionId: stored.connectionId,
      },
    );

    // Disclosure is permitted only to an MFA-verified session that holds
    // connection:manage for this exact persisted customer. Record it before
    // returning the one-time value so an audit failure fails closed.
    await appendAuditEvent({
      orgId: actor.orgId,
      actorId: actor.id,
      action: "aws.connection.handoff.disclosed",
      targetType: "aws_connection",
      targetId: stored.connectionId,
      customerId: stored.customerId,
      outcome: "allowed",
      metadata: {
        accountId: stored.accountId,
        partition: stored.partition,
        delegated: true,
      },
    });

    const respond = async (publicTemplateUrl: string | null): Promise<Response> => jsonResponse({
      connection,
      handoff: { recovered: true },
      trust: {
        externalId,
        collectorPrincipal: health.principalArn,
        vendorCollectorRoleArn: health.principalArn,
        roleSessionName: "sutra-",
        sessionNamePrefix: "sutra-",
        customerTenantId: stored.customerId,
        permissionPackVersion: stored.permissionPackVersion,
        roleProvisioningMode: stored.roleProvisioningMode,
        rolePath: stored.expectedRolePath,
        roleName: stored.expectedRoleName,
      },
      deployment: { publicTemplateUrl },
      collector: health,
    });

    if (stored.roleProvisioningMode === "customer_managed") return await respond(null);
    return await withVerifiedPublicCustomerRoleTemplate(
      process.env[AWS_CUSTOMER_ROLE_TEMPLATE_URL_ENV],
      respond,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
