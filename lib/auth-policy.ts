export const ORG_ROLES = [
  "org_owner",
  "org_admin",
  "analyst",
  "viewer",
  "customer_admin",
  "customer_viewer",
] as const;

export type OrgRole = (typeof ORG_ROLES)[number];
export type ScopeMode = "all_customers" | "assigned_customers";

export const CUSTOMER_ROLES = [
  "customer_admin",
  "analyst",
  "viewer",
  "customer_viewer",
] as const;

export type CustomerRole = (typeof CUSTOMER_ROLES)[number];

export const CAPABILITIES = [
  "workspace:read",
  "membership:manage",
  "membership:manage:customer",
  "customer:create",
  "connection:read",
  "connection:manage",
  "sync:run",
  "finding:manage",
  "export:read",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The customer-level roles a customer-scoped administrator may ever assign or
 * invite. A customer_admin may never mint an organization role, so this list is
 * the single source of truth used by both the invitation and the customer
 * assignment repositories when the actor only holds `membership:manage:customer`.
 */
export const CUSTOMER_MANAGEABLE_ROLES = ["customer_admin", "customer_viewer"] as const;
export type CustomerManageableRole = (typeof CUSTOMER_MANAGEABLE_ROLES)[number];

const CUSTOMER_MANAGEABLE_ROLE_SET: ReadonlySet<string> = new Set(CUSTOMER_MANAGEABLE_ROLES);

export function isCustomerManageableRole(role: string): role is CustomerManageableRole {
  return CUSTOMER_MANAGEABLE_ROLE_SET.has(role);
}

export interface CustomerGrant {
  readonly customerId: string;
  readonly role: CustomerRole;
}

export interface AuthorizationSubject {
  readonly userId: string;
  readonly orgId: string;
  readonly membershipId: string;
  readonly role: OrgRole;
  readonly scopeMode: ScopeMode;
  readonly grants: readonly CustomerGrant[];
}

export interface AuthorizationRequest {
  readonly orgId: string;
  readonly capability: Capability;
  readonly customerId?: string;
}

export type AuthorizationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "CROSS_ORG" | "CUSTOMER_SCOPE" | "ROLE" };

const ROLE_CAPABILITIES: Readonly<Record<OrgRole, ReadonlySet<Capability>>> = {
  org_owner: new Set(CAPABILITIES),
  org_admin: new Set(CAPABILITIES),
  analyst: new Set([
    "workspace:read",
    "connection:read",
    "sync:run",
    "finding:manage",
    "export:read",
  ]),
  viewer: new Set(["workspace:read", "connection:read", "export:read"]),
  customer_admin: new Set([
    "workspace:read",
    "membership:manage:customer",
    "connection:read",
    "connection:manage",
    "sync:run",
    "finding:manage",
    "export:read",
  ]),
  customer_viewer: new Set(["workspace:read", "connection:read", "export:read"]),
};

const CUSTOMER_ROLE_CAPABILITIES: Readonly<Record<CustomerRole, ReadonlySet<Capability>>> = {
  customer_admin: new Set([
    "workspace:read",
    "connection:read",
    "connection:manage",
    "sync:run",
    "finding:manage",
    "export:read",
  ]),
  analyst: new Set([
    "workspace:read",
    "connection:read",
    "sync:run",
    "finding:manage",
    "export:read",
  ]),
  viewer: new Set(["workspace:read", "connection:read", "export:read"]),
  customer_viewer: new Set(["workspace:read", "connection:read", "export:read"]),
};

/**
 * Central, side-effect-free authorization policy.
 *
 * Customer-scoped access is an intersection: the organization role and the
 * explicit customer grant must both allow the operation. This prevents a broad
 * grant from upgrading a read-only membership (and vice versa).
 */
export function authorize(subject: AuthorizationSubject, request: AuthorizationRequest): AuthorizationDecision {
  if (subject.orgId !== request.orgId) {
    return { allowed: false, reason: "CROSS_ORG" };
  }
  if (!ROLE_CAPABILITIES[subject.role].has(request.capability)) {
    return { allowed: false, reason: "ROLE" };
  }
  if (request.customerId === undefined) {
    return { allowed: true };
  }
  if (subject.scopeMode === "all_customers") {
    return { allowed: true };
  }
  const grant = subject.grants.find((candidate) => candidate.customerId === request.customerId);
  if (grant === undefined) {
    return { allowed: false, reason: "CUSTOMER_SCOPE" };
  }
  return CUSTOMER_ROLE_CAPABILITIES[grant.role].has(request.capability)
    ? { allowed: true }
    : { allowed: false, reason: "ROLE" };
}

/**
 * True when the subject holds the organization-owner role. Pure predicate over
 * the already-resolved authorization subject; it derives nothing from the
 * request and crosses no organization boundary.
 */
export function isOrganizationOwner(subject: AuthorizationSubject): boolean {
  return subject.role === "org_owner";
}

/**
 * The single gate for the recovery-administration workstream. Recovery is
 * deliberately owner-only: an actor may administer recovery ONLY when it both
 * carries org-wide `membership:manage` AND is an organization owner. org_admin
 * carries `membership:manage` but is intentionally excluded, so the second
 * conjunct is load-bearing, not redundant. This never mints a session and never
 * bypasses MFA — it only authorizes credential resets / owner (re)provisioning.
 */
export function canAdministerRecovery(subject: AuthorizationSubject): boolean {
  return ROLE_CAPABILITIES[subject.role].has("membership:manage") && subject.role === "org_owner";
}

export function effectiveCapabilities(subject: AuthorizationSubject): readonly Capability[] {
  return CAPABILITIES.filter((capability) => ROLE_CAPABILITIES[subject.role].has(capability));
}

/**
 * The customers a subject is entitled to administer. This is *only* the set of
 * customers where the subject explicitly holds the `customer_admin` role in
 * `customer_access` — never inferred from an organization role or from a broad
 * `all_customers` scope. An empty set means the subject can manage nobody, and
 * every customer-scoped write must fail closed.
 */
export function administeredCustomerIds(subject: AuthorizationSubject): readonly string[] {
  return subject.grants
    .filter((grant) => grant.role === "customer_admin")
    .map((grant) => grant.customerId);
}

/**
 * Resolves how far a subject may manage organization membership.
 *
 * - `org` — the subject holds org-wide `membership:manage` (org_owner/org_admin)
 *   and may manage every membership and customer exactly as before.
 * - `customer` — the subject only holds `membership:manage:customer`
 *   (customer_admin) and may act solely within its administered-customer set,
 *   granting only customer-level roles.
 * - `null` — the subject cannot manage membership at all.
 *
 * Org-wide capability always wins so operators never lose reach.
 */
export type MembershipManagementScope =
  | { readonly mode: "org" }
  | { readonly mode: "customer"; readonly customerIds: readonly string[] };

export function resolveMembershipManagementScope(
  subject: AuthorizationSubject,
): MembershipManagementScope | null {
  const capabilities = ROLE_CAPABILITIES[subject.role];
  if (capabilities.has("membership:manage")) return { mode: "org" };
  if (capabilities.has("membership:manage:customer")) {
    return { mode: "customer", customerIds: administeredCustomerIds(subject) };
  }
  return null;
}
