import { env } from "cloudflare:workers";
import type { JobHandler, RunnableJob } from "../lib/background-job-runner.ts";
import { deliverItsmTicket } from "../lib/itsm-delivery.ts";
import type { CaseStatusLike, ItsmCaseLike } from "../lib/itsm-sync.ts";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";
import { buildAllocation, detectAnomalies, evaluateBudgets, type BudgetDefinition } from "../lib/finops-insights.ts";
import {
  deliverScheduledReport,
  type ReportDeliveryEnv,
  type ReportDeliveryResult,
  type ScheduledReportEnvelope,
} from "../lib/finops-report-delivery.ts";
import { nextRunAtIso } from "../lib/finops-report-schedule.ts";
import {
  describeFiredAlert,
  evaluateAlertRules,
  type AlertMetricMap,
  type AlertRule,
  type AlertRuleEvaluation,
  type AlertRuleScope,
} from "../lib/alert-rules.ts";
import {
  assembleAlertMetrics,
  DEFAULT_NEW_FINDING_WINDOW_MS,
  type AlertMetricSignals,
  type CloudFindingSignals,
  type OpenFindingSignal,
  type PostureSignal,
} from "../lib/alert-metrics.ts";
import { isKnownExploited, KEV_AS_OF } from "../lib/kev-snapshot.ts";
import {
  buildSecurityNotificationPayloads,
  normalizeSecurityNotificationEvent,
} from "../lib/security-notifications.ts";
import { buildMspScorecard } from "../lib/kubernetes-posture-trend.ts";
import { addCaseNote } from "./case-repository";
import { AlertRuleRepository, type RecordAlertEventInput } from "./alert-rule-repository";
import { AgentlessScanRepository } from "./agentless-scan-repository";
import { CloudVulnerabilityRepository } from "./cloud-vulnerability-repository";
import { FinopsScheduledReportRepository, type ReportDeliveryKind } from "./finops-scheduled-report-repository";
import { FinopsWorkspaceRepository } from "./finops-workspace-repository";
import { FinopsBillingEngineRepository } from "./finops-billing-engine-repository";
import {
  ITSM_SECRET_CLEANUP_JOB_KIND,
  ItsmConnectorRepository,
} from "./itsm-connector-repository";
import { JobQueueRepository } from "./job-queue-repository";
import { KubernetesRepository } from "./kubernetes-repository";
import {
  appendAuditEvent,
  createSyncRun,
  failSyncRun,
  getConnectionForOrg,
  getLatestConnectionForOrg,
  listHostedCollectorOperationRuns,
  listActiveAwsConnectionsForCustomer,
  listConnectionsForOrg,
  markConnectionNeedsAttention,
  persistSnapshot,
} from "./pilot-repository";
import {
  HOSTED_COLLECTOR_COLLECT_JOB_KIND,
  runHostedCollectorJob,
} from "../lib/hosted-collector-job";
import { HOSTED_BROKER_INGEST_JOB_KIND } from "../lib/hosted-broker-ingest";
import { runHostedBrokerIngestJob } from "../lib/hosted-broker-ingest-job";
import { RetentionSweepRepository } from "./retention-sweep-repository";
import { SecurityNotificationRepository } from "./security-notification-repository";
import {
  enqueueFinopsAlert,
  evaluateFinopsAlertsForCustomer,
  recipientsForDestination,
} from "./finops-alert-service";
import type { FinopsAlert } from "../lib/finops-alerts.ts";
import { runUptimeProbeJob, buildUptimeProbeDeps } from "../lib/uptime-probe-handler";
import { requiredConfiguredPublicOrigin } from "../lib/api-auth";
import { planVulnFeedRefresh } from "../lib/vuln-feed-refresh-schedule";
import { refreshBoundedVulnerabilityFeed } from "../lib/vuln-feed-runtime";
import type { ManagedOutboundEnvironment } from "../lib/managed-outbound-fetch";
import { VulnerabilityMirrorRepository } from "./vulnerability-mirror-repository";
import {
  requestAgentlessTeardownSweep,
  runCollectorSync,
  runFinopsExportChunkRead,
  runFinopsSourceCollection,
  runSignedOrganizationsTaxonomy,
  safeCollectionFailureCode,
} from "../lib/pilot-server";
import {
  createFinopsBrokerObjectReader,
} from "../lib/finops-broker-object-reader";
import {
  FINOPS_DATA_EXPORT_INGEST_JOB_KIND,
  runFinopsDataExportIngestJob,
} from "../lib/finops-data-export-ingest-job";
import {
  FINOPS_SOURCE_COLLECT_JOB_KIND,
  runFinopsSourceCollectJob,
} from "../lib/finops-source-collect-job";
import { FinopsEvidenceReferenceSealer } from "../lib/finops-source-evidence-reference";
import {
  FINOPS_TA_ORGANIZATION_ACTIVATE_JOB_KIND,
  TRUSTED_ADVISOR_ORGANIZATIONS_TAXONOMY_OPERATIONS,
  TRUSTED_ADVISOR_STANDARD_SOURCE_ID,
  runTrustedAdvisorAccountCollectionJob,
  runTrustedAdvisorManifestFinalizeJob,
  runTrustedAdvisorOrganizationActivationJob,
  type TrustedAdvisorServerConnection,
} from "../lib/finops-trusted-advisor-standard-orchestration";
import {
  FINOPS_TA_ACCOUNT_COLLECT_JOB_KIND,
  FINOPS_TA_MANIFEST_FINALIZE_JOB_KIND,
} from "../lib/finops-trusted-advisor-organization-job";
import {
  createTrustedAdvisorTaxonomySignatureVerifier,
} from "../lib/finops-trusted-advisor-taxonomy-kms";
import { FinopsSourceJobLedgerRepository } from "./finops-source-job-ledger-repository";
import { FinopsSourceSnapshotRepository } from "./finops-source-snapshot-repository";
import { TrustedAdvisorOrganizationRepository } from "./finops-trusted-advisor-organization-repository";
import { EvidenceRepository } from "./evidence-repository";

const CASE_STATUSES: ReadonlySet<CaseStatusLike> = new Set<CaseStatusLike>([
  "open", "investigating", "resolved", "accepted_risk",
]);

const TRUSTED_ADVISOR_ORGANIZATIONS_CONTRACT_ID =
  "aws-organizations-taxonomy-read-v1";
const TRUSTED_ADVISOR_ADVANCED_PERMISSION_PACK = "standard-2026-08.2";

function trustedAdvisorServerConnection(
  organizationId: string,
  connection: Awaited<ReturnType<typeof getConnectionForOrg>>,
): TrustedAdvisorServerConnection | null {
  if (
    connection === null
    || connection.sourceKind !== "aws_trust_role"
    || connection.status !== "active"
    || connection.partition !== "aws"
    || connection.permissionPackVersion !== TRUSTED_ADVISOR_ADVANCED_PERMISSION_PACK
  ) return null;
  return {
    organizationId,
    customerId: connection.customerId,
    connectionId: connection.id,
    awsAccountId: connection.awsAccountId,
    partition: connection.partition,
    sourceKind: connection.sourceKind,
    status: connection.status,
  };
}

/** Production composition for the signed Organizations activation job. */
export async function runTrustedAdvisorOrganizationActivationHandler(
  job: RunnableJob,
): Promise<void> {
  const repository = new TrustedAdvisorOrganizationRepository();
  const verifier = createTrustedAdvisorTaxonomySignatureVerifier(
    env as unknown as Readonly<Record<string, string | undefined>>,
  );
  await runTrustedAdvisorOrganizationActivationJob(job, {
    repository,
    queue: new JobQueueRepository(),
    getAnchorConnection: async (scope) => trustedAdvisorServerConnection(
      scope.organizationId,
      await getConnectionForOrg(scope.organizationId, scope.connectionId),
    ),
    listCustomerConnections: async (scope) => (await listActiveAwsConnectionsForCustomer(
      scope.organizationId,
      scope.customerId,
      TRUSTED_ADVISOR_ADVANCED_PERMISSION_PACK,
    )).flatMap((connection) => {
      const mapped = trustedAdvisorServerConnection(scope.organizationId, connection);
      return mapped === null ? [] : [mapped];
    }),
    collectSignedTaxonomy: (input) => {
      if (input.operations !== TRUSTED_ADVISOR_ORGANIZATIONS_TAXONOMY_OPERATIONS) {
        throw new Error("trusted-advisor-taxonomy-operations-invalid");
      }
      return runSignedOrganizationsTaxonomy({
        tenantId: input.scope.organizationId,
        customerId: input.scope.customerId,
        connectionId: input.scope.connectionId,
        jobId: job.id,
        contractId: TRUSTED_ADVISOR_ORGANIZATIONS_CONTRACT_ID,
      });
    },
    verifyTaxonomySignature: verifier.verify,
    expectedSignerKeyId: verifier.expectedSignerKeyId,
    now: Date.now,
  });
}

