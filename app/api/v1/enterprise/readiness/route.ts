import { ComplianceWorkspaceRepository } from "../../../../../db/compliance-workspace-repository";
import { listComplianceExceptions } from "../../../../../db/compliance-exception-repository";
import { getLatestCostSnapshot } from "../../../../../db/cost-repository";
import { FinopsWorkspaceRepository } from "../../../../../db/finops-workspace-repository";
import { ItsmConnectorRepository } from "../../../../../db/itsm-connector-repository";
import { getPilotStateForOrg } from "../../../../../db/pilot-repository";
import { SecurityNotificationRepository } from "../../../../../db/security-notification-repository";
import { UptimeRepository } from "../../../../../db/uptime-repository";
import { VulnerabilityMirrorRepository } from "../../../../../db/vulnerability-mirror-repository";
import { requireConnectionScope } from "../../../../../lib/api-connection-scope";
import { buildComplianceReport } from "../../../../../lib/compliance-report";
import { buildEnterpriseActivationReadiness } from "../../../../../lib/enterprise-activation-readiness";
import {
  assessNotificationDeliveryHealth,
  withObservedNotificationReadiness,
} from "../../../../../lib/notification-delivery-health";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId")) {
      throw Object.assign(new Error("The enterprise readiness request is invalid"), { code: "INVALID_INPUT" });
    }
    const { connection, scope } = await requireConnectionScope(request, "connection:read");
    const finopsRepository = new FinopsWorkspaceRepository();
    const complianceRepository = new ComplianceWorkspaceRepository();
    const notificationRepository = new SecurityNotificationRepository();
    const now = Date.now();
    const workerConfigured = process.env.SUTRA_NOTIFICATION_WORKER_CONFIGURED === "true";

    const [
      state,
      periods,
      costSnapshot,
      signoffs,
      complianceExceptions,
      storedDestinations,
      jobs,
      connectors,
      threatFreshness,
      platform,
    ] = await Promise.all([
      getPilotStateForOrg(scope.orgId, connection.id),
      finopsRepository.listPeriods(scope, connection.id),
      getLatestCostSnapshot({ ...scope, connectionId: connection.id }),
      complianceRepository.listSignoffs(scope, connection.id),
      listComplianceExceptions({ ...scope, connectionId: connection.id }),
      notificationRepository.listDestinations(scope.orgId, scope.customerId),
      notificationRepository.listJobs(scope.orgId, scope.customerId),
      new ItsmConnectorRepository().list(scope),
      new VulnerabilityMirrorRepository().freshness(),
      new UptimeRepository().summarize(now),
    ]);
    const complianceReport = await buildComplianceReport(state, complianceExceptions, now);
    const assessment = complianceReport.assessment;
    const destinations = withObservedNotificationReadiness(
      storedDestinations,
      jobs,
      workerConfigured,
    );
    const notificationHealth = assessNotificationDeliveryHealth({
      destinations,
      jobs,
      workerConfigured,
      now,
    });
    const enabledConnectors = connectors.filter((connector) => connector.enabled);
    const bidirectionallyVerifiedConnectorCount = enabledConnectors.filter((connector) => {
      const updatedAt = Date.parse(connector.updatedAt);
      const outboundAt = connector.lastOutboundSuccessAt === null
        ? Number.NaN
        : Date.parse(connector.lastOutboundSuccessAt);
      const inboundAt = connector.lastAuthenticatedInboundAt === null
        ? Number.NaN
        : Date.parse(connector.lastAuthenticatedInboundAt);
      return (
        Number.isFinite(updatedAt) &&
        Number.isFinite(outboundAt) &&
        Number.isFinite(inboundAt) &&
        outboundAt > updatedAt &&
        inboundAt > updatedAt
      );
    }).length;

    return jsonResponse(buildEnterpriseActivationReadiness({
      now,
      connectionId: connection.id,
      finops: {
        curPeriodCount: periods.length,
        curLineCount: periods.reduce((total, period) => total + period.lineCount, 0),
        costStatus: costSnapshot?.payload.status ?? null,
        costCollectedAt: costSnapshot?.collectedAt ?? null,
        forecastStatus: costSnapshot?.payload.forecast.status ?? null,
      },
      compliance: {
        snapshotId: assessment.provenance.snapshotId,
        snapshotCollectedAt: assessment.provenance.snapshotCollectedAt,
        snapshotCoverageState: assessment.provenance.snapshotCoverageState,
        total: assessment.summary.total,
        fail: assessment.summary.fail,
        unknown: assessment.summary.unknown,
        approvedMfaSignoffCount: signoffs.filter(
          (signoff) =>
            signoff.decision === "approved" &&
            signoff.mfaVerified &&
            signoff.reportSha256 === complianceReport.reportSha256,
        ).length,
      },
      notifications: {
        state: notificationHealth.state,
        enabledDestinations: notificationHealth.enabledDestinations,
        configuredDestinations: notificationHealth.configuredDestinations,
        actionableJobs: notificationHealth.queued + notificationHealth.processing + notificationHealth.retrying,
        deadLetter: notificationHealth.deadLetter,
      },
      itsm: {
        connectorCount: connectors.length,
        enabledConnectorCount: enabledConnectors.length,
        // This is derived from persisted connector posture, not an environment
        // flag. One legacy/local credential keeps the domain from claiming
        // hosted readiness until it is rotated into the managed store.
        managedSecretBacked: enabledConnectors
          .every((connector) => connector.secretStorage === "managed"),
        bidirectionallyVerifiedConnectorCount,
      },
      threatIntelligence: {
        asOf: threatFreshness.asOf,
        cveCount: threatFreshness.count,
      },
      platformHealth: {
        overall: platform.overall,
      },
    }), {
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
