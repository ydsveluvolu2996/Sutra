import { env } from "cloudflare:workers";
import {
  buildJobHandlers,
  ensureDueAgentlessTeardownSweepsEnqueued,
  ensureDueAlertEvaluationsEnqueued,
  ensureDueFinopsAlertSweepsEnqueued,
  ensureDueScheduledReportsEnqueued,
  ensureDueVulnFeedRefreshEnqueued,
  ensureRetentionSweepsEnqueued,
  dispatchComputeOptimizerOutboxTick,
  recoverComputeOptimizerActivationTick,
  scheduleComputeOptimizerDailyTick,
  scheduleAwsBudgetsTick,
  scheduleAwsNewsFeedsTick,
  scheduleExtendedSupportTick,
  scheduleAwsSupportCasesTick,
  scheduleAwsHealthTick,
  scheduleResilienceVueTick,
} from "../../../../../db/background-job-handlers";
import { AlertRuleRepository } from "../../../../../db/alert-rule-repository";
import { FinopsScheduledReportRepository } from "../../../../../db/finops-scheduled-report-repository";
import { JobQueueRepository } from "../../../../../db/job-queue-repository";
import { listConnectionsForOrg } from "../../../../../db/pilot-repository";
import { listActiveOrgIds } from "../../../../../db/organization-directory";
import {
  buildPlatformUptimeProbeTickDeps,
  runPlatformUptimeProbeTick,
} from "../../../../../lib/uptime-probe-handler";
import { runDueBackgroundJobs } from "../../../../../lib/background-job-runner";
import { verifyInternalToken } from "../../../../../lib/internal-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";
import { createComputeOptimizerActivationBoundary } from
  "../../../../../lib/finops-compute-optimizer-activation-jobs";

export const dynamic = "force-dynamic";

/** Read the shared runner token from the worker env, falling back to process env. */
function jobRunnerToken(): string | undefined {
  const runtime = env as unknown as { SUTRA_JOB_RUNNER_TOKEN?: string };
  return runtime.SUTRA_JOB_RUNNER_TOKEN ?? process.env.SUTRA_JOB_RUNNER_TOKEN;
}

/**
 * System-internal background-job drain. This endpoint is NOT tenant-scoped: it is
 * gated solely by the shared `SUTRA_JOB_RUNNER_TOKEN`. The platform uptime tick
 * is system-scoped; every queued business job still carries its own org scope.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const verdict = verifyInternalToken(jobRunnerToken(), request.headers.get("x-sutra-job-token"));
    if (verdict === "not-configured") return jsonResponse({ error: { code: "NOT_CONFIGURED" } }, { status: 503 });
    if (verdict === "unauthorized") return jsonResponse({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
    // Platform health must start before the first customer/organization exists.
    const platformUptime = await runPlatformUptimeProbeTick(buildPlatformUptimeProbeTickDeps());
    const queue = new JobQueueRepository();
    const activeOrgIds = await listActiveOrgIds();
    await ensureRetentionSweepsEnqueued(queue, activeOrgIds);
    // The scheduled-report tick: enqueue any due FinOps cost reports (all tenants).
    await ensureDueScheduledReportsEnqueued(queue, new FinopsScheduledReportRepository());
    // The alert-evaluation tick: enqueue one evaluation per tenant with enabled rules.
    await ensureDueAlertEvaluationsEnqueued(queue, new AlertRuleRepository());
    // The finops-alert-sweep tick: enqueue one cost/budget alert sweep per tenant
    // that owns a connection (the handler no-ops without an enabled destination).
    await ensureDueFinopsAlertSweepsEnqueued(
      queue,
      activeOrgIds,
      async (orgId) => (await listConnectionsForOrg(orgId)).map((connection) => ({ customerId: connection.customerId })),
    );
    // Reuse one customer lister for the remaining per-tenant ticks.
    const customersForOrg = async (orgId: string) =>
      (await listConnectionsForOrg(orgId)).map((connection) => ({ customerId: connection.customerId }));
    // The agentless-teardown tick: outstanding snapshots bill until a lifecycle
    // policy reaps them, so the sweep has to run on a cadence rather than only
    // when someone opens the page.
    await ensureDueAgentlessTeardownSweepsEnqueued(queue, activeOrgIds, customersForOrg);
    // The vuln-feed-refresh tick. Without this the CVE mirror never updates after
    // its initial seed: new CVEs, EPSS scores and KEV additions simply never reach
    // the ranking, and the queue keeps reporting stale risk as current. Enqueues
    // exactly ONE job across all orgs because the mirror is global.
    await ensureDueVulnFeedRefreshEnqueued(queue, activeOrgIds, customersForOrg);
    // ADV-07 uses one deterministic connection-scoped job per six-hour UTC
    // window. The production composition owns the pinned egress and replay
    // ledger; this system tick supplies no tenant IDs or source URLs.
    const awsNewsFeeds = await scheduleAwsNewsFeedsTick();
    // ADV-08 uses the same deterministic six-hour cadence. Scheduling never
    // loads broker credentials; the server-owned handler resolves them only
    // after a scoped durable job has been claimed.
    const awsBudgets = await scheduleAwsBudgetsTick();
    // ADV-04 is a deterministic daily, connection-scoped projection. The
    // handler reloads the AWS boundary and signed-broker credentials only after
    // the durable job is claimed; the queue payload contains no provider data.
    const extendedSupport = await scheduleExtendedSupportTick();
    // ADV-09 schedules one canonical organization anchor per daily UTC window;
    // account fan-out is resolved only inside the claimed server-owned job.
    const awsSupportCases = await scheduleAwsSupportCasesTick();
    // ADV-06 schedules one canonical organization-view capture per UTC day;
    // credentials and candidate-account fan-out remain server-owned.
    const awsHealth = await scheduleAwsHealthTick();
    // ADV-10 schedules one connection-scoped Resilience Hub capture per UTC
    // day; the signed provider session is created only by the claimed handler.
    const resilienceVue = await scheduleResilienceVueTick();
    // Compute Optimizer is intentionally two-phase. Seal/replay the daily
    // activation, recover discovery-gated runs, then publish only durable
    // materializer outbox entries. One absolute deadline covers all three.
    const computeOptimizerBoundary = createComputeOptimizerActivationBoundary();
    const computeOptimizerSchedule = await scheduleComputeOptimizerDailyTick(
      computeOptimizerBoundary,
    );
    const computeOptimizerRecovery = await recoverComputeOptimizerActivationTick(
      computeOptimizerBoundary,
    );
    const computeOptimizerOutbox = await dispatchComputeOptimizerOutboxTick(
      computeOptimizerBoundary,
    );
    // A hosted inventory job can legitimately use most of the broker's
    // five-minute bound. Process at most one job of each kind per 15-second
    // sidecar tick so the loopback request itself remains bounded.
    const result = await runDueBackgroundJobs({ queue, handlers: buildJobHandlers(), maxPerKind: 1 });
    return jsonResponse({
      ...result,
      platformUptime,
      awsNewsFeeds,
      awsBudgets,
      extendedSupport,
      awsSupportCases,
      awsHealth,
      resilienceVue,
      computeOptimizer: {
        schedule: computeOptimizerSchedule,
        recovery: computeOptimizerRecovery,
        outbox: computeOptimizerOutbox,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
