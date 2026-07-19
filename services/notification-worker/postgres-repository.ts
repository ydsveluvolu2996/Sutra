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
import { postgresDatabase } from "../../db/postgres-d1-adapter.ts";
import type {
  ClaimedNotificationJob,
} from "../../db/security-notification-repository.ts";
import type { SecurityNotificationWorkerRepository } from "./worker.ts";

const JOB_ID = /^njob_[a-f0-9]{32}$/u;
const LEASE_ID = /^nlease_[a-f0-9]{32}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;

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
implements SecurityNotificationWorkerRepository {
  private readonly database: D1Database;

  public constructor(databaseUrl: string) {
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
    status: Extract<NotificationOutboxStatus, "delivered" | "retry_scheduled" | "dead_letter" | "not_configured">,
    errorCode: string | null,
    nextAttemptAt: number | null,
  ): Promise<void> {
    if (
      !JOB_ID.test(jobId) ||
      !LEASE_ID.test(leaseToken) ||
      (errorCode !== null && !ERROR_CODE.test(errorCode))
    ) throw new Error("Notification worker persistence operation rejected");
    const now = Date.now();
    const result = await this.database.prepare(
      `UPDATE security_notification_outbox SET
         status = ?, next_attempt_at = ?, last_error_code = ?,
         lease_token = NULL, lease_expires_at = NULL, updated_at = ?,
         delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END
       WHERE id = ? AND lease_token = ? AND status = 'processing'`,
    ).bind(
      status, nextAttemptAt ?? now, errorCode, now, status, now, jobId, leaseToken,
    ).run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new Error("Notification worker persistence operation rejected");
    }
  }
}
