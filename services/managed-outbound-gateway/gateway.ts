import {
  classifyManagedProviderWebhookUrl,
  type ManagedProviderWebhookTarget,
} from "../../lib/managed-provider-webhooks.ts";

const GATEWAY_SCHEMA = "sutra.managed-outbound.v2";
const MAX_ENVELOPE_BYTES = 512 * 1024;
const MAX_HEADER_COUNT = 12;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_HEADER_BYTES = 24 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 90;
const NONCE_TTL_MS = 10 * 60 * 1_000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 30_000;

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const NONCE = /^[A-Za-z0-9_-]{20,128}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const BASE64URL = /^[A-Za-z0-9_-]*$/u;
const ACCOUNT_ID = /^[0-9]{4,32}$/u;
const CVE_ID = /^CVE-\d{4}-\d{4,}$/u;
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/u;
const SAFE_USER_AGENT = /^[\u0020-\u007e]{1,256}$/u;

export type ManagedOutboundTarget =
  | "cisa-kev"
  | "first-epss"
  | "nvd-cves"
  | "turnstile-siteverify"
  | "zoho-in-jwks"
  | "zoho-in-mail"
  | "zoho-in-oauth"
  | ManagedProviderWebhookTarget;

interface OutboundEnvelope {
  readonly schemaVersion: typeof GATEWAY_SCHEMA;
  readonly target: ManagedOutboundTarget;
  readonly targetOrigin: string;
  readonly method: "GET" | "POST";
  readonly pathAndQuery: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
  readonly idempotencyKey: string | null;
}

interface ValidatedOutbound {
  readonly envelope: OutboundEnvelope;
  readonly body: Uint8Array;
  readonly headers: Headers;
  readonly targetUrl: URL;
  readonly maximumResponseBytes: number;
}

interface DurableResponse {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

type ReservationResult =
  | { readonly kind: "proceed"; readonly reservationId: string | null }
  | { readonly kind: "replay"; readonly response: DurableResponse }
  | {
      readonly kind:
        | "idempotency-conflict"
        | "idempotency-pending"
        | "idempotency-uncertain"
        | "nonce-replay";
    };

interface ReservationInput {
  readonly nonce: string;
  readonly nonceExpiresAt: number;
  readonly idempotencyKey: string | null;
  readonly idempotencyExpiresAt: number;
  readonly fingerprint: string;
}

interface CompletionInput {
  readonly idempotencyKey: string;
  readonly reservationId: string;
  readonly response: DurableResponse;
}

interface UncertainInput {
  readonly idempotencyKey: string;
  readonly reservationId: string;
}

export interface OutboundRequestState {
  reserve(input: ReservationInput): Promise<ReservationResult>;
  complete(input: CompletionInput): Promise<void>;
  uncertain(input: UncertainInput): Promise<void>;
}

interface DurableObjectStubLike {
  fetch(input: Request): Promise<Response>;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface ManagedOutboundGatewayEnvironment {
  readonly SUTRA_OUTBOUND_CLIENT_KEYS?: string;
  readonly OUTBOUND_REQUEST_STATE?: DurableObjectNamespaceLike;
}

export interface ManagedOutboundGatewayRuntime {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly state?: (keyId: string) => OutboundRequestState;
  readonly log?: (
    entry: Readonly<Record<string, string | number | boolean | null>>,
  ) => void;
}

type DenialCode =
  | "AUTHENTICATION_INVALID"
  | "AUTHENTICATION_REQUIRED"
  | "BODY_INVALID"
  | "CONFIGURATION_INVALID"
  | "HEADER_DENIED"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_PENDING"
  | "IDEMPOTENCY_REQUIRED"
  | "IDEMPOTENCY_UNCERTAIN"
  | "METHOD_DENIED"
  | "REPLAY_DETECTED"
  | "ROUTE_NOT_FOUND"
  | "TARGET_DENIED"
  | "TARGET_PATH_DENIED"
  | "UPSTREAM_RESPONSE_TOO_LARGE"
  | "UPSTREAM_UNAVAILABLE";

class GatewayDenial extends Error {
  public readonly status: number;
  public readonly code: DenialCode;