/** Production composition for one frozen member-account standard-check job. */
export async function runTrustedAdvisorAccountCollectionHandler(
  job: RunnableJob,
): Promise<void> {
  const repository = new TrustedAdvisorOrganizationRepository();
  const snapshots = new FinopsSourceSnapshotRepository();
  const evidence = new EvidenceRepository();
  const sealer = await FinopsEvidenceReferenceSealer.fromEnvironment(
    env as unknown as Readonly<Record<string, string | undefined>>,
  );
  await runTrustedAdvisorAccountCollectionJob(job, {
    repository,
    queue: new JobQueueRepository(),
    findManifest: (input) => repository.getManifestByIdentity(input),
    collectCompletedStandardChecks: async (input) => {
      const sourceJob: RunnableJob = {
        ...job,
        connectionId: input.connectionId,
        kind: FINOPS_SOURCE_COLLECT_JOB_KIND,
        payload: {
          connectionId: input.connectionId,
          sourceId: input.sourceId,
          contractId: input.contractId,
        },
      };
      await runFinopsSourceCollectJob(sourceJob, {
        getConnection: (organizationId, connectionId) =>
          getConnectionForOrg(organizationId, connectionId),
        collect: runFinopsSourceCollection,
        ledger: new FinopsSourceJobLedgerRepository(),
        evidence,
        snapshots,
        evidenceReferenceSealer: sealer,
        now: Date.now,
      });
      const scope = {
        organizationId: input.organizationId,
        customerId: input.customerId,
        connectionId: input.connectionId,
      };
      const snapshot = await snapshots.getSnapshotForAttempt(
        scope,
        TRUSTED_ADVISOR_STANDARD_SOURCE_ID,
        input.orchestrationJobId,
        input.attempt,
      );
      if (
        snapshot === null
        || (snapshot.status !== "complete" && snapshot.status !== "partial")
        || snapshot.sourceId !== TRUSTED_ADVISOR_STANDARD_SOURCE_ID
      ) throw new Error("trusted-advisor-standard-snapshot-unavailable");
      const objectId = await sealer.open(snapshot.evidenceReference, {
        ...scope,
        sourceId: TRUSTED_ADVISOR_STANDARD_SOURCE_ID,
        generationId: snapshot.generationId,
      });
      const stored = await evidence.readFinopsSourceSnapshot({
        scope: {
          orgId: scope.organizationId,
          customerId: scope.customerId,
          connectionId: scope.connectionId,
        },
        objectId,
        snapshotId: snapshot.generationId,
        contentSha256: snapshot.contentSha256,
      });
      return {
        snapshot: {
          ...snapshot,
          sourceId: TRUSTED_ADVISOR_STANDARD_SOURCE_ID,
          status: snapshot.status,
          schemaVersion: "sutra.finops-source-evidence.v2" as const,
        },
        verifiedBody: stored.body,
      };
    },
    now: Date.now,
  });
}

/** Production composition for the retrying manifest finalizer. */
export async function runTrustedAdvisorManifestFinalizeHandler(
  job: RunnableJob,
): Promise<void> {
  const repository = new TrustedAdvisorOrganizationRepository();
  await runTrustedAdvisorManifestFinalizeJob(job, {
    repository,
    findManifest: (input) => repository.getManifestByIdentity(input),
    now: Date.now,
  });
}

interface ItsmDispatchPayload {
  readonly customerId: string;
  readonly connectionId: string;
  readonly connectorId: string;
  readonly connectorName: string;
  readonly actorUserId: string;
  readonly itsmCase: ItsmCaseLike;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseItsmCase(value: unknown): ItsmCaseLike | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const caseId = asString(record.caseId);
  const title = asString(record.title);
  const severity = asString(record.severity);
  const priority = asString(record.priority);
  const summary = typeof record.summary === "string" ? record.summary : null;
  const status = record.status;
  if (
    caseId === null || title === null || severity === null || priority === null || summary === null ||
    typeof status !== "string" || !CASE_STATUSES.has(status as CaseStatusLike)
  ) return null;
  return { caseId, title, summary, severity, priority, status: status as CaseStatusLike };
}

function parseItsmDispatchPayload(payload: unknown): ItsmDispatchPayload | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const customerId = asString(record.customerId);
  const connectionId = asString(record.connectionId);
  const connectorId = asString(record.connectorId);
  const connectorName = asString(record.connectorName);
  const actorUserId = asString(record.actorUserId);
  const itsmCase = parseItsmCase(record.itsmCase);
  if (customerId === null || connectionId === null || connectorId === null || connectorName === null || actorUserId === null || itsmCase === null) {
    return null;
  }
  return { customerId, connectionId, connectorId, connectorName, actorUserId, itsmCase };
}

function deliveryOutcome(result: { readonly delivered: boolean; readonly statusCode?: number; readonly error?: string }): string {
  if (result.delivered) return `delivered (${result.statusCode})`;
  if (result.statusCode === undefined) return `failed (${result.error ?? "dispatch-error"})`;
  return `rejected (${result.statusCode})`;
}

async function runItsmDispatch(job: RunnableJob): Promise<void> {
  const payload = parseItsmDispatchPayload(job.payload);
  if (payload === null) throw new Error("itsm-dispatch-payload-invalid");
  const connector = await new ItsmConnectorRepository().getForDispatch(
    { orgId: job.orgId, customerId: payload.customerId },
    payload.connectorId,
  );
  if (connector === null || !connector.enabled) throw new Error("itsm-connector-unavailable");
  const result = await deliverItsmTicket({
    connector: {
      baseUrl: connector.baseUrl,
      sharedSecret: connector.sharedSecret,
      connectorType: connector.connectorType,
      projectKey: connector.projectKey,
    },
    itsmCase: payload.itsmCase,
    environment: env as unknown as ManagedOutboundEnvironment,
  });
  if (result.delivered) {
    await new ItsmConnectorRepository().recordOutboundSuccess(
      { orgId: job.orgId, customerId: payload.customerId },
      connector.id,
      connector.updatedAt,
    );
  }
  const outcome = deliveryOutcome(result);
  await addCaseNote({
    orgId: job.orgId,
    customerId: payload.customerId,
    connectionId: payload.connectionId,
    caseId: payload.itsmCase.caseId,
    actorUserId: payload.actorUserId,
    note: `ITSM dispatch (durable retry) to '${connector.name}' ${outcome}.`,
  });
  // Rethrow on a non-delivery so the queue's own backoff/dead-letter policy
  // decides the next attempt — the note above records what actually happened.
  if (!result.delivered) throw new Error(`itsm-dispatch ${outcome}`);
}

export async function runItsmSecretCleanupJob(
  job: RunnableJob,
  repository: Pick<ItsmConnectorRepository, "cleanupDeletedManagedSecret"> =
    new ItsmConnectorRepository(),
): Promise<void> {
  if (
    job.customerId === null ||
    typeof job.payload !== "object" ||
    job.payload === null ||
    Array.isArray(job.payload)
  ) {
    throw new Error("itsm-secret-cleanup-payload-invalid");
  }
  const payload = job.payload as Record<string, unknown>;
  if (
    Object.keys(payload).some((key) => key !== "connectorId" && key !== "secretReference") ||
    typeof payload.connectorId !== "string" ||
    !/^itc_[a-f0-9]{32}$/u.test(payload.connectorId) ||
    typeof payload.secretReference !== "string" ||
    payload.secretReference.length > 512
  ) {
    throw new Error("itsm-secret-cleanup-payload-invalid");
  }
  await repository.cleanupDeletedManagedSecret(
    { orgId: job.orgId, customerId: job.customerId },
    payload.connectorId,
    payload.secretReference,
  );
}

