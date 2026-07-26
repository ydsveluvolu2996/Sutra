import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AgentRevocationInputError,
  agentDisplayName,
  agentRevocationActionLabel,
  agentRevocationConfirmation,
  applyAgentRevocation,
  buildAgentRevocationRequest,
  isRevocable,
  type ManagedAgent,
} from "../lib/kubernetes-agent-revocation.ts";

const AGENT_ID = `kagent_${"a".repeat(32)}`;
const CONNECTION_ID = `conn_${"b".repeat(32)}`;
const CLUSTER_ID = `kcluster_${"c".repeat(48)}`;

function agent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    agentId: AGENT_ID,
    clusterId: CLUSTER_ID,
    nodeName: null,
    state: "online",
    agentVersion: "0.2.0",
    deployment: { namespace: "sutra", podName: "sutra-agent-0", startedAt: "2026-07-20T00:00:00.000Z" },
    lastHeartbeatAt: "2026-07-26T00:00:00.000Z",
    lastScanAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

test("the request targets the agent path and carries exactly the two keys the route allows", () => {
  const request = buildAgentRevocationRequest({
    agentId: AGENT_ID, connectionId: CONNECTION_ID, clusterId: CLUSTER_ID, clusterName: "alpha",
  });
  assert.equal(request.path, `/api/v1/kubernetes/agents/${AGENT_ID}/revoke`);
  // The route rejects any body that is not exactly { connectionId, clusterId }.
  assert.deepEqual(Object.keys(request.body).sort(), ["clusterId", "connectionId"]);
  assert.equal(request.body.connectionId, CONNECTION_ID);
  assert.equal(request.body.clusterId, CLUSTER_ID);
  // No tenant identity and no credential material is ever sent from the browser.
  const serialized = JSON.stringify(request.body);
  assert.doesNotMatch(serialized, /orgId|customerId|token|secret/iu);
});

test("malformed agent, connection and cluster identifiers are refused before any request", () => {
  for (const target of [
    { agentId: "kagent_nope", connectionId: CONNECTION_ID, clusterId: CLUSTER_ID, clusterName: "a" },
    { agentId: AGENT_ID, connectionId: "conn_nope", clusterId: CLUSTER_ID, clusterName: "a" },
    { agentId: AGENT_ID, connectionId: CONNECTION_ID, clusterId: "kcluster_nope", clusterName: "a" },
    { agentId: `../${AGENT_ID}`, connectionId: CONNECTION_ID, clusterId: CLUSTER_ID, clusterName: "a" },
  ]) {
    assert.throws(() => buildAgentRevocationRequest(target), AgentRevocationInputError);
  }
});

test("the confirmation names the agent and cluster and states what breaks", () => {
  const copy = agentRevocationConfirmation({
    agentId: AGENT_ID, connectionId: CONNECTION_ID, clusterId: CLUSTER_ID, clusterName: "prod-alpha",
  });
  assert.match(copy, new RegExp(AGENT_ID, "u"));
  assert.match(copy, /prod-alpha/u);
  assert.match(copy, /stops reporting/u);
  assert.match(copy, /re-enrolled/u);
  assert.match(copy, /cannot be undone/u);
});

test("the action label is an accessible name bound to the specific agent and cluster", () => {
  assert.equal(
    agentRevocationActionLabel(agent(), "prod-alpha"),
    "Revoke credential for agent sutra/sutra-agent-0 on cluster prod-alpha",
  );
  assert.equal(agentDisplayName(agent({ deployment: null })), AGENT_ID);
  assert.equal(agentDisplayName(agent({ deployment: null, nodeName: "ip-10-0-1-5" })), "node ip-10-0-1-5");
});

test("a confirmed revocation flips only the named agent to revoked and keeps its heartbeat evidence", () => {
  const other = `kagent_${"d".repeat(32)}`;
  const listed = [agent(), agent({ agentId: other, state: "offline" })];
  const next = applyAgentRevocation(listed, AGENT_ID);
  assert.equal(next[0]?.state, "revoked");
  assert.equal(next[0]?.lastHeartbeatAt, "2026-07-26T00:00:00.000Z");
  assert.equal(next[1]?.state, "offline");
  // Unknown ids and already-revoked agents are a no-op, never an invented row.
  assert.deepEqual(applyAgentRevocation(listed, "kagent_missing"), listed);
  assert.equal(applyAgentRevocation(next, AGENT_ID)[0], next[0]);
});

test("only an unrevoked agent is revocable", () => {
  assert.equal(isRevocable(agent()), true);
  assert.equal(isRevocable(agent({ state: "offline" })), true);
  assert.equal(isRevocable(agent({ state: "revoked" })), false);
});

test("the revoke route is a session-gated operator action scoped by the resolved connection", async () => {
  const route = await readFile(
    new URL("../app/api/v1/kubernetes/agents/[agentId]/revoke/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /export async function POST\(/u);
  assert.match(route, /assertSameOrigin\(request\)/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getConnectionForOrg\(authenticated\.subject\.orgId, input\.connectionId\)/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:manage", connection\.customerId\)/u);
  // Tenant identity is session-derived, never caller-supplied.
  assert.doesNotMatch(route, /input\.(?:orgId|customerId|tenantId)/u);
  // The response carries state only — no token or credential material.
  assert.doesNotMatch(route, /token|credential/iu);
});

test("the fleet workspace is the operator surface that wires revocation", async () => {
  const workspace = await readFile(
    new URL("../app/kubernetes/fleet/fleet-health-workspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(workspace, /buildAgentRevocationRequest\(/u);
  assert.match(workspace, /applyAgentRevocation\(/u);
  // Explicit inline confirmation, never a native dialog.
  assert.match(workspace, /agentRevocationConfirmation\(/u);
  assert.doesNotMatch(workspace, /window\.confirm/u);
  // In-flight disabling, an accessible name per control, and an announced result.
  assert.match(workspace, /disabled=\{revokingAgentId !== null\}/u);
  assert.match(workspace, /aria-label=\{agentRevocationActionLabel\(agent, clusterName\)\}/u);
  assert.match(workspace, /role="alert"/u);
  // The real API error is surfaced, not a generic failure string.
  assert.match(workspace, /result\?\.error\?\.message/u);
});
