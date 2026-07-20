import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const agentModule = await import("../db/kubernetes-agent-repository.ts");
const kubernetesModule = await import("../db/kubernetes-repository.ts");
const migrations = await import("../db/runtime-migrations.ts");

const ORG_A = "org_agent_tenant_a";
const CUSTOMER_A = "cust_agent_tenant_a";
const ORG_B = "org_agent_tenant_b";
const CUSTOMER_B = "cust_agent_tenant_b";
const CONNECTION_A = "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USER_A = "user_agent_tenant_a";

async function withRepository(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-agent-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    migrations.resetRuntimeSchemaCacheForTests();
    await migrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'agent-a', 'Agent A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'agent-b', 'Agent B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'customer-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'customer-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
      database.prepare(
        "INSERT INTO users (id, issuer, subject, email, display_name, status) VALUES (?, 'https://issuer.example', 'agent-subject', 'agent@example.com', 'Agent', 'active')",
      ).bind(USER_A),
      database.prepare(
        `INSERT INTO aws_connections
          (id, org_id, customer_id, aws_account_id, role_arn, external_id_ciphertext,
           external_id_key_version, permission_pack_version, status)
         VALUES (?, ?, ?, '123456789012', 'arn:aws:iam::123456789012:role/Sutra',
                 'ciphertext', 'v1', '2', 'active')`,
      ).bind(CONNECTION_A, ORG_A, CUSTOMER_A),
    ]);
    const cluster = await new kubernetesModule.KubernetesRepository(database).registerCluster({
      scope: { orgId: ORG_A, customerId: CUSTOMER_A },
      clusterUid: "cluster-uid-production",
      name: "Production",
    });
    let now = Date.parse("2026-07-17T10:00:00.000Z");
    const repository = new agentModule.KubernetesAgentRepository(database, () => now);
    await run({ database, repository, cluster, advance: (milliseconds) => { now += milliseconds; } });
  } finally {
    await miniflare.dispose();
  }
}

test("bootstrap is returned once, stored only as a digest, and bound to exact server scope", async () => {
  await withRepository(async ({ database, repository, cluster }) => {
    const issued = await repository.issueBootstrap({
      scope: {
        orgId: ORG_A,
        customerId: CUSTOMER_A,
        connectionId: CONNECTION_A,
        clusterId: cluster.id,
      },
      createdBy: USER_A,
    });
    const stored = await database.prepare(
      "SELECT token_digest, org_id, customer_id, connection_id, cluster_id FROM kubernetes_agent_bootstraps WHERE id = ?",
    ).bind(issued.bootstrapId).first();
    assert.match(stored.token_digest, /^[a-f0-9]{64}$/u);
    assert.notEqual(stored.token_digest, issued.token);
    assert.deepEqual(
      [stored.org_id, stored.customer_id, stored.connection_id, stored.cluster_id],
      [ORG_A, CUSTOMER_A, CONNECTION_A, cluster.id],
    );
    await assert.rejects(repository.issueBootstrap({
      scope: {
        orgId: ORG_B,
        customerId: CUSTOMER_B,
        connectionId: CONNECTION_A,
        clusterId: cluster.id,
      },
      createdBy: USER_A,
    }), (error) => error.code === "NOT_FOUND");
  });
});

