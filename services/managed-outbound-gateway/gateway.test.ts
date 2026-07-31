import assert from "node:assert/strict";
import test from "node:test";

import {
  createManagedOutboundFetch,
  ManagedOutboundDestinationDeniedError,
  ManagedOutboundIdempotencyRequiredError,
} from "./client.ts";
import {
  handleManagedOutboundRequest,
  OutboundRequestStateDurableObject,
} from "./gateway.ts";

const NOW = Date.now();
const KEY_ID = "production-app";
const APP_TARGETS = [
  "cisa-kev",
  "first-epss",
  "jira-cloud-webhook",
  "nvd-cves",
  "pagerduty-events",
  "servicenow-webhook",
  "slack-webhook",
  "teams-logic-workflow",
  "teams-powerplatform-workflow",
  "turnstile-siteverify",
  "zoho-in-jwks",
  "zoho-in-mail",
  "zoho-in-oauth",
] as const;

function base64Url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64url");
}

class MemoryStorage {
  public readonly values = new Map<string, unknown>();
  public alarmAt: number | null = null;

  public async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  public async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  public async transaction<T>(
    closure: (transaction: MemoryStorage) => Promise<T>,
  ): Promise<T> {
    return closure(this);
  }

  public async delete(key: string): Promise<boolean>;
  public async delete(keys: readonly string[]): Promise<number>;
  public async delete(keyOrKeys: string | readonly string[]): Promise<boolean | number> {
    if (typeof keyOrKeys === "string") return this.values.delete(keyOrKeys);
    let removed = 0;
    for (const key of keyOrKeys) {
      if (this.values.delete(key)) removed += 1;
    }
    return removed;
  }

  public async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  public async setAlarm(value: number): Promise<void> {
    this.alarmAt = value;
  }

  public async list<T>(options: {
    readonly startAfter?: string;
    readonly limit?: number;
  } = {}): Promise<Map<string, T>> {
    const entries = [...this.values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .filter(([key]) => options.startAfter === undefined || key > options.startAfter)
      .slice(0, options.limit ?? Number.MAX_SAFE_INTEGER);
    return new Map(entries) as Map<string, T>;
  }
}

class MemoryNamespace {
  public readonly storage = new MemoryStorage();
  public readonly object = new OutboundRequestStateDurableObject({
    storage: this.storage,
  });

  public idFromName(name: string): string {
    return name;
  }