  public constructor(
    status: number,
    code: DenialCode,
  ) {
    super(code);
    this.name = "GatewayDenial";
    this.status = status;
    this.code = code;
  }
}

interface TargetPolicy {
  readonly origin?: string;
  readonly method: "GET" | "POST";
  readonly allowedHeaders: ReadonlySet<string>;
  readonly maximumRequestBytes: number;
  readonly maximumResponseBytes: number;
  readonly validateUrl: (url: URL) => boolean;
  readonly validateContentType?: (value: string | null) => boolean;
  readonly validateBody?: (body: Uint8Array) => boolean;
  readonly validateHeaders?: (headers: Headers) => boolean;
  readonly idempotency: "forbidden" | "required";
}

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const FORM_CONTENT_TYPE = /^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/iu;

function validJson(body: Uint8Array): boolean {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    );
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function noQuery(url: URL, path: string): boolean {
  return url.pathname === path && url.search === "";
}

function validNvdQuery(url: URL): boolean {
  if (url.pathname !== "/rest/json/cves/2.0") return false;
  const permitted = new Set([
    "cveId",
    "lastModEndDate",
    "lastModStartDate",
    "resultsPerPage",
    "startIndex",
  ]);
  for (const key of url.searchParams.keys()) {
    if (!permitted.has(key) || url.searchParams.getAll(key).length !== 1) return false;
  }
  const cveId = url.searchParams.get("cveId");
  if (cveId !== null && !CVE_ID.test(cveId)) return false;
  const results = url.searchParams.get("resultsPerPage");
  if (
    results !== null &&
    (!/^\d{1,4}$/u.test(results) || Number(results) < 1 || Number(results) > 2_000)
  ) return false;
  const start = url.searchParams.get("startIndex");
  if (
    start !== null &&
    (
      !/^(?:0|[1-9]\d{0,5})$/u.test(start) ||
      Number(start) > 100_000
    )
  ) return false;
  const dates: number[] = [];
  for (const key of ["lastModStartDate", "lastModEndDate"] as const) {
    const value = url.searchParams.get(key);
    if (
      value !== null &&
      (
        value.length > 40 ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) ||
        !Number.isFinite(Date.parse(value))
      )
    ) return false;
    if (value !== null) dates.push(Date.parse(value));
  }
  if (cveId !== null) return dates.length === 0;
  return (
    dates.length === 2 &&
    dates[1]! > dates[0]! &&
    dates[1]! - dates[0]! <= 120 * 24 * 60 * 60 * 1_000
  );
}

const COMMON_GET_HEADERS = new Set(["accept", "user-agent"]);

function strictForm(
  body: Uint8Array,
  required: ReadonlySet<string>,
  permitted: ReadonlySet<string>,
): URLSearchParams | null {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  const params = new URLSearchParams(decoded);
  for (const key of params.keys()) {
    if (!permitted.has(key) || params.getAll(key).length !== 1) return null;
  }
  for (const key of required) {
    if (!params.has(key)) return null;
  }
  return params;
}

function validZohoOAuthBody(body: Uint8Array): boolean {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return false;
  }
  const unvalidated = new URLSearchParams(decoded);
  const grantType = unvalidated.get("grant_type");
  const required = grantType === "refresh_token"
    ? new Set(["client_id", "client_secret", "grant_type", "refresh_token"])
    : grantType === "authorization_code"
      ? new Set(["client_id", "code", "code_verifier", "grant_type", "redirect_uri"])
      : null;
  const permitted = required === null
    ? new Set<string>()
    : grantType === "authorization_code"
      ? new Set([...required, "client_secret"])
      : required;
  const params = required === null ? null : strictForm(body, required, permitted);
  if (params === null) return false;
  const clientId = params.get("client_id") ?? "";
  if (
    clientId.length < 8 ||
    clientId.length > 512 ||
    /[\s\u0000-\u001f\u007f]/u.test(clientId)
  ) return false;
  const clientSecret = params.get("client_secret");
  if (
    clientSecret !== null &&
    (
      clientSecret.length < 8 ||
      clientSecret.length > 512 ||
      /[\s\u0000-\u001f\u007f]/u.test(clientSecret)
    )
  ) return false;
  if (grantType === "refresh_token") {
    const refreshToken = params.get("refresh_token") ?? "";
    return (
      refreshToken.length >= 20 &&
      refreshToken.length <= 2_048 &&
      !/[\s\u0000-\u001f\u007f]/u.test(refreshToken)
    );
  }
  return (
    /^[A-Za-z0-9._~-]{8,2048}$/u.test(params.get("code") ?? "") &&
    /^[A-Za-z0-9_-]{43}$/u.test(params.get("code_verifier") ?? "") &&
    params.get("redirect_uri") ===
      "https://www.sutracmdb.com/api/auth/oidc/callback" &&
    params.get("refresh_token") === null
  );
}

function validTurnstileBody(body: Uint8Array): boolean {
  const keys = new Set(["idempotency_key", "response", "secret"]);
  const params = strictForm(body, keys, keys);
  if (params === null) return false;
  return [...keys].every((key) => {
    const value = params.get(key) ?? "";
    return (
      value.length >= 8 &&
      value.length <= 2_048 &&
      !/[\s\u0000-\u001f\u007f]/u.test(value)
    );
  });
}

function validZohoMailBody(body: Uint8Array): boolean {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return false;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (
    Object.keys(message).sort().join("\n") !==
      ["content", "fromAddress", "mailFormat", "subject", "toAddress"].join("\n") ||
    message.mailFormat !== "plaintext"
  ) return false;
  for (const key of ["fromAddress", "toAddress", "subject", "content"] as const) {
    if (
      typeof message[key] !== "string" ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(message[key])
    ) return false;
  }
  return (
    EMAIL.test(message.fromAddress as string) &&
    EMAIL.test(message.toAddress as string) &&
    (message.subject as string).length > 0 &&
    (message.subject as string).length <= 200 &&
    !/[\u0000-\u001f\u007f]/u.test(message.subject as string) &&
    (message.content as string).length > 0
  );
}