const REPORT_ID = /^fsr_[a-f0-9]{32}$/u;
const REPORT_CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

const SCHEDULED_REPORT_DISCLAIMER =
  "Scheduled cost report over the latest persisted billing period for this " +
  "connection. Currencies are never summed together; anomalies are statistical " +
  "signals, not billing truth; and the report is marked delivered only when the " +
  "configured transport returned a 2xx response.";

interface ScheduledReportPayload {
  readonly scheduleId: string;
  readonly connectionId: string;
  readonly name: string;
  readonly deliveryKind: ReportDeliveryKind;
  readonly deliveryTarget: string;
}

function parseScheduledReportPayload(payload: unknown): ScheduledReportPayload | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const scheduleId = asString(record.scheduleId);
  const connectionId = asString(record.connectionId);
  const name = asString(record.name);
  const deliveryTarget = asString(record.deliveryTarget);
  const deliveryKind = record.deliveryKind;
  if (
    scheduleId === null || !REPORT_ID.test(scheduleId) ||
    connectionId === null || !REPORT_CONNECTION_ID.test(connectionId) ||
    name === null || deliveryTarget === null ||
    (deliveryKind !== "webhook" && deliveryKind !== "email")
  ) return null;
  return { scheduleId, connectionId, name, deliveryKind, deliveryTarget };
}

/** Compose the immutable report envelope from the pure FinOps engines. */
function buildReportEnvelope(input: {
  readonly name: string;
  readonly connectionId: string;
  readonly period: string | null;
  readonly lines: readonly NormalizedCurLine[];
  readonly budgets: readonly BudgetDefinition[];
  readonly nowMs: number;
}): ScheduledReportEnvelope {
  const allocation = buildAllocation(input.lines, "service");
  const budgetEvaluations = evaluateBudgets(input.lines, input.budgets);
  const anomalies = detectAnomalies(input.lines);
  return {
    schema: "sutra.finops-scheduled-report.v1",
    scheduleName: input.name,
    connectionId: input.connectionId,
    period: input.period,
    lineCount: input.lines.length,
    currencyTotals: allocation.map((entry) => ({ currency: entry.currency, totalMicros: entry.totalMicros })),
    budgetStates: budgetEvaluations.map((entry) => ({ name: entry.name, state: entry.state, spentMicros: entry.spentMicros })),
    anomalyCount: anomalies.anomalies.length,
    generatedAt: new Date(input.nowMs).toISOString(),
    disclaimer: SCHEDULED_REPORT_DISCLAIMER,
  };
}

/** Injectable dependencies so the render->deliver path is unit-testable. */
export interface ScheduledReportRunDeps {
  readonly scheduleRepo: Pick<FinopsScheduledReportRepository, "get">;
  readonly finopsRepo: Pick<FinopsWorkspaceRepository, "listPeriods" | "linesForPeriod" | "listBudgets">;
  readonly deliver: (
    kind: ReportDeliveryKind,
    target: string,
    envelope: ScheduledReportEnvelope,
  ) => Promise<ReportDeliveryResult>;
  readonly now: () => number;
}

/**
 * Build the latest-period cost summary for a due schedule and deliver it. The
 * FinOps computation is REUSED from the pure engines (buildAllocation /
 * evaluateBudgets / detectAnomalies) over the persisted CUR lines — nothing is
 * recomputed here. Delivery honesty: a configured transport that did not accept
 * the report rethrows so the queue governs the retry; an unconfigured transport
 * ('none') is an honest non-delivery with nothing to retry.
 */
export async function runScheduledReportJob(job: RunnableJob, deps: ScheduledReportRunDeps): Promise<void> {
  const payload = parseScheduledReportPayload(job.payload);
  if (payload === null) throw new Error("finops-scheduled-report-payload-invalid");
  if (job.customerId === null) throw new Error("finops-scheduled-report-requires-customer");
  const scope = { orgId: job.orgId, customerId: job.customerId };
  const schedule = await deps.scheduleRepo.get(scope, payload.scheduleId);
  // Disabled or removed between enqueue and run: honest no-op, nothing to send.
  if (schedule === null || !schedule.enabled) return;
  const periods = await deps.finopsRepo.listPeriods(scope, payload.connectionId);
  const period = periods[0]?.period ?? null;
  const lines = period === null
    ? []
    : await deps.finopsRepo.linesForPeriod(scope, payload.connectionId, period);
  const budgets = await deps.finopsRepo.listBudgets(scope);
  const envelope = buildReportEnvelope({
    name: schedule.name,
    connectionId: payload.connectionId,
    period,
    lines,
    budgets,
    nowMs: deps.now(),
  });
  const result = await deps.deliver(payload.deliveryKind, payload.deliveryTarget, envelope);
  if (!result.delivered && result.transport !== "none") {
    throw new Error(`finops-scheduled-report delivery via ${result.transport} was not accepted`);
  }
}

function reportDeliveryEnv(): ReportDeliveryEnv {
  return env as unknown as ReportDeliveryEnv;
}

// --- Metric alerting -------------------------------------------------------

export interface AlertDispatchInput {
  readonly scope: AlertRuleScope;
  readonly evaluation: AlertRuleEvaluation;
  readonly message: string;
  readonly firedAtMs: number;
}

export interface AlertDispatchOutcome {
  readonly deliveryState: "queued" | "no_destination";
  readonly destinationCount: number;
}

/** Injected dependencies so the evaluate -> record -> dispatch path is unit-testable. */
export interface AlertEvaluationRunDeps {
  readonly loadEnabledRules: (scope: AlertRuleScope) => Promise<readonly AlertRule[]>;
  readonly loadMetrics: (scope: AlertRuleScope) => Promise<AlertMetricMap>;
  readonly recordEvent: (input: RecordAlertEventInput) => Promise<unknown>;
  readonly dispatch: (input: AlertDispatchInput) => Promise<AlertDispatchOutcome>;
  readonly now: () => number;
}

export interface AlertEvaluationSummary {
  readonly rulesEvaluated: number;
  readonly fired: number;
  readonly dispatched: number;
}

const MAX_ALERT_MESSAGE = 2_000;
/**
 * Evaluate a tenant's enabled alert rules against freshly assembled metrics,
 * record each firing, and dispatch it through the EXISTING notification system.
 * Honesty is enforced by the pure evaluator (an unavailable metric never fires)
 * and preserved here: the delivery_state recorded is exactly what dispatch
 * reported — a firing with no configured destination is recorded as
 * 'no_destination', never faked as delivered.
 */
export async function runAlertEvaluationJob(
  job: RunnableJob,
  deps: AlertEvaluationRunDeps,
): Promise<AlertEvaluationSummary> {
  if (job.customerId === null) throw new Error("alert-evaluation-requires-customer");
  const scope: AlertRuleScope = { orgId: job.orgId, customerId: job.customerId };
  const rules = await deps.loadEnabledRules(scope);
  if (rules.length === 0) return { rulesEvaluated: 0, fired: 0, dispatched: 0 };
  const metrics = await deps.loadMetrics(scope);
  const evaluations = evaluateAlertRules(rules, metrics);
  let fired = 0;
  let dispatched = 0;
  for (const evaluation of evaluations) {
    // The pure evaluator already refuses to fire on an unavailable metric; the
    // observedValue guard is a belt-and-braces check before we persist a number.
    if (!evaluation.fired || evaluation.observedValue === null) continue;
    fired += 1;
    const firedAtMs = deps.now();
    const message = describeFiredAlert(evaluation).slice(0, MAX_ALERT_MESSAGE);
    const outcome = await deps.dispatch({ scope, evaluation, message, firedAtMs });
    if (outcome.deliveryState === "queued") dispatched += 1;
    await deps.recordEvent({
      orgId: scope.orgId,
      customerId: scope.customerId,
      ruleId: evaluation.rule.id,
      observedValue: evaluation.observedValue,
      message,
      deliveryState: outcome.deliveryState,
      destinationCount: outcome.destinationCount,
    });
  }
  return { rulesEvaluated: evaluations.length, fired, dispatched };
}

