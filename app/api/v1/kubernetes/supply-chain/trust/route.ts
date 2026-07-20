import { KubernetesSupplyChainRepository } from "../../../../../../db/kubernetes-supply-chain-repository";
import { getConnectionForOrg } from "../../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../../lib/api-auth";
import type { KubernetesSupplyChainEvidence } from "../../../../../../lib/kubernetes-supply-chain";
import { errorResponse, jsonResponse } from "../../../../../../lib/pilot-server";
import { evidenceToArtifact } from "../../../../../../lib/supply-chain-trust-inputs";
import { verifySupplyChainTrust } from "../../../../../../lib/supply-chain-verification";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;

function invalid(): never {
  throw Object.assign(new Error("Supply-chain trust request rejected"), { code: "INVALID_INPUT" });
}

function identifier(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  return value;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => !["connectionId", "clusterId", "limit"].includes(key))) invalid();
    const connectionId = identifier(url.searchParams.get("connectionId"), CONNECTION_ID);
    const clusterId = identifier(url.searchParams.get("clusterId"), CLUSTER_ID);
    const limitText = url.searchParams.get("limit") ?? "200";
    if (!/^\d{1,3}$/u.test(limitText)) invalid();
    const limit = Number(limitText);
    if (limit < 1 || limit > 500) invalid();
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId, clusterId };
    const evidence = await new KubernetesSupplyChainRepository().list(scope, limit);

    // Mirror the /kubernetes/supply-chain trust panel exactly: one artifact per
    // image digest (evidence may carry history for a digest), and NO fabricated
    // VEX or vulnerability inputs. Passing [] keeps the engine's honest
    // "submitted attestation metadata only" claim boundary intact — a verified
    // signature/provenance is only accepted with its key/builder evidence and
    // never establishes source-code safety on its own.
    const byDigest = new Map<string, KubernetesSupplyChainEvidence>();
    for (const record of evidence) {
      if (!byDigest.has(record.image.digest)) byDigest.set(record.image.digest, record);
    }
    const report = verifySupplyChainTrust({
      artifacts: [...byDigest.values()].map((record) => evidenceToArtifact(record)),
      vexStatements: [],
      vulnerabilities: [],
    });
    return jsonResponse({
      ...report,
      connectionId,
      clusterId,
      configured: evidence.length > 0,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