const TARGETS: Readonly<Record<ManagedOutboundTarget, TargetPolicy>> = {
  "zoho-in-oauth": {
    origin: "https://accounts.zoho.in",
    method: "POST",
    idempotency: "forbidden",
    allowedHeaders: new Set(["accept", "content-type"]),
    maximumRequestBytes: 32 * 1024,
    maximumResponseBytes: 64 * 1024,
    validateUrl: (url) => noQuery(url, "/oauth/v2/token"),
    validateContentType: (value) => value !== null && FORM_CONTENT_TYPE.test(value),
    validateBody: validZohoOAuthBody,
  },
  "zoho-in-jwks": {
    origin: "https://accounts.zoho.in",
    method: "GET",
    idempotency: "forbidden",
    allowedHeaders: new Set(["accept"]),
    maximumRequestBytes: 0,
    maximumResponseBytes: 256 * 1024,
    validateUrl: (url) => noQuery(url, "/oauth/v2/keys"),
  },
  "zoho-in-mail": {
    origin: "https://mail.zoho.in",
    method: "POST",
    idempotency: "required",
    allowedHeaders: new Set(["accept", "authorization", "content-type"]),
    maximumRequestBytes: 320 * 1024,
    maximumResponseBytes: 256 * 1024,
    validateUrl: (url) => {
      const segments = url.pathname.split("/");
      return (
        url.search === "" &&
        segments.length === 5 &&
        segments[1] === "api" &&
        segments[2] === "accounts" &&
        ACCOUNT_ID.test(segments[3] ?? "") &&
        segments[4] === "messages"
      );
    },
    validateContentType: (value) => value !== null && JSON_CONTENT_TYPE.test(value),
    validateBody: validZohoMailBody,
    validateHeaders: (headers) =>
      /^Zoho-oauthtoken [A-Za-z0-9._-]{20,2048}$/u.test(
        headers.get("authorization") ?? "",
      ),
  },
  "turnstile-siteverify": {
    origin: "https://challenges.cloudflare.com",
    method: "POST",
    idempotency: "required",
    allowedHeaders: new Set(["accept", "content-type"]),
    maximumRequestBytes: 16 * 1024,
    maximumResponseBytes: 64 * 1024,
    validateUrl: (url) => noQuery(url, "/turnstile/v0/siteverify"),
    validateContentType: (value) => value !== null && FORM_CONTENT_TYPE.test(value),
    validateBody: validTurnstileBody,
  },
  "cisa-kev": {
    origin: "https://www.cisa.gov",
    method: "GET",
    idempotency: "forbidden",
    allowedHeaders: COMMON_GET_HEADERS,
    maximumRequestBytes: 0,
    maximumResponseBytes: 32 * 1024 * 1024,
    validateUrl: (url) =>
      noQuery(url, "/sites/default/files/feeds/known_exploited_vulnerabilities.json"),
  },
  "first-epss": {
    origin: "https://epss.cyentia.com",
    method: "GET",
    idempotency: "forbidden",
    allowedHeaders: COMMON_GET_HEADERS,
    maximumRequestBytes: 0,
    maximumResponseBytes: 32 * 1024 * 1024,
    validateUrl: (url) => noQuery(url, "/epss_scores-current.csv.gz"),
  },
  "nvd-cves": {
    origin: "https://services.nvd.nist.gov",
    method: "GET",
    idempotency: "forbidden",
    allowedHeaders: new Set(["accept", "apikey", "user-agent"]),
    maximumRequestBytes: 0,
    maximumResponseBytes: 32 * 1024 * 1024,
    validateUrl: validNvdQuery,
    validateHeaders: (headers) => {
      const apiKey = headers.get("apikey");
      return apiKey === null || /^[A-Za-z0-9_-]{20,128}$/u.test(apiKey);
    },
  },
  "slack-webhook": {
    origin: "https://hooks.slack.com",
    method: "POST",
    idempotency: "required",
    allowedHeaders: new Set(["content-type"]),
    maximumRequestBytes: 48 * 1024,
    maximumResponseBytes: 16 * 1024,
    validateUrl: (url) =>
      classifyManagedProviderWebhookUrl(url) === "slack-webhook",
    validateContentType: (value) => value !== null && JSON_CONTENT_TYPE.test(value),
    validateBody: validJson,
  },
  "pagerduty-events": {
    origin: "https://events.pagerduty.com",
    method: "POST",
    idempotency: "required",
    allowedHeaders: new Set(["content-type"]),
    maximumRequestBytes: 32 * 1024,
    maximumResponseBytes: 16 * 1024,
    validateUrl: (url) =>
      classifyManagedProviderWebhookUrl(url) === "pagerduty-events",
    validateContentType: (value) => value !== null && JSON_CONTENT_TYPE.test(value),
    validateBody: validJson,
  },
  "jira-cloud-webhook": {
    method: "POST",
    idempotency: "required",
    allowedHeaders: new Set(["content-type", "x-sutra-signature"]),
    maximumRequestBytes: 64 * 1024,
    maximumResponseBytes: 16 * 1024,
    validateUrl: (url) =>
      classifyManagedProviderWebhookUrl(url) === "jira-cloud-webhook",
    validateContentType: (value) => value !== null && JSON_CONTENT_TYPE.test(value),
    validateBody: validJson,
    validateHeaders: (headers) => {
      const signature = headers.get("x-sutra-signature");
      return signature === null || /^[a-f0-9]{64}$/u.test(signature);
    },
  },
  "servicenow-webhook": {
    method: "POST",
    idempotency: "required",
    allowedHeaders: new Set(["content-type", "x-sutra-signature"]),
    maximumRequestBytes: 64 * 1024,
    maximumResponseBytes: 16 * 1024,
    validateUrl: (url) =>
      classifyManagedProviderWebhookUrl(url) === "servicenow-webhook",
    validateContentType: (value) => value !== null && JSON_CONTENT_TYPE.test(value),
    validateBody: validJson,
    validateHeaders: (headers) => {
      const signature = headers.get("x-sutra-signature");
      return signature === null || /^[a-f0-9]{64}$/u.test(signature);
    },
  },
  "teams-logic-workflow": {
    method: "POST",
    idempotency: "required",
    allowedHeaders: new Set(["content-type"]),
    maximumRequestBytes: 64 * 1024,
    maximumResponseBytes: 16 * 1024,
    validateUrl: (url) =>
      classifyManagedProviderWebhookUrl(url) === "teams-logic-workflow",
    validateContentType: (value) => value !== null && JSON_CONTENT_TYPE.test(value),
    validateBody: validJson,
  },
  "teams-powerplatform-workflow": {
    method: "POST",
    idempotency: "required",
    allowedHeaders: new Set(["content-type"]),
    maximumRequestBytes: 64 * 1024,
    maximumResponseBytes: 16 * 1024,
    validateUrl: (url) =>
      classifyManagedProviderWebhookUrl(url) === "teams-powerplatform-workflow",
    validateContentType: (value) => value !== null && JSON_CONTENT_TYPE.test(value),
    validateBody: validJson,
  },
};

