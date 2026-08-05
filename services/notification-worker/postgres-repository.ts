import type {
  NotificationDestination,
  NotificationDestinationConfig,
  NotificationOutboxStatus,
} from "../../lib/notification-destination-types.ts";
import { normalizeNotificationDestinationConfig } from "../../lib/notification-destination-boundary.ts";
import type {
  SecurityNotificationEvent,
  SecurityNotificationPayloads,
} from "../../lib/security-notifications.ts";
import {
  postgresDatabase,
  withPostgresTransaction,
} from "../../db/postgres-d1-adapter.ts";
import type {
  ClaimedNotificationJob,
} from "../../db/security-notification-repository.ts";
import type { SecurityNotificationWorkerRepository } from "./worker.ts";
import type {
  SesFeedbackEvent,
} from "../../lib/ses-feedback.ts";
import type { SesFeedbackRepository } from "./ses-feedback.ts";

const JOB_ID = /^njob_[a-f0-9]{32}$/u;
const LEASE_ID = /^nlease_[a-f0-9]{32}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;
const DELIVERY_ID = /^notify_[a-f0-9]{48}$/u;

interface ClaimedRow {
  id: string;
  org_id: string;
  customer_id: string;
  event_json: string;
  payload_json: string;
  attempt_count: number;
  destination_id: string;
  d_org_id: string;
  d_customer_id: string;
  channel: NotificationDestination["channel"];
  display_name: string;
  enabled: number;
  secret_reference: string | null;
  email_recipients_json: string | null;
  email_from_address: string | null;
  ses_region: string | null;
  created_at: number;
  updated_at: number;
}

