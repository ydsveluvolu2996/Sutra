import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type SecretsManagerClientConfig,
} from "@aws-sdk/client-secrets-manager";
import {
  SESv2Client,
  SendEmailCommand,
  type SESv2ClientConfig,
  type SendEmailRequest,
} from "@aws-sdk/client-sesv2";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type SQSClientConfig,
  type ReceiveMessageCommandOutput,
} from "@aws-sdk/client-sqs";
import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import {
  requiredManagedOutboundFetch,
  type ManagedOutboundEnvironment,
} from "../../lib/managed-outbound-fetch.ts";
import type {
  ManagedOutboundClientRuntime,
} from "../managed-outbound-gateway/client.ts";
import {
  classifyManagedProviderWebhookUrl,
} from "../../lib/managed-provider-webhooks.ts";
import type {
  NotificationDnsResolver,
  NotificationHttpResponse,
  PinnedNotificationHttpTransport,
  ResolvedRoutingKeySecret,
  ResolvedWebhookSecret,
  SecurityNotificationDeliveryDependencies,
  SecurityNotificationSecretResolver,
  SesV2WorkloadIamTransport,
  WebhookNotificationChannel,
} from "../../lib/security-notification-delivery.ts";
import type {
  SesFeedbackQueue,
  SesFeedbackQueueMessage,
} from "./ses-feedback.ts";

const SECRET_REFERENCE = /^secret:\/\/notifications\/([A-Za-z0-9][A-Za-z0-9._/-]{1,160})$/u;
const SECRET_PREFIX = /^[A-Za-z0-9/_+=.@-]{1,128}$/u;
const MAXIMUM_SECRET_BYTES = 16 * 1024;
const AWS_OPERATION_TIMEOUT_MS = 5_000;
const SQS_LONG_POLL_SECONDS = 10;
const SQS_OPERATION_TIMEOUT_MS = 12_000;
const SES_CONFIGURATION_SET = /^[A-Za-z0-9_-]{1,64}$/u;
const SQS_RECEIPT_HANDLE = /^[^\u0000-\u001f\u007f]{1,4096}$/u;
const SES_FEEDBACK_QUEUE_URL = /^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/\d{12}\/sutra-production-ses-feedback$/u;

export class NotificationRuntimeConfigurationError extends Error {
  public readonly code = "INVALID_RUNTIME_CONFIGURATION";

  public constructor() {
    super("Notification worker runtime configuration rejected");
    this.name = "NotificationRuntimeConfigurationError";
  }
}

function invalid(): never {
  throw new NotificationRuntimeConfigurationError();
}

interface WebhookSecretDocument {
  readonly version: 1;
  readonly channel: WebhookNotificationChannel;
  readonly webhookUrl: string;
  readonly expectedHostname: string;
  readonly idempotencyHeader?: "Idempotency-Key";
}

function parseSecretDocument(
  value: string,
  channel: WebhookSecretDocument["channel"],
): ResolvedWebhookSecret {
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_SECRET_BYTES) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalid();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid();
  const record = parsed as Record<string, unknown>;
  const allowed = new Set(["version", "channel", "webhookUrl", "expectedHostname", "idempotencyHeader"]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    record.version !== 1 ||
    record.channel !== channel ||
    typeof record.webhookUrl !== "string" ||
    typeof record.expectedHostname !== "string" ||
    (
      record.idempotencyHeader !== undefined &&
      record.idempotencyHeader !== "Idempotency-Key"
    ) ||
    (channel === "slack" && record.idempotencyHeader !== undefined)
  ) invalid();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(record.webhookUrl);
  } catch {
    return invalid();
  }
  const target = classifyManagedProviderWebhookUrl(parsedUrl);
  if (
    parsedUrl.hostname !== record.expectedHostname ||
    (channel === "slack" && target !== "slack-webhook") ||
    (
      channel === "microsoft_teams" &&
      target !== "teams-logic-workflow" &&
      target !== "teams-powerplatform-workflow"
    ) ||
    (
      channel === "generic_webhook" &&
      target !== "jira-cloud-webhook" &&
      target !== "servicenow-webhook"
    )
  ) invalid();
  return {
    webhookUrl: record.webhookUrl,
    expectedHostname: record.expectedHostname,
    ...(record.idempotencyHeader === "Idempotency-Key"
      ? { idempotencyHeader: "Idempotency-Key" as const }
      : {}),
  };
}

