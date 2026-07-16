import { requireRecentMfa } from "../../../../../db/auth-repository";
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
  getCollectorHealth,
  getPilotSecrets,
  jsonResponse,
  registerCollectorConnection,
  requirePilotActor,
} from "../../../../../lib/pilot-server";
import { assertSessionCapability } from "../../../../../lib/api-auth";
import { withLocalOnboardingAccountLock } from "../../../../../lib/local-onboarding-lock";
import { commitRoleThenRegisterCollector } from "../../../../../lib/local-aws-lifecycle";

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
    const actor = await requirePilotActor(request, "workspace:read");
    assertSameOrigin(request);
    const body = parseBody(await readBoundedJson(request));
    const stored = await getStoredConnectionSecret(body.connectionId);
    assertSessionCapability(actor.authenticated, "connection:manage", stored.customerId);
    requireRecentMfa(actor.authenticated);
    return await withLocalOnboardingAccountLock(
      stored.partition,
      stored.accountId,
      async () => {
        const current = await getStoredConnectionSecret(body.connectionId);
        if (
          current.customerId !== stored.customerId ||
          current.accountId !== stored.accountId ||
          current.partition !== stored.partition
        ) {
          throw Object.assign(new Error("The AWS connection changed while role registration was waiting"), { code: "INVALID_STATE" });
        }
        if (current.status === "disabled") {
          throw Object.assign(
            new Error("A disabled AWS connection cannot register or replace its IAM role"),
            { code: "INVALID_STATE" },
          );
        }
        const health = await getCollectorHealth(current.partition);
        if (health.mode !== "live") {
          throw Object.assign(new Error("AWS role registration requires an explicitly enabled live collector"), { code: "INVALID_STATE" });
        }
        const role = parseIamRoleArn(body.roleArn, {
          accountId: current.accountId,
          partition: current.partition,
        });
        if (role.rolePathAndName !== "sutra/SutraReadOnlyRole") {
          throw Object.assign(
            new Error("Use the reviewed /sutra/SutraReadOnlyRole from the versioned Sutra template"),
            { code: "INVALID_INPUT" },
          );
        }
        const secrets = getPilotSecrets();
        const externalId = await decryptExternalId(
          { ciphertext: current.externalIdCiphertext, keyVersion: current.externalIdKeyVersion },
          secrets.connectionEncryptionKey,
          { orgId: LOCAL_ORG_ID, customerId: current.customerId, connectionId: current.connectionId },
        );
        const connection = await commitRoleThenRegisterCollector({
          // The control plane closes the one-time handoff first. If collector
          // reconciliation fails, the pending role remains safe to retry.
          commitControlPlaneRole: () => setConnectionRole(current.connectionId, role.arn, actor.id),
          registerCollector: () => registerCollectorConnection({
            tenantId: LOCAL_ORG_ID,
            connectionId: current.connectionId,
            accountId: current.accountId,
            partition: current.partition,
            roleArn: role.arn,
            externalId,
            enabledRegions: current.enabledRegions,
          }),
        });
        return jsonResponse({ connection, registered: true });
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
