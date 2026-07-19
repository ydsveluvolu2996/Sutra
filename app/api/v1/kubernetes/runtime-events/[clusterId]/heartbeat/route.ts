import { FalcoRuntimeRepository } from "../../../../../../../db/falco-runtime-repository";
import { EnvironmentFalcoCredentialResolver } from "../../../../../../../lib/falco-runtime-config";
import {
  FalcoRequestSecurityError,
  FalcoRequestVerifier,
} from "../../../../../../../lib/falco-request-security";

export const dynamic = "force-dynamic";

const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;
const MAXIMUM_BODY_BYTES = 1_024;

function rejected(status: number, code: string): Response {
  return Response.json({ error: { code, message: "Falco heartbeat rejected" } }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly clusterId: string }> },
): Promise<Response> {
  try {
    const { clusterId } = await context.params;
    if (!CLUSTER_ID.test(clusterId)) return rejected(400, "INVALID_REQUEST");
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > MAXIMUM_BODY_BYTES) return rejected(413, "BODY_TOO_LARGE");
    const repository = new FalcoRuntimeRepository();
    const scope = await repository.resolveCluster(clusterId);
    if (scope === null) return rejected(401, "AUTHENTICATION_FAILED");
    const url = new URL(request.url);
    await new FalcoRequestVerifier({
      credentials: new EnvironmentFalcoCredentialResolver(),
      replayStore: repository,
      maximumBodyBytes: MAXIMUM_BODY_BYTES,
    }).verify({
      path: `${url.pathname}${url.search}`,
      headers: request.headers,
      body,
      expectedClusterId: clusterId,
    });
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return rejected(400, "INVALID_INPUT");
    }
    const input = parsed as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => key !== "schemaVersion" && key !== "falcoVersion") ||
      input.schemaVersion !== "sutra.falco.heartbeat.v1" ||
      (input.falcoVersion !== null && typeof input.falcoVersion !== "string")
    ) return rejected(400, "INVALID_INPUT");
    await repository.heartbeat(scope, input.falcoVersion as string | null);
    return Response.json({
      schemaVersion: "sutra.falco.heartbeat-response.v1",
      status: "active",
    }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof FalcoRequestSecurityError) {
      return rejected(error.code === "REQUEST_REPLAYED" ? 409 : 401, error.code);
    }
    return rejected(503, "HEARTBEAT_UNAVAILABLE");
  }
}