async function safeSignal<T>(load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch {
    // A source that cannot be read is honestly reported as unavailable (the
    // metric it backs never fires) rather than failing the whole tenant's tick.
    return undefined;
  }
}

/**
 * Live metric collector: reuse the pure FinOps engines over the latest ingested
 * billing period, the cloud vulnerability findings joined to the CISA KEV
 * catalog, and the Kubernetes posture scorecard. Each source is best-effort and
 * only contributes a signal when it genuinely has data; missing sources leave
 * their metrics unavailable, which the assembler discloses.
 */
export async function collectLiveTenantMetrics(scope: AlertRuleScope): Promise<AlertMetricMap> {
  const nowMs = Date.now();
  const signals: {
    budgets?: AlertMetricSignals["budgets"];
    anomalies?: AlertMetricSignals["anomalies"];
    cloudFindings?: CloudFindingSignals;
    posture?: PostureSignal;
  } = {};

  const finops = await safeSignal(async () => {
    const connection = await getLatestConnectionForOrg(scope.orgId);
    if (connection === null || connection.customerId !== scope.customerId) return null;
    const repo = new FinopsWorkspaceRepository();
    const budgets = await repo.listBudgets(scope);
    const periods = await repo.listPeriods(scope, connection.id);
    const lines = periods.length > 0
      ? await repo.linesForPeriod(scope, connection.id, periods[0].period)
      : [];
    return { budgets: evaluateBudgets(lines, budgets), anomalies: detectAnomalies(lines) };
  });
  if (finops !== null && finops !== undefined) {
    signals.budgets = finops.budgets;
    signals.anomalies = finops.anomalies;
  }

  const cloudFindings = await safeSignal(async () => {
    const connections = (await listConnectionsForOrg(scope.orgId))
      .filter((connection) => connection.customerId === scope.customerId);
    if (connections.length === 0) return undefined;
    const repo = new CloudVulnerabilityRepository();
    const openFindings: OpenFindingSignal[] = [];
    for (const connection of connections) {
      const findings = await repo.listForConnection(scope, connection.id);
      for (const finding of findings) {
        openFindings.push({
          severity: finding.severity,
          firstSeenMs: finding.firstSeenMs,
          knownExploited: isKnownExploited(finding.cveId),
        });
      }
    }
    // An empty set cannot be distinguished from "never scanned", so we do not
    // claim a 0 observation; the metric stays unavailable instead.
    if (openFindings.length === 0) return undefined;
    return {
      openFindings,
      asOfMs: nowMs,
      newWindowMs: DEFAULT_NEW_FINDING_WINDOW_MS,
      kevAsOf: KEV_AS_OF,
    } satisfies CloudFindingSignals;
  });
  if (cloudFindings !== undefined) signals.cloudFindings = cloudFindings;

  const posture = await safeSignal(async () => {
    const repo = new KubernetesRepository();
    const clusters = await repo.listClusters(scope);
    if (clusters.length === 0) return undefined;
    const scorecardClusters = await Promise.all(clusters.map(async (cluster) => ({
      clusterId: cluster.id,
      clusterName: cluster.name,
      points: (await repo.listPostureTrend(scope, cluster.id)).map((point) => ({
        scanId: point.scanId,
        collectedAt: point.collectedAt,
        status: point.status,
        resourceCount: point.resourceCount,
        findingCount: point.findingCount,
        coverageCount: point.coverageCount,
        severity: point.severity,
      })),
    })));
    const scorecard = buildMspScorecard({ clusters: scorecardClusters });
    return {
      averageScore: scorecard.fleet.averageScore,
      scoredClusterCount: scorecard.clusters.filter((row) => row.score !== null).length,
    } satisfies PostureSignal;
  });
  if (posture !== undefined) signals.posture = posture;

  return assembleAlertMetrics(signals);
}

function alertEventId(): string {
  return `notify_${(crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "").slice(0, 48)}`;
}

async function alertEvidenceHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function alertText(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, maximum).trim();
}

/**
 * Dispatch a fired alert by enqueuing it into the EXISTING security-notification
 * outbox for each of the tenant's enabled destinations (optionally narrowed to
 * the rule's destinationRef). No new transport is introduced — the outbox worker
 * performs delivery. With no configured destination this returns 'no_destination'
 * so the caller records an honest non-delivery.
 */
export async function dispatchFiredAlert(input: AlertDispatchInput): Promise<AlertDispatchOutcome> {
  const repository = new SecurityNotificationRepository();
  const enabled = (await repository.listDestinations(input.scope.orgId, input.scope.customerId))
    .filter((destination) => destination.enabled);
  const ref = input.evaluation.rule.destinationRef;
  const targets = ref === undefined || ref === null
    ? enabled
    : enabled.filter((destination) => destination.id === ref);
  if (targets.length === 0) return { deliveryState: "no_destination", destinationCount: 0 };
  const rule = input.evaluation.rule;
  const title = alertText(rule.name, 200);
  const summary = alertText(input.message, 1_000);
  const publicOrigin = requiredConfiguredPublicOrigin();
  let enqueued = 0;
  for (const destination of targets) {
    const event = normalizeSecurityNotificationEvent({
      eventId: alertEventId(),
      orgId: input.scope.orgId,
      customerId: input.scope.customerId,
      clusterId: `alert:${rule.metric}`,
      severity: rule.severity,
      title,
      summary,
      occurredAt: new Date(input.firedAtMs).toISOString(),
      findingCount: 1,
      reportUrl: `${publicOrigin}/alerts`,
      evidenceSha256: await alertEvidenceHash(
        `${input.scope.orgId}\u0000${input.scope.customerId}\u0000${rule.id}\u0000${input.firedAtMs}\u0000${input.evaluation.observedValue}`,
      ),
    }, publicOrigin);
    const emailRecipients = destination.configuration.channel === "email"
      ? destination.configuration.recipients
      : ["notifications@sutracmdb.com"];
    const payloads = await buildSecurityNotificationPayloads({ event, emailRecipients });
    await repository.enqueue({
      orgId: input.scope.orgId,
      customerId: input.scope.customerId,
      destinationId: destination.id,
      idempotencyKey: `alert.${rule.id}.${input.firedAtMs}.${destination.id}`,
      event,
      payloads,
    });
    enqueued += 1;
  }
  return { deliveryState: "queued", destinationCount: enqueued };
}

export interface FinopsAlertSweepDeps {
  readonly listConnections: (orgId: string, customerId: string) => Promise<readonly { readonly id: string }[]>;
  readonly listDestinations: (orgId: string, customerId: string) => Promise<readonly {
    readonly id: string;
    readonly enabled: boolean;
    readonly configuration: { readonly channel: string; readonly recipients?: readonly string[] };
  }[]>;
  /** Evaluates the WHOLE customer at once (budgets are customer-wide). */
  readonly evaluate: (
    orgId: string,
    customerId: string,
    connectionIds: readonly string[],
  ) => Promise<{ readonly alerts: readonly FinopsAlert[] }>;
  readonly dispatch: (args: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly destinationId: string;
    readonly recipients: readonly string[];
    readonly alert: FinopsAlert;
  }) => Promise<void>;
  /** Optional sink for per-alert dispatch failures, so one bad alert is visible without killing the sweep. */
  readonly onDispatchError?: (alertId: string, destinationId: string, error: unknown) => void;
  /**
   * Durable trace of what the sweep decided. Optional so the unit tests can drive
   * the handler without a database, but ALWAYS wired in production
   * ({@link buildJobHandlers}) — without it the only evidence a cost alert ever
   * fired is the outbox row, which does not exist at all for a tenant with no
   * enabled destination.
   */
  readonly recordOutcome?: (outcome: FinopsAlertSweepOutcome) => Promise<void>;
}

/**
 * What one sweep did, for the audit trail. `deliveryState` mirrors the metric-
 * alerting vocabulary ({@link AlertEventDeliveryState}) and adds `no_alerts`:
 * - `queued`: alerts existed and at least one dispatch was attempted.
 * - `no_destination`: alerts existed but the tenant has NO enabled destination,
 *   so they were undeliverable. This is the case that previously left no trace
 *   whatsoever.
 * - `no_alerts`: the engines produced nothing (not recorded; see the handler).
 */
