import type {
  TurnstileAction,
  TurnstileClientConfiguration,
} from "./turnstile-contract";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2_048;
const MAX_RESPONSE_BYTES = 8 * 1024;
const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_TIMEOUT_MS = 5_000;
const MAX_CHALLENGE_AGE_MS = 6 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 60 * 1_000;
const KEY_PATTERN = /^[A-Za-z0-9_-]{20,128}$/u;
const TOKEN_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/u;
// Cloudflare publishes these credentials for deterministic automated tests.
// In particular, the first pair always passes validation on every hostname,
// so accepting it in a network deployment would turn the widget into a public
// bot-protection bypass. Keep them usable only for an explicitly local runtime.
const CLOUDFLARE_TEST_SITE_KEYS = new Set([
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  "1x00000000000000000000BB",
  "2x00000000000000000000BB",
  "3x00000000000000000000FF",
]);
const CLOUDFLARE_TEST_SECRET_KEYS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

export interface TurnstileEnvironment {
  readonly SUTRA_DEPLOYMENT_ENV?: string;
  readonly SUTRA_LOCAL_MODE?: string;
  readonly SUTRA_PUBLIC_ORIGIN?: string;
  readonly SUTRA_TURNSTILE_ENABLED?: string;
  readonly SUTRA_TURNSTILE_SITE_KEY?: string;
  readonly SUTRA_TURNSTILE_SECRET_KEY?: string;
  readonly SUTRA_TURNSTILE_DEV_BYPASS?: string;
}

type TurnstileErrorCode =
  | "TURNSTILE_CONFIGURATION_INVALID"
  | "TURNSTILE_REJECTED"
  | "TURNSTILE_REQUIRED"
  | "TURNSTILE_UNAVAILABLE";

export class TurnstileVerificationError extends Error {
  public readonly status: 400 | 503;
  public readonly code: TurnstileErrorCode;

  public constructor(
    status: 400 | 503,
    code: TurnstileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TurnstileVerificationError";
    this.status = status;
    this.code = code;
  }
}

interface ActiveTurnstileConfiguration {
  readonly bypass: false;
  readonly siteKey: string;
  readonly secretKey: string;
  readonly expectedHostname: string;
}

interface BypassedTurnstileConfiguration {
  readonly bypass: true;
}

type ResolvedTurnstileConfiguration =
  | ActiveTurnstileConfiguration
  | BypassedTurnstileConfiguration;

interface SiteverifyResponse {
  readonly success?: unknown;
  readonly hostname?: unknown;
  readonly action?: unknown;
  readonly challenge_ts?: unknown;
}

export interface VerifyTurnstileOptions {
  readonly fetch?: typeof fetch;
  readonly now?: number;
  readonly timeoutMs?: number;
}

function configurationError(): never {
  throw new TurnstileVerificationError(
    503,
    "TURNSTILE_CONFIGURATION_INVALID",
    "The security check is not configured correctly",
  );
}

function rejected(): never {
  throw new TurnstileVerificationError(
    400,
    "TURNSTILE_REJECTED",
    "Complete the security check and try again",
  );
}

function unavailable(): never {
  throw new TurnstileVerificationError(
    503,
    "TURNSTILE_UNAVAILABLE",
    "The security check is temporarily unavailable; please try again",
  );
}

function exactBoolean(value: string | undefined): boolean | null {
  if (value === "true") return true;
  if (value === "false" || value === undefined) return false;
  return null;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

function canonicalPublicHostname(value: string | undefined): string | null {
  if (!value || /[\r\n]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      isLoopbackHostname(url.hostname)
    ) {
      return null;
    }
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function requestHostname(request: Request): string {
  try {
    return new URL(request.url).hostname.toLowerCase();
  } catch {
    configurationError();
  }
}

function resolvedConfiguration(
  environment: TurnstileEnvironment,
  request: Request,
): ResolvedTurnstileConfiguration {
  const enabled = exactBoolean(environment.SUTRA_TURNSTILE_ENABLED);
  const bypass = exactBoolean(environment.SUTRA_TURNSTILE_DEV_BYPASS);
  if (enabled === null || bypass === null || (enabled && bypass)) {
    configurationError();
  }

  const deployment = environment.SUTRA_DEPLOYMENT_ENV?.trim() || "local";
  const hostname = requestHostname(request);
  if (bypass) {
    // This escape hatch is intentionally unusable on any network deployment.
    // NODE_ENV is not sufficient: an explicit runtime value, explicit local
    // mode and a loopback request are all required.
    if (
      deployment !== "local" ||
      environment.SUTRA_LOCAL_MODE !== "true" ||
      !isLoopbackHostname(hostname)
    ) {
      configurationError();
    }
    return { bypass: true };
  }

  // Missing configuration never silently disables bot protection. Local
  // developers opt out through the explicit loopback-only flag above.
  if (!enabled) configurationError();
  const siteKey = environment.SUTRA_TURNSTILE_SITE_KEY?.trim() ?? "";
  const secretKey = environment.SUTRA_TURNSTILE_SECRET_KEY?.trim() ?? "";
  if (
    !KEY_PATTERN.test(siteKey) ||
    !KEY_PATTERN.test(secretKey) ||
    siteKey === secretKey ||
    (
      deployment !== "local" &&
      (
        CLOUDFLARE_TEST_SITE_KEYS.has(siteKey) ||
        CLOUDFLARE_TEST_SECRET_KEYS.has(secretKey)
      )
    )
  ) {
    configurationError();
  }

  const expectedHostname =
    deployment === "local"
      ? isLoopbackHostname(hostname)
        ? hostname
        : null
      : canonicalPublicHostname(environment.SUTRA_PUBLIC_ORIGIN);
  if (expectedHostname === null) configurationError();

  return { bypass: false, siteKey, secretKey, expectedHostname };
}

export function turnstileClientConfiguration(
  environment: TurnstileEnvironment,
  request: Request,
): TurnstileClientConfiguration {
  const resolved = resolvedConfiguration(environment, request);
  return resolved.bypass
    ? { enabled: false }
    : { enabled: true, siteKey: resolved.siteKey };
}

function validatedToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_TOKEN_LENGTH ||
    !TOKEN_PATTERN.test(value)
  ) {
    throw new TurnstileVerificationError(
      400,
      "TURNSTILE_REQUIRED",
      "Complete the security check and try again",
    );
  }
  return value;
}

