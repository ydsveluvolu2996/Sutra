import { env } from "cloudflare:workers";
import { EvidenceRepository } from "../../../../../db/evidence-repository";
import { FinopsSourceJobLedgerRepository } from "../../../../../db/finops-source-job-ledger-repository";
import { FinopsSourceSnapshotRepository } from "../../../../../db/finops-source-snapshot-repository";
import { FinopsWorkspaceRepository } from "../../../../../db/finops-workspace-repository";
import { JobQueueRepository } from "../../../../../db/job-queue-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { readBoundedJson } from "../../../../../lib/aws-pilot-security";
import {
  AWS_COST_ANOMALY_SOURCE_ID,
  buildCostAnomalyDashboard,
  parsePersistedAwsCostAnomalyMaterialization,
} from "../../../../../lib/finops-aws-cost-anomaly";
import { detectAnomalies } from "../../../../../lib/finops-insights";
import {
  enqueueAwsCostAnomalyCollection,
} from "../../../../../lib/finops-source-collect-job";
import { FinopsEvidenceReferenceSealer } from "../../../../../lib/finops-source-evidence-reference";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const BODY_BYTES = 4 * 1_024;
const STALE_AFTER_HOURS = 36;
const MAX_STATISTICAL_PERIODS = 3;
const MAX_STATISTICAL_LINES = 50_000;
const REQUIRED_PERMISSION_PACK = "standard-2026-08.1";
const ALLOWED_QUERY_PARAMETERS = new Set(["connectionId"]);

function invalidRequest(): never {
  throw Object.assign(
    new Error("The AWS Cost Anomaly Detection request is invalid"),
    { code: "INVALID_INPUT", status: 400 },
  );
}

function notFound(): never {
  throw Object.assign(
    new Error("Cloud connection not found"),
    { code: "NOT_FOUND", status: 404 },
  );
}

function parseConnectionId(request: Request): string {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) {
    if (!ALLOWED_QUERY_PARAMETERS.has(key)) invalidRequest();
  }
  if (parameters.getAll("connectionId").length !== 1) invalidRequest();
  const connectionId = parameters.get("connectionId") ?? "";
  if (!CONNECTION_ID.test(connectionId)) invalidRequest();
  return connectionId;
}

