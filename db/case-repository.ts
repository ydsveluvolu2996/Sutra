import { canonicalJson } from "../lib/canonical-json";
import {
  assertCaseTransition,
  assertCaseOperationalMutationAllowed,
  caseSlaState,
  defaultCaseDueAt,
  type CaseActivity,
  type CaseAssignee,
  type CasePriority,
  type CaseStatus,
  type FindingCase,
} from "../lib/case-management";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import { commitAuditedStatements } from "./pilot-repository";

const CASE_ID = /^case_[a-f0-9]{32}$/u;
const FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._:@/#+=-]{0,127}$/u;
const MANAGING_ROLES = new Set(["org_owner", "org_admin", "analyst", "customer_admin"]);
const ACTIVITY_KINDS = new Set<CaseActivity["kind"]>([
  "created", "status_changed", "assignment_changed", "priority_changed", "due_date_changed", "note_added",
]);

interface CaseRow {
  id: string;
  case_number: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  finding_fingerprint: string;
  finding_snapshot_id: string;
  finding_severity: string;
  title: string;
  status: CaseStatus;
  priority: CasePriority;
  assignee_membership_id: string | null;
  assignee_user_id: string | null;
  assignee_name: string | null;
  assignee_email: string | null;
  assignee_role: string | null;
  due_at: number;
  resolved_at: number | null;
  closed_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ActivityRow {
  id: string;
  case_id: string;
  kind: CaseActivity["kind"];
  actor_user_id: string;
  actor_name: string;
  occurred_at: number;
  detail_json: string;
  previous_event_hash: string | null;
  event_hash: string;
}

interface FindingRow {
  snapshot_id: string;
  fingerprint: string;
  title: string;
  severity: string;
}

export class CaseRepositoryError extends Error {
  public readonly code: "NOT_FOUND" | "CONFLICT" | "INVALID_STATE" | "PERSISTENCE_FAILED";

  public constructor(code: CaseRepositoryError["code"], message: string) {
    super(message);
    this.name = "CaseRepositoryError";
    this.code = code;
  }
}

async function readyDatabase(): Promise<D1Database> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  return db;
}

export async function listCaseAssignees(input: {
  readonly orgId: string;
  readonly customerId: string;
}): Promise<readonly CaseAssignee[]> {
  const db = await readyDatabase();
  const rows = await db.prepare(
    `SELECT m.id AS membership_id, m.user_id, COALESCE(u.display_name, u.email) AS display_name,
            u.email, m.role
       FROM memberships m
       JOIN users u ON u.id = m.user_id AND u.status = 'active'
      WHERE m.org_id = ? AND m.status = 'active'
        AND m.role IN ('org_owner', 'org_admin', 'analyst', 'customer_admin')
        AND (
          m.scope_mode = 'all_customers'
          OR EXISTS (
            SELECT 1 FROM customer_access ca
             WHERE ca.org_id = m.org_id AND ca.membership_id = m.id AND ca.customer_id = ?
               AND ca.role IN ('customer_admin', 'analyst')
          )
        )
      ORDER BY COALESCE(u.display_name, u.email), m.id`,
  ).bind(input.orgId, input.customerId).all<{
    membership_id: string; user_id: string; display_name: string; email: string; role: string;
  }>();
  return (rows.results ?? []).map((row) => ({
    membershipId: row.membership_id,
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
  }));
}

