import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const root = resolve(import.meta.dirname, "..");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { GovernancePolicyRepository, GovernancePolicyRepositoryError, governancePublicError } = await import(
  "../db/governance-policy-repository.ts"
);

// The governance migration is registered centrally, not by this workstream, so
// the test applies drizzle/0064 itself on top of the runtime schema.
const migrationSql = await readFile(resolve(root, "drizzle/0064_governance_policies.sql"), "utf8");

const ORG_A = "org_gov_a";
const ORG_B = "org_gov_b";
const CUSTOMER_A = "cust_gov_a";
const CUSTOMER_B = "cust_gov_b";
const SCOPE_A = { orgId: ORG_A, customerId: CUSTOMER_A };
const SCOPE_B = { orgId: ORG_B, customerId: CUSTOMER_B };
const REQUESTER = "user_requester";
const APPROVER = "user_approver";
const T0 = Date.parse("2026-07-27T00:00:00.000Z");

function policyInput(over = {}) {
  return {
    name: "breached-budget-case",
    condition: { all: [{ signal: "budget-burndown-status", statuses: ["breached"] }] },
    actionKind: "open-case",
    actionTarget: "finops-queue",
    requiresApproval: true,
    ...over,
  };
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-governance-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    for (const statement of migrationSql.split("--> statement-breakpoint")) {
      const sql = statement.trim();
      if (sql.length > 0) await database.prepare(sql).run();
    }
    await database.batch([
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'gov-a', 'Gov A', 'active')").bind(ORG_A),
      database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, 'gov-b', 'Gov B', 'active')").bind(ORG_B),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'gov-cust-a', 'Customer A', 'active')").bind(CUSTOMER_A, ORG_A),
      database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, 'gov-cust-b', 'Customer B', 'active')").bind(CUSTOMER_B, ORG_B),
    ]);
    await run(new GovernancePolicyRepository(database), database);
  } finally {
    await miniflare.dispose();
  }
}

async function openRequest(repo, over = {}) {
  const policy = await repo.create(SCOPE_A, policyInput(), REQUESTER, T0);
  const request = await repo.requestApproval(
    SCOPE_A,
    {
      policyId: policy.id,
      requestKey: `${policy.id}|open-case|finops-queue`,
      actionKind: "open-case",
      targetRef: "bud_1",
      reason: "Budget breached; open a case for the platform team.",
      actorUserId: REQUESTER,
      ...over,
    },
    T0 + 1000,
  );
  return { policy, request };
}

test("policy CRUD is tenant-scoped and validates the condition and action", async () => {
  await withDatabase(async (repo) => {
    const created = await repo.create(SCOPE_A, policyInput(), REQUESTER, T0);
    assert.match(created.id, /^gpol_[a-f0-9]{32}$/u);
    assert.equal(created.action.kind, "open-case");
    assert.equal(created.requiresApproval, true);
    assert.equal(created.scope.customerId, CUSTOMER_A);

    // Another tenant sees nothing, and cannot read the row by id.
    assert.deepEqual(await repo.list(SCOPE_B), []);
    assert.equal(await repo.get(SCOPE_B, created.id), null);

    const updated = await repo.update(SCOPE_A, created.id, { priority: 5, enabled: false }, T0 + 1);
    assert.equal(updated?.priority, 5);
    assert.equal(updated?.enabled, false);
    assert.equal(await repo.delete(SCOPE_B, created.id), false);
    assert.equal(await repo.delete(SCOPE_A, created.id), true);
  });
});

test("an unknown action kind, a malformed condition and a missing expiry are all rejected", async () => {
  await withDatabase(async (repo) => {
    await assert.rejects(
      () => repo.create(SCOPE_A, policyInput({ actionKind: "terminate-instance" }), REQUESTER, T0),
      (error) => error instanceof GovernancePolicyRepositoryError && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      () => repo.create(SCOPE_A, policyInput({ condition: { all: [] } }), REQUESTER, T0),
      (error) => error.code === "INVALID_INPUT",
    );
    // accept-risk-with-expiry without an expiry would be a permanent suppression.
    await assert.rejects(
      () => repo.create(SCOPE_A, policyInput({ name: "risk", actionKind: "accept-risk-with-expiry" }), REQUESTER, T0),
      (error) => error.code === "INVALID_INPUT",
    );
    const accepted = await repo.create(
      SCOPE_A,
      policyInput({ name: "risk", actionKind: "accept-risk-with-expiry", actionExpiresInDays: 30 }),
      REQUESTER,
      T0,
    );
    assert.equal(accepted.action.expiresInDays, 30);
  });
});

test("a request appears in the pending queue with its actor, reason and policy name", async () => {
  await withDatabase(async (repo) => {
    const { policy, request } = await openRequest(repo);
    assert.match(request.requestId, /^greq_[a-f0-9]{32}$/u);
    assert.equal(request.decision, "requested");
    const pending = await repo.listPendingApprovals(SCOPE_A);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].policyId, policy.id);
    assert.equal(pending[0].policyName, policy.name);
    assert.equal(pending[0].actorUserId, REQUESTER);
    assert.equal(pending[0].targetRef, "bud_1");
    // No cross-tenant visibility of another org's queue.
    assert.deepEqual(await repo.listPendingApprovals(SCOPE_B), []);
  });
});

test("a second open request for the same action is refused, not queued twice", async () => {
  await withDatabase(async (repo) => {
    const { policy } = await openRequest(repo);
    await assert.rejects(
      () => repo.requestApproval(SCOPE_A, {
        policyId: policy.id,
        requestKey: `${policy.id}|open-case|finops-queue`,
        actionKind: "open-case",
        reason: "Same action, raised again.",
        actorUserId: REQUESTER,
      }, T0 + 2000),
      (error) => error.code === "DUPLICATE_REQUEST",
    );
  });
});