function publicDashboard(
  dashboard: ReturnType<typeof buildCostAnomalyDashboard>,
) {
  const monitorByArn = new Map(dashboard.aws.collection.monitors.map((monitor) =>
    [monitor.monitorArn, monitor] as const));
  return {
    aws: {
      source: dashboard.aws.source,
      status: dashboard.aws.collection.status,
      windowStartDate: dashboard.aws.collection.windowStartDate,
      windowEndDate: dashboard.aws.collection.windowEndDate,
      coverage: dashboard.aws.collection.coverage,
      anomalies: dashboard.aws.collection.anomalies.map((anomaly) => {
        const monitor = monitorByArn.get(anomaly.monitorArn);
        return {
          anomalyId: anomaly.anomalyId,
          startDate: anomaly.startDate,
          endDate: anomaly.endDate,
          feedback: anomaly.feedback,
          score: anomaly.score,
          impact: anomaly.impact,
          rootCauses: anomaly.rootCauses.map((cause) => ({
            service: cause.service,
            region: cause.region,
            linkedAccountId: cause.linkedAccountId,
            usageType: cause.usageType,
            contribution: cause.contribution,
          })),
          rootCausesOmitted: anomaly.rootCausesOmitted,
          monitorType: monitor?.type ?? null,
          monitorDimension: monitor?.dimension ?? null,
        };
      }),
      monitors: dashboard.aws.collection.monitors.map((monitor) => ({
        type: monitor.type,
        dimension: monitor.dimension,
        specificationPresent: monitor.specificationPresent,
        dimensionalValueCount: monitor.dimensionalValueCount,
        lastEvaluatedAt: monitor.lastEvaluatedAt,
      })),
      subscriptions: dashboard.aws.collection.subscriptions.map((subscription) => ({
        frequency: subscription.frequency,
        monitorCount: subscription.monitorArns.length,
        monitorArnsOmitted: subscription.monitorArnsOmitted,
        threshold: subscription.threshold,
        thresholdExpressionPresent: subscription.thresholdExpressionPresent,
        subscriberCounts: subscription.subscriberCounts,
      })),
      disclaimer: dashboard.aws.disclaimer,
    },
    sutra: dashboard.sutra,
    analysis: dashboard.analysis,
    disclaimer: dashboard.disclaimer,
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const connectionId = parseConnectionId(request);
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(
      authenticated.subject.orgId,
      connectionId,
    );
    if (
      connection === null
      || connection.sourceKind !== "aws_trust_role"
      || connection.status !== "active"
    ) notFound();
    assertSessionCapability(
      authenticated,
      "connection:read",
      connection.customerId,
    );

    const scope = {
      organizationId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: connection.id,
    };
    const snapshots = new FinopsSourceSnapshotRepository();
    const ledger = new FinopsSourceJobLedgerRepository();
    const [activeSnapshot, latestSnapshot, summary] = await Promise.all([
      snapshots.getActiveSnapshot(scope, AWS_COST_ANOMALY_SOURCE_ID),
      snapshots.getLatestSnapshot(scope, AWS_COST_ANOMALY_SOURCE_ID),
      ledger.summarize(scope, AWS_COST_ANOMALY_SOURCE_ID),
    ]);
    const latestAttempt = summary.sources[0]?.latestAttempt ?? null;
    const selectedSnapshot = latestAttempt?.status === "partial"
      && latestSnapshot?.jobId === latestAttempt.jobId
      && latestSnapshot.attempt === latestAttempt.attempt
      ? latestSnapshot
      : activeSnapshot ?? latestSnapshot;
    const noMaterializationState = latestAttempt?.status === "failed"
      || latestAttempt?.status === "cancelled"
      ? "failed"
      : latestAttempt?.status === "partial"
        ? "partial"
        : "waiting";
    if (selectedSnapshot === null) {
      return jsonResponse({
        source: "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION",
        state: noMaterializationState,
        latestAttemptStatus: latestAttempt?.status ?? null,
        collectedAt: null,
        dataThroughAt: null,
        freshness: { ageHours: null, staleAfterHours: STALE_AFTER_HOURS },
        dashboard: null,
        sutraInput: { periods: [], lineCount: 0, capped: false },
      });
    }

    try {
      const sealer = await FinopsEvidenceReferenceSealer.fromEnvironment(
        env as unknown as Readonly<Record<string, string | undefined>>,
      );
      const objectId = await sealer.open(selectedSnapshot.evidenceReference, {
        organizationId: scope.organizationId,
        customerId: scope.customerId,
        connectionId: scope.connectionId,
        sourceId: AWS_COST_ANOMALY_SOURCE_ID,
        generationId: selectedSnapshot.generationId,
      });
      const stored = await new EvidenceRepository().readFinopsSourceSnapshot({
        scope: {
          orgId: scope.organizationId,
          customerId: scope.customerId,
          connectionId: scope.connectionId,
        },
        objectId,
        snapshotId: selectedSnapshot.generationId,
        contentSha256: selectedSnapshot.contentSha256,
      });
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(stored.body);
      const collection = parsePersistedAwsCostAnomalyMaterialization(
        JSON.parse(decoded) as unknown,
        { accountId: connection.awsAccountId, partition: connection.partition },
      );
      if (
        collection.collectedAt !== selectedSnapshot.collectedAtIso
        || collection.dataThroughAt !== selectedSnapshot.dataThroughAtIso
      ) throw new Error("persisted materialization mismatch");

      const workspace = new FinopsWorkspaceRepository();
      const workspaceScope = {
        orgId: scope.organizationId,
        customerId: scope.customerId,
      };
      const availablePeriods = await workspace.listPeriods(
        workspaceScope,
        scope.connectionId,
      );
      const selectedPeriods: string[] = [];
      let expectedLines = 0;
      let capped = false;
      for (const period of availablePeriods) {
        if (selectedPeriods.length >= MAX_STATISTICAL_PERIODS) {
          capped = true;
          break;
        }
        if (
          selectedPeriods.length > 0
          && expectedLines + period.lineCount > MAX_STATISTICAL_LINES
        ) {
          capped = true;
          break;
        }
        selectedPeriods.push(period.period);
        expectedLines += Math.min(period.lineCount, MAX_STATISTICAL_LINES);
        if (expectedLines >= MAX_STATISTICAL_LINES) {
          capped = period.lineCount > MAX_STATISTICAL_LINES
            || selectedPeriods.length < availablePeriods.length;
          break;
        }
      }
      const statisticalLines = (await Promise.all(
        selectedPeriods.map((period) => workspace.linesForPeriod(
          workspaceScope,
          scope.connectionId,
          period,
        )),
      )).flat().slice(0, MAX_STATISTICAL_LINES);
      const dashboard = buildCostAnomalyDashboard(
        collection,
        detectAnomalies(statisticalLines),
      );
      const ageHours = collection.dataThroughAt === null
        ? null
        : Math.max(0, (Date.now() - Date.parse(collection.dataThroughAt)) / 3_600_000);
      const state = latestAttempt?.status === "failed"
        || latestAttempt?.status === "cancelled"
        ? "failed"
        : latestAttempt?.status === "partial"
          ? "partial"
          : latestAttempt?.status === "queued"
            || latestAttempt?.status === "running"
            ? "waiting"
          : ageHours === null || ageHours > STALE_AFTER_HOURS
            ? "stale"
            : "complete";
      return jsonResponse({
        source: "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION",
        state,
        latestAttemptStatus: latestAttempt?.status ?? null,
        collectedAt: collection.collectedAt,
        dataThroughAt: collection.dataThroughAt,
        freshness: {
          ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
          staleAfterHours: STALE_AFTER_HOURS,
        },
        dashboard: publicDashboard(dashboard),
        sutraInput: {
          periods: selectedPeriods,
          lineCount: statisticalLines.length,
          capped,
        },
      });
    } catch {
      return jsonResponse({
        source: "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION",
        state: "failed",
        latestAttemptStatus: latestAttempt?.status ?? null,
        collectedAt: selectedSnapshot.collectedAtIso,
        dataThroughAt: selectedSnapshot.dataThroughAtIso,
        freshness: { ageHours: null, staleAfterHours: STALE_AFTER_HOURS },
        dashboard: null,
        sutraInput: { periods: [], lineCount: 0, capped: false },
      });
    }
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const authenticated = await requireApiSession(request);
    const body = await readBoundedJson(request, BODY_BYTES);
    if (
      typeof body !== "object"
      || body === null
      || Array.isArray(body)
      || Object.keys(body).length !== 1
      || !("connectionId" in body)
      || typeof body.connectionId !== "string"
      || !CONNECTION_ID.test(body.connectionId)
    ) invalidRequest();
    const connection = await getConnectionForOrg(
      authenticated.subject.orgId,
      body.connectionId,
    );
    if (
      connection === null
      || connection.sourceKind !== "aws_trust_role"
      || connection.status !== "active"
    ) notFound();
    assertSessionCapability(authenticated, "sync:run", connection.customerId);
    if (connection.permissionPackVersion !== REQUIRED_PERMISSION_PACK) {
      throw Object.assign(
        new Error("The AWS Cost Anomaly Detection permission contract is not active"),
        { code: "INVALID_STATE", status: 409 },
      );
    }
    const queued = await enqueueAwsCostAnomalyCollection(
      new JobQueueRepository(),
      {
        organizationId: authenticated.subject.orgId,
        customerId: connection.customerId,
        connectionId: connection.id,
      },
    );
    return jsonResponse({ ok: true, jobId: queued.jobId }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
