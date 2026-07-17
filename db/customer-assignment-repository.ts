import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import { LocalAuthError, type AuthenticatedLocalSession } from "./auth-repository";
import { commitAuditedStatements } from "./pilot-repository";
import {
  CUSTOMER_ROLES,
  type CustomerRole,
  type OrgRole,
  type ScopeMode,
} from "../lib/auth-policy";

const MEMBERSHIP_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CUSTOMER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CUSTOMER_ROLE_SET = new Set<CustomerRole>(CUSTOMER_ROLES);

export interface CustomerAssignmentGrant {
  readonly customerId: string;
  readonly role: CustomerRole;
}

export interface CustomerAssignmentMember {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly scopeMode: ScopeMode;
  readonly status: "active" | "suspended";
  readonly grants: readonly CustomerAssignmentGrant[];
  readonly editable: boolean;
}

export interface AssignableCustomer {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface CustomerAssignmentDirectory {
  readonly members: readonly CustomerAssignmentMember[];
  readonly customers: readonly AssignableCustomer[];
}

interface MemberRow {
  membership_id: string;
  user_id: string;
  display_name: string | null;
  email: string;
  role: OrgRole;
  scope_mode: ScopeMode;
  status: "active" | "suspended";
}

interface GrantRow {
  membership_id: string;
  customer_id: string;
  role: CustomerRole;
}

function invalid(message: string): never {
  throw new LocalAuthError(400, "INVALID_INPUT", message);
}

async function database(): Promise<D1Database> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  return db;
}

function canEditMember(actor: AuthenticatedLocalSession, member: MemberRow): boolean {
  if (member.status !== "active" || member.user_id === actor.subject.userId || member.role === "org_owner") {
    return false;
  }
  return actor.subject.role === "org_owner" || member.role !== "org_admin";
}

export async function listCustomerAssignments(
  actor: AuthenticatedLocalSession,
): Promise<CustomerAssignmentDirectory> {
  const db = await database();
  const [membersResult, customersResult, grantsResult] = await Promise.all([
    db.prepare(
      `SELECT m.id AS membership_id, m.user_id, u.display_name, u.email,
              m.role, m.scope_mode, m.status
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.org_id = ?
        ORDER BY CASE m.role
                   WHEN 'org_owner' THEN 0
                   WHEN 'org_admin' THEN 1
                   ELSE 2
                 END,
                 COALESCE(u.display_name, u.email), m.id`,
    ).bind(actor.subject.orgId).all<MemberRow>(),
    db.prepare(
      `SELECT id, name, slug
         FROM customers
        WHERE org_id = ? AND status = 'active'
        ORDER BY name, id`,
    ).bind(actor.subject.orgId).all<AssignableCustomer>(),
    db.prepare(
      `SELECT ca.membership_id, ca.customer_id, ca.role
         FROM customer_access ca
         JOIN memberships m
           ON m.id = ca.membership_id AND m.org_id = ca.org_id
         JOIN customers c
           ON c.id = ca.customer_id AND c.org_id = ca.org_id
        WHERE ca.org_id = ? AND m.status = 'active' AND c.status = 'active'
        ORDER BY ca.membership_id, c.name, ca.customer_id`,
    ).bind(actor.subject.orgId).all<GrantRow>(),
  ]);
  const grantsByMember = new Map<string, CustomerAssignmentGrant[]>();
  for (const grant of grantsResult.results ?? []) {
    const current = grantsByMember.get(grant.membership_id) ?? [];
    current.push({ customerId: grant.customer_id, role: grant.role });
    grantsByMember.set(grant.membership_id, current);
  }
  return {
    members: (membersResult.results ?? []).map((member) => ({
      membershipId: member.membership_id,
      userId: member.user_id,
      displayName: member.display_name ?? member.email,
      email: member.email,
      role: member.role,
      scopeMode: member.scope_mode,
      status: member.status,
      grants: grantsByMember.get(member.membership_id) ?? [],
      editable: canEditMember(actor, member),
    })),
    customers: customersResult.results ?? [],
  };
}

