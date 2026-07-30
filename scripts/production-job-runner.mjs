import { postInternalJobRun } from "./internal-job-request.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value || /[\r\n]/u.test(value)) {
    throw new Error(`${name} is required and must be one line`);
  }
  return value;
}

const token = required("SUTRA_JOB_RUNNER_TOKEN");
const publicOrigin = required("SUTRA_PUBLIC_ORIGIN");
const requestedInterval = Number(process.env.SUTRA_JOB_RUNNER_INTERVAL_MS ?? "15000");
if (!Number.isFinite(requestedInterval)) {
  throw new Error("SUTRA_JOB_RUNNER_INTERVAL_MS must be numeric");
}
const intervalMs = Math.min(300_000, Math.max(5_000, requestedInterval));
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stopping = true;
  });
}

async function tick() {
  try {
    const response = await postInternalJobRun({
      port: 3000,
      token,
      publicOrigin,
      // One tick may execute one bounded inventory job and one bounded cleanup
      // job sequentially. Keep the private loopback request alive across both;
      // each job still has its own seven-minute durable lease.
      timeoutMs: 20 * 60_000,
    });
    if (!response.ok) {
      process.stderr.write(`${JSON.stringify({
        event: "sutra.background-job-drain.failed",
        status: response.status,
      })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      event: "sutra.background-job-drain.error",
      reason: error instanceof Error ? error.name : "unknown",
    })}\n`);
  }
}

// ECS starts this sidecar only after the application container is healthy.
// Run immediately, then serially: overlapping drains add no throughput because
// leases are durable and make shutdown/recovery harder to reason about.
while (!stopping) {
  await tick();
  await new Promise((resolvePromise) => {
    setTimeout(resolvePromise, intervalMs);
  });
}
