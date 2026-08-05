import {
  SustainabilityTargetRepository,
  type SustainabilityTargetInput,
} from "../../../../../../db/finops-sustainability-target-repository";
import { requireConnectionScope } from "../../../../../../lib/api-connection-scope";
import { assertSameOrigin, readBoundedJson } from "../../../../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse } from "../../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const BODY_BYTES = 8 * 1024;
const TARGET = /^stgt_[a-f0-9]{64}$/u;
const METRICS = new Set([
  "COMPUTE_VCPU_HOURS", "COMPUTE_MEMORY_GB_HOURS", "LAMBDA_GB_SECONDS",
  "STORAGE_GB_HOURS", "STORAGE_REQUESTS", "DATA_TRANSFER_GB",
  "DATABASE_VCPU_HOURS",
]);

function invalid(): never {
  throw Object.assign(new Error("The sustainability target request is invalid"), { code: "INVALID_INPUT", status: 400 });
}

async function resolve(request: Request, capability: "connection:read" | "connection:manage") {
  const value = await requireConnectionScope(request, capability);
  if (value.connection.sourceKind !== "aws_trust_role" || value.connection.status !== "active") {
    throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 });
  }
  return {
    ...value,
    persistenceScope: {
      organizationId: value.scope.orgId,
      customerId: value.scope.customerId,
      connectionId: value.connection.id,
    },
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const targetId = new URL(request.url).searchParams.get("targetId");
    if (targetId !== null && !TARGET.test(targetId)) invalid();
    const { persistenceScope } = await resolve(request, "connection:read");
    const repository = new SustainabilityTargetRepository();
    return jsonResponse({
      schema: "sutra.finops-sustainability-targets.v1",
      targets: await repository.list(persistenceScope, true),
      history: targetId === null ? [] : await repository.history(persistenceScope, targetId),
      governance: {
        interpretation: "TECHNICAL_RESOURCE_USE_TARGET_NOT_CARBON_TARGET",
        mutationCapability: "connection:manage",
        immutableAudit: true,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readBoundedJson(request, BODY_BYTES);
    if (typeof body !== "object" || body === null || Array.isArray(body)) invalid();
    const value = body as Readonly<Record<string, unknown>>;
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([
      "metric", "periodStart", "reason", "targetValueMicros",
      "workloadTagKey", "workloadTagValue",
    ])) invalid();
    if (typeof value.metric !== "string" || !METRICS.has(value.metric)
      || typeof value.periodStart !== "string" || typeof value.targetValueMicros !== "string"
      || typeof value.reason !== "string"
      || !((value.workloadTagKey === null && value.workloadTagValue === null)
        || (typeof value.workloadTagKey === "string" && typeof value.workloadTagValue === "string"))) invalid();
    const { authenticated, persistenceScope } = await resolve(request, "connection:manage");
    const saved = await new SustainabilityTargetRepository().set(
      persistenceScope,
      value as unknown as SustainabilityTargetInput,
      authenticated.subject.userId,
    );
    return jsonResponse({ saved, interpretation: "TECHNICAL_RESOURCE_USE_TARGET_NOT_CARBON_TARGET" });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const targetId = new URL(request.url).searchParams.get("targetId") ?? "";
    if (!TARGET.test(targetId)) invalid();
    const body = await readBoundedJson(request, BODY_BYTES);
    if (typeof body !== "object" || body === null || Array.isArray(body)
      || Object.keys(body).length !== 1 || typeof (body as { reason?: unknown }).reason !== "string") invalid();
    const { authenticated, persistenceScope } = await resolve(request, "connection:manage");
    const revoked = await new SustainabilityTargetRepository().revoke(
      persistenceScope, targetId, (body as { reason: string }).reason,
      authenticated.subject.userId,
    );
    return jsonResponse({ revoked });
  } catch (error) {
    return errorResponse(error);
  }
}
