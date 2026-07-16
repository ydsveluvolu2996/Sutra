import {
  createSyncRun,
  failSyncRun,
  getPilotState,
  getStoredConnectionSecret,
  LOCAL_ORG_ID,
  persistSnapshot,
} from "../../../../../db/pilot-repository";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import {
  errorResponse,
  jsonResponse,
  requirePilotActor,
  runCollectorSync,
  safeCollectionFailureCode,
} from "../../../../../lib/pilot-server";
import { assertSessionCapability } from "../../../../../lib/api-auth";

export const dynamic = "force-dynamic";

function connectionIdFrom(value: unknown): string {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).length !== 1 || !("connectionId" in value) ||
    typeof (value as { connectionId?: unknown }).connectionId !== "string" ||
    !/^conn_[a-f0-9]{32}$/u.test((value as { connectionId: string }).connectionId)
  ) {
    throw Object.assign(new Error("The sync request is invalid"), { code: "INVALID_INPUT" });
  }
  return (value as { connectionId: string }).connectionId;
}

export async function POST(request: Request): Promise<Response> {
  let runId: string | null = null;
  let connectionId: string | null = null;
  let actorId: string | null = null;
  try {
    const actor = await requirePilotActor(request, "workspace:read");
    actorId = actor.id;
    assertSameOrigin(request);
    connectionId = connectionIdFrom(await readBoundedJson(request));
    const stored = await getStoredConnectionSecret(connectionId);
    assertSessionCapability(actor.authenticated, "sync:run", stored.customerId);
    runId = await createSyncRun(connectionId);
    const snapshot = await runCollectorSync({
      tenantId: LOCAL_ORG_ID,
      connectionId,
      jobId: runId,
      accountId: stored.accountId,
      partition: stored.partition,
    });
    await persistSnapshot(runId, snapshot, actor.id);
    return jsonResponse({ runId, state: await getPilotState() });
  } catch (error) {
    if (runId !== null && connectionId !== null && actorId !== null) {
      try {
        await failSyncRun(runId, connectionId, actorId, safeCollectionFailureCode(error));
      } catch {
        // Preserve the original collection error; a stale failure transition
        // must not replace the evidence-boundary error returned to the caller.
      }
    }
    return errorResponse(error);
  }
}
