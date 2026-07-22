import { env } from "cloudflare:workers";
import {
  buildJobHandlers,
  ensureDueAlertEvaluationsEnqueued,
  ensureDueScheduledReportsEnqueued,
  ensureRetentionSweepsEnqueued,
} from "../../../../../db/background-job-handlers";
import { AlertRuleRepository } from "../../../../../db/alert-rule-repository";
import { FinopsScheduledReportRepository } from "../../../../../db/finops-scheduled-report-repository";
import { JobQueueRepository } from "../../../../../db/job-queue-repository";
import { listActiveOrgIds } from "../../../../../db/organization-directory";
import {
  buildPlatformUptimeProbeTickDeps,
  runPlatformUptimeProbeTick,
} from "../../../../../lib/uptime-probe-handler";
import { runDueBackgroundJobs } from "../../../../../lib/background-job-runner";
import { verifyInternalToken } from "../../../../../lib/internal-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

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
    const result = await runDueBackgroundJobs({ queue, handlers: buildJobHandlers(), maxPerKind: 25 });
    return jsonResponse({ ...result, platformUptime });
  } catch (error) {
    return errorResponse(error);
  }
}