function deny(status: number, code: DenialCode): never {
  throw new GatewayDenial(status, code);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function base64UrlToBytes(
  value: string,
  maximumBytes: number,
  status = 400,
  code: DenialCode = "BODY_INVALID",
): Uint8Array {
  if (
    !BASE64URL.test(value) ||
    value.length > Math.ceil(maximumBytes * 4 / 3) + 4
  ) deny(status, code);
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
  } catch {
    deny(status, code);
  }
  if (binary.length > maximumBytes) deny(status, code);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64Url(bytes) !== value) deny(status, code);
  return bytes;
}

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return bytesToBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
    ),
  );
}

async function boundedBytes(
  response: Request | Response,
  maximumBytes: number,
  tooLargeStatus = 502,
  tooLargeCode: DenialCode = "UPSTREAM_RESPONSE_TOO_LARGE",
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (
      !/^\d+$/u.test(declared) ||
      Number(declared) > maximumBytes
    )
  ) {
    void response.body?.cancel().catch(() => undefined);
    deny(tooLargeStatus, tooLargeCode);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        complete = true;
        break;
      }
      total += part.value.byteLength;
      if (total > maximumBytes) deny(tooLargeStatus, tooLargeCode);
      chunks.push(part.value);
    }
  } finally {
    if (complete) reader.releaseLock();
    else void reader.cancel().catch(() => undefined);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function readEnvelope(request: Request): Promise<OutboundEnvelope> {
  if (!/^application\/json(?:;|$)/iu.test(request.headers.get("content-type") ?? "")) {
    deny(400, "BODY_INVALID");
  }
  const bytes = await boundedBytes(
    request,
    MAX_ENVELOPE_BYTES,
    413,
    "BODY_INVALID",
  );
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    deny(400, "BODY_INVALID");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    deny(400, "BODY_INVALID");
  }
  const candidate = value as Record<string, unknown>;
  const expectedKeys = [
    "body",
    "headers",
    "idempotencyKey",
    "method",
    "pathAndQuery",
    "schemaVersion",
    "target",
    "targetOrigin",
  ];
  if (
    Object.keys(candidate).sort().join("\n") !== expectedKeys.join("\n") ||
    candidate.schemaVersion !== GATEWAY_SCHEMA ||
    typeof candidate.targetOrigin !== "string" ||
    candidate.targetOrigin.length < 8 ||
    candidate.targetOrigin.length > 512 ||
    typeof candidate.pathAndQuery !== "string" ||
    candidate.pathAndQuery.length < 1 ||
    candidate.pathAndQuery.length > 2_048 ||
    typeof candidate.body !== "string" ||
    !Array.isArray(candidate.headers) ||
    candidate.headers.length > MAX_HEADER_COUNT ||
    !(
      candidate.idempotencyKey === null ||
      (
        typeof candidate.idempotencyKey === "string" &&
        IDEMPOTENCY_KEY.test(candidate.idempotencyKey)
      )
    )
  ) deny(400, "BODY_INVALID");
  if (
    typeof candidate.target !== "string" ||
    !Object.hasOwn(TARGETS, candidate.target)
  ) deny(403, "TARGET_DENIED");
  if (candidate.method !== "GET" && candidate.method !== "POST") {
    deny(405, "METHOD_DENIED");
  }
  return candidate as unknown as OutboundEnvelope;
}

function validatedHeaders(
  input: readonly (readonly [string, string])[],
  policy: TargetPolicy,
): Headers {
  const output = new Headers();
  let total = 0;
  for (const entry of input) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    ) deny(400, "BODY_INVALID");
    const name = entry[0].toLowerCase();
    const value = entry[1];
    const bytes = new TextEncoder().encode(value).byteLength;
    total += name.length + bytes;
    if (
      name !== entry[0] ||
      !policy.allowedHeaders.has(name) ||
      output.has(name) ||
      bytes > MAX_HEADER_VALUE_BYTES ||
      total > MAX_HEADER_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(value) ||
      (name === "user-agent" && !SAFE_USER_AGENT.test(value))
    ) deny(400, "HEADER_DENIED");
    output.set(name, value);
  }
  if (
    policy.validateContentType !== undefined &&
    !policy.validateContentType(output.get("content-type"))
  ) deny(400, "HEADER_DENIED");
  if (policy.validateHeaders !== undefined && !policy.validateHeaders(output)) {
    deny(400, "HEADER_DENIED");
  }
  return output;
}

function safeTargetUrl(
  targetOrigin: string,
  pathAndQuery: string,
  policy: TargetPolicy,
): URL {
  if (
    !pathAndQuery.startsWith("/") ||
    pathAndQuery.startsWith("//") ||
    pathAndQuery.includes("\\") ||
    pathAndQuery.includes("#") ||
    /[\u0000-\u001f\u007f]/u.test(pathAndQuery)
  ) deny(400, "TARGET_PATH_DENIED");
  let target: URL;
  let origin: URL;
  try {
    origin = new URL(targetOrigin);
    target = new URL(pathAndQuery, `${targetOrigin}/`);
  } catch {
    deny(400, "TARGET_PATH_DENIED");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.port !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.origin !== targetOrigin ||
    target.origin !== targetOrigin ||
    (policy.origin !== undefined && targetOrigin !== policy.origin) ||
    target.username !== "" ||
    target.password !== "" ||
    `${target.pathname}${target.search}` !== pathAndQuery ||
    !policy.validateUrl(target)
  ) deny(400, "TARGET_PATH_DENIED");
  return target;
}

