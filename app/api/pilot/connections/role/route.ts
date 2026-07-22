import { requireRecentMfa } from "../../../../../db/auth-repository";
import {
  commitVerifiedConnectionRole,
  getStoredConnectionSecretForOrg,
} from "../../../../../db/pilot-repository";
import {
  assertSameOrigin,
  decryptExternalId,
  parseIamRoleArn,
  readBoundedJson,
} from "../../../../../lib/aws-pilot-security";
import {
  activateCollectorConnection,
  discardStagedCollectorConnection,
  errorResponse,
  getCollectorHealth,
  getPilotSecrets,
  jsonResponse,
  registerCollectorConnection,
  requirePilotActor,
  verifyCollectorConnection,
} from "../../../../../lib/pilot-server";
import { assertSessionCapability } from "../../../../../lib/api-auth";
import { withLocalOnboardingAccountLock } from "../../../../../lib/local-onboarding-lock";
import { stageVerifyThenCommitRole } from "../../../../../lib/local-aws-lifecycle";

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
    const stored = await getStoredConnectionSecretForOrg(actor.orgId, body.connectionId);
    assertSessionCapability(actor.authenticated, "connection:manage", stored.customerId);
    requireRecentMfa(actor.authenticated);
    return await withLocalOnboardingAccountLock(
      stored.partition,
      stored.accountId,
      async () => {
        const current = await getStoredConnectionSecretForOrg(actor.orgId, body.connectionId);
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
        const expectedRolePathAndName = `${current.expectedRolePath.slice(1)}${current.expectedRoleName}`;
        if (role.rolePathAndName !== expectedRolePathAndName) {
          throw Object.assign(
            new Error(`Use the dedicated ${current.expectedRolePath}${current.expectedRoleName} role selected for this connection`),
            { code: "INVALID_INPUT" },
          );
        }
        const secrets = getPilotSecrets();
        const externalId = await decryptExternalId(
          { ciphertext: current.externalIdCiphertext, keyVersion: current.externalIdKeyVersion },
          secrets.connectionEncryptionKey,
          { orgId: actor.orgId, customerId: current.customerId, connectionId: current.connectionId },
        );
        const registerRoleWithCollector = (roleArn: string) => registerCollectorConnection({
          tenantId: actor.orgId,
          connectionId: current.connectionId,
          accountId: current.accountId,
          partition: current.partition,
          roleArn,
          externalId,
          enabledRegions: current.enabledRegions,
          roleProvisioningMode: current.roleProvisioningMode,
          expectedRolePath: current.expectedRolePath,
          expectedRoleName: current.expectedRoleName,
        });
        const verifyRoleWithCollector = () => verifyCollectorConnection({
          tenantId: actor.orgId,
          connectionId: current.connectionId,
          jobId: `verify_role_${crypto.randomUUID().replaceAll("-", "")}`,
          accountId: current.accountId,
          partition: current.partition,
          roleArn: role.arn,
          sessionNamePrefix: "sutra-",
        });
        const activateRoleWithCollector = (roleArn: string) => activateCollectorConnection({
          tenantId: actor.orgId,
          connectionId: current.connectionId,
          roleArn,
        });
        const result = await stageVerifyThenCommitRole({
          stageCollector: () => registerRoleWithCollector(role.arn),
          verifyCollector: verifyRoleWithCollector,
          commitVerifiedControlPlaneRole: (verification) => commitVerifiedConnectionRole({
            connectionId: current.connectionId,
            expectedPreviousRoleArn: current.roleArn.length === 0 ? null : current.roleArn,
            roleArn: role.arn,
            actorId: actor.id,
            verification,
          }),
          activateCollector: () => activateRoleWithCollector(role.arn),
          compensateStagedCollector: async () => {
            if (current.roleArn.length === 0) {
              await discardStagedCollectorConnection({
                tenantId: actor.orgId,
                connectionId: current.connectionId,
                roleArn: role.arn,
              });
              return;
            }
            if (current.roleArn === role.arn) {
              // Durable state already names this exact role. Activation is safe
              // only if verification reached the collector's VERIFIED state.
              await activateRoleWithCollector(current.roleArn);
              return;
            }
            await registerRoleWithCollector(current.roleArn);
            await verifyCollectorConnection({
              tenantId: actor.orgId,
              connectionId: current.connectionId,
              jobId: `restore_role_${crypto.randomUUID().replaceAll("-", "")}`,
              accountId: current.accountId,
              partition: current.partition,
              roleArn: current.roleArn,
              sessionNamePrefix: "sutra-",
            });
            await activateRoleWithCollector(current.roleArn);
          },
        });
        return jsonResponse({
          connection: result.connection,
          registered: true,
          verification: result.verification,
        });
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
