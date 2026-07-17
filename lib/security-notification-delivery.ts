import { isIP } from "node:net";
import type {
  SecurityNotificationChannel,
  SecurityNotificationPayloads,
} from "./security-notifications.ts";
import { canonicalJson } from "./canonical-json.ts";

const SECRET_REFERENCE = /^secret:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{2,190}$/u;
const AWS_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const DELIVERY_ID = /^notify_[a-f0-9]{48}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TIMEOUT_MS = 5_000;
const MAXIMUM_RESPONSE_BYTES = 16_384;
const MAXIMUM_SES_PAYLOAD_BYTES = 128 * 1024;
const MAXIMUM_SLACK_PAYLOAD_BYTES = 48 * 1024;
const MAXIMUM_TEAMS_PAYLOAD_BYTES = 64 * 1024;

export type SecurityNotificationDeliveryStatus =
  | "delivered"
  | "retryable_failure"
  | "permanent_failure";

export interface SecurityNotificationDeliveryResult {
  readonly channel: SecurityNotificationChannel;
  readonly status: SecurityNotificationDeliveryStatus;
  readonly providerStatus: number | null;
  readonly errorCode:
    | "NONE"
    | "AUTHORIZATION_REJECTED"
    | "DESTINATION_REJECTED"
    | "PAYLOAD_REJECTED"
    | "PROVIDER_THROTTLED"
    | "PROVIDER_UNAVAILABLE"
    | "REQUEST_TIMEOUT"
    | "TRANSPORT_FAILURE";
  readonly retryAfterSeconds: number | null;
}

export interface ResolvedWebhookSecret {
  /** Secret value returned only inside the worker trust boundary. */
  readonly webhookUrl: string;
  /** Exact hostname recorded when the managed secret was provisioned. */
  readonly expectedHostname: string;
  /** Enable only when the receiving Teams workflow deduplicates this header. */
  readonly idempotencyHeader?: "Idempotency-Key";
}

export interface SecurityNotificationSecretResolver {
  resolveWebhook(input: {
    readonly secretReference: string;
    readonly channel: "slack" | "microsoft_teams";
  }): Promise<ResolvedWebhookSecret | null>;
}

export interface NotificationDnsResolver {
  resolve(hostname: string): Promise<readonly string[]>;
}

export interface NotificationHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly bodyBytes: Uint8Array;
}

/**
 * Implementations must connect only to one of `validatedAddresses`, disable
 * redirects, preserve the original TLS SNI/Host, enforce `timeoutMs`, and stop
 * reading after `maximumResponseBytes`. This avoids DNS-rebinding races that a
 * separate DNS preflight plus ordinary fetch would leave open.
 */
export interface PinnedNotificationHttpTransport {
  post(input: {
    readonly url: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
    readonly validatedAddresses: readonly string[];
    readonly redirect: "error";
    readonly timeoutMs: 5_000;
    readonly maximumResponseBytes: 16_384;
  }): Promise<NotificationHttpResponse>;
}

/**
 * The SES transport signs the request with workload IAM credentials at send
 * time. Implementations must not accept long-lived access keys through this
 * contract and must disable redirects and bound the response.
 */
export interface SesV2WorkloadIamTransport {
  post(input: {
    readonly service: "ses";
    readonly region: string;
    readonly url: URL;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
    readonly redirect: "error";
    readonly timeoutMs: 5_000;
    readonly maximumResponseBytes: 16_384;
  }): Promise<NotificationHttpResponse>;
}

export interface SecurityNotificationDeliveryDependencies {
  readonly secrets: SecurityNotificationSecretResolver;
  readonly dns: NotificationDnsResolver;
  readonly http: PinnedNotificationHttpTransport;
  readonly ses: SesV2WorkloadIamTransport;
}

export interface SecurityNotificationDestinations {
  readonly email?: {
    readonly region: string;
    readonly fromAddress: string;
  };
  readonly slackSecretReference?: string;
  readonly microsoftTeamsSecretReference?: string;
}

export class SecurityNotificationDeliveryError extends Error {
  public readonly code: "INVALID_CONFIGURATION" | "UNSAFE_DESTINATION";

  public constructor(code: "INVALID_CONFIGURATION" | "UNSAFE_DESTINATION") {
    super("Security notification delivery rejected");
    this.name = "SecurityNotificationDeliveryError";
    this.code = code;
  }
}

function invalid(code: SecurityNotificationDeliveryError["code"]): never {
  throw new SecurityNotificationDeliveryError(code);
}

function jsonBytes(value: unknown, maximum: number): Uint8Array {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return invalid("INVALID_CONFIGURATION");
  }
  const body = new TextEncoder().encode(serialized);
  if (body.byteLength < 2 || body.byteLength > maximum) invalid("INVALID_CONFIGURATION");
  return body;
}

function validHostname(hostname: string): boolean {
  return hostname.length <= 253 &&
    hostname === hostname.toLowerCase() &&
    hostname.split(".").every((label) => HOST_LABEL.test(label));
}

