// Integration coverage for the FinOps cost/budget alert AUTOMATION against a
// real database (Miniflare D1 + the real runtime schema), rather than the
// injected-dep unit tests in tests/finops-alert-sweep.test.mjs.
//
// Everything below the test seam is the production path:
//   ensureDueFinopsAlertSweepsEnqueued(real JobQueueRepository, real
//   listActiveOrgIds, real listConnectionsForOrg)
//     -> background_jobs row
//     -> runDueBackgroundJobs(real buildJobHandlers() registry)
//     -> runFinopsAlertSweepJob -> evaluateFinopsAlertsForCustomer (real
//        FinopsWorkspaceRepository over ingested finops_cur_lines +
//        finops_budgets) -> enqueueFinopsAlert (real
//        SecurityNotificationRepository) -> security_notification_outbox rows
//        -> appendAuditEvent -> audit_events row.
//
// Nothing is stubbed: the only test-owned inputs are the seeded tenant rows and
// the ingested billing lines, both written through the real repositories.
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const { JobQueueRepository } = await import("../db/job-queue-repository.ts");
const {
  buildJobHandlers,
  ensureDueFinopsAlertSweepsEnqueued,
  FINOPS_ALERT_SWEEP_INTERVAL_MS,
} = await import("../db/background-job-handlers.ts");
const { runDueBackgroundJobs } = await import("../lib/background-job-runner.ts");
const { FinopsWorkspaceRepository } = await import("../db/finops-workspace-repository.ts");
const { SecurityNotificationRepository } = await import("../db/security-notification-repository.ts");
const { listConnectionsForOrg } = await import("../db/pilot-repository.ts");
const { listActiveOrgIds } = await import("../db/organization-directory.ts");
const { evaluateFinopsAlertsForCustomer } = await import("../db/finops-alert-service.ts");

const ORG_ALERT = "org_finops_alert";
const CUSTOMER_ALERT = "cust_finops_alert";
const CONNECTION_ALERT = `conn_${"a1".repeat(16)}`;
// A SECOND account under the SAME customer, with byte-identical cost data. Its
// anomaly is the collision case: same service, same day, same currency.
const CONNECTION_ALERT_TWIN = `conn_${"c3".repeat(16)}`;
const ORG_QUIET = "org_finops_quiet";
const CUSTOMER_QUIET = "cust_finops_quiet";
const CONNECTION_QUIET = `conn_${"b2".repeat(16)}`;
const ACTOR = "user_finops_alert_admin";
const PERIOD = "2026-06";
const ANOMALY_ID = /^cost_anomaly:2026-06-04:AmazonEC2:[0-9a-f]{8}$/u;
const BUDGET_ID = /^budget_breached:2026-06:fb_[0-9a-f]{32}$/u;

/**
 * Billing lines for one connection that WILL trigger both engines:
 * - detectAnomalies: three trailing days of 2.00 USD for AmazonEC2 then a
 *   20.00 USD day -> 10x the trailing median, above the 1-unit floor.
 * - buildBudgetBurndown: 26.00 USD month-to-date against a 10.00 USD budget ->
 *   month-to-date already exceeds the limit -> status "breached".
 */
function triggeringLines() {
  const amounts = [
    ["2026-06-01T00:00:00.000Z", "2000000"],
    ["2026-06-02T00:00:00.000Z", "2000000"],
    ["2026-06-03T00:00:00.000Z", "2000000"],
    ["2026-06-04T00:00:00.000Z", "20000000"],
  ];
  return amounts.map(([usageStartIso, amountMicros], index) => ({
    lineItemId: `li-${index}`,
    usageAccountId: "111122223333",
    service: "AmazonEC2",
    chargeCategory: "Usage",
    usageStartIso,
    amountMicros,
    currency: "USD",
    region: "us-east-1",
    amortizedMicros: null,
    commitmentType: null,
    commitmentId: null,
    commitmentExpiry: null,
    tags: { env: "prod" },
  }));
}

