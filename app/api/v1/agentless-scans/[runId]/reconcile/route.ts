import { AgentlessScanRepository } from "../../../../../../db/agentless-scan-repository";
import { getConnectionForOrg } from "../../../../../../db/pilot-repository";
import { reconcileAgentlessBrokerRun } from "../../../../../../lib/agentless-broker-reconciliation";
import { assertSessionCapability, requireApiSession } from "../../../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../../../lib/aws-pilot-security";
import {
  errorResponse,
  jsonResponse,
  readAgentlessRun,
} from "../../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const RUN_ID = /^ags_[a-f0-9]{32}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

function invalid(): never {
  throw Object.assign(new Error("The agentless reconciliation request is invalid"), {
    code: "INVALID_INPUT",
  });
}

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly runId: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { runId } = await context.params;
    if (!RUN_ID.test(runId)) invalid();
    const body = await readBoundedJson(request, 2_048);
    if (
      body === null ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as { connectionId?: unknown }).connectionId !== "string" ||
      !CONNECTION_ID.test((body as { connectionId: string }).connectionId)
    ) invalid();
    const connectionId = (body as { connectionId: string }).connectionId;
    const authenticated = await requireApiSession(request);
    const orgId = authenticated.subject.orgId;
    const connection = await getConnectionForOrg(orgId, connectionId);
    if (connection === null) {
      throw Object.assign(new Error("Cloud connection not found"), {
        code: "NOT_FOUND",
        status: 404,
      });
    }
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = { orgId, customerId: connection.customerId };
    const repository = new AgentlessScanRepository();
    const run = await repository.getRun(scope, runId);
    const plan = await repository.getRunPlan(scope, runId);
    if (run === null || plan === null || run.connectionId !== connectionId) {
      throw Object.assign(new Error("Agentless scan run not found"), {
        code: "NOT_FOUND",
        status: 404,
      });
    }
    if (run.status !== "running") {
      return jsonResponse({ runId, status: run.status, reconciled: true });
    }
    const broker = await readAgentlessRun({
      runId,
      tenantId: orgId,
      connectionId,
    });
    const status = await reconcileAgentlessBrokerRun({
      repository,
      scope,
      run,
      connectionId,
      plan,
      broker,
    });
    return jsonResponse({
      runId,
      status,
      reconciled: status !== "running",
      interpretation: status === "running"
        ? "The scan is still running; no clean result is implied."
        : "The broker terminal result, findings, and teardown ownership were persisted.",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