export interface FinopsAlertSweepOutcome {
  readonly orgId: string;
  readonly customerId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly connectionCount: number;
  readonly destinationCount: number;
  readonly alertsEvaluated: number;
  readonly dispatched: number;
  readonly dispatchFailures: number;
  readonly truncated: boolean;
  readonly deliveryState: "queued" | "no_destination" | "no_alerts";
}

/** Hard ceiling on dispatches per sweep, so one tenant cannot monopolise a tick. */
const FINOPS_SWEEP_MAX_DISPATCHES = 200;

/**
 * The `finops-alert-sweep` handler: for one tenant (org + customer), evaluate
 * cost/budget alerts ONCE across all of that customer's connections, then route
 * each alert to every ENABLED notification destination through the durable
 * outbox. Idempotent per (alert, destination) so repeated sweeps collapse rather
 * than spam. A tenant with no enabled destination is a no-op.
 *
 * Resilience: a single failed dispatch must NOT abort the tenant's sweep —
 * otherwise one malformed alert or a destination disabled mid-run would make the
 * whole job throw, retry from scratch (re-dispatching everything before it), and
 * eventually dead-letter. Failures are collected and reported; the sweep only
 * throws if EVERY dispatch failed, which is a real systemic fault worth retrying.
 *
 * Evidence: the sweep records ONE durable outcome per run (`recordOutcome`) with
 * the evaluated/dispatched/failed counts. Evaluation therefore runs BEFORE the
 * enabled-destination check — mirroring the metric-alerting path, which evaluates
 * and then records `no_destination` — because "alerts existed but nothing could
 * be delivered" is precisely the state that otherwise leaves no trace. The hourly
 * cadence gate keeps that extra read cheap.
 */
export async function runFinopsAlertSweepJob(job: RunnableJob, deps: FinopsAlertSweepDeps): Promise<void> {
  if (job.customerId === null) throw new Error("finops-alert-sweep-requires-customer");
  const orgId = job.orgId;
  const customerId = job.customerId;
  const connectionIds = (await deps.listConnections(orgId, customerId)).map((connection) => connection.id);
  if (connectionIds.length === 0) return;
  const destinations = (await deps.listDestinations(orgId, customerId)).filter((destination) => destination.enabled);

  // One evaluation for the whole customer: anomalies per connection internally,
  // budgets over the combined spend.
  const { alerts } = await deps.evaluate(orgId, customerId, connectionIds);

  const record = async (outcome: Omit<FinopsAlertSweepOutcome, "orgId" | "customerId" | "jobId" | "attempt" | "connectionCount" | "destinationCount">): Promise<void> => {
    const full: FinopsAlertSweepOutcome = {
      orgId,
      customerId,
      jobId: job.id,
      attempt: job.attempt,
      connectionCount: connectionIds.length,
      destinationCount: destinations.length,
      ...outcome,
    };
    // Always leave a log line: the durable write can itself fail, and a swallowed
    // audit failure must not become an invisible one.
    console.info(`finops-alert-sweep ${JSON.stringify(full)}`);
    try {
      await deps.recordOutcome?.(full);
    } catch (error) {
      // Evidence is not worth losing the delivered alerts over.
      console.warn(`finops-alert-sweep audit write failed for ${orgId}/${customerId}: ${String(error)}`);
    }
  };

  // Nothing fired. Recording an "all clear" for every tenant every hour would
  // bury the audit chain in noise, so this stays untraced by design.
  if (alerts.length === 0) return;
  if (destinations.length === 0) {
    // THE case the audit trail exists for: real alerts, zero delivery paths.
    await record({
      alertsEvaluated: alerts.length,
      dispatched: 0,
      dispatchFailures: 0,
      truncated: false,
      deliveryState: "no_destination",
    });
    return;
  }

  let attempted = 0;
  let failed = 0;
  let truncated = false;
  for (const alert of alerts) {
    for (const destination of destinations) {
      if (attempted >= FINOPS_SWEEP_MAX_DISPATCHES) {
        truncated = true;
        break;
      }
      attempted += 1;
      try {
        await deps.dispatch({
          orgId,
          customerId,
          // Alert identity already encodes its own connection scope; the event's
          // grouping key uses the customer's first connection for context.
          connectionId: connectionIds[0],
          destinationId: destination.id,
          recipients: recipientsForDestination(destination),
          alert,
        });
      } catch (error) {
        failed += 1;
        deps.onDispatchError?.(alert.id, destination.id, error);
      }
    }
    if (truncated) break;
  }
  if (truncated) {
    console.warn(`finops-alert-sweep truncated at ${FINOPS_SWEEP_MAX_DISPATCHES} dispatches for ${orgId}/${customerId}`);
  }
  // Recorded BEFORE the total-failure throw, so a systemic failure is evidenced
  // rather than only visible as a dead-lettered job.
  await record({
    alertsEvaluated: alerts.length,
    dispatched: attempted - failed,
    dispatchFailures: failed,
    truncated,
    deliveryState: "queued",
  });
  // Only a total failure is a retryable fault; partial failures are reported.
  if (attempted > 0 && failed === attempted) {
    throw new Error(`finops-alert-sweep-all-dispatches-failed (${failed}/${attempted})`);
  }
}

/**
 * The system actor a FinOps alert sweep is attributed to. A sweep runs from the
 * durable job queue with NO authenticated user, so it uses the same `actorType:
 * "system"` convention the cold-path recovery administration already uses; the
 * audit schema does not constrain `actor_id` to a user row.
 */
const FINOPS_SWEEP_ACTOR_ID = "system_finops_alert_sweep";

/**
 * Persist one sweep's outcome to the tenant's hash-chained `audit_events` table.
 *
 * Why the audit chain and not `alert_events`: the metric-alerting sibling's
 * `AlertRuleRepository.recordEvent` inserts `SELECT … FROM alert_rules WHERE
 * r.id = ?` and requires an `arule_<32 hex>` id, so recording a FinOps alert
 * there would mean fabricating an alert_rule row that no operator created. The
 * audit chain accepts a system actor honestly and needs no new table.
 *
 * The request id is derived from (org, customer, job, attempt), so the unique
 * `audit_events(org_id, request_id)` index makes a replay of the same attempt
 * idempotent while a genuine retry (new attempt) records its own row.
 */
async function recordFinopsAlertSweepAudit(outcome: FinopsAlertSweepOutcome): Promise<void> {
  const requestKey = (await alertEvidenceHash(
    `${outcome.orgId}\u0000${outcome.customerId}\u0000${outcome.jobId}\u0000${outcome.attempt}`,
  )).slice(0, 32);
  await appendAuditEvent({
    orgId: outcome.orgId,
    actorType: "system",
    actorId: FINOPS_SWEEP_ACTOR_ID,
    action: "finops.alert_sweep.completed",
    targetType: "finops_alert_sweep",
    targetId: outcome.jobId,
    customerId: outcome.customerId,
    // An undeliverable or partially failed sweep is NOT an "allowed" outcome.
    outcome: outcome.deliveryState === "queued" && outcome.dispatchFailures === 0 ? "allowed" : "failed",
    requestId: `finops.alert_sweep.completed:${requestKey}`,
    metadata: {
      deliveryState: outcome.deliveryState,
      connectionCount: outcome.connectionCount,
      destinationCount: outcome.destinationCount,
      alertsEvaluated: outcome.alertsEvaluated,
      dispatched: outcome.dispatched,
      dispatchFailures: outcome.dispatchFailures,
      truncated: outcome.truncated,
      attempt: outcome.attempt,
    },
  });
}

/**
 * The app-side registry of durable job handlers. Each handler does real work and
 * throws on failure — nothing is fabricated, and the runner completes a job only
 * when its handler returns without throwing.
 */
