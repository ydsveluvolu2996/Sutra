import { defaultCaseDueAt, type CasePriority } from "../lib/case-management.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import { commitAuditedStatements } from "./pilot-repository";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;
const EVENT_ID = /^frte_[a-f0-9]{48}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,191}$/u;

export interface RuntimeEventCase {
  readonly id: string;
  readonly caseNumber: string;
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly clusterId: string;
  readonly sourceType: "falco_runtime_event";
  readonly sourceId: string;
  readonly evidenceSha256: string;
  readonly title: string;
  readonly severity: string;
  readonly priority: CasePriority;
  readonly status: "open";
  readonly dueAt: string;
  readonly createdAt: string;
}

interface RuntimeCaseRow {
  id: string;
  case_number: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  cluster_id: string;
  source_type: "falco_runtime_event";
  source_id: string;
  evidence_sha256: string;
  title: string;
  severity: string;
  priority: CasePriority;
  status: "open";
  due_at: number;
  created_at: number;
}

export class RuntimeEventCaseRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "PERSISTENCE_FAILED";

  public constructor(code: RuntimeEventCaseRepositoryError["code"]) {
    super("Runtime event case operation rejected");
    this.name = "RuntimeEventCaseRepositoryError";
    this.code = code;
  }
}

function assertInput(input: {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly clusterId: string;
  readonly eventId: string;
  readonly evidenceSha256: string;
  readonly actorUserId: string;
}): void {
  if (
    !IDENTIFIER.test(input.orgId) ||
    !IDENTIFIER.test(input.customerId) ||
    !CONNECTION_ID.test(input.connectionId) ||
    !CLUSTER_ID.test(input.clusterId) ||
    !EVENT_ID.test(input.eventId) ||
    !HASH.test(input.evidenceSha256) ||
    !IDENTIFIER.test(input.actorUserId)
  ) throw new RuntimeEventCaseRepositoryError("INVALID_INPUT");
}

function fromRow(row: RuntimeCaseRow): RuntimeEventCase {
  if (row.source_type !== "falco_runtime_event" || row.status !== "open") {
    throw new RuntimeEventCaseRepositoryError("PERSISTENCE_FAILED");
  }
  return {
    id: row.id,
    caseNumber: row.case_number,
    orgId: row.org_id,
    customerId: row.customer_id,
    connectionId: row.connection_id,
    clusterId: row.cluster_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    evidenceSha256: row.evidence_sha256,
    title: row.title,
    severity: row.severity,
    priority: row.priority,
    status: row.status,
    dueAt: new Date(Number(row.due_at)).toISOString(),
    createdAt: new Date(Number(row.created_at)).toISOString(),
  };
}

const SELECT = `SELECT id, case_number, org_id, customer_id, connection_id,
  cluster_id, source_type, source_id, evidence_sha256, title, severity,
  priority, status, due_at, created_at FROM security_source_cases`;

function caseNumber(id: string, now: number): string {
  return `SUT-${new Date(now).toISOString().slice(0, 10).replaceAll("-", "")}-${id.slice(-8).toUpperCase()}`;
}

