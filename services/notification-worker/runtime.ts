import { createServer, type Server } from "node:http";
import {
  createAwsNotificationRuntimeAdapters,
  type NotificationRuntimeAdapters,
} from "./runtime-adapters.ts";
import type { SecurityNotificationDeliveryDependencies } from "../../lib/security-notification-delivery.ts";
import {
  processOneSesFeedback,
  type SesFeedbackProcessingResult,
  type SesFeedbackQueue,
} from "./ses-feedback.ts";

const INTEGER = /^\d{1,6}$/u;
const SAFE_PREFIX = /^[A-Za-z0-9/_+=.@-]{1,128}$/u;
const SES_CONFIGURATION_SET = /^[A-Za-z0-9_-]{1,64}$/u;
const AWS_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const AWS_ACCOUNT_ID = /^\d{12}$/u;
const SQS_QUEUE_URL = /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\/(\d{12})\/sutra-production-ses-feedback$/u;
const MANAGED_OUTBOUND_URL = /^https:\/\/outbound\.sutracmdb\.com$/u;
const MANAGED_OUTBOUND_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BASE64URL_PRIVATE_KEY = /^[A-Za-z0-9_-]{64,4096}$/u;

type NotificationOutboundResult =
  | "idle"
  | "provider_accepted"
  | "delivered"
  | "retry_scheduled"
  | "dead_letter"
  | "not_configured";

type NotificationWorkerResult =
  | NotificationOutboundResult
  | SesFeedbackProcessingResult;

export interface NotificationWorkerRuntimeConfig {
  readonly pollIntervalMs: number;
  readonly healthPort: number;
  readonly secretPrefix: string;
  readonly sesConfigurationSetName: string | null;
  readonly sesFeedbackQueueUrl: string | null;
  readonly sesFeedbackAccountId: string | null;
  readonly awsRegion: string | null;
}

export interface NotificationWorkerRuntimeStatus {
  readonly live: boolean;
  readonly ready: boolean;
  readonly stopping: boolean;
  readonly lastPollCompletedAt: string | null;
  readonly lastResult: NotificationWorkerResult | null;
  readonly consecutiveFailures: number;
}

export type ProcessOneSecurityNotification = (input: {
  readonly delivery: SecurityNotificationDeliveryDependencies;
  readonly feedback: SesFeedbackQueue | null;
  readonly feedbackConfiguration: {
    readonly expectedRegion: string;
    readonly expectedAccountId: string;
    readonly expectedConfigurationSetName: string;
  } | null;
  readonly signal: AbortSignal;
}) => Promise<NotificationWorkerResult>;

export async function processNotificationWorkerIteration(input: {
  readonly signal: AbortSignal;
  readonly processOutbound: () => Promise<NotificationOutboundResult>;
  readonly processFeedback: ((signal: AbortSignal) => Promise<SesFeedbackProcessingResult>) | null;
}): Promise<NotificationWorkerResult> {
  if (input.processFeedback === null) return input.processOutbound();
  const feedbackAbort = new AbortController();
  const abortFeedback = () => feedbackAbort.abort();
  if (input.signal.aborted) {
    feedbackAbort.abort();
  } else {
    input.signal.addEventListener("abort", abortFeedback, { once: true });
  }
  const feedbackOutcome = input.processFeedback(feedbackAbort.signal).then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error }),
  );
  try {
    const outbound = await input.processOutbound();
    if (outbound !== "idle") feedbackAbort.abort();
    const feedback = await feedbackOutcome;
    if (feedback.error !== null) throw feedback.error;
    return outbound === "idle" ? feedback.value ?? "idle" : outbound;
  } finally {
    feedbackAbort.abort();
    input.signal.removeEventListener("abort", abortFeedback);
  }
}

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
  return async ({ delivery, feedback, feedbackConfiguration, signal }) => {
    return processNotificationWorkerIteration({
      signal,
      processOutbound: () => processOneSecurityNotification({ repository, delivery }),
      processFeedback: feedback === null || feedbackConfiguration === null
        ? null
        : (feedbackSignal) => processOneSesFeedback({
            queue: feedback,
            repository,
            ...feedbackConfiguration,
            signal: feedbackSignal,
          }),
    });
  };
}