test("enrollment is one-time, cluster-bound, rotates with overlap, and revocation is immediate", async () => {
  await withRepository(async ({ database, repository, cluster, advance }) => {
    const scope = {
      orgId: ORG_A,
      customerId: CUSTOMER_A,
      connectionId: CONNECTION_A,
      clusterId: cluster.id,
    };
    const wrong = await repository.issueBootstrap({ scope, createdBy: USER_A });
    await assert.rejects(repository.enroll(wrong.token, {
      clusterId: "different-cluster",
      clusterName: "Production",
      agentVersion: "1.0.0",
      capabilities: ["inventory"],
    }), (error) => error.code === "AUTHENTICATION_REQUIRED");
    const issued = await repository.issueBootstrap({ scope, createdBy: USER_A });
    const enrolled = await repository.enroll(issued.token, {
      clusterId: cluster.clusterUid,
      clusterName: cluster.name,
      agentVersion: "1.0.0",
      capabilities: ["inventory", "posture"],
    });
    await assert.rejects(repository.enroll(issued.token, {
      clusterId: cluster.clusterUid,
      clusterName: cluster.name,
      agentVersion: "1.0.0",
      capabilities: ["inventory"],
    }), (error) => error.code === "AUTHENTICATION_REQUIRED");
    const stored = await database.prepare(
      "SELECT current_token_digest FROM kubernetes_agents WHERE id = ?",
    ).bind(enrolled.agentId).first();
    assert.match(stored.current_token_digest, /^[a-f0-9]{64}$/u);
    assert.notEqual(stored.current_token_digest, enrolled.token);
    const rotated = await repository.rotate(enrolled.agentId, enrolled.token);
    await repository.authenticate(enrolled.agentId, enrolled.token, { allowPrevious: true });
    await assert.rejects(
      repository.authenticate(enrolled.agentId, enrolled.token),
      (error) => error.code === "AUTHENTICATION_REQUIRED",
    );
    advance(5 * 60_000 + 1);
    await assert.rejects(
      repository.authenticate(enrolled.agentId, enrolled.token, { allowPrevious: true }),
      (error) => error.code === "AUTHENTICATION_REQUIRED",
    );
    const agent = await repository.authenticate(enrolled.agentId, rotated.token);
    assert.deepEqual(
      [agent.orgId, agent.customerId, agent.connectionId, agent.clusterId, agent.clusterUid],
      [ORG_A, CUSTOMER_A, CONNECTION_A, cluster.id, cluster.clusterUid],
    );
    await assert.rejects(repository.revoke({
      ...scope,
      orgId: ORG_B,
      customerId: CUSTOMER_B,
    }, enrolled.agentId), (error) => error.code === "NOT_FOUND");
    await repository.revoke(scope, enrolled.agentId);
    await assert.rejects(
      repository.authenticate(enrolled.agentId, rotated.token, { allowPrevious: true }),
      (error) => error.code === "AUTHENTICATION_REQUIRED",
    );
  });
});