function connectionStatement(database, { orgId, customerId, connectionId, accountId = "111122223333" }) {
  return database.prepare(
    `INSERT INTO aws_connections
       (id, org_id, customer_id, partition, aws_account_id, role_arn,
        external_id_ciphertext, external_id_key_version, permission_pack_version, status)
     VALUES (?, ?, ?, 'aws', ?, ?, 'ct', 'v1', '2026-01', 'active')`,
  ).bind(connectionId, orgId, customerId, accountId, `arn:aws:iam::${accountId}:role/SutraReadOnlyRole`);
}

async function seedTenant(database, {
  orgId,
  slug,
  customerId,
  connectionId,
  accountId = "111122223333",
}) {
  await database.batch([
    database.prepare("INSERT INTO organizations (id, slug, name, status) VALUES (?, ?, ?, 'active')")
      .bind(orgId, slug, `Org ${slug}`),
    database.prepare("INSERT INTO customers (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, 'active')")
      .bind(customerId, orgId, `${slug}-cust`, `Customer ${slug}`),
    connectionStatement(database, { orgId, customerId, connectionId, accountId }),
  ]);
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-finops-alerts-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    // Every repository in the automation path resolves its handle via the
    // ambient getRawDb(), so bind the injected D1 database into the worker env.
    cloudflare.env.DB = database;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);

    // The alerting tenant: two connections + CUR lines + budget + enabled destination.
    await seedTenant(database, { orgId: ORG_ALERT, slug: "finops-alert", customerId: CUSTOMER_ALERT, connectionId: CONNECTION_ALERT });
    await connectionStatement(database, {
      orgId: ORG_ALERT,
      customerId: CUSTOMER_ALERT,
      connectionId: CONNECTION_ALERT_TWIN,
      accountId: "444455556666",
    }).run();
    // The quiet tenant: identical cost data, but NO notification destination.
    await seedTenant(database, {
      orgId: ORG_QUIET,
      slug: "finops-quiet",
      customerId: CUSTOMER_QUIET,
      connectionId: CONNECTION_QUIET,
      // AT-11 makes live AWS account/role ownership global. This independent
      // tenant therefore needs its own account instead of reusing the alerting
      // tenant's trust role in a fixture.
      accountId: "777788889999",
    });
    // upsertDestination gates on an active user row (the recorded creator).
    await database.prepare(
      "INSERT INTO users (id, issuer, subject, email, display_name, status) VALUES (?, 'https://issuer.test', 'sub-finops', 'admin@sutra.test', 'FinOps Admin', 'active')",
    ).bind(ACTOR).run();

    const workspace = new FinopsWorkspaceRepository(database);
    for (const [orgId, customerId, connectionId] of [
      [ORG_ALERT, CUSTOMER_ALERT, CONNECTION_ALERT],
      [ORG_ALERT, CUSTOMER_ALERT, CONNECTION_ALERT_TWIN],
      [ORG_QUIET, CUSTOMER_QUIET, CONNECTION_QUIET],
    ]) {
      const ingest = await workspace.replacePeriod({ orgId, customerId }, connectionId, PERIOD, triggeringLines());
      assert.equal(ingest.inserted, 4);
    }
    const budgetAlert = await workspace.saveBudget(
      { orgId: ORG_ALERT, customerId: CUSTOMER_ALERT },
      { name: "Monthly EC2", currency: "USD", limitMicros: "10000000" },
      ACTOR,
    );
    await workspace.saveBudget(
      { orgId: ORG_QUIET, customerId: CUSTOMER_QUIET },
      { name: "Monthly EC2 Quiet", currency: "USD", limitMicros: "10000000" },
      ACTOR,
    );

    const notifications = new SecurityNotificationRepository(database);
    const enabled = await notifications.upsertDestination({
      orgId: ORG_ALERT,
      customerId: CUSTOMER_ALERT,
      actorId: ACTOR,
      displayName: "FinOps Slack",
      enabled: true,
      configuration: {
        channel: "slack",
        secretReference: `secret://notifications/${ORG_ALERT}/${CUSTOMER_ALERT}/slack/webhook`,
      },
    });
    assert.equal(enabled.enabled, true);
    // A DISABLED second destination proves the handler's enabled-filter is real.
    const disabled = await notifications.upsertDestination({
      orgId: ORG_ALERT,
      customerId: CUSTOMER_ALERT,
      actorId: ACTOR,
      displayName: "FinOps PagerDuty",
      enabled: false,
      configuration: {
        channel: "pagerduty",
        secretReference: `secret://notifications/${ORG_ALERT}/${CUSTOMER_ALERT}/pagerduty/routing`,
      },
    });
    assert.equal(disabled.enabled, false);

    await run({
      database,
      queue: new JobQueueRepository(database),
      notifications,
      enabledDestinationId: enabled.id,
      disabledDestinationId: disabled.id,
      budgetId: budgetAlert.id,
    });
  } finally {
    await miniflare.dispose();
  }
}