export async function listFindingCases(input: {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly now?: number;
}): Promise<readonly FindingCase[]> {
  const db = await readyDatabase();
  const rows = await db.prepare(caseSelectSql(
    `WHERE c.org_id = ? AND c.customer_id = ? AND c.connection_id = ?
     ORDER BY CASE c.status WHEN 'open' THEN 0 WHEN 'investigating' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END,
              c.updated_at DESC, c.id DESC LIMIT 200`,
  )).bind(input.orgId, input.customerId, input.connectionId).all<CaseRow>();
  const cases = rows.results ?? [];
  if (cases.length === 0) return [];
  const activities = await db.prepare(
    `SELECT a.id, a.case_id, a.kind, a.actor_user_id,
            COALESCE(u.display_name, u.email) AS actor_name, a.occurred_at,
            a.detail_json, a.previous_event_hash, a.event_hash
       FROM finding_case_activities a
       JOIN users u ON u.id = a.actor_user_id
      WHERE a.org_id = ? AND a.customer_id = ? AND a.connection_id = ?
      ORDER BY a.occurred_at ASC, a.id ASC LIMIT 2000`,
  ).bind(input.orgId, input.customerId, input.connectionId).all<ActivityRow>();
  const byCase = new Map<string, CaseActivity[]>();
  for (const row of activities.results ?? []) {
    const parsed = activityFromRow(row);
    const current = byCase.get(parsed.caseId) ?? [];
    current.push(parsed);
    byCase.set(parsed.caseId, current);
  }
  const now = input.now ?? Date.now();
  return cases.map((row) => caseFromRow(row, byCase.get(row.id) ?? [], now));
}