const PAGERDUTY_ROUTING_KEY = /^[A-Za-z0-9]{20,64}$/u;

function parseRoutingKeyDocument(value: string): ResolvedRoutingKeySecret {
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_SECRET_BYTES) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalid();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid();
  const record = parsed as Record<string, unknown>;
  const allowed = new Set(["version", "channel", "routingKey"]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    record.version !== 1 ||
    record.channel !== "pagerduty" ||
    typeof record.routingKey !== "string" ||
    !PAGERDUTY_ROUTING_KEY.test(record.routingKey)
  ) invalid();
  return { routingKey: record.routingKey };
}

export interface ManagedSecretReader {
  getSecretString(secretId: string): Promise<string | null>;
}

export class AwsSecretsManagerReader implements ManagedSecretReader {
  private readonly client: SecretsManagerClient;

  public constructor(config: SecretsManagerClientConfig = {}) {
    this.client = new SecretsManagerClient(config);
  }

  public async getSecretString(secretId: string): Promise<string | null> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), AWS_OPERATION_TIMEOUT_MS);
    try {
      const result = await this.client.send(new GetSecretValueCommand({
        SecretId: secretId,
        VersionStage: "AWSCURRENT",
      }), { abortSignal: abort.signal });
      if (result.SecretString === undefined) invalid();
      return result.SecretString;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "ResourceNotFoundException"
      ) return null;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  public destroy(): void {
    this.client.destroy();
  }
}

export class AwsManagedSecretResolver implements SecurityNotificationSecretResolver {
  private readonly reader: ManagedSecretReader;
  private readonly secretPrefix: string;

  public constructor(input: {
    readonly reader: ManagedSecretReader;
    readonly secretPrefix: string;
  }) {
    if (!SECRET_PREFIX.test(input.secretPrefix) || !input.secretPrefix.endsWith("/")) invalid();
    this.reader = input.reader;
    this.secretPrefix = input.secretPrefix;
  }

  public async resolveWebhook(input: {
    readonly secretReference: string;
    readonly channel: WebhookNotificationChannel;
  }): Promise<ResolvedWebhookSecret | null> {
    const match = SECRET_REFERENCE.exec(input.secretReference);
    if (match === null || match[1] === undefined || match[1].includes("..")) invalid();
    const value = await this.reader.getSecretString(`${this.secretPrefix}${match[1]}`);
    return value === null ? null : parseSecretDocument(value, input.channel);
  }

  public async resolveRoutingKey(input: {
    readonly secretReference: string;
    readonly channel: "pagerduty";
  }): Promise<ResolvedRoutingKeySecret | null> {
    if (input.channel !== "pagerduty") invalid();
    const match = SECRET_REFERENCE.exec(input.secretReference);
    if (match === null || match[1] === undefined || match[1].includes("..")) invalid();
    const value = await this.reader.getSecretString(`${this.secretPrefix}${match[1]}`);
    return value === null ? null : parseRoutingKeyDocument(value);
  }
}

export class NodeNotificationDnsResolver implements NotificationDnsResolver {
  public async resolve(hostname: string): Promise<readonly string[]> {
    const lookup = Promise.all([
      resolve4(hostname).catch(() => []),
      resolve6(hostname).catch(() => []),
    ]);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new DOMException("Timed out", "TimeoutError")),
        AWS_OPERATION_TIMEOUT_MS,
      );
    });
    const [ipv4, ipv6] = await Promise.race([lookup, bounded]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
    return [...ipv4, ...ipv6];
  }
}

function responseHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key] = typeof value === "string"
      ? value
      : value === undefined
        ? undefined
        : value.join(", ");
  }
  return normalized;
}

export class NodePinnedHttpsTransport implements PinnedNotificationHttpTransport {
  public async post(input: {
    readonly url: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
    readonly validatedAddresses: readonly string[];
    readonly redirect: "error";
    readonly timeoutMs: 5_000;
    readonly maximumResponseBytes: 16_384;
    readonly gatewayIdempotencyKey: string;
  }): Promise<NotificationHttpResponse> {
    const address = input.validatedAddresses[0];
    const family = address === undefined ? 0 : isIP(address);
    if (family === 0) invalid();
    return new Promise<NotificationHttpResponse>((resolve, reject) => {
      let settled = false;
      const succeed = (value: NotificationHttpResponse) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const abort = new AbortController();
      const timeout = setTimeout(() => {
        abort.abort();
        fail(new DOMException("Timed out", "TimeoutError"));
      }, input.timeoutMs);
      const req = request(input.url, {
        method: "POST",
        agent: false,
        signal: abort.signal,
        servername: input.url.hostname,
        headers: {
          ...input.headers,
          "content-length": String(input.body.byteLength),
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, address, family);
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.byteLength;
          if (total > input.maximumResponseBytes) {
            response.destroy();
            fail(new Error("Bounded provider response exceeded"));
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => {
          clearTimeout(timeout);
          succeed({
            status: response.statusCode ?? 0,
            headers: responseHeaders(response.headers),
            bodyBytes: Buffer.concat(chunks),
          });
        });
        response.on("error", (error) => {
          clearTimeout(timeout);
          fail(error);
        });
      });
      req.on("error", (error) => {
        clearTimeout(timeout);
        if (abort.signal.aborted) return;
        fail(error);
      });
      req.end(input.body);
    });
  }
}

export class ManagedOutboundNotificationHttpTransport
implements PinnedNotificationHttpTransport {
  private readonly outboundFetch: typeof fetch;

  public constructor(
    environment: ManagedOutboundEnvironment,
    runtime: ManagedOutboundClientRuntime = {},
  ) {
    this.outboundFetch = requiredManagedOutboundFetch(
      environment,
      undefined,
      runtime,
    );
  }

  public async post(input: {
    readonly url: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
    readonly validatedAddresses: readonly string[];
    readonly redirect: "error";
    readonly timeoutMs: 5_000;
    readonly maximumResponseBytes: 16_384;
    readonly gatewayIdempotencyKey: string;
  }): Promise<NotificationHttpResponse> {
    if (
      input.redirect !== "error" ||
      !/^notify_[a-f0-9]{48}$/u.test(input.gatewayIdempotencyKey) ||
      input.body.byteLength > 64 * 1024
    ) invalid();
    const response = await this.outboundFetch(input.url, {
      method: "POST",
      headers: {
        ...input.headers,
        "idempotency-key": input.gatewayIdempotencyKey,
      },
      body: Uint8Array.from(input.body).buffer,
      redirect: "error",
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/u.test(declared) || Number(declared) > input.maximumResponseBytes)
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("Bounded provider response exceeded");
    }
    const bodyBytes = new Uint8Array(await response.arrayBuffer());
    if (bodyBytes.byteLength > input.maximumResponseBytes) {
      throw new Error("Bounded provider response exceeded");
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      bodyBytes,
    };
  }
}

export interface SesEmailSender {
  send(input: SendEmailRequest, signal: AbortSignal): Promise<NotificationHttpResponse>;
}

export class AwsSesV2Sender implements SesEmailSender {
  private readonly client: SESv2Client;

  public constructor(config: SESv2ClientConfig = {}) {
    this.client = new SESv2Client(config);
  }

