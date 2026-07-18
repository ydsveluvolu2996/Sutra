import { KubernetesRepository } from "../../../../../db/kubernetes-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { buildWorkloadDrift, type DriftWorkload } from "../../../../../lib/kubernetes-drift";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;

function invalid(): never {
  throw Object.assign(new Error("Drift query rejected"), { code: "INVALID_INPUT" });
}

interface WorkloadEvidence {
  readonly namespace: string | null;
  readonly name: string;
  readonly workloadKind?: string;
  readonly hostNetwork?: boolean | null;
  readonly hostPid?: boolean | null;
  readonly hostIpc?: boolean | null;
  readonly hasHostPath?: boolean | null;
  readonly runAsNonRoot?: boolean | null;
  readonly containers?: readonly {
    readonly name: string;
    readonly image: string | null;
    readonly privileged: boolean | null;
    readonly allowPrivilegeEscalation: boolean | null;
    readonly runAsNonRoot: boolean | null;
    readonly capabilitiesAdd: readonly string[] | null;
  }[];
}

function toDriftWorkload(workload: WorkloadEvidence): DriftWorkload {
  return {
    namespace: workload.namespace ?? "",
    name: workload.name,
    workloadKind: workload.workloadKind ?? "Workload",
    hostNetwork: workload.hostNetwork ?? null,
    hostPid: workload.hostPid ?? null,
    hostIpc: workload.hostIpc ?? null,
    hasHostPath: workload.hasHostPath ?? null,
    runAsNonRoot: workload.runAsNonRoot ?? null,
    containers: (workload.containers ?? []).map((container) => ({
      name: container.name,
      image: container.image,
      privileged: container.privileged,
      allowPrivilegeEscalation: container.allowPrivilegeEscalation,
      runAsNonRoot: container.runAsNonRoot,
      capabilitiesAdd: container.capabilitiesAdd,
    })),
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => !["connectionId", "clusterId"].includes(key))) invalid();
    const connectionId = url.searchParams.get("connectionId");
    const clusterId = url.searchParams.get("clusterId");
    if (
      connectionId === null || !CONNECTION_ID.test(connectionId) ||
      clusterId === null || !CLUSTER_ID.test(clusterId)
    ) invalid();
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    }
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
    const scans = await new KubernetesRepository().listWorkloadScans(scope, clusterId);
    const report = buildWorkloadDrift({
      current: (scans.latest?.workloads ?? []).map((workload) => toDriftWorkload(workload as unknown as WorkloadEvidence)),
      previous: scans.previous === null ? null : scans.previous.workloads.map((workload) => toDriftWorkload(workload as unknown as WorkloadEvidence)),
    });
    return jsonResponse({
      ...report,
      latestScanAt: scans.latest?.collectedAt ?? null,
      previousScanAt: scans.previous?.collectedAt ?? null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