test("a node-scoped bootstrap enrolls many nodes concurrently, isolates them, and is idempotent per node", async () => {
  await withRepository(async ({ database, repository, cluster }) => {
    const scope = {
      orgId: ORG_A,
      customerId: CUSTOMER_A,
      connectionId: CONNECTION_A,
      clusterId: cluster.id,
    };
    const bootstrap = await repository.issueBootstrap({ scope, createdBy: USER_A, nodeScoped: true });
    assert.equal(bootstrap.nodeScoped, true);
    const identity = (nodeName) => ({
      clusterId: cluster.clusterUid,
      clusterName: cluster.name,
      agentVersion: "1.0.0",
      capabilities: ["inventory"],
      nodeName,
    });
    // The shared enrollment secret is redeemed once per node — a node-scoped
    // bootstrap MUST NOT be consumed after the first pod, unlike a single-use one.
    const nodes = ["node-a1", "node-b2", "node-c3", "node-d4"];
    const credentials = await Promise.all(nodes.map((node) => repository.enroll(bootstrap.token, identity(node))));
    const agentIds = new Set(credentials.map((credential) => credential.agentId));
    assert.equal(agentIds.size, nodes.length, "every distinct node gets its own agent identity");

    const listed = await repository.listDeploymentHealth(scope);
    assert.equal(listed.length, nodes.length);
    assert.deepEqual([...listed.map((row) => row.nodeName)].sort(), [...nodes].sort());

    // Each node heartbeats independently against its own credential/agentId.
    for (const credential of credentials) {
      const agent = await repository.authenticate(credential.agentId, credential.token);
      assert.equal(agent.nodeName !== null, true);
      await repository.recordHeartbeat({
        agent,
        agentVersion: "1.0.1",
        capabilities: ["inventory"],
        deployment: {
          namespace: "sutra-system",
          podName: `sutra-agent-${agent.nodeName}`,
          startedAt: "2026-07-17T09:00:00.000Z",
        },
        modules: { trivy: "AVAILABLE" },
      });
    }
    assert.equal((await repository.listDeploymentHealth(scope)).every((row) => row.state === "online"), true);

    // A pod restart on an already-enrolled node re-presents the secret and must
    // re-attach to the SAME identity (idempotent, not a duplicate) with a fresh
    // credential that invalidates the previous one.
    const first = credentials[0];
    const reenrolled = await repository.enroll(bootstrap.token, identity("node-a1"));
    assert.equal(reenrolled.agentId, first.agentId, "re-enroll re-attaches to the node's row");
    assert.equal((await repository.listDeploymentHealth(scope)).length, nodes.length, "no duplicate node rows");
    await assert.rejects(
      repository.authenticate(first.agentId, first.token, { allowPrevious: true }),
      (error) => error.code === "AUTHENTICATION_REQUIRED",
      "the superseded credential no longer authenticates",
    );
    const reattached = await repository.authenticate(reenrolled.agentId, reenrolled.token);
    assert.equal(reattached.nodeName, "node-a1");

    // Cross-connection (tenant/cluster) isolation: another scope never sees these.
    assert.deepEqual(
      await repository.listDeploymentHealth({ ...scope, connectionId: "conn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
      [],
    );
    const stored = await database.prepare(
      "SELECT COUNT(*) AS total FROM kubernetes_agents WHERE org_id = ? AND status = 'active'",
    ).bind(ORG_B).first();
    assert.equal(Number(stored.total), 0, "no node agent leaks into another org");
  });
});

test("node identity must match the bootstrap mode and stays cluster-bound and authenticated", async () => {
  await withRepository(async ({ repository, cluster }) => {
    const scope = {
      orgId: ORG_A,
      customerId: CUSTOMER_A,
      connectionId: CONNECTION_A,
      clusterId: cluster.id,
    };
    // A single-use bootstrap rejects a client-asserted node name.
    const singleUse = await repository.issueBootstrap({ scope, createdBy: USER_A });
    await assert.rejects(repository.enroll(singleUse.token, {
      clusterId: cluster.clusterUid,
      clusterName: cluster.name,
      agentVersion: "1.0.0",
      capabilities: ["inventory"],
      nodeName: "node-a1",
    }), (error) => error.code === "AUTHENTICATION_REQUIRED");

    // A node-scoped bootstrap requires a node name and stays cluster-bound.
    const nodeScoped = await repository.issueBootstrap({ scope, createdBy: USER_A, nodeScoped: true });
    await assert.rejects(repository.enroll(nodeScoped.token, {
      clusterId: cluster.clusterUid,
      clusterName: cluster.name,
      agentVersion: "1.0.0",
      capabilities: ["inventory"],
    }), (error) => error.code === "AUTHENTICATION_REQUIRED");
    await assert.rejects(repository.enroll(nodeScoped.token, {
      clusterId: "different-cluster-uid",
      clusterName: cluster.name,
      agentVersion: "1.0.0",
      capabilities: ["inventory"],
      nodeName: "node-a1",
    }), (error) => error.code === "AUTHENTICATION_REQUIRED");
    // A valid node-scoped enrollment still succeeds afterward.
    const credential = await repository.enroll(nodeScoped.token, {
      clusterId: cluster.clusterUid,
      clusterName: cluster.name,
      agentVersion: "1.0.0",
      capabilities: ["inventory"],
      nodeName: "node-a1",
    });
    assert.equal((await repository.authenticate(credential.agentId, credential.token)).nodeName, "node-a1");
  });
});

test("deployment health listing reports heartbeat modules, online state, and exact tenant scope", async () => {
  await withRepository(async ({ repository, cluster, advance }) => {
    const scope = {
      orgId: ORG_A,
      customerId: CUSTOMER_A,
      connectionId: CONNECTION_A,
      clusterId: cluster.id,
    };
    assert.deepEqual(await repository.listDeploymentHealth(scope), []);
    const bootstrap = await repository.issueBootstrap({ scope, createdBy: USER_A });
    const credential = await repository.enroll(bootstrap.token, {
      clusterId: cluster.clusterUid,
      clusterName: cluster.name,
      agentVersion: "1.0.0",
      capabilities: ["inventory"],
    });
    const agent = await repository.authenticate(credential.agentId, credential.token);
    await repository.recordHeartbeat({
      agent,
      agentVersion: "1.0.1",
      capabilities: ["inventory", "hubble-flows.v1"],
      deployment: {
        namespace: "sutra-system",
        podName: "sutra-agent-abc",
        startedAt: "2026-07-17T09:00:00.000Z",
      },
      modules: { trivy: "AVAILABLE", falco: "NOT_CONFIGURED", "falco-gateway": "DEGRADED" },
    });
    const listed = await repository.listDeploymentHealth(scope);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].agentId, credential.agentId);
    assert.equal(listed[0].state, "online");
    assert.equal(listed[0].agentVersion, "1.0.1");
    assert.deepEqual(listed[0].modules, {
      trivy: "AVAILABLE",
      falco: "NOT_CONFIGURED",
      "falco-gateway": "DEGRADED",
    });
    assert.deepEqual(listed[0].deployment, {
      namespace: "sutra-system",
      podName: "sutra-agent-abc",
      startedAt: "2026-07-17T09:00:00.000Z",
    });
    assert.ok(listed[0].lastHeartbeatAt !== null);
    assert.deepEqual(
      await repository.listDeploymentHealth({ ...scope, connectionId: "conn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
      [],
      "another connection scope must never see this agent",
    );
    advance(30 * 60_000 + 1);
    assert.equal((await repository.listDeploymentHealth(scope))[0].state, "offline");
    await repository.revoke(scope, credential.agentId);
    assert.equal((await repository.listDeploymentHealth(scope))[0].state, "revoked");
  });
});

test("heartbeat, immutable scan receipts, offline state, and revocation use server scope", async () => {
  await withRepository(async ({ database, repository, cluster, advance }) => {
    const scope = {
      orgId: ORG_A,
      customerId: CUSTOMER_A,
      connectionId: CONNECTION_A,
      clusterId: cluster.id,
    };
    const bootstrap = await repository.issueBootstrap({ scope, createdBy: USER_A });
    const credential = await repository.enroll(bootstrap.token, {
      clusterId: cluster.clusterUid,
      clusterName: cluster.name,
      agentVersion: "1.0.0",
      capabilities: ["inventory"],
    });
    const agent = await repository.authenticate(credential.agentId, credential.token);
    assert.equal((await repository.health(agent)).state, "offline");
    await repository.recordHeartbeat({
      agent,
      agentVersion: "1.0.1",
      capabilities: ["inventory"],
      deployment: {
        namespace: "sutra-system",
        podName: "sutra-agent-abc",
        startedAt: "2026-07-17T09:00:00.000Z",
      },
      modules: { trivy: "AVAILABLE", falco: "NOT_CONFIGURED" },
    });
    assert.equal((await repository.health(agent)).state, "online");
    const scanId = "kscan_agent_receipt_0001";
    await database.prepare(
      `INSERT INTO kubernetes_scan_runs
        (id, org_id, customer_id, cluster_id, status, collected_at, idempotency_key,
         evidence_sha256, posture_sha256, resource_count, finding_count, coverage_count)
       VALUES (?, ?, ?, ?, 'partial', ?, 'agent-receipt-publication',
               ?, ?, 1, 1, 6)`,
    ).bind(
      scanId, ORG_A, CUSTOMER_A, cluster.id, Date.parse("2026-07-17T10:00:00.000Z"),
      "a".repeat(64), "b".repeat(64),
    ).run();
    const receipt = {
      agent,
      idempotencyKey: "agent-receipt-0001",
      payloadSha256: "c".repeat(64),
      scanRunId: scanId,
    };
    await repository.recordScanReceipt(receipt);
    await repository.recordScanReceipt(receipt);
    assert.deepEqual(await repository.getScanReceipt(agent, receipt.idempotencyKey), {
      payloadSha256: receipt.payloadSha256,
      scanRunId: scanId,
    });
    await assert.rejects(repository.recordScanReceipt({
      ...receipt,
      payloadSha256: "d".repeat(64),
    }), (error) => error.code === "CONFLICT");
    await assert.rejects(
      database.prepare(
        "UPDATE kubernetes_agent_scan_receipts SET payload_sha256 = ? WHERE agent_id = ?",
      ).bind("e".repeat(64), agent.agentId).run(),
      /immutable/u,
    );
    advance(30 * 60_000 + 1);
    assert.equal((await repository.health(agent)).state, "offline");
    await repository.revoke(scope, credential.agentId);
    assert.equal((await repository.health(agent)).state, "revoked");
  });
});