export function classifyManagedOutboundUrl(
  value: string | URL,
  method: string,
): ManagedOutboundTarget | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  for (const [target, policy] of Object.entries(TARGETS) as [
    ManagedOutboundTarget,
    TargetPolicy,
  ][]) {
    if (
      method.toUpperCase() === policy.method &&
      (policy.origin === undefined || url.origin === policy.origin) &&
      url.username === "" &&
      url.password === "" &&
      policy.validateUrl(url)
    ) return target;
  }
  return null;
}

export function permittedUpstreamHeaderNames(
  target: ManagedOutboundTarget,
): ReadonlySet<string> {
  return TARGETS[target].allowedHeaders;
}

export function managedOutboundRequiresIdempotency(
  target: ManagedOutboundTarget,
): boolean {
  return TARGETS[target].idempotency === "required";
}

async function validateOutbound(
  envelope: OutboundEnvelope,
): Promise<ValidatedOutbound> {
  const policy = TARGETS[envelope.target];
  if (envelope.method !== policy.method) deny(405, "METHOD_DENIED");
  if (policy.idempotency === "required" && envelope.idempotencyKey === null) {
    deny(400, "IDEMPOTENCY_REQUIRED");
  }
  if (policy.idempotency === "forbidden" && envelope.idempotencyKey !== null) {
    deny(400, "BODY_INVALID");
  }
  const body = base64UrlToBytes(envelope.body, policy.maximumRequestBytes);
  if (
    (policy.method === "GET" && body.byteLength !== 0) ||
    (policy.method === "POST" && body.byteLength === 0) ||
    (policy.validateBody !== undefined && !policy.validateBody(body))
  ) deny(400, "BODY_INVALID");
  return {
    envelope,
    body,
    headers: validatedHeaders(envelope.headers, policy),
    targetUrl: safeTargetUrl(envelope.targetOrigin, envelope.pathAndQuery, policy),
    maximumResponseBytes: policy.maximumResponseBytes,
  };
}

interface ClientAuthorization {
  readonly publicKey: Uint8Array;
  readonly allowedTargets: ReadonlySet<ManagedOutboundTarget>;
}

function parseClientAuthorizations(
  source: string | undefined,
): ReadonlyMap<string, ClientAuthorization> {
  if (source === undefined || source.length > 16 * 1024) {
    deny(503, "CONFIGURATION_INVALID");
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    deny(503, "CONFIGURATION_INVALID");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length < 1 ||
    Object.keys(value).length > 16
  ) deny(503, "CONFIGURATION_INVALID");
  const keys = new Map<string, ClientAuthorization>();
  const encodedKeys = new Set<string>();
  for (const [keyId, rawAuthorization] of Object.entries(value)) {
    if (
      !KEY_ID.test(keyId) ||
      rawAuthorization === null ||
      typeof rawAuthorization !== "object" ||
      Array.isArray(rawAuthorization)
    ) {
      deny(503, "CONFIGURATION_INVALID");
    }
    const authorization = rawAuthorization as Record<string, unknown>;
    if (
      Object.keys(authorization).sort().join("\n") !==
        ["allowedTargets", "publicKey"].join("\n") ||
      typeof authorization.publicKey !== "string" ||
      !Array.isArray(authorization.allowedTargets) ||
      authorization.allowedTargets.length < 1 ||
      authorization.allowedTargets.length > Object.keys(TARGETS).length ||
      authorization.allowedTargets.some(
        (target) => typeof target !== "string" || !Object.hasOwn(TARGETS, target),
      ) ||
      new Set(authorization.allowedTargets).size !== authorization.allowedTargets.length ||
      encodedKeys.has(authorization.publicKey)
    ) deny(503, "CONFIGURATION_INVALID");
    const bytes = base64UrlToBytes(
      authorization.publicKey,
      32,
      503,
      "CONFIGURATION_INVALID",
    );
    if (bytes.byteLength !== 32) deny(503, "CONFIGURATION_INVALID");
    encodedKeys.add(authorization.publicKey);
    keys.set(keyId, {
      publicKey: bytes,
      allowedTargets: new Set(
        authorization.allowedTargets as ManagedOutboundTarget[],
      ),
    });
  }
  return keys;
}

async function canonicalRequest(
  envelope: OutboundEnvelope,
  keyId: string,
  timestamp: string,
  nonce: string,
): Promise<string> {
  const headerBytes = new TextEncoder().encode(JSON.stringify(envelope.headers));
  const body = base64UrlToBytes(envelope.body, MAX_ENVELOPE_BYTES);
  return [
    GATEWAY_SCHEMA,
    keyId,
    timestamp,
    nonce,
    envelope.idempotencyKey ?? "-",
    envelope.target,
    envelope.targetOrigin,
    envelope.method,
    envelope.pathAndQuery,
    await sha256(headerBytes),
    await sha256(body),
  ].join("\n");
}

export async function signManagedOutboundEnvelope(input: {
  readonly envelope: OutboundEnvelope;
  readonly keyId: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly privateKey: CryptoKey;
}): Promise<string> {
  const canonical = await canonicalRequest(
    input.envelope,
    input.keyId,
    input.timestamp,
    input.nonce,
  );
  return bytesToBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        input.privateKey,
        new TextEncoder().encode(canonical).buffer,
      ),
    ),
  );
}

