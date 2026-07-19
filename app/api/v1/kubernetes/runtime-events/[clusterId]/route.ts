import { FalcoRuntimeRepository } from "../../../../../../db/falco-runtime-repository";
import { EnvironmentFalcoCredentialResolver } from "../../../../../../lib/falco-runtime-config";
import {
  FALCO_MAXIMUM_BODY_BYTES,
  parseFalcoRuntimePayload,
} from "../../../../../../lib/falco-runtime-boundary";
import {
  FalcoRequestSecurityError,
  FalcoRequestVerifier,
} from "../../../../../../lib/falco-request-security";

export const dynamic = "force-dynamic";

const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;

function response(status: number, code: string): Response {
  return Response.json({ error: { code, message: "Falco ingestion request rejected" } }, {
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
    if (!CLUSTER_ID.test(clusterId)) return response(400, "INVALID_REQUEST");
    const contentLength = request.headers.get("content-length");
    if (
      contentLength !== null &&
      (!/^\d{1,9}$/u.test(contentLength) || Number(contentLength) > FALCO_MAXIMUM_BODY_BYTES)
    ) return response(413, "BODY_TOO_LARGE");
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > FALCO_MAXIMUM_BODY_BYTES) return response(413, "BODY_TOO_LARGE");
    const repository = new FalcoRuntimeRepository();
    const scope = await repository.resolveCluster(clusterId);
    if (scope === null) return response(401, "AUTHENTICATION_FAILED");
    const url = new URL(request.url);
    const verifier = new FalcoRequestVerifier({
      credentials: new EnvironmentFalcoCredentialResolver(),
      replayStore: repository,
    });
    await verifier.verify({
      path: `${url.pathname}${url.search}`,
      headers: request.headers,
      body,
      expectedClusterId: clusterId,
    });
    const events = parseFalcoRuntimePayload({ clusterId, body });
    const result = await repository.publish(scope, events);
    return Response.json({
      schemaVersion: "sutra.falco.ingestion-response.v1",
      accepted: result.accepted,
      duplicates: result.duplicates,
    }, {
      status: 202,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof FalcoRequestSecurityError) {
      const status = error.code === "BODY_TOO_LARGE" ? 413 :
        error.code === "REQUEST_REPLAYED" ? 409 : 401;
      return response(status, error.code);
    }
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "BODY_TOO_LARGE") return response(413, code);
    if (code === "INVALID_INPUT" || code === "EVIDENCE_MISMATCH") return response(400, code);
    return response(503, "INGESTION_UNAVAILABLE");
  }
}