  public get(): { fetch(request: Request): Promise<Response> } {
    return { fetch: (request) => this.object.fetch(request) };
  }
}

async function fixture(
  allowedTargets: readonly string[] = APP_TARGETS,
) {
  const pair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const publicKey = base64Url(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateKey = base64Url(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const namespace = new MemoryNamespace();
  const env = {
    SUTRA_OUTBOUND_CLIENT_KEYS: JSON.stringify({
      [KEY_ID]: { publicKey, allowedTargets },
    }),
    OUTBOUND_REQUEST_STATE: namespace,
  };
  let nonce = 0;
  const clientEnvironment = {
    SUTRA_MANAGED_OUTBOUND_URL: "https://outbound.sutracmdb.com",
    SUTRA_MANAGED_OUTBOUND_KEY_ID: KEY_ID,
    SUTRA_MANAGED_OUTBOUND_PRIVATE_KEY: privateKey,
  };
  const nextNonce = () => `00000000-0000-4000-8000-${String(++nonce).padStart(12, "0")}`;
  return { env, namespace, clientEnvironment, nextNonce };
}

async function denialCode(response: Response): Promise<string> {
  const value = await response.json() as { error: { code: string } };
  return value.error.code;
}

test("health fails closed without keys and succeeds with the Durable Object binding", async () => {
  const unhealthy = await handleManagedOutboundRequest(
    new Request("https://outbound.sutracmdb.com/healthz"),
    {},
    { log: () => undefined },
  );
  assert.equal(unhealthy.status, 503);
  assert.equal(await denialCode(unhealthy), "CONFIGURATION_INVALID");

  const { env } = await fixture();
  const healthy = await handleManagedOutboundRequest(
    new Request("https://outbound.sutracmdb.com/healthz"),
    env,
  );
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), {
    schemaVersion: "sutra.managed-outbound.health.v1",
    status: "ok",
  });
});

test("gateway configuration rejects duplicate public-key material across workload IDs", async () => {
  const { env } = await fixture(["cisa-kev"]);
  const configured = JSON.parse(env.SUTRA_OUTBOUND_CLIENT_KEYS) as Record<
    string,
    { readonly publicKey: string; readonly allowedTargets: readonly string[] }
  >;
  const first = configured[KEY_ID];
  assert.ok(first);
  const response = await handleManagedOutboundRequest(
    new Request("https://outbound.sutracmdb.com/healthz"),
    {
      ...env,
      SUTRA_OUTBOUND_CLIENT_KEYS: JSON.stringify({
        [KEY_ID]: first,
        "production-feed": {
          publicKey: first.publicKey,
          allowedTargets: ["first-epss"],
        },
      }),
    },
    { log: () => undefined },
  );
  assert.equal(response.status, 503);
  assert.equal(await denialCode(response), "CONFIGURATION_INVALID");
});

test("the client maps the exact CISA URL and the gateway forwards only that origin", async () => {
  const { env, clientEnvironment, nextNonce } = await fixture();
  const forwarded: Request[] = [];
  const managedFetch = createManagedOutboundFetch(clientEnvironment, {
    now: () => NOW,
    randomUUID: nextNonce,
    fetch: (request, init) => handleManagedOutboundRequest(new Request(request, init), env, {
      now: () => NOW,
      randomUUID: nextNonce,
      fetch: async (upstream, init) => {
        forwarded.push(new Request(upstream, init));
        return Response.json({ catalogVersion: "test" });
      },
      log: () => undefined,
    }),
  });

  const response = await managedFetch(
    "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
    { headers: { accept: "application/json", cookie: "must-not-forward" } },
  );
  assert.equal(response.status, 200);
  assert.equal(forwarded.length, 1);
  const forwardedRequest = forwarded[0];
  assert.ok(forwardedRequest);
  assert.equal(
    forwardedRequest.url,
    "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
  );
  assert.equal(forwardedRequest.headers.get("accept"), "application/json");
  assert.equal(forwardedRequest.headers.has("cookie"), false);
});

test("arbitrary, private, alternate-port, and unregistered webhook destinations fail before I/O", async () => {
  const { clientEnvironment, nextNonce } = await fixture();
  let calls = 0;
  const managedFetch = createManagedOutboundFetch(clientEnvironment, {
    now: () => NOW,
    randomUUID: nextNonce,
    fetch: async () => {
      calls += 1;
      throw new Error("must not be called");
    },
  });
  const denied = [
    "http://169.254.169.254/latest/meta-data",
    "https://localhost/internal",
    "https://www.cisa.gov:444/sites/default/files/feeds/known_exploited_vulnerabilities.json",
    "https://customer.example/webhook",
    "https://services.nvd.nist.gov/rest/json/cves/2.0?resultsPerPage=9999",
  ];
  for (const url of denied) {
    await assert.rejects(
      managedFetch(url),
      ManagedOutboundDestinationDeniedError,
    );
  }
  assert.equal(calls, 0);
});

test("side-effecting provider writes require a caller-owned stable idempotency key before I/O", async () => {
  const { clientEnvironment, nextNonce } = await fixture();
  let calls = 0;
  const managedFetch = createManagedOutboundFetch(clientEnvironment, {
    now: () => NOW,
    randomUUID: nextNonce,
    fetch: async () => {
      calls += 1;
      throw new Error("must not be called");
    },
  });
  await assert.rejects(
    managedFetch("https://hooks.slack.com/services/T12345678/B12345678/abcdefghijklmnop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"text":"test"}',
    }),
    ManagedOutboundIdempotencyRequiredError,
  );
  assert.equal(calls, 0);
});