async function authenticate(
  request: Request,
  envelope: OutboundEnvelope,
  keys: ReadonlyMap<string, ClientAuthorization>,
  now: number,
): Promise<{
  readonly keyId: string;
  readonly nonce: string;
  readonly fingerprint: string;
  readonly allowedTargets: ReadonlySet<ManagedOutboundTarget>;
}> {
  const keyId = request.headers.get("x-sutra-key-id") ?? "";
  const timestamp = request.headers.get("x-sutra-timestamp") ?? "";
  const nonce = request.headers.get("x-sutra-nonce") ?? "";
  const signatureSource = request.headers.get("x-sutra-signature") ?? "";
  if (
    !KEY_ID.test(keyId) ||
    !/^\d{10}$/u.test(timestamp) ||
    !NONCE.test(nonce) ||
    signatureSource.length !== 86
  ) deny(401, "AUTHENTICATION_REQUIRED");
  const authorization = keys.get(keyId);
  if (authorization === undefined) deny(401, "AUTHENTICATION_INVALID");
  const seconds = Number(timestamp);
  if (Math.abs(Math.floor(now / 1_000) - seconds) > MAX_CLOCK_SKEW_SECONDS) {
    deny(401, "AUTHENTICATION_INVALID");
  }
  const signature = base64UrlToBytes(
    signatureSource,
    64,
    401,
    "AUTHENTICATION_INVALID",
  );
  if (signature.byteLength !== 64) deny(401, "AUTHENTICATION_INVALID");
  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(authorization.publicKey).buffer,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      Uint8Array.from(signature).buffer,
      new TextEncoder().encode(
        await canonicalRequest(envelope, keyId, timestamp, nonce),
      ).buffer,
    );
  } catch {
    deny(503, "CONFIGURATION_INVALID");
  }
  if (!valid) deny(401, "AUTHENTICATION_INVALID");
  const fingerprintEnvelope = envelope.target === "zoho-in-mail"
    ? {
        ...envelope,
        // The short-lived Zoho access token authenticates transport but does
        // not change the mail operation. Excluding it lets a legitimate retry
        // recover a cached result after token rotation without sending twice.
        headers: envelope.headers.filter(([name]) => name !== "authorization"),
      }
    : envelope;
  return {
    keyId,
    nonce,
    allowedTargets: authorization.allowedTargets,
    fingerprint: await sha256(
      await canonicalRequest(fingerprintEnvelope, keyId, timestamp, nonce)
        .then((canonical) => canonical.replace(`\n${timestamp}\n${nonce}\n`, "\n-\n-\n")),
    ),
  };
}

