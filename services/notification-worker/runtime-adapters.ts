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
import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
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

const SECRET_REFERENCE = /^secret:\/\/notifications\/([A-Za-z0-9][A-Za-z0-9._/-]{1,160})$/u;
const SECRET_PREFIX = /^[A-Za-z0-9/_+=.@-]{1,128}$/u;
const MAXIMUM_SECRET_BYTES = 16 * 1024;
const AWS_OPERATION_TIMEOUT_MS = 5_000;

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

  public constructor(senderForRegion: (region: string) => SesEmailSender) {
    this.senderForRegion = senderForRegion;
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
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), input.timeoutMs);
    try {
      return await this.senderForRegion(input.region).send(
        request as SendEmailRequest,
        abort.signal,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface NotificationRuntimeAdapters {
  readonly dependencies: SecurityNotificationDeliveryDependencies;
  destroy(): void;
}

export function createAwsNotificationRuntimeAdapters(input: {
  readonly secretPrefix: string;
  readonly secretsConfig?: SecretsManagerClientConfig;
  readonly sesConfig?: Omit<SESv2ClientConfig, "region">;
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
  return {
    dependencies: {
      secrets: new AwsManagedSecretResolver({
        reader: secrets,
        secretPrefix: input.secretPrefix,
      }),
      dns: new NodeNotificationDnsResolver(),
      http: new NodePinnedHttpsTransport(),
      ses: new AwsSdkSesV2Transport(senderForRegion),
    },
    destroy() {
      secrets.destroy();
      for (const sender of senders.values()) sender.destroy();
      senders.clear();
    },
  };
}
