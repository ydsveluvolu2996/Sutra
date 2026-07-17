import { canonicalJson } from "../lib/canonical-json.ts";
import type {
  NotificationDestination,
  NotificationDestinationConfig,
  NotificationOutboxJob,
  NotificationOutboxStatus,
} from "../lib/notification-destination-types.ts";
import type {
  SecurityNotificationEvent,
  SecurityNotificationPayloads,
} from "../lib/security-notifications.ts";
import { normalizeNotificationDestinationConfig } from "../lib/notification-destination-boundary.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,191}$/u;
const DESTINATION_ID = /^ndest_[a-f0-9]{32}$/u;
const JOB_ID = /^njob_[a-f0-9]{32}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{7,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;

interface DestinationRow {
  id: string;
  org_id: string;
  customer_id: string;
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

interface JobRow {
  id: string;
  destination_id: string;
  channel: NotificationDestination["channel"];
  status: NotificationOutboxStatus;
  attempt_count: number;
  next_attempt_at: number;
  last_error_code: string | null;
  created_at: number;
  delivered_at: number | null;
}

export interface ClaimedNotificationJob {
  readonly id: string;
  readonly orgId: string;
  readonly customerId: string;
  readonly leaseToken: string;
  readonly destination: NotificationDestination;
  readonly event: SecurityNotificationEvent;
  readonly payloads: SecurityNotificationPayloads;
  readonly attemptCount: number;
}

export class SecurityNotificationRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "PERSISTENCE_FAILED";

  public constructor(code: SecurityNotificationRepositoryError["code"]) {
    super("Security notification persistence operation rejected");
    this.name = "SecurityNotificationRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new SecurityNotificationRepositoryError("INVALID_INPUT");
}

function randomId(prefix: "ndest" | "njob"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function safeText(value: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (
    normalized.length < 1 ||
    normalized.length > maximum ||
    /[\u0000-\u001f\u007f<>]/u.test(normalized)
  ) invalid();
  return normalized;
}

function destinationFrom(row: DestinationRow): NotificationDestination {
  let configuration: NotificationDestinationConfig;
  if (row.channel === "email") {
    let recipients: unknown;
    try {
      recipients = JSON.parse(row.email_recipients_json ?? "");
    } catch {
      return invalid();
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
    id: row.id,
    orgId: row.org_id,
    customerId: row.customer_id,
    channel: row.channel,
    displayName: row.display_name,
    enabled: Number(row.enabled) === 1,
    configuration,
    deliveryReadiness: "adapter_not_configured",
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}

function jobFrom(row: JobRow): NotificationOutboxJob {
  return {
    id: row.id,
    destinationId: row.destination_id,
    channel: row.channel,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: new Date(Number(row.next_attempt_at)).toISOString(),
    lastErrorCode: row.last_error_code,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    deliveredAt: row.delivered_at === null ? null : new Date(Number(row.delivered_at)).toISOString(),
  };
}

const DESTINATION_SELECT = `
  SELECT id, org_id, customer_id, channel, display_name, enabled,
         secret_reference, email_recipients_json, email_from_address,
         ses_region, created_at, updated_at
    FROM security_notification_destinations`;

export class SecurityNotificationRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async listDestinations(
    orgId: string,
    customerId: string,
  ): Promise<readonly NotificationDestination[]> {
    if (!IDENTIFIER.test(orgId) || !IDENTIFIER.test(customerId)) invalid();
    const db = await this.ready();
    const rows = await db.prepare(
      `${DESTINATION_SELECT}
        WHERE org_id = ? AND customer_id = ?
        ORDER BY channel, id`,
    ).bind(orgId, customerId).all<DestinationRow>();
    return (rows.results ?? []).map(destinationFrom);
  }

  public async upsertDestination(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly actorId: string;
    readonly displayName: string;
    readonly enabled: boolean;
    readonly configuration: NotificationDestinationConfig;
  }): Promise<NotificationDestination> {
    if (
      !IDENTIFIER.test(input.orgId) ||
      !IDENTIFIER.test(input.customerId) ||
      !IDENTIFIER.test(input.actorId)
    ) invalid();
    const configuration = normalizeNotificationDestinationConfig(input.configuration);
    const displayName = safeText(input.displayName, 100);
    const id = randomId("ndest");
    const now = Date.now();
    const emailRecipients = configuration.channel === "email"
      ? canonicalJson(configuration.recipients)
      : null;
    const result = await (await this.ready()).prepare(
      `INSERT INTO security_notification_destinations
        (id, org_id, customer_id, channel, display_name, enabled,
         secret_reference, email_recipients_json, email_from_address,
         ses_region, created_by, created_at, updated_at)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM customers c
         JOIN users u ON u.id = ? AND u.status = 'active'
        WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')
       ON CONFLICT (org_id, customer_id, channel) DO UPDATE SET
         display_name = excluded.display_name,
         enabled = excluded.enabled,
         secret_reference = excluded.secret_reference,
         email_recipients_json = excluded.email_recipients_json,
         email_from_address = excluded.email_from_address,
         ses_region = excluded.ses_region,
         updated_at = excluded.updated_at`,
    ).bind(
      id, configuration.channel, displayName, input.enabled ? 1 : 0,
      configuration.channel === "email" ? null : configuration.secretReference,
      emailRecipients,
      configuration.channel === "email" ? configuration.fromAddress : null,
      configuration.channel === "email" ? configuration.sesRegion : null,
      input.actorId, now, now, input.actorId,
      input.customerId, input.orgId,
    ).run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new SecurityNotificationRepositoryError("SCOPE_NOT_FOUND");
    }
    const stored = (await this.listDestinations(input.orgId, input.customerId))
      .find((candidate) => candidate.channel === configuration.channel);
    if (stored === undefined) throw new SecurityNotificationRepositoryError("PERSISTENCE_FAILED");
    return stored;
  }

  public async enqueue(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly destinationId: string;
    readonly idempotencyKey: string;
    readonly event: SecurityNotificationEvent;
    readonly payloads: SecurityNotificationPayloads;
  }): Promise<NotificationOutboxJob> {
    if (
      !IDENTIFIER.test(input.orgId) ||
      !IDENTIFIER.test(input.customerId) ||
      !DESTINATION_ID.test(input.destinationId) ||
      !IDEMPOTENCY_KEY.test(input.idempotencyKey) ||
      !HASH.test(input.payloads.payloadSha256) ||
      input.event.orgId !== input.orgId ||
      input.event.customerId !== input.customerId
    ) invalid();
    const eventJson = canonicalJson(input.event);
    const payloadJson = canonicalJson(input.payloads);
    if (eventJson.length > 16 * 1024 || payloadJson.length > 256 * 1024) invalid();
    const id = randomId("njob");
    const now = Date.now();
    const db = await this.ready();
    await db.prepare(
      `INSERT OR IGNORE INTO security_notification_outbox
        (id, org_id, customer_id, destination_id, idempotency_key,
         event_json, payload_json, payload_sha256, status, next_attempt_at)
       SELECT ?, d.org_id, d.customer_id, d.id, ?, ?, ?, ?, 'pending', ?
         FROM security_notification_destinations d
        WHERE d.id = ? AND d.org_id = ? AND d.customer_id = ? AND d.enabled = 1`,
    ).bind(
      id, input.idempotencyKey, eventJson, payloadJson,
      input.payloads.payloadSha256, now, input.destinationId,
      input.orgId, input.customerId,
    ).run();
    const row = await db.prepare(
      `SELECT o.id, o.destination_id, d.channel, o.status, o.attempt_count,
              o.next_attempt_at, o.last_error_code, o.created_at, o.delivered_at
         FROM security_notification_outbox o
         JOIN security_notification_destinations d ON d.id = o.destination_id
        WHERE o.org_id = ? AND o.customer_id = ? AND o.destination_id = ?
          AND o.idempotency_key = ? LIMIT 1`,
    ).bind(
      input.orgId, input.customerId, input.destinationId, input.idempotencyKey,
    ).first<JobRow>();
    if (row === null) throw new SecurityNotificationRepositoryError("SCOPE_NOT_FOUND");
    return jobFrom(row);
  }

  public async listJobs(
    orgId: string,
    customerId: string,
    limit = 50,
  ): Promise<readonly NotificationOutboxJob[]> {
    if (
      !IDENTIFIER.test(orgId) ||
      !IDENTIFIER.test(customerId) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    ) invalid();
    const rows = await (await this.ready()).prepare(
      `SELECT o.id, o.destination_id, d.channel, o.status, o.attempt_count,
              o.next_attempt_at, o.last_error_code, o.created_at, o.delivered_at
         FROM security_notification_outbox o
         JOIN security_notification_destinations d ON d.id = o.destination_id
        WHERE o.org_id = ? AND o.customer_id = ?
        ORDER BY o.created_at DESC, o.id DESC LIMIT ?`,
    ).bind(orgId, customerId, limit).all<JobRow>();
    return (rows.results ?? []).map(jobFrom);
  }

  public async claim(now = Date.now()): Promise<ClaimedNotificationJob | null> {
    const db = await this.ready();
    const leaseToken = `nlease_${crypto.randomUUID().replaceAll("-", "")}`;
    const leaseExpiresAt = now + 30_000;
    await db.prepare(
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
    const row = await db.prepare(
      `SELECT o.id, o.org_id, o.customer_id, o.event_json, o.payload_json,
              o.attempt_count, d.id AS destination_id, d.org_id AS d_org_id,
              d.customer_id AS d_customer_id, d.channel, d.display_name,
              d.enabled, d.secret_reference, d.email_recipients_json,
              d.email_from_address, d.ses_region, d.created_at, d.updated_at
         FROM security_notification_outbox o
         JOIN security_notification_destinations d
           ON d.id = o.destination_id AND d.org_id = o.org_id AND d.customer_id = o.customer_id
        WHERE o.lease_token = ? AND o.status = 'processing' LIMIT 1`,
    ).bind(leaseToken).first<{
      id: string; org_id: string; customer_id: string; event_json: string;
      payload_json: string; attempt_count: number; destination_id: string;
      d_org_id: string; d_customer_id: string; channel: DestinationRow["channel"];
      display_name: string; enabled: number; secret_reference: string | null;
      email_recipients_json: string | null; email_from_address: string | null;
      ses_region: string | null; created_at: number; updated_at: number;
    }>();
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
      destination: destinationFrom({
        id: row.destination_id,
        org_id: row.d_org_id,
        customer_id: row.d_customer_id,
        channel: row.channel,
        display_name: row.display_name,
        enabled: row.enabled,
        secret_reference: row.secret_reference,
        email_recipients_json: row.email_recipients_json,
        email_from_address: row.email_from_address,
        ses_region: row.ses_region,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }),
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
      !/^nlease_[a-f0-9]{32}$/u.test(leaseToken) ||
      (errorCode !== null && !/^[A-Z][A-Z0-9_]{2,63}$/u.test(errorCode))
    ) invalid();
    const now = Date.now();
    const result = await (await this.ready()).prepare(
      `UPDATE security_notification_outbox SET
         status = ?, next_attempt_at = ?, last_error_code = ?,
         lease_token = NULL, lease_expires_at = NULL, updated_at = ?,
         delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END
       WHERE id = ? AND lease_token = ? AND status = 'processing'`,
    ).bind(
      status, nextAttemptAt ?? now, errorCode, now, status, now, jobId, leaseToken,
    ).run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new SecurityNotificationRepositoryError("PERSISTENCE_FAILED");
    }
  }
}