function providerHostname(channel: "slack" | "microsoft_teams", hostname: string): boolean {
  if (channel === "slack") return hostname === "hooks.slack.com";
  return (
    hostname.endsWith(".logic.azure.com") ||
    hostname.endsWith(".environment.api.powerplatform.com")
  ) && hostname.split(".").length >= 4;
}

function webhookUrl(
  channel: "slack" | "microsoft_teams",
  resolved: ResolvedWebhookSecret,
): URL {
  let url: URL;
  try {
    url = new URL(resolved.webhookUrl);
  } catch {
    return invalid("UNSAFE_DESTINATION");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.port !== "" && url.port !== "443") ||
    !validHostname(url.hostname) ||
    url.hostname !== resolved.expectedHostname ||
    !providerHostname(channel, url.hostname) ||
    url.pathname.length < 2 ||
    url.pathname.length > 2_048 ||
    url.search.length > 4_096
  ) invalid("UNSAFE_DESTINATION");
  if (channel === "slack" && (
    url.search !== "" ||
    !/^\/services\/[A-Za-z0-9_-]{8,}\/[A-Za-z0-9_-]{8,}\/[A-Za-z0-9_-]{16,}$/u.test(url.pathname)
  )) invalid("UNSAFE_DESTINATION");
  return url;
}

function ipv4Private(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && parts[2] === 2) ||
    (a === 192 && b === 88 && parts[2] === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

function ipv6Private(address: string): boolean {
  let normalized: string;
  try {
    normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return true;
  }
  if (
    normalized === "::" || normalized === "::1" ||
    normalized.startsWith("fc") || normalized.startsWith("fd") ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("::ffff:")
  ) return true;
  return false;
}

export function isPublicNotificationAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !ipv4Private(address);
  if (family === 6) return !ipv6Private(address);
  return false;
}

function retryAfter(headers: Readonly<Record<string, string | undefined>>): number | null {
  const value = headers["retry-after"] ?? headers["Retry-After"];
  if (value === undefined || !/^\d{1,5}$/u.test(value)) return null;
  const seconds = Number(value);
  return seconds <= 86_400 ? seconds : null;
}

function classify(
  channel: SecurityNotificationChannel,
  response: NotificationHttpResponse,
): SecurityNotificationDeliveryResult {
  if (response.bodyBytes.byteLength > MAXIMUM_RESPONSE_BYTES) {
    return {
      channel,
      status: "retryable_failure",
      providerStatus: null,
      errorCode: "TRANSPORT_FAILURE",
      retryAfterSeconds: null,
    };
  }
  if (response.status >= 200 && response.status < 300) {
    return { channel, status: "delivered", providerStatus: response.status, errorCode: "NONE", retryAfterSeconds: null };
  }
  if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
    return {
      channel,
      status: "retryable_failure",
      providerStatus: response.status,
      errorCode: response.status === 429 ? "PROVIDER_THROTTLED" : "PROVIDER_UNAVAILABLE",
      retryAfterSeconds: retryAfter(response.headers),
    };
  }
  return {
    channel,
    status: "permanent_failure",
    providerStatus: response.status >= 400 && response.status < 500 ? response.status : null,
    errorCode: response.status === 401 || response.status === 403
      ? "AUTHORIZATION_REJECTED"
      : response.status === 413
        ? "PAYLOAD_REJECTED"
        : "DESTINATION_REJECTED",
    retryAfterSeconds: null,
  };
}

function transportFailure(
  channel: SecurityNotificationChannel,
  error: unknown,
): SecurityNotificationDeliveryResult {
  const timeout = error instanceof DOMException && error.name === "TimeoutError";
  return {
    channel,
    status: "retryable_failure",
    providerStatus: null,
    errorCode: timeout ? "REQUEST_TIMEOUT" : "TRANSPORT_FAILURE",
    retryAfterSeconds: null,
  };
}

async function validatedAddresses(
  dns: NotificationDnsResolver,
  hostname: string,
): Promise<readonly string[]> {
  const addresses = [...new Set(await dns.resolve(hostname))];
  if (
    addresses.length < 1 ||
    addresses.length > 16 ||
    addresses.some((address) => !isPublicNotificationAddress(address))
  ) invalid("UNSAFE_DESTINATION");
  return addresses;
}

