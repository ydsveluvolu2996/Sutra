import { KubernetesRepository } from "../../../../../db/kubernetes-repository";
import { getConnectionForOrg, getPilotStateForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { buildAwsIamCiem } from "../../../../../lib/aws-iam-ciem";
import { deriveAwsIamPrincipals } from "../../../../../lib/aws-iam-ciem-evidence";
import { projectStoredKubernetesWorkspace } from "../../../../../lib/kubernetes-workspace-projection";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;

function invalid(): never {
  throw Object.assign(new Error("AWS IAM CIEM request rejected"), { code: "INVALID_INPUT" });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId" && key !== "clusterId")) invalid();
    const connectionId = url.searchParams.get("connectionId");
    if (connectionId === null || !CONNECTION_ID.test(connectionId)) invalid();
    const clusterIdValue = url.searchParams.get("clusterId");
    if (clusterIdValue !== null && !CLUSTER_ID.test(clusterIdValue)) invalid();
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);

    // Reproduce the workspace exactly as the /kubernetes/iam page assembles it:
    // the authorized CMDB resources merged with the projected latest Kubernetes
    // workspace for the selected (else first active) cluster. IAM principals are
    // derived only from resources actually present in this authorized snapshot —
    // a principal whose policy statements were not collected degrades to
    // `statements: null` and is reported unresolved, never "grants nothing".
    const state = await getPilotStateForOrg(authenticated.subject.orgId, connectionId);
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
    const repository = new KubernetesRepository();
    const clusters = await repository.listClusters(scope);
    const cluster = clusterIdValue === null
      ? clusters.find((candidate) => candidate.status === "active") ?? null
      : clusters.find((candidate) => candidate.id === clusterIdValue) ?? null;
    if (clusterIdValue !== null && cluster === null) {
      throw Object.assign(new Error("Kubernetes cluster not found"), { code: "NOT_FOUND" });
    }
    const workspace = cluster === null ? null : await repository.getLatestWorkspace(scope, cluster.id);
    const projected = workspace === null ? [] : projectStoredKubernetesWorkspace(workspace, connection).resources;
    const resources = [...state.resources, ...projected];

    const report = buildAwsIamCiem(deriveAwsIamPrincipals(resources));
    return jsonResponse({
      ...report,
      connectionId,
      clusterId: cluster?.id ?? null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
