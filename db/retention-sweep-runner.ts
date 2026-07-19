import type { BackgroundJob } from "./job-queue-repository.ts";
import { JobQueueRepository } from "./job-queue-repository.ts";
import { RetentionSweepRepository, type RetentionSweepResult } from "./retention-sweep-repository.ts";

export async function runRetentionSweepJob(
  job: BackgroundJob,
  queue = new JobQueueRepository(),
  retention = new RetentionSweepRepository(),
  now = Date.now(),
): Promise<RetentionSweepResult> {
  if (job.kind !== "retention-sweep" || job.status !== "leased") {
    throw Object.assign(new Error("The leased job is not a retention sweep"), { code: "INVALID_INPUT" });
  }
  try {
    const result = await retention.sweep(job.orgId, now);
    if (!(await queue.complete(job.orgId, job.id, now))) throw new Error("The retention job lease was lost");
    return result;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message.slice(0, 2_000) : "retention-sweep-failed";
    await queue.fail(job.orgId, job.id, message, now);
    throw caught;
  }
}