async function deliverWebhook(input: {
  readonly channel: "slack" | "microsoft_teams";
  readonly secretReference: string;
  readonly deliveryId: string;
  readonly payload: unknown;
  readonly maximumPayloadBytes: number;
  readonly dependencies: SecurityNotificationDeliveryDependencies;
}): Promise<SecurityNotificationDeliveryResult> {
  if (!SECRET_REFERENCE.test(input.secretReference)) invalid("INVALID_CONFIGURATION");
  let secret: ResolvedWebhookSecret | null;
  try {
    secret = await input.dependencies.secrets.resolveWebhook({
      secretReference: input.secretReference,
      channel: input.channel,
    });
  } catch (error) {
    return transportFailure(input.channel, error);
  }
  if (secret === null) {
    return {
      channel: input.channel,
      status: "permanent_failure",
      providerStatus: null,
      errorCode: "DESTINATION_REJECTED",
      retryAfterSeconds: null,
    };
  }
  const url = webhookUrl(input.channel, secret);
  let addresses: readonly string[];
  try {
    addresses = await validatedAddresses(input.dependencies.dns, url.hostname);
  } catch (error) {
    if (error instanceof SecurityNotificationDeliveryError) throw error;
    return transportFailure(input.channel, error);
  }
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (secret.idempotencyHeader === "Idempotency-Key" && input.channel === "microsoft_teams") {
    headers["Idempotency-Key"] = input.deliveryId;
  }
  const body = jsonBytes(input.payload, input.maximumPayloadBytes);
  try {
    const response = await input.dependencies.http.post({
      url,
      headers,
      body,
      validatedAddresses: addresses,
      redirect: "error",
      timeoutMs: TIMEOUT_MS,
      maximumResponseBytes: MAXIMUM_RESPONSE_BYTES,
    });
    return classify(input.channel, response);
  } catch (error) {
    return transportFailure(input.channel, error);
  }
}

async function deliverEmail(input: {
  readonly deliveryId: string;
  readonly payload: SecurityNotificationPayloads["email"];
  readonly destination: NonNullable<SecurityNotificationDestinations["email"]>;
  readonly transport: SesV2WorkloadIamTransport;
}): Promise<SecurityNotificationDeliveryResult> {
  if (
    !AWS_REGION.test(input.destination.region) ||
    input.destination.fromAddress.length > 254 ||
    !EMAIL.test(input.destination.fromAddress)
  ) invalid("INVALID_CONFIGURATION");
  const hostname = `email.${input.destination.region}.amazonaws.com`;
  const body = jsonBytes({
    FromEmailAddress: input.destination.fromAddress,
    Destination: { ToAddresses: input.payload.to },
    Content: {
      Simple: {
        Subject: { Data: input.payload.subject, Charset: "UTF-8" },
        Body: { Text: { Data: input.payload.text, Charset: "UTF-8" } },
      },
    },
  }, MAXIMUM_SES_PAYLOAD_BYTES);
  try {
    const response = await input.transport.post({
      service: "ses",
      region: input.destination.region,
      url: new URL(`https://${hostname}/v2/email/outbound-emails`),
      headers: {
        "content-type": "application/json",
      },
      body,
      redirect: "error",
      timeoutMs: TIMEOUT_MS,
      maximumResponseBytes: MAXIMUM_RESPONSE_BYTES,
    });
    return classify("email", response);
  } catch (error) {
    return transportFailure("email", error);
  }
}

export async function deliverSecurityNotification(input: {
  readonly deliveryId: string;
  readonly payloads: SecurityNotificationPayloads;
  readonly destinations: SecurityNotificationDestinations;
  readonly dependencies: SecurityNotificationDeliveryDependencies;
}): Promise<readonly SecurityNotificationDeliveryResult[]> {
  if (!DELIVERY_ID.test(input.deliveryId) || !SHA256.test(input.payloads.payloadSha256)) {
    invalid("INVALID_CONFIGURATION");
  }
  let material: string;
  try {
    material = canonicalJson({
      email: input.payloads.email,
      slack: input.payloads.slack,
      microsoftTeams: input.payloads.microsoftTeams,
    });
  } catch {
    return invalid("INVALID_CONFIGURATION");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const expectedHash = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (expectedHash !== input.payloads.payloadSha256) invalid("INVALID_CONFIGURATION");
  const deliveries: Promise<SecurityNotificationDeliveryResult>[] = [];
  if (input.destinations.email !== undefined) {
    deliveries.push(deliverEmail({
      deliveryId: input.deliveryId,
      payload: input.payloads.email,
      destination: input.destinations.email,
      transport: input.dependencies.ses,
    }));
  }
  if (input.destinations.slackSecretReference !== undefined) {
    deliveries.push(deliverWebhook({
      channel: "slack",
      secretReference: input.destinations.slackSecretReference,
      deliveryId: input.deliveryId,
      payload: input.payloads.slack,
      maximumPayloadBytes: MAXIMUM_SLACK_PAYLOAD_BYTES,
      dependencies: input.dependencies,
    }));
  }
  if (input.destinations.microsoftTeamsSecretReference !== undefined) {
    deliveries.push(deliverWebhook({
      channel: "microsoft_teams",
      secretReference: input.destinations.microsoftTeamsSecretReference,
      deliveryId: input.deliveryId,
      payload: input.payloads.microsoftTeams,
      maximumPayloadBytes: MAXIMUM_TEAMS_PAYLOAD_BYTES,
      dependencies: input.dependencies,
    }));
  }
  if (deliveries.length < 1) invalid("INVALID_CONFIGURATION");
  return Promise.all(deliveries);
}