test("self-approval is refused: the requester can never decide their own request", async () => {
  await withDatabase(async (repo) => {
    const { request } = await openRequest(repo);
    await assert.rejects(
      () => repo.decideApproval(SCOPE_A, {
        requestId: request.requestId,
        decision: "approved",
        reason: "Approving my own request.",
        actorUserId: REQUESTER,
      }, T0 + 2000),
      (error) => error instanceof GovernancePolicyRepositoryError && error.code === "SELF_APPROVAL_REFUSED",
    );
    // Self-rejection is refused too — the separation is on the actor, not the verdict.
    await assert.rejects(
      () => repo.decideApproval(SCOPE_A, {
        requestId: request.requestId,
        decision: "rejected",
        reason: "Rejecting my own request.",
        actorUserId: REQUESTER,
      }, T0 + 2000),
      (error) => error.code === "SELF_APPROVAL_REFUSED",
    );
    // The refused attempts wrote nothing: the request is still pending.
    const pending = await repo.listPendingApprovals(SCOPE_A);
    assert.equal(pending.length, 1);
    const history = await repo.listApprovalHistory(SCOPE_A, request.requestId);
    assert.equal(history.length, 1);
    // Refusal is surfaced as a 403, not a generic failure.
    const translated = governancePublicError(new GovernancePolicyRepositoryError("SELF_APPROVAL_REFUSED", "no"));
    assert.equal(translated.code, "AUTHORIZATION_DENIED");
    assert.equal(translated.status, 403);
  });
});

test("a decision appends a row and is immutable: deciding twice is refused and history is preserved", async () => {
  await withDatabase(async (repo, database) => {
    const { request } = await openRequest(repo);
    const history = await repo.decideApproval(SCOPE_A, {
      requestId: request.requestId,
      decision: "approved",
      reason: "Reviewed the evidence; open the case.",
      actorUserId: APPROVER,
    }, T0 + 5000);
    assert.equal(history.length, 2);
    assert.deepEqual(history.map((entry) => entry.decision), ["requested", "approved"]);
    // The original request row is untouched — same id, same actor, same reason.
    assert.equal(history[0].id, request.id);
    assert.equal(history[0].actorUserId, REQUESTER);
    assert.equal(history[0].reason, request.reason);
    assert.equal(history[1].actorUserId, APPROVER);
    assert.notEqual(history[1].id, history[0].id);
    assert.deepEqual(await repo.listPendingApprovals(SCOPE_A), []);

    // Re-deciding — with either verdict, by anyone — is refused.
    for (const decision of ["approved", "rejected"]) {
      await assert.rejects(
        () => repo.decideApproval(SCOPE_A, {
          requestId: request.requestId,
          decision,
          reason: "Changing the recorded decision.",
          actorUserId: APPROVER,
        }, T0 + 6000),
        (error) => error instanceof GovernancePolicyRepositoryError && error.code === "ALREADY_DECIDED",
      );
    }
    // Nothing was rewritten, and no row was removed.
    const after = await repo.listApprovalHistory(SCOPE_A, request.requestId);
    assert.deepEqual(after, history);
    const count = await database.prepare("SELECT COUNT(*) AS total FROM governance_approvals").first();
    assert.equal(Number(count.total), 2);
  });
});

test("deleting a policy never deletes its approval ledger", async () => {
  await withDatabase(async (repo) => {
    const { policy, request } = await openRequest(repo);
    await repo.decideApproval(SCOPE_A, {
      requestId: request.requestId,
      decision: "rejected",
      reason: "Not this cycle; the spike is a one-off migration.",
      actorUserId: APPROVER,
    }, T0 + 5000);
    assert.equal(await repo.delete(SCOPE_A, policy.id), true);
    const history = await repo.listApprovalHistory(SCOPE_A, request.requestId);
    assert.equal(history.length, 2);
    assert.equal(history[1].decision, "rejected");
    assert.equal(history[1].actorUserId, APPROVER);
  });
});

test("a decision requires a substantive reason and a known verdict", async () => {
  await withDatabase(async (repo) => {
    const { request } = await openRequest(repo);
    for (const bad of ["", "  ", "short"]) {
      await assert.rejects(
        () => repo.decideApproval(SCOPE_A, { requestId: request.requestId, decision: "approved", reason: bad, actorUserId: APPROVER }, T0 + 5000),
        (error) => error.code === "INVALID_INPUT",
      );
    }
    await assert.rejects(
      () => repo.decideApproval(SCOPE_A, { requestId: request.requestId, decision: "maybe", reason: "A valid reason here.", actorUserId: APPROVER }, T0 + 5000),
      (error) => error.code === "INVALID_INPUT",
    );
    // Another tenant cannot decide this org's request.
    await assert.rejects(
      () => repo.decideApproval(SCOPE_B, { requestId: request.requestId, decision: "approved", reason: "Cross-tenant decision attempt.", actorUserId: APPROVER }, T0 + 5000),
      (error) => error.code === "REQUEST_NOT_FOUND",
    );
  });
});

test("the repository never issues an UPDATE or DELETE against the approval ledger", async () => {
  const source = await readFile(resolve(root, "db/governance-policy-repository.ts"), "utf8");
  assert.doesNotMatch(source, /UPDATE\s+governance_approvals/iu);
  assert.doesNotMatch(source, /DELETE\s+FROM\s+governance_approvals/iu);
  // Policies, by contrast, are ordinary mutable configuration.
  assert.match(source, /UPDATE governance_policies/u);
});