  public async send(input: SendEmailRequest, signal: AbortSignal): Promise<NotificationHttpResponse> {
    const output = await this.client.send(new SendEmailCommand(input), { abortSignal: signal });
    return {
      status: output.$metadata.httpStatusCode ?? 200,
      headers: {},
      bodyBytes: new Uint8Array(),
    };
  }

  public destroy(): void {
    this.client.destroy();
  }
}

export class AwsSdkSesV2Transport implements SesV2WorkloadIamTransport {
  private readonly senderForRegion: (region: string) => SesEmailSender;
  private readonly configurationSetName: string | null;

  public constructor(
    senderForRegion: (region: string) => SesEmailSender,
    configurationSetName: string | null = null,
  ) {
    if (
      configurationSetName !== null &&
      !SES_CONFIGURATION_SET.test(configurationSetName)
    ) invalid();
    this.senderForRegion = senderForRegion;
    this.configurationSetName = configurationSetName;
  }

  public async post(input: {
    readonly service: "ses";
    readonly region: string;
    readonly url: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
    readonly redirect: "error";
    readonly timeoutMs: 5_000;
    readonly maximumResponseBytes: 16_384;
  }): Promise<NotificationHttpResponse> {
    const expectedHost = `email.${input.region}.amazonaws.com`;
    if (
      input.service !== "ses" ||
      input.url.protocol !== "https:" ||
      input.url.hostname !== expectedHost ||
      input.url.pathname !== "/v2/email/outbound-emails"
    ) invalid();
    let request: unknown;
    try {
      request = JSON.parse(new TextDecoder().decode(input.body));
    } catch {
      return invalid();
    }
    if (typeof request !== "object" || request === null || Array.isArray(request)) invalid();
    if (this.configurationSetName === null) {
      return {
        status: 0,
        headers: {},
        bodyBytes: new Uint8Array(),
        adapterErrorCode: "ADAPTER_NOT_CONFIGURED",
      };
    }
    const requestRecord = request as Record<string, unknown>;
    if ("ConfigurationSetName" in requestRecord) invalid();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), input.timeoutMs);
    try {
      try {
        return await this.senderForRegion(input.region).send(
          {
            ...requestRecord,
            ConfigurationSetName: this.configurationSetName,
          } as SendEmailRequest,
          abort.signal,
        );
      } catch (error) {
        const name = typeof error === "object" && error !== null && "name" in error
          ? String(error.name)
          : "";
        if (name === "TooManyRequestsException" || name === "ThrottlingException") {
          return { status: 429, headers: {}, bodyBytes: new Uint8Array() };
        }
        if (
          name === "ServiceUnavailableException" ||
          name === "InternalServiceErrorException"
        ) {
          return { status: 503, headers: {}, bodyBytes: new Uint8Array() };
        }
        if (
          name === "AccessDeniedException" ||
          name === "AccountSuspendedException" ||
          name === "SendingPausedException"
        ) {
          return { status: 403, headers: {}, bodyBytes: new Uint8Array() };
        }
        if (
          name === "MessageRejected" ||
          name === "MailFromDomainNotVerifiedException" ||
          name === "BadRequestException" ||
          name === "NotFoundException"
        ) {
          return { status: 400, headers: {}, bodyBytes: new Uint8Array() };
        }
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface NotificationRuntimeAdapters {
  readonly dependencies: SecurityNotificationDeliveryDependencies;
  readonly feedback: SesFeedbackQueue | null;
  destroy(): void;
}

export interface SqsFeedbackClient {
  send(
    command: unknown,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<unknown>;
  destroy(): void;
}

export class AwsSqsSesFeedbackQueue implements SesFeedbackQueue {
  private readonly client: SqsFeedbackClient;
  private readonly queueUrl: string;

  public constructor(input: {
    readonly queueUrl: string;
    readonly config?: SQSClientConfig;
    readonly client?: SqsFeedbackClient;
  }) {
    if (
      !SES_FEEDBACK_QUEUE_URL.test(input.queueUrl) ||
      (input.client === undefined && input.config === undefined)
    ) invalid();
    this.queueUrl = input.queueUrl;
    if (input.client !== undefined) {
      this.client = input.client;
    } else {
      const sdkClient = new SQSClient(input.config ?? {});
      this.client = {
        send(command, options) {
          if (command instanceof ReceiveMessageCommand) {
            return sdkClient.send(command, options);
          }
          if (command instanceof DeleteMessageCommand) {
            return sdkClient.send(command, options);
          }
          return invalid();
        },
        destroy() {
          sdkClient.destroy();
        },
      };
    }
  }

  public async receive(signal?: AbortSignal): Promise<SesFeedbackQueueMessage | null> {
    if (signal?.aborted) return null;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => abort.abort(), SQS_OPERATION_TIMEOUT_MS);
    try {
      const response = await this.client.send(new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 1,
        VisibilityTimeout: 60,
        WaitTimeSeconds: SQS_LONG_POLL_SECONDS,
      }), { abortSignal: abort.signal }) as ReceiveMessageCommandOutput;
      const message = response.Messages?.[0];
      if (
        message === undefined ||
        message.Body === undefined ||
        message.ReceiptHandle === undefined
      ) return null;
      if (!SQS_RECEIPT_HANDLE.test(message.ReceiptHandle)) invalid();
      return {
        body: message.Body,
        receiptHandle: message.ReceiptHandle,
      };
    } catch (error) {
      if (signal?.aborted) return null;
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  public async delete(receiptHandle: string): Promise<void> {
    if (!SQS_RECEIPT_HANDLE.test(receiptHandle)) invalid();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), AWS_OPERATION_TIMEOUT_MS);
    try {
      await this.client.send(new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
      }), { abortSignal: abort.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  public destroy(): void {
    this.client.destroy();
  }
}

export function createAwsNotificationRuntimeAdapters(input: {
  readonly secretPrefix: string;
  readonly sesConfigurationSetName?: string | null;
  readonly sesFeedbackQueueUrl?: string | null;
  readonly awsRegion?: string | null;
  readonly secretsConfig?: SecretsManagerClientConfig;
  readonly sesConfig?: Omit<SESv2ClientConfig, "region">;
  readonly sqsConfig?: Omit<SQSClientConfig, "region">;
  readonly managedOutboundEnvironment: ManagedOutboundEnvironment;
}): NotificationRuntimeAdapters {
  const secrets = new AwsSecretsManagerReader(input.secretsConfig);
  const senders = new Map<string, AwsSesV2Sender>();
  const senderForRegion = (region: string): AwsSesV2Sender => {
    const existing = senders.get(region);
    if (existing !== undefined) return existing;
    const created = new AwsSesV2Sender({ ...input.sesConfig, region });
    senders.set(region, created);
    return created;
  };
  const feedback = input.sesFeedbackQueueUrl === null ||
    input.sesFeedbackQueueUrl === undefined ||
    input.awsRegion === null ||
    input.awsRegion === undefined
    ? null
    : new AwsSqsSesFeedbackQueue({
        queueUrl: input.sesFeedbackQueueUrl,
        config: { ...input.sqsConfig, region: input.awsRegion },
      });
  return {
    dependencies: {
      secrets: new AwsManagedSecretResolver({
        reader: secrets,
        secretPrefix: input.secretPrefix,
      }),
      dns: new NodeNotificationDnsResolver(),
      http: new ManagedOutboundNotificationHttpTransport(
        input.managedOutboundEnvironment,
      ),
      ses: new AwsSdkSesV2Transport(
        senderForRegion,
        input.sesConfigurationSetName ?? null,
      ),
    },
    feedback,
    destroy() {
      secrets.destroy();
      for (const sender of senders.values()) sender.destroy();
      senders.clear();
      feedback?.destroy();
    },
  };
}
