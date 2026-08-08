/**
 * Guided-onboarding progress for one organization.
 *
 * The reference flow is three steps -- choose your goals, share the name,
 * connect your infrastructure. Only the first two are stored, because only
 * they are records of a choice. The third is derived on every read from
 * whether a real (non-fixture) AWS connection exists, so the strip can neither
 * claim a connection that was deleted nor miss one that exists.
 *
 * Goals are a lens over the product (which cards Home leads with), never a
 * permission: nothing in the authorization subject derives from them.
 */
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import type { AuthorizationSubject } from "../lib/auth-policy";

export const ONBOARDING_GOALS = Object.freeze([
  "cmdb",
  "finops",
  "vulnerabilities",
] as const);

export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number];

export interface OnboardingProgress {
  readonly goals: readonly OnboardingGoal[];
  readonly steps: {
    readonly goals: boolean;
    readonly name: boolean;
    readonly connect: boolean;
  };
  /** All three steps done. Purely derived; nothing stores "complete". */
  readonly completed: boolean;
}

export class OnboardingError extends Error {
  public readonly status: number;
  public constructor(status: number, message: string) {
    super(message);
    this.name = "OnboardingError";
    this.status = status;
  }
}

// Printable, no markup delimiters, no control characters -- the same shape
// the self-serve org-name derivation enforces.
const WORKSPACE_NAME = /^[^<>\u0000-\u001f\u007f]{2,100}$/u;

function parseGoals(json: string): readonly OnboardingGoal[] {
  try {
    const raw: unknown = JSON.parse(json);
    if (!Array.isArray(raw)) return [];
    // Unknown ids are dropped rather than surfaced: a goal id removed in a
    // later release must not wedge the strip for an org that once chose it.
    return raw.filter((goal): goal is OnboardingGoal =>
      (ONBOARDING_GOALS as readonly string[]).includes(goal as string));
  } catch {
    return [];
  }
}

function validatedGoals(goals: readonly string[]): readonly OnboardingGoal[] {
  if (!Array.isArray(goals) || goals.length === 0 || goals.length > ONBOARDING_GOALS.length) {
    throw new OnboardingError(400, "Choose at least one goal");
  }
  const unique = [...new Set(goals)];
  if (unique.length !== goals.length) throw new OnboardingError(400, "Goals must be unique");
  for (const goal of unique) {
    if (!(ONBOARDING_GOALS as readonly string[]).includes(goal)) {
      throw new OnboardingError(400, "Unknown goal");
    }
  }
  // Stored in canonical catalog order so the same choice always serializes
  // identically regardless of click order.
  return ONBOARDING_GOALS.filter((goal) => unique.includes(goal));
}

async function connectExists(db: D1Database, orgId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS present FROM aws_connections
      WHERE org_id = ? AND source_kind IN ('aws_trust_role', 'aws_static_credentials')
      LIMIT 1`,
  ).bind(orgId).first<{ present: number }>();
  return row !== null;
}

export async function getOnboardingProgress(
  subject: AuthorizationSubject,
): Promise<OnboardingProgress> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  const row = await db.prepare(
    `SELECT goals_json, name_shared_at FROM organization_onboarding WHERE org_id = ?`,
  ).bind(subject.orgId).first<{ goals_json: string; name_shared_at: number | null }>();
  const goals = row === null ? [] : parseGoals(row.goals_json);
  const connect = await connectExists(db, subject.orgId);
  const steps = {
    goals: goals.length > 0,
    name: row !== null && row.name_shared_at !== null,
    connect,
  };
  return { goals, steps, completed: steps.goals && steps.name && steps.connect };
}

export async function chooseOnboardingGoals(
  subject: AuthorizationSubject,
  goals: readonly string[],
  now = Date.now(),
): Promise<OnboardingProgress> {
  const chosen = validatedGoals(goals);
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  await db.prepare(
    `INSERT INTO organization_onboarding (org_id, goals_json, name_shared_at, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT (org_id) DO UPDATE SET goals_json = excluded.goals_json, updated_at = excluded.updated_at`,
  ).bind(subject.orgId, JSON.stringify(chosen), now, now).run();
  return getOnboardingProgress(subject);
}

export async function shareWorkspaceName(
  subject: AuthorizationSubject,
  name: string,
  now = Date.now(),
): Promise<OnboardingProgress> {
  const trimmed = typeof name === "string" ? name.trim().replace(/\s+/gu, " ") : "";
  if (!WORKSPACE_NAME.test(trimmed)) {
    throw new OnboardingError(400, "Enter a workspace name between 2 and 100 characters");
  }
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  // Rename and stamp in one atomic batch: the strip marks this step done only
  // when the organization row actually carries the operator's chosen name. A
  // missing org surfaces as the stamp's FK violation, which rolls back the
  // whole batch -- mapped here rather than leaked as a driver error.
  let results: D1Result[];
  try {
    results = await db.batch([
      db.prepare(`UPDATE organizations SET name = ? WHERE id = ?`).bind(trimmed, subject.orgId),
      db.prepare(
        `INSERT INTO organization_onboarding (org_id, goals_json, name_shared_at, created_at, updated_at)
         VALUES (?, '[]', ?, ?, ?)
         ON CONFLICT (org_id) DO UPDATE SET name_shared_at = excluded.name_shared_at, updated_at = excluded.updated_at`,
      ).bind(subject.orgId, now, now, now),
    ]);
  } catch {
    throw new OnboardingError(404, "The organization could not be renamed");
  }
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    throw new OnboardingError(404, "The organization could not be renamed");
  }
  return getOnboardingProgress(subject);
}
