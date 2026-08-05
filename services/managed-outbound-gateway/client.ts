import {
  classifyManagedOutboundUrl,
  managedOutboundRequiresIdempotency,
  managedOutboundProtocol,
  permittedUpstreamHeaderNames,
  signManagedOutboundEnvelope,
  type ManagedOutboundTarget,
} from "./gateway.ts";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const MAXIMUM_REQUEST_BYTES = 320 * 1024;

export interface ManagedOutboundClientEnvironment {
  readonly SUTRA_MANAGED_OUTBOUND_URL?: string;
  readonly SUTRA_MANAGED_OUTBOUND_KEY_ID?: string;
  readonly SUTRA_MANAGED_OUTBOUND_PRIVATE_KEY?: string;
}

export interface ManagedOutboundClientRuntime {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}

export class ManagedOutboundClientConfigurationError extends Error {
  public constructor() {
    super("Managed outbound client configuration is invalid");
    this.name = "ManagedOutboundClientConfigurationError";
  }
}

export class ManagedOutboundDestinationDeniedError extends Error {
  public constructor() {
    super("The outbound destination is not registered");
    this.name = "ManagedOutboundDestinationDeniedError";
  }
}

export class ManagedOutboundIdempotencyRequiredError extends Error {
  public constructor() {
    super("A stable Idempotency-Key is required for outbound writes");
    this.name = "ManagedOutboundIdempotencyRequiredError";
  }
}

function invalidConfiguration(): never {
  throw new ManagedOutboundClientConfigurationError();
}

function gatewayOrigin(value: string | undefined): string {
  if (value === undefined || value.length > 2_048) invalidConfiguration();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidConfiguration();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) invalidConfiguration();
  return url.origin;
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!BASE64URL.test(value) || value.length > 8_192) invalidConfiguration();
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let decoded: string;
  try {
    decoded = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
  } catch {
    invalidConfiguration();
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

async function privateKey(value: string): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(value);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      Uint8Array.from(bytes).buffer,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
  } catch {
    invalidConfiguration();
  }
}

async function boundedRequestBody(request: Request): Promise<Uint8Array> {
  if (request.body === null) return new Uint8Array();
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > MAXIMUM_REQUEST_BYTES)
  ) throw new TypeError("Managed outbound request body is too large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAXIMUM_REQUEST_BYTES) {
    throw new TypeError("Managed outbound request body is too large");
  }
  return bytes;
}

function selectedHeaders(request: Request, target: ManagedOutboundTarget): [string, string][] {
  const permitted = permittedUpstreamHeaderNames(target);
  const selected: [string, string][] = [];
  for (const [name, value] of request.headers) {
    const canonical = name.toLowerCase();
    if (permitted.has(canonical)) selected.push([canonical, value]);
  }
  selected.sort(([left], [right]) => left.localeCompare(right));
  return selected;
}

/**
 * Returns a fetch-compatible adapter for Sutra's registered provider/feed
 * destinations. It cannot proxy an arbitrary URL. Side-effecting provider
 * writes fail closed unless the caller supplies a stable `Idempotency-Key`;
 * OAuth token exchanges are nonce-only so token bodies are never persisted.
 */
export function createManagedOutboundFetch(
  environment: ManagedOutboundClientEnvironment,
  runtime: ManagedOutboundClientRuntime = {},
): typeof fetch {
  const origin = gatewayOrigin(environment.SUTRA_MANAGED_OUTBOUND_URL);
  const keyId = environment.SUTRA_MANAGED_OUTBOUND_KEY_ID ?? "";
  const encodedPrivateKey = environment.SUTRA_MANAGED_OUTBOUND_PRIVATE_KEY ?? "";
  if (!KEY_ID.test(keyId)) invalidConfiguration();
  let importedKey: Promise<CryptoKey> | null = null;
  const signingKey = (): Promise<CryptoKey> => {
    importedKey ??= privateKey(encodedPrivateKey);
    return importedKey;
  };

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const method = request.method.toUpperCase();
    const target = classifyManagedOutboundUrl(request.url, method);
    if (target === null) throw new ManagedOutboundDestinationDeniedError();
    const idempotencySource = request.headers.get("idempotency-key");
    const idempotencyKey = !managedOutboundRequiresIdempotency(target)
      ? null
      : idempotencySource !== null && IDEMPOTENCY_KEY.test(idempotencySource)
        ? idempotencySource
        : (() => {
            throw new ManagedOutboundIdempotencyRequiredError();
          })();
    const body = await boundedRequestBody(request);
    const targetUrl = new URL(request.url);
    const envelope = {
      schemaVersion: managedOutboundProtocol.schemaVersion,
      target,
      targetOrigin: targetUrl.origin,
      method: method as "GET" | "POST",
      pathAndQuery: `${targetUrl.pathname}${targetUrl.search}`,
      headers: selectedHeaders(request, target),
      body: bytesToBase64Url(body),
      idempotencyKey,
    };
    const timestamp = String(
      Math.floor((runtime.now ?? Date.now)() / 1_000),
    );
    const nonce = (
      runtime.randomUUID ??
      (() => crypto.randomUUID())
    )();
    const signature = await signManagedOutboundEnvelope({
      envelope,
      keyId,
      timestamp,
      nonce,
      privateKey: await signingKey(),
    });
    return (runtime.fetch ?? fetch)(`${origin}/v1/fetch`, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-sutra-key-id": keyId,
        "x-sutra-nonce": nonce,
        "x-sutra-signature": signature,
        "x-sutra-timestamp": timestamp,
      },
      body: JSON.stringify(envelope),
      signal: request.signal,
    });
  };
}