test("Zoho IN OIDC token and JWKS endpoints are the only OAuth server routes", async () => {
  const { env, clientEnvironment, nextNonce } = await fixture();
  const upstreamUrls: string[] = [];
  const managedFetch = createManagedOutboundFetch(clientEnvironment, {
    now: () => NOW,
    randomUUID: nextNonce,
    fetch: (request, init) =>
      handleManagedOutboundRequest(new Request(request, init), env, {
        now: () => NOW,
        randomUUID: nextNonce,
        fetch: async (upstream) => {
          upstreamUrls.push(String(upstream));
          return Response.json({ keys: [] });
        },
        log: () => undefined,
      }),
  });

  const tokenResponse = await managedFetch(
    "https://accounts.zoho.in/oauth/v2/token",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": "oidc:transaction:0123456789abcdef",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "zoho-client-id",
        client_secret: "zoho-client-secret",
        code: "authorization-code",
        redirect_uri: "https://www.sutracmdb.com/api/auth/oidc/callback",
        code_verifier: "a".repeat(43),
      }),
    },
  );
  assert.equal(tokenResponse.status, 200);
  const jwksResponse = await managedFetch(
    "https://accounts.zoho.in/oauth/v2/keys",
    { headers: { accept: "application/json" } },
  );
  assert.equal(jwksResponse.status, 200);
  assert.deepEqual(upstreamUrls, [
    "https://accounts.zoho.in/oauth/v2/token",
    "https://accounts.zoho.in/oauth/v2/keys",
  ]);

  await assert.rejects(
    managedFetch("https://accounts.zoho.in/.well-known/openid-configuration"),
    ManagedOutboundDestinationDeniedError,
  );
});

test("OAuth token responses are nonce-protected but never persisted or replayed", async () => {
  const { env, namespace, clientEnvironment, nextNonce } = await fixture([
    "zoho-in-oauth",
  ]);
  let upstreamCalls = 0;
  const accessToken = "access-token-that-must-never-be-persisted";
  const refreshToken = "refresh-token-that-must-never-be-persisted";
  const managedFetch = createManagedOutboundFetch(clientEnvironment, {
    now: () => NOW,
    randomUUID: nextNonce,
    fetch: (request, init) =>
      handleManagedOutboundRequest(new Request(request, init), env, {
        now: () => NOW,
        randomUUID: nextNonce,
        fetch: async () => {
          upstreamCalls += 1;
          return Response.json({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
        },
        log: () => undefined,
      }),
  });
  const invoke = () => managedFetch("https://accounts.zoho.in/oauth/v2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "zoho-client-id",
      client_secret: "zoho-client-secret",
      refresh_token: "long-lived-refresh-token-value",
      grant_type: "refresh_token",
    }),
  });
  assert.equal((await invoke()).status, 200);
  assert.equal((await invoke()).status, 200);
  assert.equal(upstreamCalls, 2, "refresh-token calls remain independently retryable");
  const serializedState = JSON.stringify([...namespace.storage.values]);
  assert.doesNotMatch(serializedState, new RegExp(accessToken));
  assert.doesNotMatch(serializedState, new RegExp(refreshToken));
  assert.doesNotMatch(serializedState, /access_token|refresh_token/u);
  assert.ok(
    [...namespace.storage.values.keys()].every((key) => key.startsWith("nonce:")),
  );
});