export function buildJobHandlers(): Record<string, JobHandler> {
  return {
    "retention-sweep": async (job) => {
      await new RetentionSweepRepository().sweep(job.orgId);
    },
    "itsm-dispatch": runItsmDispatch,
    [ITSM_SECRET_CLEANUP_JOB_KIND]: runItsmSecretCleanupJob,
    "finops-scheduled-report": (job) => runScheduledReportJob(job, {
      scheduleRepo: new FinopsScheduledReportRepository(),
      finopsRepo: new FinopsWorkspaceRepository(),
      deliver: (kind, target, envelope) =>
        deliverScheduledReport({ kind, target, envelope, env: reportDeliveryEnv() }),
      now: Date.now,
    }),
    "alert-evaluation": async (job) => {
      await runAlertEvaluationJob(job, {
        loadEnabledRules: (scope) => new AlertRuleRepository().listEnabled(scope),
        loadMetrics: (scope) => collectLiveTenantMetrics(scope),
        recordEvent: (input) => new AlertRuleRepository().recordEvent(input),
        dispatch: dispatchFiredAlert,
        now: Date.now,
      });
    },
    "finops-alert-sweep": (job) => runFinopsAlertSweepJob(job, {
      listConnections: async (orgId, customerId) =>
        (await listConnectionsForOrg(orgId)).filter((connection) => connection.customerId === customerId).map((connection) => ({ id: connection.id })),
      listDestinations: (orgId, customerId) => new SecurityNotificationRepository().listDestinations(orgId, customerId),
      evaluate: async (orgId, customerId, connectionIds) =>
        (await evaluateFinopsAlertsForCustomer(orgId, customerId, connectionIds)).evaluation,
      dispatch: (args) => enqueueFinopsAlert(
        new SecurityNotificationRepository(),
        { ...args, publicOrigin: requiredConfiguredPublicOrigin() },
      ),
      onDispatchError: (alertId, destinationId, error) => {
        // Visible without aborting the sweep; the runner still completes the job.
        console.warn(`finops-alert-sweep dispatch failed for ${alertId} → ${destinationId}: ${String(error)}`);
      },
      recordOutcome: recordFinopsAlertSweepAudit,
    }),
    "uptime-probe": (job) => runUptimeProbeJob(job, buildUptimeProbeDeps()),
    // The hosted broker ingestion job: persist a signed, server-scoped broker
    // collection into its tenant via the SAME path the local collector uses.
    // Enqueued by the ingest route (not a periodic tick); tenant identity comes
    // strictly from the job's scope, never from the payload.
    [HOSTED_BROKER_INGEST_JOB_KIND]: (job) => runHostedBrokerIngestJob(job, {
      getConnection: (orgId, connectionId) => getConnectionForOrg(orgId, connectionId),
      createSyncRun: (connectionId, options) => createSyncRun(connectionId, options),
      persistSnapshot: ({ runId, payload, actorId, origin, orgId, rawEvidenceBytes }) =>
        persistSnapshot(runId, payload, actorId, origin, null, null, orgId, rawEvidenceBytes),
    }),
    [HOSTED_COLLECTOR_COLLECT_JOB_KIND]: (job) => runHostedCollectorJob(job, {
      getConnection: (orgId, connectionId) => getConnectionForOrg(orgId, connectionId),
      listOperationRuns: (input) => listHostedCollectorOperationRuns(input),
      createSyncRun: (connectionId, options) => createSyncRun(connectionId, options),
      runCollectorSync,
      persistSnapshot: ({ runId, payload, rawEvidenceBytes, actorId, origin, orgId }) =>
        persistSnapshot(runId, payload, actorId, origin, null, null, orgId, rawEvidenceBytes),
      failSyncRun,
      markConnectionNeedsAttention,
      safeFailureCode: safeCollectionFailureCode,
    }),
    [FINOPS_DATA_EXPORT_INGEST_JOB_KIND]: (job) =>
      runFinopsDataExportIngestJob(job, {
        getConnection: (orgId, connectionId) =>
          getConnectionForOrg(orgId, connectionId),
        repository: new FinopsBillingEngineRepository(),
        readObject: (boundary, request) =>
          createFinopsBrokerObjectReader(boundary, {
            readChunk: runFinopsExportChunkRead,
          })(request),
        now: Date.now,
      }),
    [FINOPS_SOURCE_COLLECT_JOB_KIND]: async (job) =>
      runFinopsSourceCollectJob(job, {
        getConnection: (orgId, connectionId) =>
          getConnectionForOrg(orgId, connectionId),
        collect: runFinopsSourceCollection,
        ledger: new FinopsSourceJobLedgerRepository(),
        evidence: new EvidenceRepository(),
        snapshots: new FinopsSourceSnapshotRepository(),
        evidenceReferenceSealer:
          await FinopsEvidenceReferenceSealer.fromEnvironment(
            env as unknown as Readonly<Record<string, string | undefined>>,
          ),
        now: Date.now,
      }),
    [FINOPS_TA_ORGANIZATION_ACTIVATE_JOB_KIND]: async (job) => {
      await runTrustedAdvisorOrganizationActivationHandler(job);
    },
    [FINOPS_TA_ACCOUNT_COLLECT_JOB_KIND]: async (job) => {
      await runTrustedAdvisorAccountCollectionHandler(job);
    },
    [FINOPS_TA_MANIFEST_FINALIZE_JOB_KIND]: async (job) => {
      await runTrustedAdvisorManifestFinalizeHandler(job);
    },
    "agentless-teardown-sweep": (job) => {
      const repository = new AgentlessScanRepository();
      return runAgentlessTeardownSweepJob(job, {
        // Keep one broker call inside its five-minute authenticated request
        // bound even when AWS applies the SDK's full retry budget.
        listOutstanding: (orgId) => repository.listOpenTeardownDebt(orgId, 25),
        sweep: (resources) => requestAgentlessTeardownSweep({
          tenantId: job.orgId,
          operationId: job.id,
          resources: resources.map((resource) => ({
            connectionId: resource.connectionId,
            resourceId: resource.resourceId,
            resourceKind: resource.resourceKind,
            accountScope: resource.accountScope,
            region: resource.region,
          })),
        }),
        settle: (orgId, resourceId) =>
          repository.resolveTeardownDebt(orgId, resourceId),
        recordAttempt: (orgId, resourceId, detail) =>
          repository.recordTeardownAttempt(orgId, resourceId, detail),
      });
    },
    "vuln-feed-refresh": (job) => {
      const repository = new VulnerabilityMirrorRepository();
      return runVulnFeedRefreshJob(job, {
        readFeedState: () => repository.feedStates(),
        plan: (states, now) => planVulnFeedRefresh(states, {}, now),
        refreshFeed: (feed, options) => refreshBoundedVulnerabilityFeed({
          feed,
          repository,
          environment: env as unknown as ManagedOutboundEnvironment,
          ...(options.nvdWindowDays === undefined
            ? {}
            : { nvdWindowDays: options.nvdWindowDays }),
        }),
        audit: async (event) => {
          const numberValue = (key: string): number => {
            const value = event[key];
            return typeof value === "number" && Number.isFinite(value) ? value : 0;
          };
          const failureCount = Array.isArray(event.failures)
            ? event.failures.length
            : 0;
          await appendAuditEvent({
            orgId: job.orgId,
            actorType: "system",
            actorId: "system:vulnerability-feed-refresh",
            action: "vulnerability.feed_refresh.completed",
            targetType: "vulnerability_feed_mirror",
            targetId: job.id,
            customerId: job.customerId,
            outcome: failureCount === 0 ? "allowed" : "failed",
            requestId: `vuln.feed_refresh:${job.id}:${job.attempt}`,
            // Upstream exception text can contain URLs/request identifiers.
            // Persist only bounded counts and the explicit host-handoff flag.
            metadata: {
              refreshed: numberValue("refreshed"),
              rowsWritten: numberValue("rowsWritten"),
              deferredToHost: numberValue("deferredToHost"),
              needsHostRun: event.needsHostRun === true,
              failureCount,
              attempt: job.attempt,
            },
          });
        },
      });
    },
  };
}

/**
 * Ensure every given org has at most one in-flight retention sweep. For each org
 * with no queued/leased `retention-sweep`, enqueue one. Idempotent: a second call
 * before the first sweep drains enqueues nothing. Returns the number enqueued.
 */
