import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connect } from "node:net";

import { LIVE_COMPOSE_PROJECT, LIVE_RUNTIME_CONFIG } from "./live-aws-host.mjs";

const DEFAULT_WEB_PORT = 3000;
const COLLECTOR_PORT = 8788;

export function credentialState(remainingMinutes) {
  if (!Number.isFinite(remainingMinutes) || remainingMinutes < 0) return "failed";
  if (remainingMinutes < 15) return "failed";
  if (remainingMinutes < 30) return "warning";
  return "healthy";
}

export function buildDemoStatus({ web, collector, postgres, credentials }) {
  const checks = [web, collector, postgres, ...(credentials === undefined ? [] : [credentials])];
  return {
    ok: checks.every((check) => check.state !== "failed"),
    checks,
  };
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
    });
    const body = await response.json().catch(() => null);
    return { ok: response.ok && body?.ok === true, body };
  } catch {
    return { ok: false, body: null };
  }
}

async function loopbackPortOpen(port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(3_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function capture(command, args, environment = process.env) {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

async function postgresCheck(root) {
  const environmentPath = resolve(root, ".sutra/docker.env");
  try {
    await access(environmentPath);
  } catch {
    return { name: "PostgreSQL", state: "failed", detail: "local Docker configuration is missing" };
  }
  const result = await capture("docker", [
    "compose", "--project-name", LIVE_COMPOSE_PROJECT,
    "--env-file", environmentPath,
    "ps", "--status", "running", "--services", "postgres",
  ]).catch(() => ({ code: 1, stdout: "" }));
  const running = result.code === 0 && result.stdout.split(/\r?\n/u).includes("postgres");
  return {
    name: "PostgreSQL",
    state: running ? "healthy" : "failed",
    detail: running ? "live database container is running" : "live database container is not running",
  };
}

async function credentialCheck(root) {
  const profile = process.env.AWS_PROFILE?.trim();
  const principal = process.env.SUTRA_COLLECTOR_PRINCIPAL_ARN?.trim();
  if (!profile || !principal) return undefined;
  const executable = resolve(root, "services/aws-collector/dist/src/aws-sandbox-preflight.js");
  const environment = {
    ...process.env,
    SUTRA_COLLECTOR_PRINCIPAL_ARN: principal,
  };
  const result = await capture(process.execPath, [executable], environment).catch(() => ({
    code: 1,
    stdout: "",
    stderr: "",
  }));
  if (result.code !== 0) {
    return {
      name: "AWS session",
      state: "failed",
      detail: `profile ${profile} must be refreshed before live collection`,
    };
  }
  try {
    const assessment = JSON.parse(result.stdout);
    const remaining = Number(assessment.remainingMinutes);
    const state = credentialState(remaining);
    return {
      name: "AWS session",
      state,
      detail: state === "warning"
        ? `profile ${profile} expires in about ${remaining} minutes; refresh before the demo`
        : `profile ${profile} has about ${remaining} minutes remaining`,
    };
  } catch {
    return { name: "AWS session", state: "failed", detail: "credential preflight returned an invalid result" };
  }
}

export async function collectDemoStatus({
  root,
  webPort = Number(process.env.SUTRA_WEB_PORT ?? DEFAULT_WEB_PORT),
} = {}) {
  const projectRoot = root ?? resolve(import.meta.dirname, "..");
  const [webResult, collectorOpen, postgres, credentials] = await Promise.all([
    fetchJson(`http://127.0.0.1:${webPort}/api/healthz`),
    loopbackPortOpen(COLLECTOR_PORT),
    postgresCheck(projectRoot),
    credentialCheck(projectRoot),
  ]);
  return buildDemoStatus({
    web: {
      name: "Sutra web",
      state: webResult.ok ? "healthy" : "failed",
      detail: webResult.ok ? `ready on http://127.0.0.1:${webPort}` : "readiness endpoint is unavailable",
    },
    collector: {
      name: "AWS collector",
      state: collectorOpen && webResult.ok ? "healthy" : "failed",
      detail: collectorOpen && webResult.ok
        ? "loopback collector is reachable and passed combined readiness"
        : "collector port or combined readiness is unavailable",
    },
    postgres,
    credentials,
  });
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  try {
    await access(resolve(root, LIVE_RUNTIME_CONFIG));
  } catch {
    process.stderr.write("Sutra live runtime configuration is missing; run the guarded live launcher first.\n");
    process.exitCode = 1;
    return;
  }
  const status = await collectDemoStatus({ root });
  process.stdout.write("Sutra live demo status\n");
  for (const check of status.checks) {
    const marker = check.state === "healthy" ? "PASS" : check.state === "warning" ? "WARN" : "FAIL";
    process.stdout.write(`[${marker}] ${check.name}: ${check.detail}\n`);
  }
  if (!status.checks.some((check) => check.name === "AWS session")) {
    process.stdout.write("[SKIP] AWS session: set AWS_PROFILE and SUTRA_COLLECTOR_PRINCIPAL_ARN to validate expiry\n");
  }
  process.exitCode = status.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
