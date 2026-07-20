import { KubernetesRepository } from "../../../../../db/kubernetes-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { buildCollectedIacInput, type CollectedClusterWorkloads } from "../../../../../lib/iac-collected-inputs";
import { scanIacResources } from "../../../../../lib/iac-misconfiguration";
import type { KubernetesWorkloadEvidence } from "../../../../../lib/kubernetes-posture";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;

function invalid(): never {
  throw Object.assign(new Error("IaC collected-scan query rejected"), { code: "INVALID_INPUT" });
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

    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
    const repository = new KubernetesRepository();
    const clusters = await repository.listClusters(scope);
    // Scan a single active cluster when asked, otherwise every active cluster the
    // connection owns. A requested cluster that is not in the tenant-scoped list
    // is a not-found, never a silent empty scan.
    const targets = clusterIdValue === null
      ? clusters
      : clusters.filter((cluster) => cluster.id === clusterIdValue);
    if (clusterIdValue !== null && targets.length === 0) {
      throw Object.assign(new Error("Kubernetes cluster not found"), { code: "NOT_FOUND" });
    }

    const collected: CollectedClusterWorkloads[] = [];
    for (const cluster of targets) {
      const scans = await repository.listWorkloadScans(scope, cluster.id);
      const latest = scans.latest;
      collected.push({
        clusterId: cluster.id,
        clusterName: cluster.name,
        collectedAt: latest?.collectedAt ?? null,
        workloads: (latest?.workloads ?? []).filter(
          (workload): workload is KubernetesWorkloadEvidence => workload.kind === "Workload",
        ),
      });
    }

    const input = buildCollectedIacInput(collected);
    const report = scanIacResources(input.resources, { tenant: connection.customerId });

    return jsonResponse({
      report,
      coverage: input.coverage,
      connectionId,
      customerId: connection.customerId,
      clusterId: clusterIdValue,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