export function readNotificationWorkerRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): NotificationWorkerRuntimeConfig {
  const poll = env.SUTRA_NOTIFICATION_POLL_INTERVAL_MS ?? "1000";
  const port = env.SUTRA_NOTIFICATION_HEALTH_PORT ?? "8081";
  const secretPrefix =
    env.SUTRA_NOTIFICATION_CONFIG_PREFIX ??
    env.SUTRA_NOTIFICATION_SECRET_PREFIX ??
    "sutra/notifications/";
  const sesConfigurationSetName =
    env.SUTRA_SES_CONFIGURATION_SET?.trim() ?? "";
  const sesFeedbackQueueUrl =
    env.SUTRA_SES_FEEDBACK_QUEUE_URL?.trim() ?? "";
  const sesFeedbackAccountId =
    env.SUTRA_SES_FEEDBACK_ACCOUNT_ID?.trim() ?? "";
  const awsRegion = env.AWS_REGION?.trim() ?? "";
  const managedOutboundUrl = env.SUTRA_MANAGED_OUTBOUND_URL?.trim() ?? "";
  const managedOutboundKeyId = env.SUTRA_MANAGED_OUTBOUND_KEY_ID?.trim() ?? "";
  const managedOutboundPrivateKey =
    env.SUTRA_MANAGED_OUTBOUND_PRIVATE_KEY?.trim() ?? "";
  const feedbackValues = [
    sesConfigurationSetName,
    sesFeedbackQueueUrl,
    sesFeedbackAccountId,
  ];
  const feedbackConfigured = feedbackValues.every((value) => value !== "");
  const feedbackPartiallyConfigured =
    feedbackValues.some((value) => value !== "") && !feedbackConfigured;
  const queueMatch = SQS_QUEUE_URL.exec(sesFeedbackQueueUrl);
  if (
    !INTEGER.test(poll) ||
    Number(poll) < 100 ||
    Number(poll) > 60_000 ||
    !INTEGER.test(port) ||
    Number(port) < 1_024 ||
    Number(port) > 65_535 ||
    !SAFE_PREFIX.test(secretPrefix) ||
    !secretPrefix.endsWith("/") ||
    (
      sesConfigurationSetName !== "" &&
      !SES_CONFIGURATION_SET.test(sesConfigurationSetName)
    ) ||
    feedbackPartiallyConfigured ||
    (
      feedbackConfigured &&
      (
        !AWS_REGION.test(awsRegion) ||
        !AWS_ACCOUNT_ID.test(sesFeedbackAccountId) ||
        queueMatch === null ||
        queueMatch[1] !== awsRegion ||
        queueMatch[2] !== sesFeedbackAccountId
      )
    ) ||
    !MANAGED_OUTBOUND_URL.test(managedOutboundUrl) ||
    !MANAGED_OUTBOUND_KEY_ID.test(managedOutboundKeyId) ||
    !BASE64URL_PRIVATE_KEY.test(managedOutboundPrivateKey)
  ) throw new Error("Notification worker runtime configuration rejected");
  return {
    pollIntervalMs: Number(poll),
    healthPort: Number(port),
    secretPrefix,
    sesConfigurationSetName:
      sesConfigurationSetName === "" ? null : sesConfigurationSetName,
    sesFeedbackQueueUrl:
      sesFeedbackQueueUrl === "" ? null : sesFeedbackQueueUrl,
    sesFeedbackAccountId:
      sesFeedbackAccountId === "" ? null : sesFeedbackAccountId,
    awsRegion: awsRegion === "" ? null : awsRegion,
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
    sesConfigurationSetName: config.sesConfigurationSetName,
    sesFeedbackQueueUrl: config.sesFeedbackQueueUrl,
    awsRegion: config.awsRegion,
    managedOutboundEnvironment: process.env as unknown as {
      readonly SUTRA_MANAGED_OUTBOUND_URL?: string;
      readonly SUTRA_MANAGED_OUTBOUND_KEY_ID?: string;
      readonly SUTRA_MANAGED_OUTBOUND_PRIVATE_KEY?: string;
    },
  });
  const feedbackConfiguration =
    config.sesConfigurationSetName !== null &&
    config.sesFeedbackAccountId !== null &&
    config.awsRegion !== null
      ? {
          expectedRegion: config.awsRegion,
          expectedAccountId: config.sesFeedbackAccountId,
          expectedConfigurationSetName: config.sesConfigurationSetName,
        }
      : null;
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
        const result = await processOne({
          delivery: adapters.dependencies,
          feedback: adapters.feedback,
          feedbackConfiguration,
          signal,
        });
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
