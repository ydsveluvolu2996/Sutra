import type { AuthenticatedLocalSession } from "../db/auth-repository";
import { browserSessionIsActive } from "./browser-session-lifecycle.ts";

export interface SessionAdministrationRecord {
  readonly id: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string;
  };
  readonly identitySource: "local_password" | "hosted_oidc";
  readonly identitySourceLabel: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly mfaVerifiedAt: string | null;
  readonly current: boolean;
  readonly status: "active" | "expired" | "revoked";
  /**
   * Browser fingerprinting is intentionally not performed. A row represents
   * one server-side browser session, not a claim that Sutra uniquely identified
   * a physical device.
   */
  readonly deviceLabel: "Browser session";
}

export function canAdministerSession(
  actor: AuthenticatedLocalSession,
  targetUserId: string,
): boolean {
  return targetUserId === actor.subject.userId ||
    actor.subject.role === "org_owner" ||
    actor.subject.role === "org_admin";
}

export function canViewOrganizationSessions(actor: AuthenticatedLocalSession): boolean {
  return actor.subject.role === "org_owner" || actor.subject.role === "org_admin";
}

export function sessionStatus(
  expiresAt: number,
  lastSeenAt: number,
  revokedAt: number | null,
  now: number,
): SessionAdministrationRecord["status"] {
  if (revokedAt !== null) return "revoked";
  return browserSessionIsActive({
    absoluteExpiresAt: expiresAt,
    lastSeenAt,
    revokedAt,
  }, now) ? "active" : "expired";
}
