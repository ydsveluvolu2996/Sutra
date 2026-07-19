import { KubernetesRepository } from "../../../../../../db/kubernetes-repository";
import { getConnectionForOrg } from "../../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../../../lib/aws-pilot-security";
import {
  createKubernetesInstallationPlan,
  KUBERNETES_INSTALLATION_MODULES,
  type KubernetesInstallationModule,
} from "../../../../../../lib/kubernetes-installation-plan";
import { errorResponse, jsonResponse } from "../../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;
const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u;

function invalid(): never {
  throw Object.assign(new Error("Kubernetes installation plan request rejected"), {
    code: "INVALID_INPUT",
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const authenticated = await requireApiSession(request);
    const raw = await readBoundedJson(request, 8 * 1024);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) invalid();
    const body = raw as Record<string, unknown>;
    if (
      Object.keys(body).length !== 5 ||
      body.operation !== "create-plan" ||
      typeof body.connectionId !== "string" || !CONNECTION_ID.test(body.connectionId) ||
      typeof body.clusterId !== "string" || !CLUSTER_ID.test(body.clusterId) ||
      typeof body.context !== "string" || !CONTEXT.test(body.context) ||
      !Array.isArray(body.modules) ||
      body.modules.some((module) =>
        typeof module !== "string" ||
        !KUBERNETES_INSTALLATION_MODULES.includes(module as KubernetesInstallationModule))
    ) invalid();
    const connection = await getConnectionForOrg(authenticated.subject.orgId, body.connectionId);
    if (connection === null) {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    }
    assertSessionCapability(authenticated, "connection:manage", connection.customerId);
    const scope = {
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
    };
    const cluster = (await new KubernetesRepository().listClusters(scope))
      .find((candidate) => candidate.id === body.clusterId && candidate.status === "active");
    if (cluster === undefined) {
      throw Object.assign(new Error("Kubernetes cluster not found"), { code: "NOT_FOUND" });
    }
    const plan = createKubernetesInstallationPlan({
      clusterId: cluster.id,
      clusterName: cluster.name,
      context: body.context,
      modules: body.modules as KubernetesInstallationModule[],
    });
    return jsonResponse({ plan }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