export async function ensureRetentionSweepsEnqueued(
  queue: JobQueueRepository,
  orgIds: readonly string[],
  now = Date.now(),
): Promise<number> {
  let enqueued = 0;
  for (const orgId of orgIds) {
    const existing = await queue.list(orgId, null);
    const active = existing.some(
      (job) => job.kind === "retention-sweep" && (job.status === "queued" || job.status === "leased"),
    );
    if (active) continue;
    await queue.enqueue({ orgId, customerId: null, kind: "retention-sweep", payload: { orgId } }, now);
    enqueued += 1;
  }
  return enqueued;
}

/**
 * The scheduled-report tick: enqueue one `finops-scheduled-report` job per DUE
 * schedule across all tenants, mirroring the collection-schedule cadence model.
 * Each due schedule is advanced to its next run FIRST (markRun) so a failed
 * enqueue never leaves it perpetually due looping the queue; a missed window
 * self-heals on the next cadence. Returns the number of jobs enqueued.
 */
export async function ensureDueScheduledReportsEnqueued(
  queue: JobQueueRepository,
  reports: FinopsScheduledReportRepository,
  now = Date.now(),
): Promise<number> {
  const due = await reports.listDue(now);
  let enqueued = 0;
  for (const report of due) {
    const advanced = await reports.markRun(report.id, now, nextRunAtIso(report.cadence, now), now);
    if (!advanced) continue;
    try {
      await queue.enqueue({
        orgId: report.orgId,
        customerId: report.customerId,
        kind: "finops-scheduled-report",
        payload: {
          scheduleId: report.id,
          connectionId: report.connectionId,
          name: report.name,
          deliveryKind: report.deliveryKind,
          deliveryTarget: report.deliveryTarget,
        },
      }, now);
      enqueued += 1;
    } catch {
      // A schedule whose customer is no longer active cannot be enqueued; the
      // row was already advanced, so it is simply re-evaluated next cadence.
    }
  }
  return enqueued;
}

/**
 * The alert-evaluation tick: ensure every tenant that has at least one enabled
 * alert rule has at most one in-flight `alert-evaluation` job. Mirrors the
 * retention-sweep cadence model — a tenant with an already queued/leased
 * evaluation enqueues nothing, so a slow tick never piles up duplicate work.
 * Rules are discovered with the ONE system-level scan; each carries its own
 * tenant scope, so every enqueued job runs strictly within that tenant. Returns
 * the number of jobs enqueued.
 */
export async function ensureDueAlertEvaluationsEnqueued(
  queue: JobQueueRepository,
  rules: AlertRuleRepository,
  now = Date.now(),
): Promise<number> {
  const enabled = await rules.listEnabledForAllTenants(now);
  const tenants = new Map<string, { readonly orgId: string; readonly customerId: string }>();
  for (const rule of enabled) {
    tenants.set(`${rule.scope.orgId}\u0000${rule.scope.customerId}`, rule.scope);
  }
  let enqueued = 0;
  for (const tenant of tenants.values()) {
    const existing = await queue.list(tenant.orgId, tenant.customerId);
    const active = existing.some(
      (job) => job.kind === "alert-evaluation" && (job.status === "queued" || job.status === "leased"),
    );
    if (active) continue;
    try {
      await queue.enqueue(
        { orgId: tenant.orgId, customerId: tenant.customerId, kind: "alert-evaluation", payload: {} },
        now,
      );
      enqueued += 1;
    } catch {
      // A tenant whose customer is no longer active cannot be enqueued; it is
      // simply re-evaluated on the next tick.
    }
  }
  return enqueued;
}

/**
 * The finops-alert-sweep tick: ensure every tenant (org + customer that owns at
 * least one connection) has at most one in-flight `finops-alert-sweep` job.
 * Mirrors the retention-sweep cadence model — a tenant with an already
 * queued/leased sweep enqueues nothing. The handler is a no-op when the tenant
 * has no enabled notification destination, so enqueuing broadly is safe: work is
 * only ever done where alerts can actually be delivered. Returns the number of
 * jobs enqueued.
 */
/**
 * Minimum gap between cost/budget sweeps for one tenant. The job runner ticks
 * every ~15s; re-reading every connection's billing lines (up to 50k rows each)
 * and re-running the engines that often is pure waste — cost data changes when a
 * billing file is ingested, not second to second. Hourly is ample for spend
 * alerting and keeps the tick cheap.
 */
export const FINOPS_ALERT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export async function ensureDueFinopsAlertSweepsEnqueued(
  queue: JobQueueRepository,
  orgIds: readonly string[],
  connectionsForOrg: (orgId: string) => Promise<readonly { readonly customerId: string }[]>,
  now = Date.now(),
  intervalMs = FINOPS_ALERT_SWEEP_INTERVAL_MS,
): Promise<number> {
  let enqueued = 0;
  for (const orgId of orgIds) {
    const connections = await connectionsForOrg(orgId);
    const customerIds = [...new Set(connections.map((connection) => connection.customerId))];
    for (const customerId of customerIds) {
      const existing = await queue.list(orgId, customerId);
      const sweeps = existing.filter((job) => job.kind === "finops-alert-sweep");
      // Never stack sweeps for the same tenant.
      if (sweeps.some((job) => job.status === "queued" || job.status === "leased")) continue;
      // CADENCE — and, deliberately, the dead-letter cooldown. `list` is ordered
      // created_at DESC, so the first sweep is the newest whatever its status.
      // Gating on age means a dead-lettered sweep is NOT retried on the very next
      // tick forever; it gets one fresh attempt per interval instead.
      const newest = sweeps[0];
      if (newest !== undefined && now - newest.createdAt < intervalMs) continue;
      try {
        await queue.enqueue({ orgId, customerId, kind: "finops-alert-sweep", payload: {} }, now);
        enqueued += 1;
      } catch {
        // A customer no longer active cannot be enqueued; re-evaluated next tick.
      }
    }
  }
  return enqueued;
}

// ─────────────────────────────────────────────────────────────────────────────
// agentless-teardown-sweep
//
// Reconciles resources an agentless scan left behind. Wired as its own job kind
// rather than folded into an existing sweep because its failure mode is
// financial, not informational: an unreaped snapshot bills the customer every
// hour, so it must retry on its own cadence and must not be starved by an
// unrelated sweep failing.
//
// Sutra can only delete in its OWN scan account — the customer role carries an
// explicit deny — so the sweep decides per resource whether to act or merely
// observe. That decision lives in lib/aws-agentless-teardown-sweep.ts and is
// tested there; this handler only supplies the tenant scope and persists what
// the sweep concluded.
// ─────────────────────────────────────────────────────────────────────────────

/** Hourly. Matches finops-alert-sweep: frequent enough to bound cost, rare enough to be cheap. */
export const AGENTLESS_TEARDOWN_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface AgentlessTeardownSweepDeps {
  /** Open debt for the org. Org-scoped on purpose — see the repository comment. */
  listOutstanding: (orgId: string) => Promise<readonly {
    readonly connectionId: string;
    readonly resourceId: string;
    readonly resourceKind: "snapshot" | "volume" | "instance";
    readonly region: string;
    readonly accountScope: "customer" | "sutra-scan-account";
    readonly attempts: number;
    readonly firstSeenAt: string;
  }[]>;
  sweep: (resources: readonly {
    readonly connectionId: string;
    readonly resourceId: string;
    readonly resourceKind: "snapshot" | "volume" | "instance";
    readonly region: string;
    readonly accountScope: "customer" | "sutra-scan-account";
    readonly attempts: number;
    readonly firstSeenAt: string;
  }[]) => Promise<{
    readonly outcomes: readonly { readonly resourceId: string; readonly disposition: string; readonly detail: string }[];
    readonly summary: { readonly considered: number; readonly stillOutstanding: number };
  }>;
  /** Close a debt row. Called only for resources proven gone. */
  settle: (orgId: string, resourceId: string) => Promise<boolean>;
  /** Record a failed attempt without closing the row. */
  recordAttempt: (orgId: string, resourceId: string, detail: string) => Promise<void>;
  audit?: (event: Record<string, unknown>) => Promise<void>;
}

