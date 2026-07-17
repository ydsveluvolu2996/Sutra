import { createServer, type Server } from "node:http";
import {
  createAwsNotificationRuntimeAdapters,
  type NotificationRuntimeAdapters,
} from "./runtime-adapters.ts";
import type { SecurityNotificationDeliveryDependencies } from "../../lib/security-notification-delivery.ts";

const INTEGER = /^\d{1,6}$/u;
const SAFE_PREFIX = /^[A-Za-z0-9/_+=.@-]{1,128}$/u;

export interface NotificationWorkerRuntimeConfig {
  readonly pollIntervalMs: number;
  readonly healthPort: number;
  readonly secretPrefix: string;
}

export interface NotificationWorkerRuntimeStatus {
  readonly live: boolean;
  readonly ready: boolean;
  readonly stopping: boolean;
  readonly lastPollCompletedAt: string | null;
  readonly lastResult: "idle" | "delivered" | "retry_scheduled" | "dead_letter" | "not_configured" | null;
  readonly consecutiveFailures: number;
}

export type ProcessOneSecurityNotification = (input: {
  readonly delivery: SecurityNotificationDeliveryDependencies;
}) => Promise<"idle" | "delivered" | "retry_scheduled" | "dead_letter" | "not_configured">;

async function defaultProcessor(): Promise<ProcessOneSecurityNotification> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (
    databaseUrl === undefined ||
    databaseUrl.length > 4_096 ||
    !/^postgres(?:ql)?:\/\//u.test(databaseUrl)
  ) throw new Error("Notification worker database configuration rejected");
  const [
    { processOneSecurityNotification },
    { PostgresSecurityNotificationWorkerRepository },
  ] = await Promise.all([
    import("./worker.ts"),
    import("./postgres-repository.ts"),
  ]);
  const repository = new PostgresSecurityNotificationWorkerRepository(databaseUrl);
  return ({ delivery }) => processOneSecurityNotification({ repository, delivery });
}

export function readNotificationWorkerRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): NotificationWorkerRuntimeConfig {
  const poll = env.SUTRA_NOTIFICATION_POLL_INTERVAL_MS ?? "1000";
  const port = env.SUTRA_NOTIFICATION_HEALTH_PORT ?? "8081";
  const secretPrefix = env.SUTRA_NOTIFICATION_SECRET_PREFIX ?? "sutra/notifications/";
  if (
    !INTEGER.test(poll) ||
    Number(poll) < 100 ||
    Number(poll) > 60_000 ||
    !INTEGER.test(port) ||
    Number(port) < 1_024 ||
    Number(port) > 65_535 ||
    !SAFE_PREFIX.test(secretPrefix) ||
    !secretPrefix.endsWith("/")
  ) throw new Error("Notification worker runtime configuration rejected");
  return {
    pollIntervalMs: Number(poll),
    healthPort: Number(port),
    secretPrefix,
  };
}

function safeLog(
  level: "info" | "error",
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null>> = {},
): void {
  const entry = JSON.stringify({ level, event, ...fields });
  (level === "error" ? console.error : console.log)(entry);
}

function healthServer(
  port: number,
  readStatus: () => NotificationWorkerRuntimeStatus,
): Promise<Server> {
  const server = createServer((request, response) => {
    const status = readStatus();
    if (request.method !== "GET" || (request.url !== "/healthz" && request.url !== "/readyz")) {
      response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      response.end('{"error":"not_found"}');
      return;
    }
    const readyRequest = request.url === "/readyz";
    const healthy = readyRequest ? status.ready && !status.stopping : status.live;
    response.writeHead(healthy ? 200 : 503, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({
      status: healthy ? "ok" : "unavailable",
      ready: status.ready,
      stopping: status.stopping,
      lastPollCompletedAt: status.lastPollCompletedAt,
      consecutiveFailures: status.consecutiveFailures,
    }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function runNotificationWorker(input: {
  readonly config?: NotificationWorkerRuntimeConfig;
  readonly adapters?: NotificationRuntimeAdapters;
  readonly signal?: AbortSignal;
  readonly processOne?: ProcessOneSecurityNotification;
} = {}): Promise<void> {
  const config = input.config ?? readNotificationWorkerRuntimeConfig();
  const ownedAbort = new AbortController();
  const signal = input.signal ?? ownedAbort.signal;
  const adapters = input.adapters ?? createAwsNotificationRuntimeAdapters({
    secretPrefix: config.secretPrefix,
  });
  const processOne = input.processOne ?? await defaultProcessor();
  let state: NotificationWorkerRuntimeStatus = {
    live: true,
    ready: false,
    stopping: false,
    lastPollCompletedAt: null,
    lastResult: null,
    consecutiveFailures: 0,
  };
  const server = await healthServer(config.healthPort, () => state);
  state = { ...state, ready: true };
  safeLog("info", "notification_worker.started", { healthPort: config.healthPort });
  try {
    while (!signal.aborted) {
      try {
        const result = await processOne({ delivery: adapters.dependencies });
        state = {
          ...state,
          ready: true,
          lastPollCompletedAt: new Date().toISOString(),
          lastResult: result,
          consecutiveFailures: 0,
        };
        if (result !== "idle") safeLog("info", "notification_worker.job_finished", { result });
      } catch {
        state = {
          ...state,
          ready: false,
          lastPollCompletedAt: new Date().toISOString(),
          consecutiveFailures: state.consecutiveFailures + 1,
        };
        safeLog("error", "notification_worker.poll_failed", {
          consecutiveFailures: state.consecutiveFailures,
        });
      }
      await wait(config.pollIntervalMs, signal);
    }
  } finally {
    state = { ...state, ready: false, stopping: true };
    await new Promise<void>((resolve) => server.close(() => resolve()));
    adapters.destroy();
    state = { ...state, live: false };
    safeLog("info", "notification_worker.stopped");
  }
}

export async function main(): Promise<void> {
  const abort = new AbortController();
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    process.once(name, () => abort.abort());
  }
  await runNotificationWorker({ signal: abort.signal });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {
    safeLog("error", "notification_worker.fatal");
    process.exitCode = 1;
  });
}
