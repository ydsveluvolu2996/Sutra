import { isCollectableAwsSourceKind } from "../../../../../lib/aws-connection-source";
import { FinopsActiveBillingQueryRepository } from "../../../../../db/finops-active-billing-query-repository";
import { FinopsSourceJobLedgerRepository } from "../../../../../db/finops-source-job-ledger-repository";
import { FinopsSourceSnapshotRepository } from "../../../../../db/finops-source-snapshot-repository";
import { getConnectionForOrg, getPilotStateForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { buildFinopsSourceReadiness } from "../../../../../lib/finops-source-health";
import { buildPersistedFinopsSourceEvidence } from "../../../../../lib/finops-source-health-evidence";
import { buildStoredFinopsSourceEvidence } from "../../../../../lib/finops-source-snapshot-evidence";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ALLOWED_QUERY_PARAMETERS = new Set(["connectionId"]);

function invalidRequest(): never {
  throw Object.assign(
    new Error("The FinOps source-readiness request is invalid"),
    { code: "INVALID_INPUT", status: 400 },
  );
}

export async function GET(request: Request): Promise<Response> {
  try {
    const parameters = new URL(request.url).searchParams;
    for (const key of parameters.keys()) {
      if (!ALLOWED_QUERY_PARAMETERS.has(key)) invalidRequest();
    }
    if (parameters.getAll("connectionId").length !== 1) invalidRequest();
    const connectionId = parameters.get("connectionId") ?? "";
    if (!CONNECTION_ID.test(connectionId)) invalidRequest();

    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (
      connection === null
      || !isCollectableAwsSourceKind(connection.sourceKind)
      || connection.status !== "active"
    ) {
      throw Object.assign(
        new Error("Cloud connection not found"),
        { code: "NOT_FOUND", status: 404 },
      );
    }
    assertSessionCapability(authenticated, "connection:read", connection.customerId);

    const scope = {
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId,
    };
    const billingRepository = new FinopsActiveBillingQueryRepository();
    const snapshotRepository = new FinopsSourceSnapshotRepository();
    const jobLedgerRepository = new FinopsSourceJobLedgerRepository();
    const [
      pilotState,
      activeBillingPartitions,
      activeSourceSnapshots,
      sourceJobSummary,
    ] = await Promise.all([
      getPilotStateForOrg(scope.orgId, connectionId),
      billingRepository.listActivePartitions(scope),
      snapshotRepository.listActiveSnapshots({
        organizationId: scope.orgId,
        customerId: scope.customerId,
        connectionId: scope.connectionId,
      }),
      jobLedgerRepository.summarize({
        organizationId: scope.orgId,
        customerId: scope.customerId,
        connectionId: scope.connectionId,
      }),
    ]);
    const baselineEvidence = buildPersistedFinopsSourceEvidence({
      scope,
      connection,
      pilotState,
      activeBillingPartitions,
    });
    const evidence = buildStoredFinopsSourceEvidence({
      scope,
      baselineEvidence,
      activeSnapshots: activeSourceSnapshots,
      latestAttempts: sourceJobSummary.sources.map(
        (source) => source.latestAttempt,
      ),
    });

    return jsonResponse(buildFinopsSourceReadiness({ scope, evidence }));
  } catch (error) {
    return errorResponse(error);
  }
}
