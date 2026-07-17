import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const collector = await readFile(new URL("../services/kubernetes-collector/src/collector.ts", import.meta.url), "utf8");

test("collector uses bounded requests and never requests Kubernetes Secrets", () => {
  assert.match(collector, /REQUEST_TIMEOUT_MS = 10_000/u);
  assert.match(collector, /COLLECTION_TIMEOUT_MS = 60_000/u);
  assert.match(collector, /MAX_RESPONSE_BYTES = 4 \* 1024 \* 1024/u);
  assert.match(collector, /MAX_PAGES_PER_COLLECTOR = 20/u);
  assert.match(collector, /MAX_TOTAL_RESOURCES = 10_000/u);
  assert.doesNotMatch(collector, /path:\s*["'][^"']*secrets/iu);
  assert.doesNotMatch(collector, /\/api\/v1\/secrets/iu);
});

test("collector never projects Kubernetes data, stringData, annotations, env, or command fields", () => {
  const normalization = collector.slice(collector.indexOf("function configuration"));
  assert.doesNotMatch(normalization, /\.data\b/u);
  assert.doesNotMatch(normalization, /stringData/u);
  assert.doesNotMatch(normalization, /annotations/u);
  assert.doesNotMatch(normalization, /\.env\b/u);
  assert.doesNotMatch(normalization, /\.command\b/u);
});
