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
  "customer:create",
  "connection:read",
  "connection:manage",
  "sync:run",
  "finding:manage",
  "export:read",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

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

export function effectiveCapabilities(subject: AuthorizationSubject): readonly Capability[] {
  return CAPABILITIES.filter((capability) => ROLE_CAPABILITIES[subject.role].has(capability));
}
