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
const localCollectorEnabled = environment.SUTRA_LOCAL_MODE === "true";
if (!localCollectorEnabled && environment.SUTRA_BROKER_AUTH_MODE !== "asymmetric") {
  throw new Error("Hosted runtime requires SUTRA_BROKER_AUTH_MODE=asymmetric");
}
// The loopback HMAC collector is developer fixture infrastructure only. Hosted
// replicas use the separately scaled broker service and must never create a
// task-local connection registry or replay cache.
const collector = localCollectorEnabled
  ? spawn(process.execPath, [resolve(root, "services/aws-collector/dist/src/local-server.js")], {
      cwd: root,
      env: environment,
      stdio: "inherit",
    })
  : null;
/**
 * Serves on miniflare directly — NOT `wrangler dev`.
 *
 * `wrangler dev` is a development orchestrator: its ProxyController and
 * InspectorProxyWorker sit above the workerd runtime, and every runtime death
 * observed in production came from that layer rather than from workerd. A
 * request-scoped fault (an unread body) was escalated to a fatal process exit, and
 * a roughly hourly exit came from the same machinery. scripts/serve-worker.mjs
 * starts the same runtime with the same bindings and none of that harness, so the
 * restart logic below should now be a genuine backstop rather than routine.
 */
function spawnWeb() {
  return spawn(process.execPath, [
    resolve(root, "scripts/serve-worker.mjs"),
    "--config", resolve(root, "dist/server/wrangler.json"),
    "--env-file", variablesPath,
    "--ip", webHost,
    "--port", webPort,
  ], {
    cwd: root,
    env: environment,
    stdio: "inherit",
  });
}
let web = spawnWeb();

/**
 * RESTART THE WORKER RUNTIME RATHER THAN THE WHOLE CONTAINER.
 *
 * Observed in production 2026-07-29: wrangler 4.114.0 exits 1 roughly hourly from
 * `ProxyController.emitErrorEvent` with "Network connection lost." Taking the
 * container down with it meant Postgres-adjacent state, the collector and the job
 * ticker were all cycled too, and every request in flight failed — which is what
 * made a healthy /api/v1/cases look broken.
 *
 * Restarting just this child is seconds instead of a full container start, so the
 * blast radius of a runtime hiccup is a few requests rather than the whole app.
 *
 * BOUNDED AND LOUD on purpose. Silent infinite respawning would turn a permanent
 * fault (a bad build, a missing binding) into a hot loop that looks like uptime.
 * Past the budget the supervisor gives up and exits non-zero, which is the signal
 * Docker and an operator can both act on.
 */
const WEB_RESTART_BUDGET = 5;
const WEB_RESTART_WINDOW_MS = 60 * 60 * 1000;
const webRestarts = [];

function webRestartsInWindow(nowMs) {
  while (webRestarts.length > 0 && nowMs - webRestarts[0] > WEB_RESTART_WINDOW_MS) webRestarts.shift();
  return webRestarts.length;
}

// Durable background-job ticker. When a runner token is configured, poll the
// system-internal drain endpoint on an interval. Failures are logged and never
// crash the pilot — the endpoint is idempotent and the next tick simply retries.
const jobRunnerToken = environment.SUTRA_JOB_RUNNER_TOKEN;
let jobRunnerTimer;
if (
  environment.SUTRA_JOB_RUNNER_SELF_TICK !== "false" &&
  typeof jobRunnerToken === "string" &&
  jobRunnerToken.length > 0
) {
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
  collector?.kill(signal);
  web.kill(signal);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stop(signal));

async function nextChildExit() {
  const exits = [
    new Promise((resolvePromise) => web.once("exit", (code, signal) => resolvePromise({ name: "web", code, signal }))),
  ];
  if (collector !== null) {
    exits.push(new Promise((resolvePromise) =>
      collector.once("exit", (code, signal) => resolvePromise({ name: "collector", code, signal }))));
  }
  return Promise.race(exits);
}

let exit = await nextChildExit();
// Re-arm around a web restart. In local fixture mode the loopback collector is
// deliberately NOT restarted. Hosted mode has no task-local collector child.
while (exit.name === "web" && !closing) {
  const attempts = webRestartsInWindow(Date.now()) + 1;
  if (attempts > WEB_RESTART_BUDGET) {
    process.stderr.write(`${JSON.stringify({
      event: "sutra.supervisor.web-restart-budget-exhausted",
      attempts: attempts - 1,
      windowMinutes: WEB_RESTART_WINDOW_MS / 60000,
      detail: "the Worker runtime keeps dying; giving up rather than hiding a permanent fault in a restart loop",
    })}\n`);
    break;
  }
  webRestarts.push(Date.now());
  process.stderr.write(`${JSON.stringify({
    event: "sutra.supervisor.web-restarting",
    code: exit.code,
    signal: exit.signal,
    attempt: attempts,
    budget: WEB_RESTART_BUDGET,
    detail: "restarting the Worker runtime in place; the container and the collector keep running",
  })}\n`);
  web = spawnWeb();
  exit = await nextChildExit();
}
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