/** Every outbox row for a tenant, read straight out of the table. */
async function outboxRows(database, orgId, customerId) {
  const rows = await database.prepare(
    `SELECT id, destination_id, idempotency_key, status
       FROM security_notification_outbox
      WHERE org_id = ? AND customer_id = ?
      ORDER BY idempotency_key ASC`,
  ).bind(orgId, customerId).all();
  return rows.results ?? [];
}

/** Every sweep audit row for a tenant, read straight out of the chained table. */
async function sweepAuditRows(database, orgId) {
  const rows = await database.prepare(
    `SELECT customer_id, actor_type, actor_id, target_id, outcome, metadata_json
       FROM audit_events
      WHERE org_id = ? AND action = 'finops.alert_sweep.completed'
      ORDER BY occurred_at ASC, id ASC`,
  ).bind(orgId).all();
  return (rows.results ?? []).map((row) => ({ ...row, metadata: JSON.parse(row.metadata_json) }));
}

/** The production tick, wired exactly as app/api/internal/jobs/run/route.ts wires it. */
function runTick(queue, now = Date.now()) {
  return (async () => {
    const orgIds = await listActiveOrgIds();
    return ensureDueFinopsAlertSweepsEnqueued(
      queue,
      orgIds,
      async (orgId) => (await listConnectionsForOrg(orgId)).map((connection) => ({ customerId: connection.customerId })),
      now,
    );
  })();
}

/**
 * The production drain. `now` matters once a tick enqueues with a future clock:
 * a job is only leasable when `run_after <= now`.
 */
function drain(queue, now = Date.now()) {
  return runDueBackgroundJobs({ queue, handlers: buildJobHandlers(), maxPerKind: 25, now: () => now });
}

test("the real evaluator finds one anomaly PER CONNECTION and one customer-wide breached budget", async () => {
  await withDatabase(async ({ budgetId }) => {
    const result = await evaluateFinopsAlertsForCustomer(
      ORG_ALERT,
      CUSTOMER_ALERT,
      [CONNECTION_ALERT, CONNECTION_ALERT_TWIN],
    );
    assert.equal(result.period, PERIOD);
    // Line counts are summed across the customer's connections.
    assert.deepEqual(result.periods, [{ period: PERIOD, lineCount: 8 }]);

    const anomalies = result.evaluation.alerts.filter((alert) => alert.kind === "cost_anomaly");
    // The collision case: identical service/day/currency in two accounts stays
    // TWO alerts, because the id hash covers the connection.
    assert.equal(anomalies.length, 2);
    for (const anomaly of anomalies) {
      assert.match(anomaly.id, ANOMALY_ID);
      assert.equal(anomaly.severity, "critical"); // 10x trailing median
      assert.equal(anomaly.evidence.ratio, 10);
    }
    assert.equal(new Set(anomalies.map((alert) => alert.id)).size, 2);

    // ONE budget alert, period-scoped, over the COMBINED spend of both accounts.
    const budgets = result.evaluation.alerts.filter((alert) => alert.kind === "budget_breached");
    assert.equal(budgets.length, 1);
    assert.match(budgets[0].id, BUDGET_ID);
    assert.equal(budgets[0].id, `budget_breached:${PERIOD}:${budgetId}`);
    assert.equal(budgets[0].severity, "critical");
    assert.equal(result.evaluation.evaluated.anomalies, 2);
    assert.equal(result.evaluation.evaluated.budgets, 1);
  });
});

