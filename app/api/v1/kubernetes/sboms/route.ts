import {
  KubernetesSbomRepository,
} from "../../../../../db/kubernetes-sbom-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import {
  assertSessionCapability,
  requireApiSession,
} from "../../../../../lib/api-auth";
import {
  assertSameOrigin,
  readBoundedJson,
} from "../../../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;
const POLICY_ID = /^klp_[a-f0-9]{48}$/u;

function invalid(): never {
  throw Object.assign(new Error("SBOM request rejected"), { code: "INVALID_INPUT" });
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

function boundedInteger(value: string | null, fallback: number, maximum: number): number {
  const text = value ?? String(fallback);
  if (!/^\d{1,5}$/u.test(text)) invalid();
  const result = Number(text);
  if (result < 1 || result > maximum) invalid();
  return result;
}

async function scopeFor(
  request: Request,
  connectionId: string,
  clusterId: string,
  capability: "connection:read" | "connection:manage",
) {
  const authenticated = await requireApiSession(request);
  const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
  if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
  assertSessionCapability(authenticated, capability, connection.customerId);
  return {
    authenticated,
    scope: {
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      clusterId,
    },
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const allowed = new Set(["connectionId", "clusterId", "view", "query", "limit", "scanLimit", "policyId"]);
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) invalid();
    const connectionId = identifier(url.searchParams.get("connectionId"), CONNECTION_ID);
    const clusterId = identifier(url.searchParams.get("clusterId"), CLUSTER_ID);
    const view = url.searchParams.get("view") ?? "history";
    const { scope } = await scopeFor(request, connectionId, clusterId, "connection:read");
    const repository = new KubernetesSbomRepository();
    if (view === "history") {
      const history = await repository.history(scope, boundedInteger(url.searchParams.get("limit"), 10, 20));
      return jsonResponse({ schemaVersion: "sutra.kubernetes-sbom-history.v1", clusterId, history });
    }
    if (view === "components") {
      const query = url.searchParams.get("query");
      if (query === null) invalid();
      const search = await repository.search(
        scope,
        query,
        boundedInteger(url.searchParams.get("limit"), 100, 200),
        boundedInteger(url.searchParams.get("scanLimit"), 10, 20),
      );
      return jsonResponse({ schemaVersion: "sutra.kubernetes-sbom-component-search.v1", clusterId, query, ...search });
    }
    if (view === "policies") {
      const policies = await repository.listPolicies(scope);
      return jsonResponse({ schemaVersion: "sutra.kubernetes-sbom-license-policies.v1", clusterId, policies });
    }
    if (view === "diff") {
      const result = await repository.diffLatest(scope);
      return jsonResponse({ schemaVersion: "sutra.kubernetes-sbom-diff.v1", clusterId, ...result });
    }
    if (view === "evaluation") {
      const policyId = identifier(url.searchParams.get("policyId"), POLICY_ID);
      const result = await repository.evaluateLatest(
        scope,
        policyId,
        boundedInteger(url.searchParams.get("limit"), 2_000, 10_000),
      );
      return jsonResponse({ schemaVersion: "sutra.kubernetes-sbom-license-evaluation.v1", clusterId, ...result });
    }
    return invalid();
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = exactRecord(
      await readBoundedJson(request, 64 * 1_024),
      ["operation", "connectionId", "clusterId", "expectedVersion", "policy"],
    );
    if (body.operation !== "publish-license-policy-version") invalid();
    const connectionId = identifier(body.connectionId, CONNECTION_ID);
    const clusterId = identifier(body.clusterId, CLUSTER_ID);
    if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) invalid();
    const { authenticated, scope } = await scopeFor(request, connectionId, clusterId, "connection:manage");
    const policy = await new KubernetesSbomRepository().publishPolicyVersion(
      scope,
      body.policy,
      authenticated.subject.userId,
      Number(body.expectedVersion),
    );
    return jsonResponse({ policy }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
