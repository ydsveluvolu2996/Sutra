import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  FalcoGatewayConfigurationError,
  handleFalcoGatewayRequest,
  loadFalcoGatewayConfig,
  type FalcoGatewayDependencies,
} from "../services/falco-signing-gateway/gateway.ts";
import { canonicalFalcoRequest } from "../lib/falco-request-security.ts";
import { parseFalcoRuntimePayload } from "../lib/falco-runtime-boundary.ts";

const clusterId = `kcluster_${"d".repeat(48)}`;
const secret = randomBytes(32);
const rawSecret = "must-not-leave-the-cluster";
const event = {
  output: `shell command ${rawSecret}`,
  priority: "Critical",
  rule: "Terminal shell in container",
  time: "2026-07-17T07:01:02.345Z",
  source: "syscall",
  hostname: "worker-1",
  output_fields: {
    "k8s.ns.name": "payments",
    "k8s.pod.name": "api-123",
    "container.image.repository": "registry.example/api",
    "container.image.tag": "42",
    "proc.name": "sh",
    "proc.cmdline": rawSecret,
  },
};

const config = {
  clusterId,
  controlPlaneOrigin: "https://app.sutracmdb.com",
  keyId: "current",
  hmacKey: secret,
  forwardTimeoutMs: 1_000,
  maximumAttempts: 3,
};

function request(body: Uint8Array = Buffer.from(JSON.stringify(event))) {
  return {
    method: "POST",
    pathname: "/events",
    contentType: "application/json",
    body,
  };
}

function dependencies(fetchImplementation: typeof fetch, logs: unknown[] = []): FalcoGatewayDependencies {
  return {
    fetch: fetchImplementation,
    now: () => 1_752_735_000_000,
    nonce: () => "abcdefghijklmnopqrstuvwx",
    sleep: async () => {},
    log: (entry) => logs.push(entry),
  };
}

test("sanitizes, signs and forwards a Falcosidekick event to its cluster-scoped endpoint", async () => {
  let forwarded: { url: URL; init: RequestInit } | null = null;
  const result = await handleFalcoGatewayRequest(request(), config, dependencies(
    async (url, init) => {
      forwarded = { url: new URL(String(url)), init: init ?? {} };
      return new Response(null, { status: 202 });
    },
  ));
  assert.equal(result.status, 202);
  assert.ok(forwarded);
  const captured = forwarded as unknown as { url: URL; init: RequestInit };
  assert.equal(captured.url.href, `https://app.sutracmdb.com/api/v1/kubernetes/runtime-events/${clusterId}`);
  assert.equal(captured.init.redirect, "error");
  const body = Buffer.from(captured.init.body as Uint8Array);
  assert.equal(body.toString().includes(rawSecret), false);
  assert.match(body.toString(), /payments/u);
  const [roundTripped] = parseFalcoRuntimePayload({ clusterId, body });
  assert.equal(roundTripped.namespace, "payments");
  assert.equal(roundTripped.containerImage, "registry.example/api:42");

  const headers = new Headers(captured.init.headers);
  const path = captured.url.pathname;
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  const expected = createHmac("sha256", secret).update(canonicalFalcoRequest({
    method: "POST",
    path,
    timestamp: headers.get("x-sutra-falco-timestamp") ?? "",
    nonce: headers.get("x-sutra-falco-nonce") ?? "",
    keyId: "current",
    clusterId,
    bodySha256,
  })).digest("base64url");
  assert.equal(headers.get("x-sutra-falco-signature"), expected);
});

test("retries only bounded transient failures and never logs payloads or credentials", async () => {
  const logs: unknown[] = [];
  let attempts = 0;
  const result = await handleFalcoGatewayRequest(request(), config, dependencies(
    async () => {
      attempts += 1;
      return new Response(null, { status: attempts < 3 ? 503 : 202 });
    },
    logs,
  ));
  assert.equal(result.status, 202);
  assert.equal(attempts, 3);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(rawSecret), false);
  assert.equal(serialized.includes(secret.toString("base64url")), false);
  assert.deepEqual(logs, [
    { event: "forward_retry", attempt: 1, status: 503 },
    { event: "forward_retry", attempt: 2, status: 503 },
  ]);

  attempts = 0;
  const rejected = await handleFalcoGatewayRequest(request(), config, dependencies(async () => {
    attempts += 1;
    return new Response(null, { status: 401 });
  }));
  assert.equal(rejected.status, 503);
  assert.equal(attempts, 1);
});

test("rejects invalid methods, media types, payloads and oversized requests before forwarding", async () => {
  let forwards = 0;
  const deps = dependencies(async () => {
    forwards += 1;
    return new Response(null, { status: 202 });
  });
  assert.equal((await handleFalcoGatewayRequest({
    ...request(), method: "GET",
  }, config, deps)).status, 405);
  assert.equal((await handleFalcoGatewayRequest({
    ...request(), contentType: "text/plain",
  }, config, deps)).status, 415);
  assert.equal((await handleFalcoGatewayRequest(
    request(Buffer.from("{")),
    config,
    deps,
  )).status, 400);
  assert.equal((await handleFalcoGatewayRequest(
    request(new Uint8Array(256 * 1024 + 1)),
    config,
    deps,
  )).status, 413);
  assert.equal(forwards, 0);
});

test("configuration requires HTTPS, a cluster-bound identity and 256-bit or stronger HMAC material", () => {
  const valid = {
    SUTRA_FALCO_CONTROL_PLANE_URL: "https://app.sutracmdb.com/",
    SUTRA_FALCO_CLUSTER_ID: clusterId,
    SUTRA_FALCO_KEY_ID: "current",
    SUTRA_FALCO_HMAC_KEY: secret.toString("base64url"),
  };
  assert.equal(loadFalcoGatewayConfig(valid).controlPlaneOrigin, "https://app.sutracmdb.com");
  for (const invalid of [
    { ...valid, SUTRA_FALCO_CONTROL_PLANE_URL: "http://app.sutracmdb.com/" },
    { ...valid, SUTRA_FALCO_CONTROL_PLANE_URL: "https://user:pass@app.sutracmdb.com/" },
    { ...valid, SUTRA_FALCO_CLUSTER_ID: "demo" },
    { ...valid, SUTRA_FALCO_HMAC_KEY: randomBytes(16).toString("base64url") },
  ]) {
    assert.throws(
      () => loadFalcoGatewayConfig(invalid),
      (error: unknown) => error instanceof FalcoGatewayConfigurationError,
    );
  }
});

test("container and workload contract are non-root, read-only and immutable-base compatible", async () => {
  const [dockerfile, manifest] = await Promise.all([
    readFile(new URL("../services/falco-signing-gateway/Dockerfile", import.meta.url), "utf8"),
    readFile(
      new URL("../deploy/kubernetes/security-stack/falco-signing-gateway.contract.yaml", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(dockerfile, /ARG NODE_IMAGE/u);
  assert.match(dockerfile, /USER 65532:65532/u);
  assert.doesNotMatch(dockerfile, /\b(?:npm|pnpm|yarn|apk|apt-get)\b/u);
  assert.match(manifest, /runAsNonRoot: true/u);
  assert.match(manifest, /readOnlyRootFilesystem: true/u);
  assert.match(manifest, /image: SET_BY_ORCHESTRATOR/u);
  assert.match(manifest, /kind: PodDisruptionBudget/u);
  assert.match(manifest, /topologySpreadConstraints:/u);
});
