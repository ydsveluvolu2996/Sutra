import {
  createSyncRun,
  CURRENT_PILOT_PERMISSION_PACK,
  failSyncRun,
  getPilotStateForOrg,
  getStoredConnectionSecretForOrg,
  markConnectionNeedsAttention,
  persistSnapshot,
} from "../../../../../db/pilot-repository";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import {
  errorResponse,
  getCollectorHealth,
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
    const stored = await getStoredConnectionSecretForOrg(actor.orgId, connectionId);
    assertSessionCapability(actor.authenticated, "sync:run", stored.customerId);
    if (stored.permissionPackVersion !== CURRENT_PILOT_PERMISSION_PACK) {
      throw Object.assign(new Error("Revalidate the current AWS permission pack before running inventory"), { code: "INVALID_STATE" });
    }
    const health = await getCollectorHealth(stored.partition);
    if (health.mode !== "live") {
      throw Object.assign(
        new Error("Use Simulation runs for fixture evidence; AWS trust connections require an explicitly enabled live collector"),
        { code: "INVALID_STATE" },
      );
    }
    runId = await createSyncRun(connectionId);
    const snapshot = await runCollectorSync({
      tenantId: actor.orgId,
      connectionId,
      jobId: runId,
      accountId: stored.accountId,
      partition: stored.partition,
    });
    await persistSnapshot(runId, snapshot, actor.id, {
      kind: "aws_sandbox",
      fixtureId: null,
      fixtureVersion: null,
    });
    return jsonResponse({ runId, state: await getPilotStateForOrg(actor.orgId, connectionId) });
  } catch (error) {
    if (runId !== null && connectionId !== null && actorId !== null) {
      try {
        const safeReason = safeCollectionFailureCode(error);
        await failSyncRun(runId, connectionId, actorId, safeReason);
        if (
          safeReason === "ASSUME_ROLE_DENIED" ||
          safeReason === "TRUST_POLICY_UNSAFE" ||
          safeReason === "CALLER_IDENTITY_MISMATCH" ||
          safeReason === "NEGATIVE_PROBE_INCONCLUSIVE"
        ) {
          await markConnectionNeedsAttention(connectionId, actorId, safeReason);
        }
      } catch {
        // Preserve the original collection error; a stale failure transition
        // must not replace the evidence-boundary error returned to the caller.
      }
    }
    return errorResponse(error);
  }
}