export async function createFindingCase(input: {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly fingerprint: string;
  readonly priority: CasePriority;
  readonly assigneeMembershipId: string | null;
  readonly dueAt: number | null;
  readonly actorUserId: string;
  readonly now?: number;
}): Promise<FindingCase> {
  if (!FINGERPRINT.test(input.fingerprint)) throw new CaseRepositoryError("INVALID_STATE", "The finding fingerprint is invalid");
  const db = await readyDatabase();
  const finding = await currentFinding(db, input);
  if (finding === null) throw new CaseRepositoryError("NOT_FOUND", "The current finding was not found");
  if (input.assigneeMembershipId !== null) await assertAssignable(db, input.orgId, input.customerId, input.assigneeMembershipId);
  const existing = await db.prepare(
    `SELECT id FROM finding_cases WHERE org_id = ? AND customer_id = ? AND connection_id = ?
      AND finding_fingerprint = ? AND status != 'closed' LIMIT 1`,
  ).bind(input.orgId, input.customerId, input.connectionId, input.fingerprint).first<{ id: string }>();
  if (existing !== null) throw new CaseRepositoryError("CONFLICT", "This finding already has an active case");

  const now = input.now ?? Date.now();
  const dueAt = input.dueAt ?? defaultCaseDueAt(input.priority, now);
  const id = `case_${crypto.randomUUID().replaceAll("-", "")}`;
  const caseNumber = caseNumberFrom(id, now);
  const detail = {
    fingerprint: finding.fingerprint,
    priority: input.priority,
    assigneeMembershipId: input.assigneeMembershipId,
    dueAt: new Date(dueAt).toISOString(),
    sourceSnapshotId: finding.snapshot_id,
  };
  const activity = await activityInsert({
    caseId: id,
    orgId: input.orgId,
    customerId: input.customerId,
    connectionId: input.connectionId,
    kind: "created",
    actorUserId: input.actorUserId,
    occurredAt: now,
    detail,
    previousHash: null,
  });
  await commitAuditedStatements({
    db,
    statements: [
      db.prepare(
        `INSERT INTO finding_cases
          (id, case_number, org_id, customer_id, connection_id, finding_fingerprint,
           finding_snapshot_id, finding_severity, title, status, priority,
           assignee_membership_id, due_at, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id, caseNumber, input.orgId, input.customerId, input.connectionId,
        finding.fingerprint, finding.snapshot_id, finding.severity, finding.title,
        input.priority, input.assigneeMembershipId, dueAt, input.actorUserId, now, now,
      ),
      db.prepare(
        `INSERT INTO finding_case_activities
          (id, case_id, org_id, customer_id, connection_id, kind, actor_user_id,
           occurred_at, detail_json, previous_event_hash, event_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(...activity),
    ],
    audit: {
      actorId: input.actorUserId,
      action: "finding.case.create",
      targetType: "finding_case",
      targetId: id,
      customerId: input.customerId,
      outcome: "allowed",
      requestId: `finding.case.activity:${activity[0]}`,
      metadata: { caseNumber, connectionId: input.connectionId, activityId: activity[0], activityHash: activity[10] },
    },
    mutationGuard: {
      sql: `SELECT 1
              FROM finding_cases c
              JOIN finding_case_activities a ON a.case_id = c.id
             WHERE c.id = ? AND c.org_id = ? AND c.customer_id = ? AND c.connection_id = ?
               AND a.id = ? AND a.event_hash = ?`,
      values: [id, input.orgId, input.customerId, input.connectionId, activity[0], activity[10]],
    },
    persistenceMessage: "The case and its audit evidence could not be committed atomically",
  });
  return requireFindingCase(db, input.orgId, input.customerId, input.connectionId, id, now);
}

export async function addCaseNote(input: CaseMutationScope & {
  readonly note: string;
}): Promise<FindingCase> {
  return mutateCase(input, "note_added", { note: input.note }, null);
}

export async function transitionFindingCase(input: CaseMutationScope & {
  readonly status: CaseStatus;
}): Promise<FindingCase> {
  const db = await readyDatabase();
  const current = await requireFindingCaseRow(db, input);
  assertCaseTransition(current.status, input.status);
  const now = input.now ?? Date.now();
  return mutateCaseWithDb(
    db,
    input,
    "status_changed",
    { from: current.status, to: input.status },
    {
      sql: `status = ?, resolved_at = ?, closed_at = ?`,
      values: [
        input.status,
        input.status === "resolved" ? now : input.status === "open" ? null : current.resolved_at,
        input.status === "closed" ? now : input.status === "open" ? null : current.closed_at,
      ],
    },
    current,
  );
}

export async function assignFindingCase(input: CaseMutationScope & {
  readonly assigneeMembershipId: string | null;
}): Promise<FindingCase> {
  const db = await readyDatabase();
  if (input.assigneeMembershipId !== null) await assertAssignable(db, input.orgId, input.customerId, input.assigneeMembershipId);
  const current = await requireFindingCaseRow(db, input);
  assertCaseOperationalMutationAllowed(current.status);
  if (current.assignee_membership_id === input.assigneeMembershipId) throw new CaseRepositoryError("INVALID_STATE", "The case already has that assignee");
  return mutateCaseWithDb(db, input, "assignment_changed", {
    from: current.assignee_membership_id,
    to: input.assigneeMembershipId,
  }, { sql: "assignee_membership_id = ?", values: [input.assigneeMembershipId] }, current);
}

export async function prioritizeFindingCase(input: CaseMutationScope & {
  readonly priority: CasePriority;
}): Promise<FindingCase> {
  const db = await readyDatabase();
  const current = await requireFindingCaseRow(db, input);
  assertCaseOperationalMutationAllowed(current.status);
  if (current.priority === input.priority) throw new CaseRepositoryError("INVALID_STATE", "The case already has that priority");
  return mutateCaseWithDb(db, input, "priority_changed", { from: current.priority, to: input.priority }, { sql: "priority = ?", values: [input.priority] }, current);
}

export async function rescheduleFindingCase(input: CaseMutationScope & {
  readonly dueAt: number;
}): Promise<FindingCase> {
  const db = await readyDatabase();
  const current = await requireFindingCaseRow(db, input);
  assertCaseOperationalMutationAllowed(current.status);
  return mutateCaseWithDb(db, input, "due_date_changed", {
    from: new Date(current.due_at).toISOString(),
    to: new Date(input.dueAt).toISOString(),
  }, { sql: "due_at = ?", values: [input.dueAt] }, current);
}

interface CaseMutationScope {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly caseId: string;
  readonly actorUserId: string;
  readonly now?: number;
}

async function mutateCase(
  input: CaseMutationScope,
  kind: CaseActivity["kind"],
  detail: Readonly<Record<string, string | null>>,
  update: { readonly sql: string; readonly values: readonly unknown[] } | null,
): Promise<FindingCase> {
  const db = await readyDatabase();
  const current = await requireFindingCaseRow(db, input);
  return mutateCaseWithDb(db, input, kind, detail, update, current);
}

async function mutateCaseWithDb(
  db: D1Database,
  input: CaseMutationScope,
  kind: CaseActivity["kind"],
  detail: Readonly<Record<string, string | null>>,
  update: { readonly sql: string; readonly values: readonly unknown[] } | null,
  current: CaseRow,
): Promise<FindingCase> {
  const now = input.now ?? Date.now();
  const latest = await db.prepare(
    `SELECT event_hash FROM finding_case_activities
      WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND case_id = ?
      ORDER BY occurred_at DESC, id DESC LIMIT 1`,
  ).bind(input.orgId, input.customerId, input.connectionId, input.caseId).first<{ event_hash: string }>();
  if (latest === null) throw new CaseRepositoryError("PERSISTENCE_FAILED", "The case activity chain is missing");
  const activity = await activityInsert({
    caseId: input.caseId,
    orgId: input.orgId,
    customerId: input.customerId,
    connectionId: input.connectionId,
    kind,
    actorUserId: input.actorUserId,
    occurredAt: now,
    detail,
    previousHash: latest.event_hash,
  });
  const updateSql = update === null ? "updated_at = ?" : `${update.sql}, updated_at = ?`;
  const updateValues = update === null ? [now] : [...update.values, now];
  await commitAuditedStatements({
    db,
    statements: [
      db.prepare(
        `UPDATE finding_cases SET ${updateSql}
          WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ? AND updated_at = ?`,
      ).bind(...updateValues, input.caseId, input.orgId, input.customerId, input.connectionId, current.updated_at),
      db.prepare(
        `INSERT INTO finding_case_activities
          (id, case_id, org_id, customer_id, connection_id, kind, actor_user_id,
           occurred_at, detail_json, previous_event_hash, event_hash)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM finding_cases
             WHERE id = ? AND org_id = ? AND customer_id = ? AND connection_id = ?
               AND updated_at = ?
          )`,
      ).bind(
        ...activity,
        input.caseId, input.orgId, input.customerId, input.connectionId, now,
      ),
    ],
    audit: {
      actorId: input.actorUserId,
      action: `finding.case.${caseOperation(kind)}`,
      targetType: "finding_case",
      targetId: input.caseId,
      customerId: input.customerId,
      outcome: "allowed",
      requestId: `finding.case.activity:${activity[0]}`,
      metadata: { connectionId: input.connectionId, activityId: activity[0], activityHash: activity[10] },
    },
    mutationGuard: {
      sql: `SELECT 1
              FROM finding_cases c
              JOIN finding_case_activities a ON a.case_id = c.id
             WHERE c.id = ? AND c.org_id = ? AND c.customer_id = ? AND c.connection_id = ?
               AND c.updated_at = ? AND a.id = ? AND a.event_hash = ?`,
      values: [input.caseId, input.orgId, input.customerId, input.connectionId, now, activity[0], activity[10]],
    },
    persistenceMessage: "The case changed while its activity and audit evidence were being committed",
  });
  return requireFindingCase(db, input.orgId, input.customerId, input.connectionId, input.caseId, now);
}

function caseOperation(kind: CaseActivity["kind"]): string {
  if (kind === "note_added") return "note";
  if (kind === "status_changed") return "transition";
  if (kind === "assignment_changed") return "assign";
  if (kind === "priority_changed") return "prioritize";
  if (kind === "due_date_changed") return "reschedule";
  return "create";
}

async function currentFinding(
  db: D1Database,
  input: { readonly orgId: string; readonly customerId: string; readonly connectionId: string; readonly fingerprint: string },
): Promise<FindingRow | null> {
  return db.prepare(
    `SELECT f.snapshot_id, f.fingerprint, f.title, f.severity
       FROM connection_heads h
       JOIN cmdb_findings f ON f.snapshot_id = h.snapshot_id AND f.org_id = h.org_id
        AND f.customer_id = h.customer_id AND f.connection_id = h.connection_id
      WHERE h.org_id = ? AND h.customer_id = ? AND h.connection_id = ? AND f.fingerprint = ?
      LIMIT 1`,
  ).bind(input.orgId, input.customerId, input.connectionId, input.fingerprint).first<FindingRow>();
}

async function assertAssignable(db: D1Database, orgId: string, customerId: string, membershipId: string): Promise<void> {
  const row = await db.prepare(
    `SELECT m.role, m.scope_mode,
            CASE
              WHEN m.scope_mode = 'all_customers' THEN 1
              WHEN EXISTS (
                SELECT 1 FROM customer_access ca WHERE ca.org_id = m.org_id
                 AND ca.membership_id = m.id AND ca.customer_id = ?
                 AND ca.role IN ('customer_admin', 'analyst')
              ) THEN 1
              ELSE 0
            END AS customer_allowed
       FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
      WHERE m.id = ? AND m.org_id = ? AND m.status = 'active' LIMIT 1`,
  ).bind(customerId, membershipId, orgId).first<{ role: string; scope_mode: string; customer_allowed: number }>();
  if (row === null || !MANAGING_ROLES.has(row.role) || Number(row.customer_allowed) !== 1) {
    throw new CaseRepositoryError("INVALID_STATE", "The selected assignee is not authorized for this customer");
  }
}

async function requireFindingCaseRow(db: D1Database, input: {
  readonly orgId: string; readonly customerId: string; readonly connectionId: string; readonly caseId: string;
}): Promise<CaseRow> {
  if (!CASE_ID.test(input.caseId)) throw new CaseRepositoryError("NOT_FOUND", "Case not found");
  const row = await db.prepare(caseSelectSql(
    `WHERE c.id = ? AND c.org_id = ? AND c.customer_id = ? AND c.connection_id = ? LIMIT 1`,
  )).bind(input.caseId, input.orgId, input.customerId, input.connectionId).first<CaseRow>();
  if (row === null) throw new CaseRepositoryError("NOT_FOUND", "Case not found");
  return row;
}

async function requireFindingCase(
  db: D1Database, orgId: string, customerId: string, connectionId: string, caseId: string, now: number,
): Promise<FindingCase> {
  const row = await requireFindingCaseRow(db, { orgId, customerId, connectionId, caseId });
  const activities = await db.prepare(
    `SELECT a.id, a.case_id, a.kind, a.actor_user_id,
            COALESCE(u.display_name, u.email) AS actor_name, a.occurred_at,
            a.detail_json, a.previous_event_hash, a.event_hash
       FROM finding_case_activities a JOIN users u ON u.id = a.actor_user_id
      WHERE a.org_id = ? AND a.customer_id = ? AND a.connection_id = ? AND a.case_id = ?
      ORDER BY a.occurred_at ASC, a.id ASC`,
  ).bind(orgId, customerId, connectionId, caseId).all<ActivityRow>();
  return caseFromRow(row, (activities.results ?? []).map(activityFromRow), now);
}

function caseSelectSql(where: string): string {
  return `SELECT c.id, c.case_number, c.org_id, c.customer_id, c.connection_id,
                 c.finding_fingerprint, c.finding_snapshot_id, c.finding_severity,
                 c.title, c.status, c.priority, c.assignee_membership_id,
                 am.user_id AS assignee_user_id, COALESCE(au.display_name, au.email) AS assignee_name,
                 au.email AS assignee_email, am.role AS assignee_role,
                 c.due_at, c.resolved_at, c.closed_at, c.created_at, c.updated_at
            FROM finding_cases c
       LEFT JOIN memberships am ON am.id = c.assignee_membership_id AND am.org_id = c.org_id
       LEFT JOIN users au ON au.id = am.user_id ${where}`;
}

function caseFromRow(row: CaseRow, activities: readonly CaseActivity[], now: number): FindingCase {
  return {
    id: row.id,
    caseNumber: row.case_number,
    orgId: row.org_id,
    customerId: row.customer_id,
    connectionId: row.connection_id,
    findingFingerprint: row.finding_fingerprint,
    findingSnapshotId: row.finding_snapshot_id,
    findingSeverity: row.finding_severity,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assignee: row.assignee_membership_id === null || row.assignee_user_id === null || row.assignee_email === null || row.assignee_role === null
      ? null
      : {
          membershipId: row.assignee_membership_id,
          userId: row.assignee_user_id,
          displayName: row.assignee_name ?? row.assignee_email,
          email: row.assignee_email,
          role: row.assignee_role,
        },
    dueAt: new Date(Number(row.due_at)).toISOString(),
    resolvedAt: row.resolved_at === null ? null : new Date(Number(row.resolved_at)).toISOString(),
    closedAt: row.closed_at === null ? null : new Date(Number(row.closed_at)).toISOString(),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    slaState: caseSlaState({
      dueAt: Number(row.due_at), status: row.status,
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
      closedAt: row.closed_at === null ? null : Number(row.closed_at), now,
    }),
    activities,
  };
}

function activityFromRow(row: ActivityRow): CaseActivity {
  if (!ACTIVITY_KINDS.has(row.kind)) throw new CaseRepositoryError("PERSISTENCE_FAILED", "A case activity kind is invalid");
  const detail = JSON.parse(row.detail_json) as unknown;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) {
    throw new CaseRepositoryError("PERSISTENCE_FAILED", "A case activity payload is invalid");
  }
  const safe: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
    if (typeof value !== "string" && value !== null) throw new CaseRepositoryError("PERSISTENCE_FAILED", "A case activity payload is invalid");
    safe[key] = value;
  }
  return {
    id: row.id,
    caseId: row.case_id,
    kind: row.kind,
    actorId: row.actor_user_id,
    actorName: row.actor_name,
    occurredAt: new Date(Number(row.occurred_at)).toISOString(),
    detail: safe,
    previousHash: row.previous_event_hash,
    eventHash: row.event_hash,
  };
}

