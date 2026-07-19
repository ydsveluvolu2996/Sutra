import { KubernetesSupplyChainRepository } from "../../../../../db/kubernetes-supply-chain-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import {
  assertSessionCapability,
  requireApiSession,
} from "../../../../../lib/api-auth";
import {
  assertSameOrigin,
  readBoundedJson,
} from "../../../../../lib/aws-pilot-security";
import { normalizeKubernetesSupplyChainEvidence } from "../../../../../lib/kubernetes-supply-chain";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;

function invalid(): never {
  throw Object.assign(new Error("Supply-chain evidence request rejected"), { code: "INVALID_INPUT" });
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !keys.includes(key))
  ) invalid();
  return record;
}

function identifier(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  return value;
}

function assertEvidenceEnvelope(value: unknown): void {
  const evidence = exactRecord(value, [
    "image",
    "vulnerabilityScan",
    "sbom",
    "signature",
    "provenance",
  ]);
  exactRecord(evidence.image, ["repository", "digest", "tag"]);
  exactRecord(evidence.vulnerabilityScan, [
    "scannerVersion",
    "scannedAt",
    "critical",
    "high",
    "medium",
    "low",
    "unknown",
    "fixedAvailable",
  ]);
  if (evidence.sbom !== null) {
    exactRecord(evidence.sbom, ["format", "componentCount", "documentSha256"]);
  }
  exactRecord(evidence.signature, [
    "state",
    "issuer",
    "subject",
    "transparencyLogVerified",
  ]);
  exactRecord(evidence.provenance, [
    "state",
    "builderId",
    "sourceRepository",
    "commitSha",
  ]);
}

async function authorizedScope(request: Request, connectionId: string, clusterId: string, capability: "connection:read" | "connection:manage") {
  const authenticated = await requireApiSession(request);
  const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
  if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
  assertSessionCapability(authenticated, capability, connection.customerId);
  return {
    orgId: authenticated.subject.orgId,
    customerId: connection.customerId,
    clusterId,
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => !["connectionId", "clusterId", "limit"].includes(key))) invalid();
    const connectionId = identifier(url.searchParams.get("connectionId"), CONNECTION_ID);
    const clusterId = identifier(url.searchParams.get("clusterId"), CLUSTER_ID);
    const limitText = url.searchParams.get("limit") ?? "100";
    if (!/^\d{1,3}$/u.test(limitText)) invalid();
    const limit = Number(limitText);
    if (limit < 1 || limit > 500) invalid();
    const scope = await authorizedScope(request, connectionId, clusterId, "connection:read");
    const evidence = await new KubernetesSupplyChainRepository().list(scope, limit);
    return jsonResponse({
      schemaVersion: "sutra.kubernetes-supply-chain-workspace.v1",
      configured: evidence.length > 0,
      clusterId,
      evidence,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = exactRecord(
      await readBoundedJson(request, 64 * 1_024),
      ["operation", "connectionId", "clusterId", "collectedAt", "evidence"],
    );
    if (body.operation !== "publish-normalized-evidence") invalid();
    const connectionId = identifier(body.connectionId, CONNECTION_ID);
    const clusterId = identifier(body.clusterId, CLUSTER_ID);
    if (typeof body.collectedAt !== "string") invalid();
    assertEvidenceEnvelope(body.evidence);
    const scope = await authorizedScope(request, connectionId, clusterId, "connection:manage");
    const normalized = await normalizeKubernetesSupplyChainEvidence({
      clusterId,
      collectedAt: body.collectedAt,
      evidence: body.evidence,
    });
    const evidence = await new KubernetesSupplyChainRepository().publish(scope, normalized);
    return jsonResponse({ evidence }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
