import { KubernetesRepository } from "../../../../db/kubernetes-repository";
import {
  getConnectionForOrg,
  getPilotStateForOrg,
} from "../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse } from "../../../../lib/pilot-server";
import { createEksEnrollmentPlan } from "../../../../lib/eks-enrollment";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;
const RESOURCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,511}$/u;

function invalid(): never {
  throw Object.assign(new Error("The Kubernetes workspace request is invalid"), {
    code: "INVALID_INPUT",
  });
}

function required(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  return value;
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

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId" && key !== "clusterId")) invalid();
    const connectionId = required(url.searchParams.get("connectionId"), CONNECTION_ID);
    const clusterIdValue = url.searchParams.get("clusterId");
    const clusterId = clusterIdValue === null ? null : required(clusterIdValue, CLUSTER_ID);
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = {
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
    };
    const repository = new KubernetesRepository();
    const clusters = await repository.listClusters(scope);
    const workspace = clusterId === null ? null : await repository.getLatestWorkspace(scope, clusterId);
    if (clusterId !== null && workspace === null) {
      throw Object.assign(new Error("Kubernetes cluster not found"), { code: "NOT_FOUND" });
    }
    return jsonResponse({ connectionId, customerId: connection.customerId, clusters, workspace });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const authenticated = await requireApiSession(request);
    const body = exactRecord(await readBoundedJson(request), ["operation", "connectionId", "resourceKey"]);
    if (body.operation !== "register-discovered-eks") invalid();
    const connectionId = required(body.connectionId, CONNECTION_ID);
    const resourceKey = required(body.resourceKey, RESOURCE_KEY);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:manage", connection.customerId);
    const state = await getPilotStateForOrg(authenticated.subject.orgId, connectionId);
    const resource = state.resources.find((candidate) =>
      candidate.resourceKey === resourceKey &&
      candidate.service === "eks" &&
      candidate.resourceType === "aws.eks.cluster" &&
      candidate.source.accountId === connection.awsAccountId,
    );
    if (resource === undefined) invalid();
    if (connection.roleArn === null) invalid();
    const plan = createEksEnrollmentPlan({
      clusterName: resource.nativeId,
      region: resource.region,
      accountId: connection.awsAccountId,
      customerRoleArn: connection.roleArn,
    });
    const cluster = await new KubernetesRepository().registerCluster({
      scope: {
        orgId: authenticated.subject.orgId,
        customerId: connection.customerId,
      },
      clusterUid: `${connection.awsAccountId}:${resource.region}:${resource.nativeId}`,
      name: resource.name ?? resource.nativeId,
      distribution: "Amazon EKS",
      version: typeof resource.configuration.kubernetesVersion === "string"
        ? resource.configuration.kubernetesVersion
        : undefined,
    });
    return jsonResponse({ cluster, plan }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