export async function replaceCustomerAssignments(
  actor: AuthenticatedLocalSession,
  input: {
    readonly membershipId: string;
    readonly scopeMode: ScopeMode;
    readonly grants: readonly CustomerAssignmentGrant[];
  },
  now = Date.now(),
): Promise<CustomerAssignmentMember> {
  if (!MEMBERSHIP_ID.test(input.membershipId)) invalid("The membership identifier is invalid");
  if (input.scopeMode !== "all_customers" && input.scopeMode !== "assigned_customers") {
    invalid("The customer scope is invalid");
  }
  if (input.grants.length > 200) invalid("A membership cannot have more than 200 customer assignments");
  if (input.scopeMode === "all_customers" && input.grants.length !== 0) {
    invalid("All-customer access cannot also contain explicit customer assignments");
  }
  const seenCustomers = new Set<string>();
  for (const grant of input.grants) {
    if (
      !CUSTOMER_ID.test(grant.customerId) ||
      !CUSTOMER_ROLE_SET.has(grant.role) ||
      seenCustomers.has(grant.customerId)
    ) {
      invalid("Customer assignments must contain unique valid customers and roles");
    }
    seenCustomers.add(grant.customerId);
  }

  const db = await database();
  const target = await db.prepare(
    `SELECT m.id AS membership_id, m.user_id, u.display_name, u.email,
            m.role, m.scope_mode, m.status
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.id = ? AND m.org_id = ?
      LIMIT 1`,
  ).bind(input.membershipId, actor.subject.orgId).first<MemberRow>();
  if (target === null) throw new LocalAuthError(404, "INVALID_INPUT", "The membership is unavailable");
  if (!canEditMember(actor, target)) {
    throw new LocalAuthError(403, "AUTHORIZATION_DENIED", "This administrator cannot change that membership");
  }

  if (input.grants.length > 0) {
    const customerPlaceholders = input.grants.map(() => "?").join(", ");
    const customerCount = await db.prepare(
      `SELECT COUNT(*) AS count
         FROM customers
        WHERE org_id = ? AND status = 'active' AND id IN (${customerPlaceholders})`,
    ).bind(actor.subject.orgId, ...input.grants.map((grant) => grant.customerId))
      .first<{ count: number }>();
    if (Number(customerCount?.count ?? 0) !== input.grants.length) {
      invalid("One or more customer assignments are outside this organization");
    }
  }

  const previous = await db.prepare(
    `SELECT customer_id, role
       FROM customer_access
      WHERE org_id = ? AND membership_id = ?
      ORDER BY customer_id`,
  ).bind(actor.subject.orgId, input.membershipId).all<{ customer_id: string; role: CustomerRole }>();
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `UPDATE memberships
          SET scope_mode = ?
        WHERE id = ? AND org_id = ? AND status = 'active' AND role = ?`,
    ).bind(input.scopeMode, input.membershipId, actor.subject.orgId, target.role),
    db.prepare(
      `DELETE FROM customer_access
        WHERE org_id = ? AND membership_id = ?
          AND EXISTS (
            SELECT 1 FROM memberships
             WHERE id = ? AND org_id = ? AND status = 'active' AND role = ?
          )`,
    ).bind(
      actor.subject.orgId,
      input.membershipId,
      input.membershipId,
      actor.subject.orgId,
      target.role,
    ),
  ];
  for (const grant of input.grants) {
    statements.push(
      db.prepare(
        `INSERT INTO customer_access
          (id, org_id, customer_id, membership_id, role, created_at)
         SELECT ?, m.org_id, c.id, m.id, ?, ?
           FROM memberships m
           JOIN customers c ON c.org_id = m.org_id AND c.id = ? AND c.status = 'active'
          WHERE m.id = ? AND m.org_id = ? AND m.status = 'active' AND m.role = ?`,
      ).bind(
        `access_${crypto.randomUUID().replaceAll("-", "")}`,
        grant.role,
        now,
        grant.customerId,
        input.membershipId,
        actor.subject.orgId,
        target.role,
      ),
    );
  }

  const exactGrantPredicate = input.grants.length === 0
    ? "NOT EXISTS (SELECT 1 FROM customer_access ca WHERE ca.org_id = m.org_id AND ca.membership_id = m.id)"
    : `NOT EXISTS (
         SELECT 1 FROM customer_access ca
          WHERE ca.org_id = m.org_id AND ca.membership_id = m.id
            AND NOT (${input.grants.map(() => "(ca.customer_id = ? AND ca.role = ?)").join(" OR ")})
       )`;
  const exactGrantValues = input.grants.flatMap((grant) => [grant.customerId, grant.role]);
  const operationId = crypto.randomUUID().replaceAll("-", "");
  await commitAuditedStatements({
    db,
    statements,
    audit: {
      orgId: actor.subject.orgId,
      actorId: actor.subject.userId,
      action: "membership.customer_scope.replace",
      targetType: "membership",
      targetId: input.membershipId,
      customerId: null,
      outcome: "allowed",
      requestId: `membership.customer_scope.replace:${operationId}`,
      metadata: {
        previousScopeMode: target.scope_mode,
        newScopeMode: input.scopeMode,
        previousAssignments: (previous.results ?? []).map((grant) => `${grant.customer_id}:${grant.role}`),
        newAssignments: input.grants.map((grant) => `${grant.customerId}:${grant.role}`),
      },
    },
    mutationGuard: {
      sql: `SELECT 1
              FROM memberships m
             WHERE m.id = ? AND m.org_id = ? AND m.status = 'active'
               AND m.role = ? AND m.scope_mode = ?
               AND (SELECT COUNT(*) FROM customer_access ca
                     WHERE ca.org_id = m.org_id AND ca.membership_id = m.id) = ?
               AND ${exactGrantPredicate}`,
      values: [
        input.membershipId,
        actor.subject.orgId,
        target.role,
        input.scopeMode,
        input.grants.length,
        ...exactGrantValues,
      ],
    },
    persistenceMessage: "The customer assignments and audit evidence could not be committed atomically",
  });

  const directory = await listCustomerAssignments(actor);
  const updated = directory.members.find((member) => member.membershipId === input.membershipId);
  if (updated === undefined) {
    throw new LocalAuthError(500, "PERSISTENCE_FAILED", "The updated membership could not be verified");
  }
  return updated;
}
