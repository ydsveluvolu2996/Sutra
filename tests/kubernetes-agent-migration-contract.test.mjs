import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Kubernetes agent control migrations are additive after Falco and store credential digests only", async () => {
  const [d1, postgres, d1Runtime, pgRuntime, pgRunner] = await Promise.all([
    readFile(new URL("drizzle/0015_kubernetes_agent_control.sql", root), "utf8"),
    readFile(new URL("postgres/migrations/0009_kubernetes_agent_control.sql", root), "utf8"),
    readFile(new URL("db/runtime-migrations.ts", root), "utf8"),
    readFile(new URL("db/postgres-runtime-migrations.ts", root), "utf8"),
    readFile(new URL("scripts/postgres-migrate.mjs", root), "utf8"),
  ]);
  for (const source of [d1, postgres]) {
    assert.match(source, /kubernetes_agent_bootstraps/u);
    assert.match(source, /kubernetes_agents/u);
    assert.match(source, /kubernetes_agent_scan_receipts/u);
    assert.match(source, /token_digest/u);
    assert.doesNotMatch(source, /(?:bootstrap|credential)_token(?!_digest)/u);
    assert.match(source, /connection_id/u);
    assert.match(source, /previous_token_expires_at/u);
  }
  assert.ok(d1Runtime.indexOf("0014_falco_runtime_events") < d1Runtime.indexOf("0015_kubernetes_agent_control"));
  assert.ok(pgRuntime.indexOf("0008_falco_runtime_events") < pgRuntime.indexOf("0009_kubernetes_agent_control"));
  assert.ok(pgRunner.indexOf("0008_falco_runtime_events.sql") < pgRunner.indexOf("0009_kubernetes_agent_control.sql"));
});

test("agent endpoints never accept Kubernetes tokens, Secrets, ConfigMaps, or webhook URLs", async () => {
  const files = [
    "app/api/v1/kubernetes/agents/enroll/route.ts",
    "app/api/v1/kubernetes/agents/bootstrap/route.ts",
    "app/api/v1/kubernetes/agents/[agentId]/rotate/route.ts",
    "app/api/v1/kubernetes/agents/[agentId]/heartbeat/route.ts",
    "app/api/v1/kubernetes/agents/[agentId]/scans/route.ts",
    "app/api/v1/kubernetes/agents/[agentId]/revoke/route.ts",
  ];
  const source = (await Promise.all(files.map((file) => readFile(new URL(file, root), "utf8")))).join("\n");
  assert.doesNotMatch(
    source,
    /["'](?:serviceAccountToken|kubeconfig|webhookUrl|secretValues|configMapValues)["']/u,
  );
  assert.match(source, /configMapValuesCollected\s*!==\s*false/u);
  assert.match(source, /secretsCollected\s*!==\s*false/u);
});
