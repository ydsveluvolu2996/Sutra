import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const { PilotServerError, runFinopsSourceCollection } =
  await import("../lib/pilot-server.ts");

cloudflare.env.SUTRA_LOCAL_MODE = "true";
cloudflare.env.SUTRA_CONNECTION_ENCRYPTION_KEY = "A".repeat(43);
cloudflare.env.SUTRA_BROKER_SHARED_SECRET = Buffer.alloc(32, 17).toString("base64");
cloudflare.env.SUTRA_BROKER_URL = "http://127.0.0.1:8788";

const INPUT = {
  tenantId: "org_source_boundary",
  connectionId: `conn_${"a".repeat(32)}`,
  jobId: `job_${"b".repeat(32)}`,
  contractId: "compute-optimizer-source-use1",
  sourceId: "compute_optimizer_organization_export",
  accountId: "123456789012",
  partition: "aws",
};

test("pre-aborted and elapsed absolute boundaries start no broker request", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error("unexpected"); };
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runFinopsSourceCollection(INPUT, {
      signal: controller.signal,
      deadlineAtMs: Date.now() + 10_000,
    }), (error) => error instanceof PilotServerError && error.code === "REQUEST_TIMEOUT");
    await assert.rejects(runFinopsSourceCollection(INPUT, {
      signal: new AbortController().signal,
      deadlineAtMs: Date.now() - 1,
    }), (error) => error instanceof PilotServerError && error.code === "REQUEST_TIMEOUT");
    assert.equal(fetches, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("abort propagates into the broker fetch and a late response is never released", async () => {
  const originalFetch = globalThis.fetch;
  let fetchStarted;
  const started = new Promise((resolve) => { fetchStarted = resolve; });
  let release;
  globalThis.fetch = async (_url, init) => new Promise((resolve, reject) => {
    release = () => resolve(new Response("{}", { status: 200 }));
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
      once: true,
    });
    fetchStarted();
  });
  try {
    const controller = new AbortController();
    let released = false;
    const pending = runFinopsSourceCollection(INPUT, {
      signal: controller.signal,
      deadlineAtMs: Date.now() + 30_000,
    }).then(() => { released = true; });
    await started;
    controller.abort();
    await assert.rejects(pending, (error) => error instanceof PilotServerError
      && error.code === "REQUEST_TIMEOUT");
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(released, false);
  } finally { globalThis.fetch = originalFetch; }
});