function destinationFrom(row: ClaimedRow): NotificationDestination {
  let configuration: NotificationDestinationConfig;
  if (row.channel === "email") {
    let recipients: unknown;
    try {
      recipients = JSON.parse(row.email_recipients_json ?? "");
    } catch {
      throw new Error("Notification worker persistence payload rejected");
    }
    configuration = normalizeNotificationDestinationConfig({
      channel: "email",
      recipients: Array.isArray(recipients) ? recipients as string[] : [],
      fromAddress: row.email_from_address ?? "",
      sesRegion: row.ses_region ?? "",
    });
  } else {
    configuration = normalizeNotificationDestinationConfig({
      channel: row.channel,
      secretReference: row.secret_reference ?? "",
    });
  }
  return {
    id: row.destination_id,
    orgId: row.d_org_id,
    customerId: row.d_customer_id,
    channel: row.channel,
    displayName: row.display_name,
    enabled: Number(row.enabled) === 1,
    configuration,
    deliveryReadiness: "configured",
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}

export class PostgresSecurityNotificationWorkerRepository
implements SecurityNotificationWorkerRepository, SesFeedbackRepository {
  private readonly database: D1Database;
  private readonly databaseUrl: string;

  public constructor(databaseUrl: string) {
    this.databaseUrl = databaseUrl;
    this.database = postgresDatabase(databaseUrl);
  }

  public async claim(now = Date.now()): Promise<ClaimedNotificationJob | null> {
    const leaseToken = `nlease_${crypto.randomUUID().replaceAll("-", "")}`;
    const leaseExpiresAt = now + 30_000;
    await this.database.prepare(
      `UPDATE security_notification_outbox SET
         status = 'processing', lease_token = ?, lease_expires_at = ?,
         attempt_count = attempt_count + 1, updated_at = ?
       WHERE id = (
         SELECT id FROM security_notification_outbox
          WHERE (
            (status IN ('pending', 'retry_scheduled') AND next_attempt_at <= ?)
            OR (status = 'processing' AND lease_expires_at < ?)
          )
          ORDER BY next_attempt_at, created_at, id LIMIT 1
       ) AND (
         (status IN ('pending', 'retry_scheduled') AND next_attempt_at <= ?)
         OR (status = 'processing' AND lease_expires_at < ?)
       )`,
    ).bind(leaseToken, leaseExpiresAt, now, now, now, now, now).run();
    const row = await this.database.prepare(
      `SELECT o.id, o.org_id, o.customer_id, o.event_json, o.payload_json,
              o.attempt_count, d.id AS destination_id, d.org_id AS d_org_id,
              d.customer_id AS d_customer_id, d.channel, d.display_name,
              d.enabled, d.secret_reference, d.email_recipients_json,
              d.email_from_address, d.ses_region, d.created_at, d.updated_at
         FROM security_notification_outbox o
         JOIN security_notification_destinations d
           ON d.id = o.destination_id AND d.org_id = o.org_id AND d.customer_id = o.customer_id
        WHERE o.lease_token = ? AND o.status = 'processing' LIMIT 1`,
    ).bind(leaseToken).first<ClaimedRow>();
    if (row === null) return null;
    let event: SecurityNotificationEvent;
    let payloads: SecurityNotificationPayloads;
    try {
      event = JSON.parse(row.event_json) as SecurityNotificationEvent;
      payloads = JSON.parse(row.payload_json) as SecurityNotificationPayloads;
    } catch {
      await this.finish(row.id, leaseToken, "dead_letter", "PAYLOAD_REJECTED", null);
      return null;
    }
    return {
      id: row.id,
      orgId: row.org_id,
      customerId: row.customer_id,
      leaseToken,
      destination: destinationFrom(row),
      event,
      payloads,
      attemptCount: Number(row.attempt_count),
    };
  }

  public async finish(
    jobId: string,
    leaseToken: string,
    status: Extract<
      NotificationOutboxStatus,
      | "provider_accepted"
      | "delivered"
      | "delivery_failed"
      | "retry_scheduled"
      | "dead_letter"
      | "not_configured"
    >,
    errorCode: string | null,
    nextAttemptAt: number | null,
    providerDeliveryId: string | null = null,
  ): Promise<void> {
    if (
      !JOB_ID.test(jobId) ||
      !LEASE_ID.test(leaseToken) ||
      (errorCode !== null && !ERROR_CODE.test(errorCode)) ||
      (
        providerDeliveryId !== null &&
        (status !== "provider_accepted" || !DELIVERY_ID.test(providerDeliveryId))
      ) ||
      (status === "provider_accepted" && providerDeliveryId === null)
    ) throw new Error("Notification worker persistence operation rejected");
    const now = Date.now();
    const result = await this.database.prepare(
      `UPDATE security_notification_outbox SET
         status = ?, next_attempt_at = ?, last_error_code = ?,
         lease_token = NULL, lease_expires_at = NULL, updated_at = ?,
         delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
         ses_delivery_id = COALESCE(?, ses_delivery_id),
         ses_accepted_at = CASE WHEN ? = 'provider_accepted' THEN ? ELSE ses_accepted_at END
       WHERE id = ? AND lease_token = ? AND status = 'processing'`,
    ).bind(
      status, nextAttemptAt ?? now, errorCode, now, status, now,
      providerDeliveryId, status, now, jobId, leaseToken,
    ).run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new Error("Notification worker persistence operation rejected");
    }
  }

  public async reconcileSesFeedback(
    event: SesFeedbackEvent,
  ): Promise<"applied" | "duplicate" | "unmatched"> {
    const errorCode = event.eventType === "bounce"
      ? "SES_BOUNCE"
      : event.eventType === "complaint"
        ? "SES_COMPLAINT"
        : event.eventType === "reject"
          ? "SES_REJECT"
          : event.eventType === "rendering_failure"
            ? "SES_RENDERING_FAILURE"
            : event.eventType === "delivery_delay"
              ? "SES_DELIVERY_DELAY"
              : null;
    const now = Date.now();
    return withPostgresTransaction(this.databaseUrl, async (query) => {
      /*
       * Lock the delivery before binding its provider message id. Every later
       * statement uses this same connection and transaction, so concurrent
       * events for one delivery serialize and cannot partially reconcile.
       */
      const targetResult = await query(
        `SELECT o.id, o.org_id, o.customer_id, o.destination_id,
                o.ses_provider_message_id
           FROM security_notification_outbox o
           JOIN security_notification_destinations d
             ON d.id = o.destination_id
            AND d.org_id = o.org_id
            AND d.customer_id = o.customer_id
            AND d.channel = 'email'
          WHERE o.ses_delivery_id = $1
          LIMIT 1
          FOR UPDATE OF o`,
        [event.deliveryId],
      );
      const target = targetResult.rows[0] as {
        id: string;
        org_id: string;
        customer_id: string;
        destination_id: string;
        ses_provider_message_id: string | null;
      } | undefined;
      if (target === undefined) return "unmatched";
      if (
        target.ses_provider_message_id !== null &&
        target.ses_provider_message_id !== event.providerMessageId
      ) throw new Error("Notification worker persistence operation rejected");

      const inserted = await query(
        `INSERT INTO security_notification_ses_feedback
          (event_id, outbox_id, org_id, customer_id, destination_id,
           delivery_id, provider_message_id, event_type, event_at,
           payload_sha256, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [
          event.eventId,
          target.id,
          target.org_id,
          target.customer_id,
          target.destination_id,
          event.deliveryId,
          event.providerMessageId,
          event.eventType,
          event.occurredAt,
          event.payloadSha256,
          now,
        ],
      );
      const existingResult = await query(
        `SELECT outbox_id, delivery_id, provider_message_id, event_type,
                event_at, payload_sha256, reconciled_at
           FROM security_notification_ses_feedback
          WHERE event_id = $1
          LIMIT 1`,
        [event.eventId],
      );
      const existing = existingResult.rows[0] as {
        outbox_id: string;
        delivery_id: string;
        provider_message_id: string;
        event_type: string;
        event_at: number;
        payload_sha256: string;
        reconciled_at: number | null;
      } | undefined;
      if (
        existing === undefined ||
        existing.outbox_id !== target.id ||
        existing.delivery_id !== event.deliveryId ||
        existing.provider_message_id !== event.providerMessageId ||
        existing.event_type !== event.eventType ||
        Number(existing.event_at) !== event.occurredAt ||
        existing.payload_sha256 !== event.payloadSha256
      ) throw new Error("Notification worker persistence operation rejected");
      if (existing.reconciled_at !== null) return "duplicate";

      const transitioned = await query(
        `UPDATE security_notification_outbox SET
           status = CASE
             WHEN $1 IN ('bounce', 'complaint', 'reject', 'rendering_failure')
               THEN 'delivery_failed'
             WHEN $1 = 'delivery' AND status <> 'delivery_failed'
               THEN 'delivered'
             WHEN $1 IN ('send', 'delivery_delay')
                  AND status NOT IN ('delivered', 'delivery_failed')
               THEN 'provider_accepted'
             ELSE status
           END,
           last_error_code = CASE
             WHEN $1 IN ('bounce', 'complaint', 'reject', 'rendering_failure')
               THEN $2
             WHEN $1 = 'delivery_delay'
                  AND status NOT IN ('delivered', 'delivery_failed')
               THEN $2
             WHEN $1 = 'delivery' AND status <> 'delivery_failed'
               THEN NULL
             ELSE last_error_code
           END,
           delivered_at = CASE
             WHEN $1 = 'delivery' AND status <> 'delivery_failed'
               THEN COALESCE(delivered_at, $3)
             ELSE delivered_at
           END,
           ses_provider_message_id = COALESCE(ses_provider_message_id, $4),
           ses_last_event_type = CASE
             WHEN ses_last_event_at IS NULL OR $3 >= ses_last_event_at THEN $1
             ELSE ses_last_event_type
           END,
           ses_last_event_at = CASE
             WHEN ses_last_event_at IS NULL OR $3 >= ses_last_event_at THEN $3
             ELSE ses_last_event_at
           END,
           updated_at = $5
         WHERE id = $6 AND org_id = $7 AND customer_id = $8
           AND destination_id = $9 AND ses_delivery_id = $10
           AND (ses_provider_message_id IS NULL OR ses_provider_message_id = $4)`,
        [
          event.eventType,
          errorCode,
          event.occurredAt,
          event.providerMessageId,
          now,
          target.id,
          target.org_id,
          target.customer_id,
          target.destination_id,
          event.deliveryId,
        ],
      );
      if (transitioned.rowCount !== 1) {
        throw new Error("Notification worker persistence operation rejected");
      }
      const reconciled = await query(
        `UPDATE security_notification_ses_feedback SET reconciled_at = $1
          WHERE event_id = $2 AND outbox_id = $3 AND reconciled_at IS NULL`,
        [now, event.eventId, target.id],
      );
      if (reconciled.rowCount !== 1) {
        throw new Error("Notification worker persistence operation rejected");
      }
      if (inserted.rowCount !== 0 && inserted.rowCount !== 1) {
        throw new Error("Notification worker persistence operation rejected");
      }
      return "applied";
    });
  }
}
