import { createConnectionDraft, LOCAL_ORG_ID } from "../../../../db/pilot-repository";
import {
  assertSameOrigin,
  encryptExternalId,
  generateExternalId,
  parseAwsAccountId,
  parseAwsPartition,
  parseRegions,
  readBoundedJson,
} from "../../../../lib/aws-pilot-security";
import {
  errorResponse,
  getCollectorHealth,
  getPilotSecrets,
  jsonResponse,
  requirePilotActor,
} from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw Object.assign(new Error("The onboarding request is invalid"), { code: "INVALID_INPUT" });
  }
  const result = value as Record<string, unknown>;
  const allowed = new Set(["customerName", "awsAccountId", "partition", "enabledRegions"]);
  if (Object.keys(result).some((key) => !allowed.has(key)) || [...allowed].some((key) => !(key in result))) {
    throw Object.assign(new Error("The onboarding request contains missing or unsupported fields"), { code: "INVALID_INPUT" });
  }
  return result;
}

function customerName(value: unknown): string {
  if (typeof value !== "string") {
    throw Object.assign(new Error("Enter a customer name"), { code: "INVALID_INPUT" });
  }
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length < 2 || normalized.length > 80 || /[<>\u0000-\u001f]/u.test(normalized)) {
    throw Object.assign(new Error("Enter a customer name between 2 and 80 characters"), { code: "INVALID_INPUT" });
  }
  return normalized;
}

function slug(value: string): string {
  const base = value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 44) || "customer";
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

function opaqueId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requirePilotActor(request, "customer:create");
    assertSameOrigin(request);
    const body = record(await readBoundedJson(request));
    const name = customerName(body.customerName);
    const accountId = parseAwsAccountId(body.awsAccountId);
    const partition = parseAwsPartition(body.partition);
    const enabledRegions = parseRegions(body.enabledRegions, partition);
    if (enabledRegions.length === 0) {
      throw Object.assign(new Error("Choose at least one AWS region"), { code: "INVALID_INPUT" });
    }

    const health = await getCollectorHealth(partition);
    if (!health.ok || !health.principalArn) {
      throw Object.assign(new Error("The local AWS collector is not ready"), { code: "INVALID_STATE" });
    }
    const customerId = opaqueId("cust");
    const connectionId = opaqueId("conn");
    const externalId = generateExternalId();
    const secrets = getPilotSecrets();
    const encrypted = await encryptExternalId(
      externalId,
      secrets.connectionEncryptionKey,
      secrets.connectionKeyVersion,
      { orgId: LOCAL_ORG_ID, customerId, connectionId },
    );
    const connection = await createConnectionDraft({
      actorId: actor.id,
      customerId,
      connectionId,
      customerName: name,
      customerSlug: slug(name),
      accountId,
      partition,
      enabledRegions,
      externalIdCiphertext: encrypted.ciphertext,
      externalIdKeyVersion: encrypted.keyVersion,
    });

    return jsonResponse({
      connection,
      trust: {
        externalId,
        vendorCollectorRoleArn: health.principalArn,
        sessionNamePrefix: "sutra-",
        customerTenantId: customerId,
        roleName: "SutraReadOnlyRole",
      },
      collector: health,
    }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