function abortable<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function boundedResponseText(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (
      !Number.isSafeInteger(declared) ||
      declared < 0 ||
      declared > maximumBytes
    ) {
      unavailable();
    }
  }

  if (response.body === null) return "";
  const reader = response.body.getReader();
  // A fixed-size destination keeps Sutra's own buffering bounded even when a
  // chunked response omits Content-Length or a peer supplies a very large
  // individual chunk.
  const buffer = new Uint8Array(maximumBytes);
  let bytesRead = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) {
        finished = true;
        return new TextDecoder().decode(buffer.subarray(0, bytesRead));
      }
      if (value.byteLength > maximumBytes - bytesRead) unavailable();
      buffer.set(value, bytesRead);
      bytesRead += value.byteLength;
    }
  } finally {
    if (finished) {
      reader.releaseLock();
    } else {
      // Do not let an uncooperative peer's cancellation extend the deadline.
      void reader.cancel().catch(() => undefined);
    }
  }
}

function strictSiteverifyResult(
  value: unknown,
  action: TurnstileAction,
  expectedHostname: string,
  now: number,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    unavailable();
  }
  const result = value as SiteverifyResponse;
  if (
    result.success !== true ||
    result.action !== action ||
    typeof result.hostname !== "string" ||
    result.hostname.toLowerCase() !== expectedHostname ||
    typeof result.challenge_ts !== "string"
  ) {
    rejected();
  }
  const challengedAt = Date.parse(result.challenge_ts);
  if (
    !Number.isFinite(challengedAt) ||
    challengedAt < now - MAX_CHALLENGE_AGE_MS ||
    challengedAt > now + MAX_FUTURE_SKEW_MS
  ) {
    rejected();
  }
}

/**
 * Verifies one single-use Turnstile token against the route's fixed action and
 * the canonical Sutra hostname. Network errors and malformed provider
 * responses fail closed; the secret and token are never logged or returned.
 */
export async function verifyTurnstileToken(
  request: Request,
  environment: TurnstileEnvironment,
  tokenValue: unknown,
  action: TurnstileAction,
  options: VerifyTurnstileOptions = {},
): Promise<void> {
  const resolved = resolvedConfiguration(environment, request);
  if (resolved.bypass) return;

  const token = validatedToken(tokenValue);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    configurationError();
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let responseText: string;
  try {
    const body = new URLSearchParams({
      secret: resolved.secretKey,
      response: token,
      idempotency_key: crypto.randomUUID(),
    });
    const response = await abortable(
      (options.fetch ?? fetch)(SITEVERIFY_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        signal: controller.signal,
      }),
      controller.signal,
    );
    if (
      !response.ok ||
      !/^application\/json(?:;|$)/iu.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      unavailable();
    }
    responseText = await boundedResponseText(
      response,
      MAX_RESPONSE_BYTES,
      controller.signal,
    );
  } catch (error) {
    if (error instanceof TurnstileVerificationError) throw error;
    unavailable();
  } finally {
    clearTimeout(timeout);
  }

  let result: unknown;
  try {
    result = JSON.parse(responseText);
  } catch (error) {
    if (error instanceof TurnstileVerificationError) throw error;
    unavailable();
  }
  strictSiteverifyResult(
    result,
    action,
    resolved.expectedHostname,
    options.now ?? Date.now(),
  );
}
