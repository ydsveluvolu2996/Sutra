import {
  DCF_EXECUTION_BOUNDS,
  DCF_EXECUTION_READ_OPERATIONS,
  type DcfCapture,
  type DcfScope,
} from "./finops-dcf-execution-history.ts";

export async function runDcfInstrumentationJob(
  job: { orgId: string; customerId: string | null; connectionId: string | null; payload: unknown },
  deps: {
    loadScope: (scope: { organizationId: string; customerId: string; connectionId: string }) => Promise<DcfScope>;
    collect: (request: { scope: DcfScope; operations: typeof DCF_EXECUTION_READ_OPERATIONS; bounds: typeof DCF_EXECUTION_BOUNDS }, signal: AbortSignal) => Promise<DcfCapture>;
    record: (scope: { organizationId: string; customerId: string; connectionId: string }, trusted: DcfScope, capture: DcfCapture) => Promise<unknown>;
  },
): Promise<unknown> {
  if (!job.customerId || !job.connectionId || JSON.stringify(job.payload) !== '{"scheduled":true}') {
    throw new Error("dcf-job-invalid");
  }
  const scope = { organizationId: job.orgId, customerId: job.customerId, connectionId: job.connectionId };
  const trusted = await deps.loadScope(scope);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DCF_EXECUTION_BOUNDS.maximumDurationMs);
  try {
    const capture = await deps.collect({
      scope: trusted,
      operations: DCF_EXECUTION_READ_OPERATIONS,
      bounds: DCF_EXECUTION_BOUNDS,
    }, controller.signal);
    return await deps.record(scope, trusted, capture);
  } finally {
    clearTimeout(timer);
  }
}
