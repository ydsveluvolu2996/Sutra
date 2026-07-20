// Public marketing-site contact leads. This is a PUBLIC, unauthenticated write
// path, so everything here is deliberately strict: bounded string caps, a
// format-checked email, a silent honeypot drop, and a durable per-source +
// global rate window. Submissions are standalone public leads — there is NO
// org_id and NO foreign key to tenant-gated customer tables.

import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

// Length caps. Kept generous enough for a real message but bounded so a single
// submission can never be used to store an unbounded blob.
export const CONTACT_NAME_MAX = 200;
export const CONTACT_EMAIL_MAX = 320;
export const CONTACT_COMPANY_MAX = 200;
export const CONTACT_MESSAGE_MAX = 2000;

// A pragmatic single-line email check: one "@", a dotted domain, no spaces or
// control characters. Full RFC 5322 is intentionally not attempted.
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/u;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const SOURCE_IP = /^[A-Za-z0-9.:_-]{1,64}$/u;
const SUBMISSION_ID = /^contact_[a-f0-9]{32}$/u;

export interface ContactSubmissionValue {
  readonly name: string;
  readonly email: string;
  readonly company: string | null;
  readonly message: string;
}

export type ContactSubmissionParse =
  | { readonly ok: true; readonly drop: false; readonly value: ContactSubmissionValue }
  // Honeypot was filled: a bot, almost certainly. We drop it silently and the
  // route still answers 200 so the bot learns nothing.
  | { readonly ok: true; readonly drop: true }
  | { readonly ok: false };

export class ContactSubmissionRepositoryError extends Error {
  public readonly code: "INVALID_INPUT";

  public constructor(code: ContactSubmissionRepositoryError["code"] = "INVALID_INPUT") {
    super("Contact submission rejected");
    this.name = "ContactSubmissionRepositoryError";
    this.code = code;
  }
}

function boundedString(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max || CONTROL_CHARS.test(trimmed)) return null;
  return trimmed;
}

/**
 * Pure, side-effect-free validation. Exported so it can be unit-tested on its
 * own. Accepts only the known keys; the `website` field is the honeypot.
 */
export function parseContactSubmission(raw: unknown): ContactSubmissionParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false };
  const record = raw as Record<string, unknown>;
  const allowed = new Set(["name", "email", "company", "message", "website"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return { ok: false };

  // Honeypot: a real user never sees or fills `website`. If it carries any
  // non-empty string we accept-and-drop rather than error, so the bot cannot
  // distinguish a drop from a success.
  if (typeof record.website === "string" && record.website.trim().length > 0) {
    return { ok: true, drop: true };
  }
  if (record.website !== undefined && typeof record.website !== "string") return { ok: false };

  const name = boundedString(record.name, 1, CONTACT_NAME_MAX);
  const email = boundedString(record.email, 5, CONTACT_EMAIL_MAX);
  const message = boundedString(record.message, 1, CONTACT_MESSAGE_MAX);
  if (name === null || email === null || message === null || !EMAIL.test(email)) return { ok: false };

  let company: string | null = null;
  if (record.company !== undefined && record.company !== null && record.company !== "") {
    company = boundedString(record.company, 1, CONTACT_COMPANY_MAX);
    if (company === null) return { ok: false };
  }

  return { ok: true, drop: false, value: { name, email, company, message } };
}

export interface RecordedSubmission extends ContactSubmissionValue {
  readonly sourceIp: string;
  readonly recipient: string;
  readonly delivered: boolean;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class ContactSubmissionRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  /** Count submissions from one source IP at or after `sinceMs` (rate window). */
  public async countRecentForSource(sourceIp: string, sinceMs: number): Promise<number> {
    if (!SOURCE_IP.test(sourceIp) || !Number.isSafeInteger(sinceMs)) throw new ContactSubmissionRepositoryError();
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT COUNT(*) AS total FROM contact_submissions WHERE source_ip = ? AND created_at >= ?`,
    ).bind(sourceIp, sinceMs).first<{ total: number }>();
    return Number(row?.total ?? 0);
  }

  /** Count all submissions at or after `sinceMs` (global abuse ceiling). */
  public async countRecentGlobal(sinceMs: number): Promise<number> {
    if (!Number.isSafeInteger(sinceMs)) throw new ContactSubmissionRepositoryError();
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT COUNT(*) AS total FROM contact_submissions WHERE created_at >= ?`,
    ).bind(sinceMs).first<{ total: number }>();
    return Number(row?.total ?? 0);
  }

  /** Durably persist an accepted submission. Returns the generated id. */
  public async record(submission: RecordedSubmission, now = Date.now()): Promise<string> {
    if (
      boundedString(submission.name, 1, CONTACT_NAME_MAX) === null ||
      boundedString(submission.email, 5, CONTACT_EMAIL_MAX) === null ||
      !EMAIL.test(submission.email) ||
      boundedString(submission.message, 1, CONTACT_MESSAGE_MAX) === null ||
      (submission.company !== null && boundedString(submission.company, 1, CONTACT_COMPANY_MAX) === null) ||
      !SOURCE_IP.test(submission.sourceIp) ||
      submission.recipient.length === 0 ||
      submission.recipient.length > CONTACT_EMAIL_MAX
    ) {
      throw new ContactSubmissionRepositoryError();
    }
    const db = await this.ready();
    const id = `contact_${randomHex(16)}`;
    await db.prepare(
      `INSERT INTO contact_submissions (id, name, email, company, message, source_ip, recipient, delivered, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      submission.name,
      submission.email,
      submission.company,
      submission.message,
      submission.sourceIp,
      submission.recipient,
      submission.delivered ? 1 : 0,
      now,
    ).run();
    return id;
  }

  /**
   * Flip the delivered flag on a previously reserved row. The route persists the
   * lead first (delivered = 0) so the rate-limit counters include in-flight
   * submissions, then calls this once the outbound transport confirms delivery.
   */
  public async markDelivered(id: string, delivered = true): Promise<void> {
    if (!SUBMISSION_ID.test(id)) throw new ContactSubmissionRepositoryError();
    const db = await this.ready();
    await db.prepare(
      `UPDATE contact_submissions SET delivered = ? WHERE id = ?`,
    ).bind(delivered ? 1 : 0, id).run();
  }
}