type ActivityInsertValues = readonly [
  string, string, string, string, string, CaseActivity["kind"], string,
  number, string, string | null, string,
];

async function activityInsert(input: {
  readonly caseId: string; readonly orgId: string; readonly customerId: string;
  readonly connectionId: string; readonly kind: CaseActivity["kind"];
  readonly actorUserId: string; readonly occurredAt: number;
  readonly detail: object; readonly previousHash: string | null;
}): Promise<ActivityInsertValues> {
  const detailJson = canonicalJson(input.detail);
  const id = `caseact_${crypto.randomUUID().replaceAll("-", "")}`;
  const eventHash = await sha256Hex(canonicalJson({
    id, caseId: input.caseId, orgId: input.orgId, customerId: input.customerId,
    connectionId: input.connectionId, kind: input.kind, actorUserId: input.actorUserId,
    occurredAt: input.occurredAt, detail: JSON.parse(detailJson), previousHash: input.previousHash,
  }));
  return [
    id, input.caseId, input.orgId, input.customerId, input.connectionId,
    input.kind, input.actorUserId, input.occurredAt, detailJson, input.previousHash, eventHash,
  ];
}

function caseNumberFrom(id: string, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10).replaceAll("-", "");
  return `SUT-${day}-${id.slice(-8).toUpperCase()}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}