function namespaceState(
  namespace: DurableObjectNamespaceLike,
  keyId: string,
): OutboundRequestState {
  const stub = namespace.get(namespace.idFromName(keyId));
  async function invoke(path: string, input: unknown): Promise<Response> {
    return stub.fetch(new Request(`https://outbound-state.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
  }
  return {
    async reserve(input) {
      const response = await invoke("/reserve", input);
      if (!response.ok) deny(503, "CONFIGURATION_INVALID");
      return response.json() as Promise<ReservationResult>;
    },
    async complete(input) {
      const response = await invoke("/complete", input);
      if (!response.ok) deny(503, "CONFIGURATION_INVALID");
    },
    async uncertain(input) {
      const response = await invoke("/uncertain", input);
      if (!response.ok) deny(503, "CONFIGURATION_INVALID");
    },
  };
}

function stateFor(
  env: ManagedOutboundGatewayEnvironment,
  runtime: ManagedOutboundGatewayRuntime,
  keyId: string,
): OutboundRequestState {
  if (runtime.state !== undefined) return runtime.state(keyId);
  if (env.OUTBOUND_REQUEST_STATE === undefined) deny(503, "CONFIGURATION_INVALID");
  return namespaceState(env.OUTBOUND_REQUEST_STATE, keyId);
}

const RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-disposition",
  "content-type",
  "etag",
  "last-modified",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);

function filteredResponseHeaders(input: Headers): readonly (readonly [string, string])[] {
  const output: [string, string][] = [];
  for (const [name, value] of input) {
    if (RESPONSE_HEADERS.has(name.toLowerCase())) output.push([name.toLowerCase(), value]);
  }
  output.push(["cache-control", "no-store"]);
  return output;
}

function responseFromDurable(
  saved: DurableResponse,
  requestId: string,
  replayed: boolean,
): Response {
  const headers = new Headers(
    saved.headers.map(([name, value]): [string, string] => [name, value]),
  );
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-sutra-outbound-request-id", requestId);
  if (replayed) headers.set("x-sutra-idempotent-replay", "true");
  const body = base64UrlToBytes(
    saved.body,
    32 * 1024 * 1024,
    503,
    "CONFIGURATION_INVALID",
  );
  const bodyForbidden =
    saved.status === 101 ||
    saved.status === 204 ||
    saved.status === 205 ||
    saved.status === 304;
  return new Response(
    bodyForbidden ? null : Uint8Array.from(body).buffer,
    {
      status: saved.status,
      headers,
    },
  );
}

function denialResponse(error: GatewayDenial, requestId: string): Response {
  return Response.json(
    {
      error: {
        schemaVersion: "sutra.managed-outbound.error.v1",
        code: error.code,
        requestId,
      },
    },
    {
      status: error.status,
      headers: {
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      },
    },
  );
}

function audit(
  runtime: ManagedOutboundGatewayRuntime,
  entry: Readonly<Record<string, string | number | boolean | null>>,
): void {
  try {
    (runtime.log ?? ((value) => console.warn(JSON.stringify(value))))(entry);
  } catch {
    // Observability must not turn a durably completed provider call into an
    // unknown client outcome. The record shape itself remains deterministic.
  }
}

export async function handleManagedOutboundRequest(
  request: Request,
  env: ManagedOutboundGatewayEnvironment,
  runtime: ManagedOutboundGatewayRuntime = {},
): Promise<Response> {
  const now = (runtime.now ?? Date.now)();
  const requestId = (
    runtime.randomUUID ??
    (() => crypto.randomUUID())
  )();
  const pathname = new URL(request.url).pathname;
  if (pathname === "/healthz") {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") deny(405, "METHOD_DENIED");
      parseClientAuthorizations(env.SUTRA_OUTBOUND_CLIENT_KEYS);
      if (env.OUTBOUND_REQUEST_STATE === undefined && runtime.state === undefined) {
        deny(503, "CONFIGURATION_INVALID");
      }
      return new Response(request.method === "HEAD" ? null : JSON.stringify({
        schemaVersion: "sutra.managed-outbound.health.v1",
        status: "ok",
      }), {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      const denial = error instanceof GatewayDenial
        ? error
        : new GatewayDenial(503, "CONFIGURATION_INVALID");
      return denialResponse(denial, requestId);
    }
  }

  let auditedKeyId: string | null = null;
  let auditedTarget: string | null = null;
  try {
    if (pathname !== "/v1/fetch") deny(404, "ROUTE_NOT_FOUND");
    if (request.method !== "POST") deny(405, "METHOD_DENIED");
    const keys = parseClientAuthorizations(env.SUTRA_OUTBOUND_CLIENT_KEYS);
    const envelope = await readEnvelope(request);
    auditedTarget = envelope.target;
    const authenticated = await authenticate(request, envelope, keys, now);
    auditedKeyId = authenticated.keyId;
    if (!authenticated.allowedTargets.has(envelope.target)) {
      deny(403, "TARGET_DENIED");
    }
    const outbound = await validateOutbound(envelope);
    const state = stateFor(env, runtime, authenticated.keyId);
    const reservation = await state.reserve({
      nonce: authenticated.nonce,
      nonceExpiresAt: now + NONCE_TTL_MS,
      idempotencyKey: envelope.idempotencyKey,
      idempotencyExpiresAt: now + IDEMPOTENCY_TTL_MS,
      fingerprint: authenticated.fingerprint,
    });
    switch (reservation.kind) {
      case "replay": {
        audit(runtime, {
          event: "managed_outbound_completed",
          status: reservation.response.status,
          requestId,
          keyId: authenticated.keyId,
          target: envelope.target,
          replayed: true,
        });
        return responseFromDurable(reservation.response, requestId, true);
      }
      case "nonce-replay":
        deny(409, "REPLAY_DETECTED");
      case "idempotency-conflict":
        deny(409, "IDEMPOTENCY_CONFLICT");
      case "idempotency-pending":
        deny(409, "IDEMPOTENCY_PENDING");
      case "idempotency-uncertain":
        deny(409, "IDEMPOTENCY_UNCERTAIN");
      case "proceed":
        break;
    }

    let upstream: Response;
    try {
      upstream = await (runtime.fetch ?? fetch)(outbound.targetUrl, {
        method: envelope.method,
        headers: outbound.headers,
        body: envelope.method === "POST"
          ? Uint8Array.from(outbound.body).buffer
          : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (envelope.idempotencyKey !== null && reservation.reservationId !== null) {
        await state.uncertain({
          idempotencyKey: envelope.idempotencyKey,
          reservationId: reservation.reservationId,
        });
      }
      deny(502, "UPSTREAM_UNAVAILABLE");
    }
    let responseBody: Uint8Array;
    try {
      responseBody = await boundedBytes(upstream, outbound.maximumResponseBytes);
    } catch (error) {
      if (envelope.idempotencyKey !== null && reservation.reservationId !== null) {
        await state.uncertain({
          idempotencyKey: envelope.idempotencyKey,
          reservationId: reservation.reservationId,
        });
      }
      throw error;
    }
    const saved: DurableResponse = {
      status: upstream.status,
      headers: filteredResponseHeaders(upstream.headers),
      body: bytesToBase64Url(responseBody),
    };
    if (envelope.idempotencyKey !== null && reservation.reservationId !== null) {
      await state.complete({
        idempotencyKey: envelope.idempotencyKey,
        reservationId: reservation.reservationId,
        response: saved,
      });
    }
    audit(runtime, {
      event: "managed_outbound_completed",
      status: saved.status,
      requestId,
      keyId: authenticated.keyId,
      target: envelope.target,
      replayed: false,
    });
    return responseFromDurable(saved, requestId, false);
  } catch (error) {
    const denial = error instanceof GatewayDenial
      ? error
      : new GatewayDenial(503, "CONFIGURATION_INVALID");
    audit(runtime, {
      event: "managed_outbound_denied",
      code: denial.code,
      status: denial.status,
      requestId,
      keyId: auditedKeyId,
      target: auditedTarget,
    });
    return denialResponse(denial, requestId);
  }
}

interface DurableObjectTransactionLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: readonly string[]): Promise<number>;
}

interface DurableObjectStorageLike extends DurableObjectTransactionLike {
  transaction<T>(
    closure: (transaction: DurableObjectTransactionLike) => Promise<T>,
  ): Promise<T>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  list<T>(options?: {
    readonly prefix?: string;
    readonly startAfter?: string;
    readonly limit?: number;
  }): Promise<Map<string, T>>;
}

interface DurableObjectStateLike {
  readonly storage: DurableObjectStorageLike;
}

type IdempotencyRecord =
  | {
      readonly state: "pending" | "uncertain";
      readonly fingerprint: string;
      readonly reservationId: string;
      readonly expiresAt: number;
    }
  | {
      readonly state: "complete";
      readonly fingerprint: string;
      readonly reservationId: string;
      readonly expiresAt: number;
      readonly response: DurableResponse;
    };

/**
 * Durable Object which serializes nonce and idempotency decisions for one
 * client key. Bind this class as `OUTBOUND_REQUEST_STATE`; do not expose it by
 * route.
 */
export class OutboundRequestStateDurableObject {
  private readonly state: DurableObjectStateLike;

  public constructor(state: DurableObjectStateLike) {
    this.state = state;
  }

  public async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const pathname = new URL(request.url).pathname;
    let input: Record<string, unknown>;
    try {
      input = await request.json() as Record<string, unknown>;
    } catch {
      return new Response(null, { status: 400 });
    }
    if (pathname === "/reserve") return this.reserve(input);
    if (pathname === "/complete") return this.complete(input);
    if (pathname === "/uncertain") return this.uncertain(input);
    return new Response(null, { status: 404 });
  }

  public async alarm(): Promise<void> {
    const now = Date.now();
    let nextExpiry: number | null = null;
    let startAfter: string | undefined;
    while (true) {
      const page = await this.state.storage.list<number | IdempotencyRecord>({
        startAfter,
        limit: 1_000,
      });
      const expired: string[] = [];
      for (const [key, value] of page) {
        const expiresAt = typeof value === "number" ? value : value.expiresAt;
        if (expiresAt <= now) expired.push(key);
        else nextExpiry = nextExpiry === null ? expiresAt : Math.min(nextExpiry, expiresAt);
      }
      if (expired.length > 0) await this.state.storage.delete(expired);
      if (page.size < 1_000) break;
      startAfter = [...page.keys()].at(-1);
      if (startAfter === undefined) break;
    }
    if (nextExpiry !== null) await this.state.storage.setAlarm(nextExpiry);
  }

  private async scheduleCleanup(expiresAt: number): Promise<void> {
    const current = await this.state.storage.getAlarm();
    if (current === null || expiresAt < current) {
      await this.state.storage.setAlarm(expiresAt);
    }
  }

  private async reserve(input: Record<string, unknown>): Promise<Response> {
    const nonce = input.nonce;
    const nonceExpiresAt = input.nonceExpiresAt;
    const idempotencyKey = input.idempotencyKey;
    const idempotencyExpiresAt = input.idempotencyExpiresAt;
    const fingerprint = input.fingerprint;
    if (
      typeof nonce !== "string" ||
      !NONCE.test(nonce) ||
      typeof nonceExpiresAt !== "number" ||
      !Number.isSafeInteger(nonceExpiresAt) ||
      !(
        idempotencyKey === null ||
        (typeof idempotencyKey === "string" && IDEMPOTENCY_KEY.test(idempotencyKey))
      ) ||
      typeof idempotencyExpiresAt !== "number" ||
      !Number.isSafeInteger(idempotencyExpiresAt) ||
      typeof fingerprint !== "string" ||
      !BASE64URL.test(fingerprint)
    ) return new Response(null, { status: 400 });

    const now = Date.now();
    const outcome = await this.state.storage.transaction<ReservationResult>(
      async (transaction) => {
        const nonceKey = `nonce:${nonce}`;
        const existingNonce = await transaction.get<number>(nonceKey);
        if (existingNonce !== undefined && existingNonce > now) {
          return { kind: "nonce-replay" };
        }
        await transaction.put(nonceKey, nonceExpiresAt);
        if (idempotencyKey === null) {
          return { kind: "proceed", reservationId: null };
        }

        const recordKey = `idempotency:${idempotencyKey}`;
        const existing = await transaction.get<IdempotencyRecord>(recordKey);
        if (existing !== undefined && existing.expiresAt > now) {
          if (existing.fingerprint !== fingerprint) {
            return { kind: "idempotency-conflict" };
          }
          if (existing.state === "complete") {
            return { kind: "replay", response: existing.response };
          }
          return {
            kind: existing.state === "pending"
              ? "idempotency-pending"
              : "idempotency-uncertain",
          };
        }
        if (existing !== undefined) await transaction.delete(recordKey);
        const reservationId = crypto.randomUUID();
        await transaction.put<IdempotencyRecord>(recordKey, {
          state: "pending",
          fingerprint,
          reservationId,
          expiresAt: idempotencyExpiresAt,
        });
        return { kind: "proceed", reservationId };
      },
    );
    if (outcome.kind !== "nonce-replay") {
      await this.scheduleCleanup(
        idempotencyKey === null
          ? nonceExpiresAt
          : Math.min(nonceExpiresAt, idempotencyExpiresAt),
      );
    }
    return Response.json(outcome);
  }

  private async complete(input: Record<string, unknown>): Promise<Response> {
    const idempotencyKey = input.idempotencyKey;
    const reservationId = input.reservationId;
    if (
      typeof idempotencyKey !== "string" ||
      !IDEMPOTENCY_KEY.test(idempotencyKey) ||
      typeof reservationId !== "string"
    ) return new Response(null, { status: 400 });
    const key = `idempotency:${idempotencyKey}`;
    const existing = await this.state.storage.get<IdempotencyRecord>(key);
    if (
      existing === undefined ||
      existing.state !== "pending" ||
      existing.reservationId !== reservationId
    ) return new Response(null, { status: 409 });
    await this.state.storage.put<IdempotencyRecord>(key, {
      ...existing,
      state: "complete",
      response: input.response as DurableResponse,
    });
    return new Response(null, { status: 204 });
  }

  private async uncertain(input: Record<string, unknown>): Promise<Response> {
    const idempotencyKey = input.idempotencyKey;
    const reservationId = input.reservationId;
    if (
      typeof idempotencyKey !== "string" ||
      !IDEMPOTENCY_KEY.test(idempotencyKey) ||
      typeof reservationId !== "string"
    ) return new Response(null, { status: 400 });
    const key = `idempotency:${idempotencyKey}`;
    const existing = await this.state.storage.get<IdempotencyRecord>(key);
    if (
      existing === undefined ||
      existing.state !== "pending" ||
      existing.reservationId !== reservationId
    ) return new Response(null, { status: 409 });
    await this.state.storage.put<IdempotencyRecord>(key, {
      ...existing,
      state: "uncertain",
    });
    return new Response(null, { status: 204 });
  }
}

export const managedOutboundProtocol = {
  schemaVersion: GATEWAY_SCHEMA,
  maximumEnvelopeBytes: MAX_ENVELOPE_BYTES,
} as const;