export class RuntimeEventCaseRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async list(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly clusterId: string;
  }): Promise<readonly RuntimeEventCase[]> {
    if (
      !IDENTIFIER.test(input.orgId) || !IDENTIFIER.test(input.customerId) ||
      !CONNECTION_ID.test(input.connectionId) || !CLUSTER_ID.test(input.clusterId)
    ) throw new RuntimeEventCaseRepositoryError("INVALID_INPUT");
    const rows = await (await this.ready()).prepare(
      `${SELECT} WHERE org_id = ? AND customer_id = ? AND connection_id = ?
         AND cluster_id = ? AND source_type = 'falco_runtime_event'
       ORDER BY created_at DESC, id DESC LIMIT 200`,
    ).bind(
      input.orgId, input.customerId, input.connectionId, input.clusterId,
    ).all<RuntimeCaseRow>();
    return (rows.results ?? []).map(fromRow);
  }

  public async create(input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly clusterId: string;
    readonly eventId: string;
    readonly evidenceSha256: string;
    readonly priority: CasePriority;
    readonly actorUserId: string;
    readonly now?: number;
  }): Promise<RuntimeEventCase> {
    assertInput(input);
    const db = await this.ready();
    const existing = await db.prepare(
      `SELECT id FROM security_source_cases
        WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND cluster_id = ?
          AND source_type = 'falco_runtime_event' AND source_id = ? AND status != 'closed'
        LIMIT 1`,
    ).bind(
      input.orgId, input.customerId, input.connectionId, input.clusterId, input.eventId,
    ).first<{ id: string }>();
    if (existing !== null) throw new RuntimeEventCaseRepositoryError("CONFLICT");

    const event = await db.prepare(
      `SELECT e.rule_name, e.priority, e.evidence_sha256
         FROM falco_runtime_events e
         JOIN kubernetes_clusters k
           ON k.id = e.cluster_id AND k.org_id = e.org_id AND k.customer_id = e.customer_id
         JOIN aws_connections a
           ON a.id = ? AND a.org_id = e.org_id AND a.customer_id = e.customer_id
          AND substr(k.cluster_uid, 1, 12) = a.aws_account_id
          AND substr(k.cluster_uid, 13, 1) = ':'
        WHERE e.id = ? AND e.org_id = ? AND e.customer_id = ? AND e.cluster_id = ?
          AND e.evidence_sha256 = ? AND k.status = 'active'
        LIMIT 1`,
    ).bind(
      input.connectionId, input.eventId, input.orgId, input.customerId,
      input.clusterId, input.evidenceSha256,
    ).first<{ rule_name: string; priority: string; evidence_sha256: string }>();
    if (event === null) throw new RuntimeEventCaseRepositoryError("NOT_FOUND");
    const now = input.now ?? Date.now();
    const id = `case_${crypto.randomUUID().replaceAll("-", "")}`;
    const number = caseNumber(id, now);
    const title = `Runtime detection: ${event.rule_name}`.slice(0, 300);
    const dueAt = defaultCaseDueAt(input.priority, now);
    await commitAuditedStatements({
      db,
      statements: [
        db.prepare(
          `INSERT INTO security_source_cases
            (id, case_number, org_id, customer_id, connection_id, cluster_id,
             source_type, source_id, evidence_sha256, title, severity, priority,
             status, due_at, created_by_user_id, created_at, updated_at)
           SELECT ?, ?, e.org_id, e.customer_id, ?, e.cluster_id,
                  'falco_runtime_event', e.id, e.evidence_sha256, ?, e.priority,
                  ?, 'open', ?, ?, ?, ?
             FROM falco_runtime_events e
             JOIN kubernetes_clusters k
               ON k.id = e.cluster_id AND k.org_id = e.org_id AND k.customer_id = e.customer_id
             JOIN aws_connections a
               ON a.id = ? AND a.org_id = e.org_id AND a.customer_id = e.customer_id
              AND substr(k.cluster_uid, 1, 12) = a.aws_account_id
              AND substr(k.cluster_uid, 13, 1) = ':'
             JOIN users u ON u.id = ? AND u.status = 'active'
            WHERE e.id = ? AND e.org_id = ? AND e.customer_id = ? AND e.cluster_id = ?
              AND e.evidence_sha256 = ? AND k.status = 'active'`,
        ).bind(
          id, number, input.connectionId, title, input.priority, dueAt,
          input.actorUserId, now, now, input.connectionId, input.actorUserId,
          input.eventId, input.orgId, input.customerId, input.clusterId,
          input.evidenceSha256,
        ),
      ],
      audit: {
        orgId: input.orgId,
        actorId: input.actorUserId,
        action: "runtime_event.case.create",
        targetType: "security_source_case",
        targetId: id,
        customerId: input.customerId,
        outcome: "allowed",
        requestId: `runtime-event-case:${input.eventId}`,
        metadata: {
          caseNumber: number,
          connectionId: input.connectionId,
          clusterId: input.clusterId,
          sourceType: "falco_runtime_event",
          sourceId: input.eventId,
          evidenceSha256: input.evidenceSha256,
          automaticContainment: "false",
          humanApproved: "true",
        },
      },
      mutationGuard: {
        sql: `SELECT 1 FROM security_source_cases
               WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
                 AND cluster_id = ? AND source_type = 'falco_runtime_event'
                 AND source_id = ? AND evidence_sha256 = ?`,
        values: [
          id, input.orgId, input.customerId, input.connectionId,
          input.clusterId, input.eventId, input.evidenceSha256,
        ],
      },
      persistenceMessage: "The runtime case and audit evidence could not be committed atomically",
    });
    const created = await db.prepare(
      `${SELECT} WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
         AND cluster_id = ? AND source_type = 'falco_runtime_event' LIMIT 1`,
    ).bind(
      id, input.orgId, input.customerId, input.connectionId, input.clusterId,
    ).first<RuntimeCaseRow>();
    if (created === null) throw new RuntimeEventCaseRepositoryError("PERSISTENCE_FAILED");
    return fromRow(created);
  }
}