test("the tick enqueues one finops-alert-sweep per connection-owning tenant and is idempotent", async () => {
  await withDatabase(async ({ queue }) => {
    // Both seeded tenants own a connection, so both get a sweep — and the
    // alerting tenant's TWO connections still produce exactly ONE sweep.
    assert.equal(await runTick(queue), 2);
    const sweeps = (await queue.list(ORG_ALERT, CUSTOMER_ALERT)).filter((job) => job.kind === "finops-alert-sweep");
    assert.equal(sweeps.length, 1);
    assert.equal(sweeps[0].status, "queued");
    assert.equal(sweeps[0].orgId, ORG_ALERT);
    assert.equal(sweeps[0].customerId, CUSTOMER_ALERT);
    assert.equal((await queue.list(ORG_QUIET, CUSTOMER_QUIET)).filter((job) => job.kind === "finops-alert-sweep").length, 1);

    // A second tick while the sweeps are still in flight enqueues nothing.
    assert.equal(await runTick(queue), 0);
    assert.equal((await queue.list(ORG_ALERT, CUSTOMER_ALERT)).filter((job) => job.kind === "finops-alert-sweep").length, 1);
  });
});

test("draining through the real handler registry lands outbox rows for the enabled destination", async () => {
  await withDatabase(async ({ database, queue, notifications, enabledDestinationId, disabledDestinationId, budgetId }) => {
    await runTick(queue);
    const result = await drain(queue);
    const outcome = result.outcomes.find((entry) => entry.kind === "finops-alert-sweep");
    assert.equal(outcome.leased, 2);
    assert.equal(outcome.succeeded, 2);
    assert.equal(outcome.unhandled, 0);
    assert.equal(result.totalFailed, 0);
    assert.equal(
      (await queue.list(ORG_ALERT, CUSTOMER_ALERT)).find((job) => job.kind === "finops-alert-sweep").status,
      "succeeded",
    );

    // All three alerts (two per-connection anomalies + one customer-wide budget)
    // landed in the durable outbox, addressed to the ENABLED destination only,
    // keyed by the alert's stable content id.
    const rows = await outboxRows(database, ORG_ALERT, CUSTOMER_ALERT);
    assert.equal(rows.length, 3);
    const keys = rows.map((row) => row.idempotency_key);
    assert.deepEqual(keys.filter((key) => BUDGET_ID.test(key)), [`budget_breached:${PERIOD}:${budgetId}`]);
    const anomalyKeys = keys.filter((key) => ANOMALY_ID.test(key));
    // TWO distinct anomaly rows for the same service/day/currency: the
    // cross-connection collision that used to collapse them is gone.
    assert.equal(anomalyKeys.length, 2);
    assert.equal(new Set(anomalyKeys).size, 2);
    assert.ok(rows.every((row) => row.destination_id === enabledDestinationId));
    assert.ok(rows.every((row) => row.destination_id !== disabledDestinationId));
    assert.ok(rows.every((row) => row.status === "pending"));

    // Same rows are visible through the repository read path the UI uses.
    const jobs = await notifications.listJobs(ORG_ALERT, CUSTOMER_ALERT);
    assert.equal(jobs.length, 3);
    assert.ok(jobs.every((job) => job.channel === "slack" && job.status === "pending"));

    // AUDIT TRAIL: the sweep left a durable, system-actor record of what fired.
    const audit = await sweepAuditRows(database, ORG_ALERT);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].customer_id, CUSTOMER_ALERT);
    assert.equal(audit[0].actor_type, "system");
    assert.equal(audit[0].actor_id, "system_finops_alert_sweep");
    assert.equal(audit[0].outcome, "allowed");
    assert.deepEqual(audit[0].metadata, {
      alertsEvaluated: 3,
      attempt: 1,
      connectionCount: 2,
      deliveryState: "queued",
      destinationCount: 1,
      dispatchFailures: 0,
      dispatched: 3,
      truncated: false,
    });
  });
});

