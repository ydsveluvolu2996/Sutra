import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { postInternalJobRun } from "./internal-job-request.mjs";

const root = resolve(import.meta.dirname, "..");
const variablesPath = resolve(root, ".dev.vars");

function parseVariables(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(".dev.vars contains an invalid line");
    const key = line.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) throw new Error(".dev.vars contains an invalid key");
    result[key] = line.slice(separator + 1);
  }
  return result;
}

const variables = parseVariables(await readFile(variablesPath, "utf8"));
const environment = { ...process.env, ...variables };
const webHost = environment.SUTRA_WEB_HOST ?? "127.0.0.1";
const webPort = "3000";

const collector = spawn(process.execPath, [resolve(root, "services/aws-collector/dist/src/local-server.js")], {
  cwd: root,
  env: environment,
  stdio: "inherit",
});
const web = spawn(resolve(root, "node_modules/.bin/wrangler"), [
  "dev",
  "--config", resolve(root, "dist/server/wrangler.json"),
  "--env-file", variablesPath,
  "--ip", webHost,
  "--port", webPort,
  "--show-interactive-dev-session", "false",
], {
  cwd: root,
  env: { ...environment, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
  stdio: "inherit",
});

// Durable background-job ticker. When a runner token is configured, poll the
// system-internal drain endpoint on an interval. Failures are logged and never
// crash the pilot — the endpoint is idempotent and the next tick simply retries.
const jobRunnerToken = environment.SUTRA_JOB_RUNNER_TOKEN;
let jobRunnerTimer;
if (typeof jobRunnerToken === "string" && jobRunnerToken.length > 0) {
  const requestedInterval = Number(environment.SUTRA_JOB_RUNNER_INTERVAL_MS ?? "15000");
  const intervalMs = Number.isFinite(requestedInterval)
    ? Math.min(300_000, Math.max(5_000, requestedInterval))
    : 15_000;
  jobRunnerTimer = setInterval(() => {
    postInternalJobRun({
      port: webPort,
      token: jobRunnerToken,
      publicOrigin: environment.SUTRA_PUBLIC_ORIGIN,
    })
      .then((response) => {
        if (!response.ok) {
          process.stderr.write(`${JSON.stringify({ event: "sutra.job-runner.tick.failed", status: response.status })}\n`);
        }
      })
      .catch((error) => {
        const reason = error instanceof Error ? error.name : "unknown";
        process.stderr.write(`${JSON.stringify({ event: "sutra.job-runner.tick.error", reason })}\n`);
      });
  }, intervalMs);
  jobRunnerTimer.unref?.();
}

let closing = false;
function stop(signal = "SIGTERM") {
  if (closing) return;
  closing = true;
  if (jobRunnerTimer !== undefined) clearInterval(jobRunnerTimer);
  collector.kill(signal);
  web.kill(signal);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stop(signal));

const exit = await Promise.race([
  new Promise((resolvePromise) => collector.once("exit", (code, signal) => resolvePromise({ name: "collector", code, signal }))),
  new Promise((resolvePromise) => web.once("exit", (code, signal) => resolvePromise({ name: "web", code, signal }))),
]);
// Captured BEFORE stop(), which sets `closing` itself: this distinguishes "an
// operator or orchestrator signalled us" from "a child died on its own".
const shutdownWasRequested = closing;
stop();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));

// ALWAYS SAY WHICH CHILD WENT, AND FAIL WHEN NOBODY ASKED US TO STOP.
//
// This block used to log only when the exit code was non-zero, so a child that
// exited CLEANLY took the whole container down in silence and reported success.
// Production showed exactly that: RestartCount=3, State.ExitCode=0,
// OOMKilled=false, no error anywhere in the logs, and `restart: unless-stopped`
// quietly bringing it back. From outside it looked like random 500 "Network
// connection lost" and 503s on any endpoint unlucky enough to be mid-request —
// with nothing to point at a restart at all.
//
// Neither child may exit while the service is meant to be serving, whatever its
// code. Exiting non-zero is what makes Docker's restart legible as a failure
// rather than a normal stop, and the structured line names the child so the next
// occurrence is one log read instead of an investigation.
if (!shutdownWasRequested) {
  process.stderr.write(`${JSON.stringify({
    event: "sutra.supervisor.child-exited",
    child: exit.name,
    code: exit.code,
    signal: exit.signal,
    detail: "no shutdown was requested; neither child may exit while serving",
  })}\n`);
  process.exitCode = 1;
} else if (exit.code !== 0 && exit.signal === null) {
  process.stderr.write(`${JSON.stringify({
    event: "sutra.supervisor.child-failed-during-shutdown",
    child: exit.name,
    code: exit.code,
  })}\n`);
  process.exitCode = 1;
}
