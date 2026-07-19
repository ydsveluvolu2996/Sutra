import assert from "node:assert/strict";
import test from "node:test";
import {
  KubernetesAgentRequestError,
  agentAuthorization,
  exactAgentRecord,
  readAgentJson,
} from "../lib/kubernetes-agent-request.ts";

test("agent authorization accepts only the exact scheme and bounded opaque token", () => {
  const token = "a".repeat(64);
  assert.equal(agentAuthorization(new Request("https://sutra.example", {
    headers: { authorization: `Bearer ${token}` },
  }), "Bearer"), token);
  assert.throws(
    () => agentAuthorization(new Request("https://sutra.example", {
      headers: { authorization: `Sutra-Bootstrap ${token}` },
    }), "Bearer"),
    (error: unknown) =>
      error instanceof KubernetesAgentRequestError &&
      error.code === "AUTHENTICATION_REQUIRED",
  );
});

test("bounded JSON fails before and during streaming without accepting unknown fields", async () => {
  await assert.rejects(
    readAgentJson(new Request("https://sutra.example", {
      method: "POST",
      headers: { "content-length": "1000" },
      body: "{}",
    }), 10),
    (error: unknown) =>
      error instanceof KubernetesAgentRequestError && error.status === 413,
  );
  await assert.rejects(
    readAgentJson(new Request("https://sutra.example", {
      method: "POST",
      body: JSON.stringify({ payload: "x".repeat(100) }),
    }), 16),
    (error: unknown) =>
      error instanceof KubernetesAgentRequestError && error.status === 413,
  );
  assert.throws(
    () => exactAgentRecord({ clusterId: "cluster", token: "forbidden" }, ["clusterId"]),
    (error: unknown) =>
      error instanceof KubernetesAgentRequestError && error.code === "INVALID_INPUT",
  );
});