export async function runAgentlessTeardownSweepJob(
  job: RunnableJob,
  deps: AgentlessTeardownSweepDeps,
): Promise<void> {
  const orgId = job.orgId;
  const outstanding = await deps.listOutstanding(orgId);
  if (outstanding.length === 0) return;

  const result = await deps.sweep(outstanding);

  let settled = 0;
  let stillBilling = 0;
  for (const outcome of result.outcomes) {
    if (outcome.disposition === "settled" || outcome.disposition === "deleted") {
      // Per-resource isolation: one failed settle must not abandon the rest.
      try {
        if (await deps.settle(orgId, outcome.resourceId)) settled += 1;
      } catch {
        // The resource is gone but the row survives; the next sweep settles it.
      }
      continue;
    }
    stillBilling += 1;
    try {
      await deps.recordAttempt(orgId, outcome.resourceId, outcome.detail);
    } catch {
      // Attempt bookkeeping is best-effort; losing it must not lose the sweep.
    }
  }

  // Audited because it is spend, and because "awaiting-customer" is a state an
  // operator may need to explain to the customer paying for it.
  const summary = {
    kind: "agentless-teardown-sweep",
    orgId,
    jobId: job.id,
    considered: result.summary.considered,
    settled,
    stillBilling,
  };
  console.info(`agentless-teardown-sweep ${JSON.stringify(summary)}`);
  if (deps.audit !== undefined) {
    try {
      await deps.audit(summary);
    } catch (error) {
      console.warn(`agentless-teardown-sweep audit write failed for ${orgId}: ${String(error)}`);
    }
  }
}

export async function ensureDueAgentlessTeardownSweepsEnqueued(
  queue: JobQueueRepository,
  orgIds: readonly string[],
  connectionsForOrg: (orgId: string) => Promise<readonly { readonly customerId: string }[]>,
  now = Date.now(),
  intervalMs = AGENTLESS_TEARDOWN_SWEEP_INTERVAL_MS,
): Promise<number> {
  let enqueued = 0;
  for (const orgId of orgIds) {
    const connections = await connectionsForOrg(orgId);
    const customerIds = [...new Set(connections.map((connection) => connection.customerId))];
    // One sweep per org is enough — the debt query is org-scoped — but the queue
    // is keyed by customer, so the first readable customer carries it.
    const carrier = customerIds[0];
    if (carrier === undefined) continue;
    const existing = await queue.list(orgId, carrier);
    const sweeps = existing.filter((entry) => entry.kind === "agentless-teardown-sweep");
    if (sweeps.some((entry) => entry.status === "queued" || entry.status === "leased")) continue;
    const newest = sweeps[0];
    // Same cadence-as-dead-letter-cooldown reasoning as finops-alert-sweep.
    if (newest !== undefined && now - newest.createdAt < intervalMs) continue;
    try {
      await queue.enqueue({ orgId, customerId: carrier, kind: "agentless-teardown-sweep", payload: {} }, now);
      enqueued += 1;
    } catch {
      // Inactive customer; re-evaluated next tick.
    }
  }
  return enqueued;
}

// ─────────────────────────────────────────────────────────────────────────────
// vuln-feed-refresh
//
// Keeps the CVE feed mirror current. Before this, `pnpm vuln:feeds:refresh` was
// the ONLY path and nothing scheduled it — so new CVEs, EPSS scores and CISA KEV
// entries reached production only when a human remembered. That degrades
// silently: the enrichment join still returns rows, they are just ranked against
// a stale world.
//
// Org-independent by nature — the mirror is global, not tenant-scoped — but the
// job queue is keyed by tenant, so one org carries it and the handler writes
// nothing tenant-specific.
//
// The feed split (KEV + bounded NVD here; EPSS bulk on the host) is decided by
// lib/vuln-feed-refresh-schedule.ts and explained there. The short version: the
// Postgres adapter opens a connection per query because workerd forbids socket
// reuse, so a 349k-row EPSS load belongs on the host, not in a request.
// ─────────────────────────────────────────────────────────────────────────────

/** Every 6h. Upstreams publish daily; this bounds staleness to a quarter-day. */
export const VULN_FEED_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface VulnFeedRefreshDeps {
  /** Current per-feed asOf + row count, for the staleness decision. */
  readFeedState: () => Promise<readonly {
    readonly feed: "kev" | "nvd" | "epss";
    readonly asOfMs: number | null;
    readonly rowCount: number;
  }[]>;
  /** Plan which feeds to pull. Injected so the decision stays unit-testable. */
  plan: (states: readonly { readonly feed: "kev" | "nvd" | "epss"; readonly asOfMs: number | null; readonly rowCount: number }[], nowMs: number) => {
    readonly decisions: readonly { readonly feed: string; readonly action: string; readonly reason: string }[];
    readonly summary: { readonly refreshing: number; readonly deferredToHost: number; readonly needsHostRun: boolean };
    readonly disclaimer: string;
  };
  /** Fetch + upsert ONE feed. Returns rows written. Must be bounded by the caller. */
  refreshFeed: (feed: "kev" | "nvd", options: { readonly nvdWindowDays?: number }) => Promise<number>;
  audit?: (event: Record<string, unknown>) => Promise<void>;
}

export async function runVulnFeedRefreshJob(
  job: RunnableJob,
  deps: VulnFeedRefreshDeps,
  now = Date.now(),
): Promise<void> {
  const states = await deps.readFeedState();
  const plan = deps.plan(states, now);

  let rowsWritten = 0;
  let refreshed = 0;
  const failures: string[] = [];

  for (const decision of plan.decisions) {
    if (decision.action !== "refresh") continue;
    if (decision.feed !== "kev" && decision.feed !== "nvd") continue;
    const windowDays = (decision as { readonly nvdWindowDays?: number }).nvdWindowDays;
    try {
      // Per-feed isolation: an upstream outage on one feed must not block the
      // other. KEV going down should never stop an NVD refresh.
      rowsWritten += await deps.refreshFeed(decision.feed, windowDays === undefined ? {} : { nvdWindowDays: windowDays });
      refreshed += 1;
    } catch (error) {
      failures.push(`${decision.feed}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const summary = {
    kind: "vuln-feed-refresh",
    orgId: job.orgId,
    jobId: job.id,
    refreshed,
    rowsWritten,
    deferredToHost: plan.summary.deferredToHost,
    // Recorded on every run so "EPSS is stale" is discoverable from the audit
    // trail rather than from rankings quietly looking wrong.
    needsHostRun: plan.summary.needsHostRun,
    failures,
    disclaimer: plan.disclaimer,
  };
  console.info(`vuln-feed-refresh ${JSON.stringify(summary)}`);
  if (deps.audit !== undefined) {
    try {
      await deps.audit(summary);
    } catch (error) {
      console.warn(`vuln-feed-refresh audit write failed: ${String(error)}`);
    }
  }

  // Throw only when EVERY attempted feed failed, so one dead upstream does not
  // dead-letter a run that partially succeeded.
  if (refreshed === 0 && failures.length > 0) {
    throw new Error(`vuln-feed-refresh-all-feeds-failed (${failures.length}): ${failures.join("; ")}`);
  }
}

export async function ensureDueVulnFeedRefreshEnqueued(
  queue: JobQueueRepository,
  orgIds: readonly string[],
  connectionsForOrg: (orgId: string) => Promise<readonly { readonly customerId: string }[]>,
  now = Date.now(),
  intervalMs = VULN_FEED_REFRESH_INTERVAL_MS,
): Promise<number> {
  // The mirror is GLOBAL. Refreshing it once per org would multiply identical
  // upstream fetches by tenant count, so the first readable org carries it and
  // the rest are skipped entirely.
  for (const orgId of orgIds) {
    const connections = await connectionsForOrg(orgId);
    const carrier = connections[0]?.customerId;
    if (carrier === undefined) continue;
    const existing = await queue.list(orgId, carrier);
    const runs = existing.filter((entry) => entry.kind === "vuln-feed-refresh");
    if (runs.some((entry) => entry.status === "queued" || entry.status === "leased")) return 0;
    const newest = runs[0];
    if (newest !== undefined && now - newest.createdAt < intervalMs) return 0;
    try {
      await queue.enqueue({ orgId, customerId: carrier, kind: "vuln-feed-refresh", payload: {} }, now);
      return 1;
    } catch {
      // Inactive customer; try the next org rather than giving up on the mirror.
      continue;
    }
  }
  return 0;
}