test("a second sweep does not duplicate outbox rows for the same alert and destination", async () => {
  await withDatabase(async ({ database, queue }) => {
    const firstTickAt = Date.now();
    await runTick(queue, firstTickAt);
    await drain(queue);
    const first = await outboxRows(database, ORG_ALERT, CUSTOMER_ALERT);
    assert.equal(first.length, 3);

    // CADENCE GATE: the first sweep is terminal, but re-reading every billing
    // line every tick is waste, so nothing is enqueued until the interval passes.
    assert.equal(await runTick(queue, firstTickAt), 0);
    const dueAt = firstTickAt + FINOPS_ALERT_SWEEP_INTERVAL_MS + 1;
    assert.equal(await runTick(queue, dueAt), 2);

    const second = await drain(queue, dueAt);
    assert.equal(second.outcomes.find((entry) => entry.kind === "finops-alert-sweep").succeeded, 2);
    assert.equal(second.totalFailed, 0);

    // Idempotency is keyed on the alert's stable content id: no new rows, and
    // the original row ids survive (the insert collapsed, it did not replace).
    const after = await outboxRows(database, ORG_ALERT, CUSTOMER_ALERT);
    assert.deepEqual(after.map((row) => row.id), first.map((row) => row.id));

    // The audit chain, by contrast, records BOTH sweeps — one per job.
    const audit = await sweepAuditRows(database, ORG_ALERT);
    assert.equal(audit.length, 2);
    assert.equal(new Set(audit.map((row) => row.target_id)).size, 2);
    assert.ok(audit.every((row) => row.metadata.alertsEvaluated === 3 && row.metadata.dispatched === 3));
  });
});

test("a tenant with no enabled destination produces no outbox rows but IS recorded as undeliverable", async () => {
  await withDatabase(async ({ database, queue }) => {
    await runTick(queue);
    await drain(queue);

    // The quiet tenant has the same cost data and a breachable budget, but no
    // destination — the sweep succeeds and writes no notification.
    assert.equal(
      (await queue.list(ORG_QUIET, CUSTOMER_QUIET)).find((job) => job.kind === "finops-alert-sweep").status,
      "succeeded",
    );
    assert.deepEqual(await outboxRows(database, ORG_QUIET, CUSTOMER_QUIET), []);
    const total = await database.prepare("SELECT COUNT(*) AS total FROM security_notification_outbox").first();
    assert.equal(Number(total.total), 3); // only the alerting tenant's three rows

    // …and the alerts are no longer invisible: the audit row states that two
    // alerts were evaluated with ZERO destinations to deliver them to.
    const audit = await sweepAuditRows(database, ORG_QUIET);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].customer_id, CUSTOMER_QUIET);
    assert.equal(audit[0].actor_type, "system");
    assert.equal(audit[0].outcome, "failed");
    assert.equal(audit[0].metadata.deliveryState, "no_destination");
    assert.equal(audit[0].metadata.destinationCount, 0);
    assert.equal(audit[0].metadata.alertsEvaluated, 2); // one anomaly + one breached budget
    assert.equal(audit[0].metadata.dispatched, 0);
  });
});
