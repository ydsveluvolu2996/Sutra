export const CASE_STATUSES = ["open", "investigating", "resolved", "closed"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];

export type CaseSlaState = "on_track" | "due_soon" | "overdue" | "met" | "missed";

export interface CaseAssignee {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: string;
}

export interface CaseActivity {
  readonly id: string;
  readonly caseId: string;
  readonly kind: "created" | "status_changed" | "assignment_changed" | "priority_changed" | "due_date_changed" | "note_added";
  readonly actorId: string;
  readonly actorName: string;
  readonly occurredAt: string;
  readonly detail: Readonly<Record<string, string | null>>;
  readonly previousHash: string | null;
  readonly eventHash: string;
}

export interface FindingCase {
  readonly id: string;
  readonly caseNumber: string;
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly findingFingerprint: string;
  readonly findingSnapshotId: string;
  readonly findingSeverity: string;
  readonly title: string;
  readonly status: CaseStatus;
  readonly priority: CasePriority;
  readonly assignee: CaseAssignee | null;
  readonly dueAt: string;
  readonly resolvedAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly slaState: CaseSlaState;
  readonly activities: readonly CaseActivity[];
}

const SLA_HOURS: Readonly<Record<CasePriority, number>> = {
  critical: 4,
  high: 24,
  medium: 72,
  low: 168,
};

const ALLOWED_TRANSITIONS: Readonly<Record<CaseStatus, ReadonlySet<CaseStatus>>> = {
  open: new Set(["investigating", "resolved", "closed"]),
  investigating: new Set(["open", "resolved", "closed"]),
  resolved: new Set(["open", "closed"]),
  closed: new Set(["open"]),
};

export function defaultCaseDueAt(priority: CasePriority, createdAt: number): number {
  return createdAt + SLA_HOURS[priority] * 60 * 60 * 1_000;
}

export function caseSlaState(input: {
  readonly dueAt: number;
  readonly status: CaseStatus;
  readonly resolvedAt: number | null;
  readonly closedAt: number | null;
  readonly now: number;
}): CaseSlaState {
  const completion = input.resolvedAt ?? input.closedAt;
  if (input.status === "resolved" || input.status === "closed") {
    return completion !== null && completion <= input.dueAt ? "met" : "missed";
  }
  if (input.now > input.dueAt) return "overdue";
  return input.dueAt - input.now <= 24 * 60 * 60 * 1_000 ? "due_soon" : "on_track";
}

export function assertCaseTransition(from: CaseStatus, to: CaseStatus): void {
  if (from === to || !ALLOWED_TRANSITIONS[from].has(to)) {
    throw Object.assign(new Error(`A case cannot move from ${from} to ${to}`), { code: "INVALID_STATE" });
  }
}

export function assertCaseOperationalMutationAllowed(status: CaseStatus): void {
  if (status === "resolved" || status === "closed") {
    throw Object.assign(
      new Error("Reopen the case before changing its assignment, priority, or due date"),
      { code: "INVALID_STATE" },
    );
  }
}

export function parseCasePriority(value: unknown): CasePriority {
  if (!CASE_PRIORITIES.includes(value as CasePriority)) {
    throw Object.assign(new Error("The case priority is invalid"), { code: "INVALID_INPUT" });
  }
  return value as CasePriority;
}

export function parseCaseStatus(value: unknown): CaseStatus {
  if (!CASE_STATUSES.includes(value as CaseStatus)) {
    throw Object.assign(new Error("The case status is invalid"), { code: "INVALID_INPUT" });
  }
  return value as CaseStatus;
}

export function parseCaseNote(value: unknown): string {
  if (typeof value !== "string") {
    throw Object.assign(new Error("The case note is invalid"), { code: "INVALID_INPUT" });
  }
  const note = value.trim();
  if (note.length < 1 || note.length > 2_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(note)) {
    throw Object.assign(new Error("Case notes must contain 1–2,000 safe characters"), { code: "INVALID_INPUT" });
  }
  return note;
}

export function parseCaseDueAt(value: unknown, now: number, allowPast = false): number {
  if (typeof value !== "string" || value.length > 40) {
    throw Object.assign(new Error("The case due date is invalid"), { code: "INVALID_INPUT" });
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value || (!allowPast && parsed <= now) || parsed > now + 366 * 24 * 60 * 60 * 1_000) {
    throw Object.assign(new Error("The case due date must be a valid future timestamp within one year"), { code: "INVALID_INPUT" });
  }
  return parsed;
}