test("a valid key cannot call a target outside its exact workload authorization", async () => {
  const { env, clientEnvironment, nextNonce } = await fixture([
    "cisa-kev",
    "first-epss",
    "nvd-cves",
  ]);
  let upstreamCalls = 0;
  const managedFetch = createManagedOutboundFetch(clientEnvironment, {
    now: () => NOW,
    randomUUID: nextNonce,
    fetch: (request, init) =>
      handleManagedOutboundRequest(new Request(request, init), env, {
        now: () => NOW,
        randomUUID: nextNonce,
        fetch: async () => {
          upstreamCalls += 1;
          return new Response("must not be called");
        },
        log: () => undefined,
      }),
  });
  const response = await managedFetch(
    "https://hooks.slack.com/services/T12345678/B12345678/abcdefghijklmnop",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "notify-feed-key-denial-0001",
      },
      body: '{"text":"denied"}',
    },
  );
  assert.equal(response.status, 403);
  assert.equal(await denialCode(response), "TARGET_DENIED");
  assert.equal(upstreamCalls, 0);
});

test("a completed mail write is durably replayed and changed content conflicts", async () => {
  const { env, clientEnvironment, nextNonce } = await fixture();
  let upstreamCalls = 0;
  const auditEntries: Readonly<Record<string, string | number | boolean | null>>[] = [];
  const gatewayFetch: typeof fetch = (request, init) =>
    handleManagedOutboundRequest(new Request(request, init), env, {
      now: () => NOW,
      randomUUID: nextNonce,
      fetch: async (upstream, init) => {
        upstreamCalls += 1;
        assert.equal(
          String(upstream),
          "https://mail.zoho.in/api/accounts/12345678/messages",
        );
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Zoho-oauthtoken access-token-0123456789",
        );
        return Response.json({ status: { code: 200 } }, { status: 201 });
      },
      log: (entry) => auditEntries.push(entry),
    });
  const managedFetch = createManagedOutboundFetch(clientEnvironment, {
    now: () => NOW,
    randomUUID: nextNonce,
    fetch: gatewayFetch,
  });
  const request = (
    content: string,
    accessToken = "access-token-0123456789",
  ) => managedFetch(
    "https://mail.zoho.in/api/accounts/12345678/messages",
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Zoho-oauthtoken ${accessToken}`,
        "content-type": "application/json; charset=utf-8",
        "idempotency-key": "mail:invite:tenant-123:operation-456",
      },
      body: JSON.stringify({
        content,
        fromAddress: "no-reply@sutracmdb.com",
        mailFormat: "plaintext",
        subject: "Invitation",
        toAddress: "client@example.com",
      }),
    },
  );

  const first = await request("hello");
  assert.equal(first.status, 201);
  assert.equal(first.headers.get("x-sutra-idempotent-replay"), null);
  const replay = await request("hello", "rotated-access-token-9876543210");
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("x-sutra-idempotent-replay"), "true");
  assert.equal(upstreamCalls, 1);
  assert.deepEqual(auditEntries, [
    {
      event: "managed_outbound_completed",
      status: 201,
      requestId: "00000000-0000-4000-8000-000000000002",
      keyId: KEY_ID,
      target: "zoho-in-mail",
      replayed: false,
    },
    {
      event: "managed_outbound_completed",
      status: 201,
      requestId: "00000000-0000-4000-8000-000000000004",
      keyId: KEY_ID,
      target: "zoho-in-mail",
      replayed: true,
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(auditEntries),
    /access-token|rotated-access-token|client@example\.com|hello/u,
  );

  const conflict = await request("changed");
  assert.equal(conflict.status, 409);
  assert.equal(await denialCode(conflict), "IDEMPOTENCY_CONFLICT");
  assert.equal(upstreamCalls, 1);
});

test("an unknown write outcome is held as uncertain and never sent twice", async () => {
  const { env, clientEnvironment, nextNonce } = await fixture();
  let upstreamCalls = 0;
  const managedFetch = createManagedOutboundFetch(clientEnvironment, {
    now: () => NOW,
    randomUUID: nextNonce,
    fetch: (request, init) => handleManagedOutboundRequest(new Request(request, init), env, {
      now: () => NOW,
      randomUUID: nextNonce,
      fetch: async () => {
        upstreamCalls += 1;
        throw new Error("connection reset after send");
      },
      log: () => undefined,
    }),
  });
  const invoke = () => managedFetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": "turnstile:challenge:0123456789abcdef",
      },
      body: "secret=secret-value&response=challenge-token&idempotency_key=provider-key",
    },
  );
  const first = await invoke();
  assert.equal(first.status, 502);
  assert.equal(await denialCode(first), "UPSTREAM_UNAVAILABLE");
  const second = await invoke();
  assert.equal(second.status, 409);
  assert.equal(await denialCode(second), "IDEMPOTENCY_UNCERTAIN");
  assert.equal(upstreamCalls, 1);
});

test("tampering with a signed target envelope is rejected before upstream I/O", async () => {
  const { env, clientEnvironment, nextNonce } = await fixture();
  let upstreamCalls = 0;
  const managedFetch = createManagedOutboundFetch(clientEnvironment, {
    now: () => NOW,
    randomUUID: nextNonce,
    fetch: async (gatewayRequest, gatewayInit) => {
      const request = new Request(gatewayRequest, gatewayInit);
      const envelope = await request.clone().json() as Record<string, unknown>;
      envelope.pathAndQuery = "//169.254.169.254/latest/meta-data";
      const tampered = new Request(request, { body: JSON.stringify(envelope) });
      return handleManagedOutboundRequest(tampered, env, {
        now: () => NOW,
        randomUUID: nextNonce,
        fetch: async () => {
          upstreamCalls += 1;
          return new Response("must not happen");
        },
        log: () => undefined,
      });
    },
  });
  const response = await managedFetch(
    "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
  );
  assert.equal(response.status, 401);
  assert.equal(await denialCode(response), "AUTHENTICATION_INVALID");
  assert.equal(upstreamCalls, 0);
});

test("denial audits contain codes and identifiers but never headers, bodies, or secrets", async () => {
  const { env, nextNonce } = await fixture();
  const entries: Readonly<Record<string, string | number | boolean | null>>[] = [];
  const providerSecret = "must-never-enter-audit-output";
  const response = await handleManagedOutboundRequest(
    new Request("https://outbound.sutracmdb.com/v1/fetch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: providerSecret,
      },
      body: JSON.stringify({
        schemaVersion: "sutra.managed-outbound.v2",
        target: "customer-webhook",
        targetOrigin: "https://customer.example",
        method: "POST",
        pathAndQuery: `/hook?secret=${providerSecret}`,
        headers: [["authorization", providerSecret]],
        body: Buffer.from(providerSecret).toString("base64url"),
        idempotencyKey: "customer:webhook:0123456789",
      }),
    }),
    env,
    {
      now: () => NOW,
      randomUUID: nextNonce,
      log: (entry) => entries.push(entry),
    },
  );
  assert.equal(response.status, 403);
  assert.equal(await denialCode(response), "TARGET_DENIED");
  assert.equal(entries.length, 1);
  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, new RegExp(providerSecret));
  assert.deepEqual(Object.keys(entries[0] ?? {}).sort(), [
    "code",
    "event",
    "keyId",
    "requestId",
    "status",
    "target",
  ]);
});

test("the Durable Object rejects an exact nonce replay and schedules expiry cleanup", async () => {
  const namespace = new MemoryNamespace();
  const reserve = (nonce: string) => namespace.object.fetch(
    new Request("https://outbound-state.internal/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nonce,
        nonceExpiresAt: Date.now() + 60_000,
        idempotencyKey: null,
        idempotencyExpiresAt: Date.now() + 60_000,
        fingerprint: "validFingerprint",
      }),
    }),
  );
  const nonce = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual(await (await reserve(nonce)).json(), {
    kind: "proceed",
    reservationId: null,
  });
  assert.deepEqual(await (await reserve(nonce)).json(), {
    kind: "nonce-replay",
  });
  assert.ok(namespace.storage.alarmAt !== null);

  namespace.storage.values.set("nonce:expired-value-000000000000", Date.now() - 1);
  await namespace.object.alarm();
  assert.equal(namespace.storage.values.has("nonce:expired-value-000000000000"), false);
});
