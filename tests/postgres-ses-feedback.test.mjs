import assert from "node:assert/strict";
import test from "node:test";

import {
  closePostgresDatabase,
  postgresDatabase,
} from "../db/postgres-d1-adapter.ts";
import { PostgresSecurityNotificationWorkerRepository } from "../services/notification-worker/postgres-repository.ts";

const databaseUrl = process.env.SUTRA_POSTGRES_RUNTIME_TEST_URL?.trim();
if (!databaseUrl) throw new Error("SUTRA_POSTGRES_RUNTIME_TEST_URL is required");

function event(deliveryId, providerMessageId, eventType, occurredAt) {
  return {
    eventId: crypto.randomUUID(),
    deliveryId,
    providerMessageId,
    eventType,
    occurredAt,
    payloadSha256: crypto.randomUUID().replaceAll("-", "").repeat(2),
  };
}

test("SES feedback reconciliation is atomic under conflicting provider events", async () => {
  const database = postgresDatabase(databaseUrl);
  const repository = new PostgresSecurityNotificationWorkerRepository(databaseUrl);
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const orgId = `org_ses_${suffix}`;
  const userId = `usr_${suffix}`;
  const customerId = `cust_${suffix}`;
  const destinationId = `ndest_${suffix}`;
  const outboxId = `njob_${suffix}`;
  const deliveryId = `notify_${suffix}${suffix.slice(0, 16)}`;
  const now = Date.parse("2026-07-30T08:00:00.000Z");

  try {
    await database.batch([
      database.prepare(
        "INSERT INTO organizations (id, slug, name) VALUES (?, ?, ?)",
      ).bind(orgId, `ses-feedback-${suffix}`, "SES feedback test"),
      database.prepare(
        `INSERT INTO users (id, issuer, subject, email, display_name)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        userId,
        "postgres-ses-feedback-test",
        suffix,
        `${suffix}@example.com`,
        "SES feedback test",
      ),
      database.prepare(
        "INSERT INTO customers (id, org_id, slug, name) VALUES (?, ?, ?, ?)",
      ).bind(customerId, orgId, `customer-${suffix}`, "SES feedback customer"),
      database.prepare(
        `INSERT INTO security_notification_destinations
          (id, org_id, customer_id, channel, display_name, enabled,
           email_recipients_json, email_from_address, ses_region, created_by)
         VALUES (?, ?, ?, 'email', ?, 1, ?, ?, 'ap-south-1', ?)`,
      ).bind(
        destinationId,
        orgId,
        customerId,
        "Security email",
        JSON.stringify(["security@example.com"]),
        "alerts@example.com",
        userId,
      ),
      database.prepare(
        `INSERT INTO security_notification_outbox
          (id, org_id, customer_id, destination_id, idempotency_key,
           event_json, payload_json, payload_sha256, status, attempt_count,
           next_attempt_at, created_at, updated_at, ses_delivery_id,
           ses_accepted_at)
         VALUES (?, ?, ?, ?, ?, '{}', '{}', ?, 'provider_accepted', 1,
                 ?, ?, ?, ?, ?)`,
      ).bind(
        outboxId,
        orgId,
        customerId,
        destinationId,
        `ses-feedback-${suffix}`,
        "0".repeat(64),
        now,
        now,
        now,
        deliveryId,
        now,
      ),
    ]);

    const first = event(deliveryId, `ses-message-a-${suffix}`, "send", now + 1_000);
    const second = event(deliveryId, `ses-message-b-${suffix}`, "send", now + 1_000);
    const raced = await Promise.allSettled([
      repository.reconcileSesFeedback(first),
      repository.reconcileSesFeedback(second),
    ]);
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(raced.filter((result) => result.status === "rejected").length, 1);
    const winner = raced[0].status === "fulfilled" ? first : second;
    const loser = winner === first ? second : first;
    assert.equal(
      raced.find((result) => result.status === "fulfilled")?.value,
      "applied",
    );

    const bound = await database.prepare(
      `SELECT status, ses_provider_message_id, last_error_code
         FROM security_notification_outbox WHERE id = ?`,
    ).bind(outboxId).first();
    assert.deepEqual(bound, {
      status: "provider_accepted",
      ses_provider_message_id: winner.providerMessageId,
      last_error_code: null,
    });
    assert.equal(await repository.reconcileSesFeedback(winner), "duplicate");
    await assert.rejects(
      repository.reconcileSesFeedback({
        ...loser,
        eventId: crypto.randomUUID(),
      }),
      /persistence operation rejected/u,
    );

    const delayed = event(deliveryId, winner.providerMessageId, "delivery_delay", now + 2_000);
    assert.equal(await repository.reconcileSesFeedback(delayed), "applied");
    const delayState = await database.prepare(
      "SELECT status, last_error_code FROM security_notification_outbox WHERE id = ?",
    ).bind(outboxId).first();
    assert.deepEqual(delayState, {
      status: "provider_accepted",
      last_error_code: "SES_DELIVERY_DELAY",
    });

    const delivered = event(deliveryId, winner.providerMessageId, "delivery", now + 3_000);
    assert.equal(await repository.reconcileSesFeedback(delivered), "applied");
    const bounced = event(deliveryId, winner.providerMessageId, "bounce", now + 4_000);
    assert.equal(await repository.reconcileSesFeedback(bounced), "applied");
    const lateDelivery = event(deliveryId, winner.providerMessageId, "delivery", now + 5_000);
    assert.equal(await repository.reconcileSesFeedback(lateDelivery), "applied");

    const terminal = await database.prepare(
      `SELECT status, last_error_code, ses_provider_message_id,
              ses_last_event_type, ses_last_event_at
         FROM security_notification_outbox WHERE id = ?`,
    ).bind(outboxId).first();
    assert.deepEqual(terminal, {
      status: "delivery_failed",
      last_error_code: "SES_BOUNCE",
      ses_provider_message_id: winner.providerMessageId,
      ses_last_event_type: "delivery",
      ses_last_event_at: now + 5_000,
    });
    const ledger = await database.prepare(
      `SELECT COUNT(*) AS event_count,
              COUNT(reconciled_at) AS reconciled_count
         FROM security_notification_ses_feedback WHERE outbox_id = ?`,
    ).bind(outboxId).first();
    assert.deepEqual(ledger, { event_count: 5, reconciled_count: 5 });

    const unmatched = event(
      `notify_${"f".repeat(48)}`,
      `ses-unmatched-${suffix}`,
      "delivery",
      now + 6_000,
    );
    assert.equal(await repository.reconcileSesFeedback(unmatched), "unmatched");
  } finally {
    await closePostgresDatabase();
  }
});
