import assert from "node:assert/strict";
import test from "node:test";

import { buildDemoStatus, credentialState } from "../scripts/live-aws-status.mjs";

const healthy = (name) => ({ name, state: "healthy", detail: "ready" });

test("credential state warns early enough to refresh before a customer demo", () => {
  assert.equal(credentialState(45), "healthy");
  assert.equal(credentialState(30), "healthy");
  assert.equal(credentialState(29), "warning");
  assert.equal(credentialState(15), "warning");
  assert.equal(credentialState(14), "failed");
  assert.equal(credentialState(Number.NaN), "failed");
});

test("demo status requires every runtime dependency and treats expiry warning as actionable but ready", () => {
  const ready = buildDemoStatus({
    web: healthy("web"),
    collector: healthy("collector"),
    postgres: healthy("postgres"),
    credentials: { name: "credentials", state: "warning", detail: "refresh soon" },
  });
  assert.equal(ready.ok, true);

  const failed = buildDemoStatus({
    web: healthy("web"),
    collector: { name: "collector", state: "failed", detail: "down" },
    postgres: healthy("postgres"),
  });
  assert.equal(failed.ok, false);
});
