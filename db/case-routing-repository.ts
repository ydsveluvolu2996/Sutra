// Repository for tenant-scoped case routing rules. A rule maps a match
// (severity set and/or customer) to a route target (assignee, team, or external
// destination) at a given precedence. Rules are advisory: they drive the routing
// PREVIEW only and never mutate a case's real assignee, so a misconfigured rule
// can't silently reassign live work. Every write is gated to a customer the
// acting organization owns.
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const SEVERITY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u;
const TARGET = /^[A-Za-z0-9][A-Za-z0-9 ._:@/#+-]{0,127}$/u;

export interface CaseRoutingTenantScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface CaseRoutingRuleInput {
  readonly priority: number;
  readonly matchSeverity?: readonly string[];
  readonly matchCustomerId?: string | null;
  readonly routeAssignee?: string | null;
  readonly routeTeam?: string | null;
  readonly routeDestination?: string | null;
}

export interface StoredCaseRoutingRule {
  readonly id: string;
  readonly priority: number;
  readonly matchSeverity: readonly string[];
  readonly matchCustomerId: string | null;
  readonly routeAssignee: string | null;
  readonly routeTeam: string | null;
  readonly routeDestination: string | null;
}

interface RuleRow {
  id: string;
  priority: number;
  match_severity: string | null;
  match_customer_id: string | null;
  route_assignee: string | null;
  route_team: string | null;
  route_destination: string | null;
}

export class CaseRoutingRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND";

  public constructor(code: CaseRoutingRepositoryError["code"]) {
    super("Case routing operation rejected");
    this.name = "CaseRoutingRepositoryError";
    this.code = code;
  }
}

function assertScope(scope: CaseRoutingTenantScope): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) {
    throw new CaseRoutingRepositoryError("INVALID_INPUT");
  }
}

function optionalTarget(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!TARGET.test(trimmed)) throw new CaseRoutingRepositoryError("INVALID_INPUT");
  return trimmed;
}

function mapRow(row: RuleRow): StoredCaseRoutingRule {
  return {
    id: row.id,
    priority: Number(row.priority),
    matchSeverity: row.match_severity === null || row.match_severity.length === 0 ? [] : row.match_severity.split(","),
    matchCustomerId: row.match_customer_id,
    routeAssignee: row.route_assignee,
    routeTeam: row.route_team,
    routeDestination: row.route_destination,
  };
}

const SELECT_COLUMNS =
  "id, priority, match_severity, match_customer_id, route_assignee, route_team, route_destination";

export class CaseRoutingRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async create(scope: CaseRoutingTenantScope, input: CaseRoutingRuleInput): Promise<StoredCaseRoutingRule> {
    assertScope(scope);
    if (!Number.isSafeInteger(input.priority) || input.priority < 0 || input.priority > 100_000) {
      throw new CaseRoutingRepositoryError("INVALID_INPUT");
    }
    const severities = [...new Set((input.matchSeverity ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
    for (const severity of severities) {
      if (!SEVERITY_TOKEN.test(severity)) throw new CaseRoutingRepositoryError("INVALID_INPUT");
    }
    const matchSeverity = severities.length === 0 ? null : severities.join(",");
    const matchCustomerId = optionalTarget(input.matchCustomerId);
    const routeAssignee = optionalTarget(input.routeAssignee);
    const routeTeam = optionalTarget(input.routeTeam);
    const routeDestination = optionalTarget(input.routeDestination);
    // A rule with no route target would decide nothing — refuse it.
    if (routeAssignee === null && routeTeam === null && routeDestination === null) {
      throw new CaseRoutingRepositoryError("INVALID_INPUT");
    }

    const id = `croute_${crypto.randomUUID().replaceAll("-", "")}`;
    const db = await this.ready();
    await db.prepare(
      `INSERT INTO case_routing_rules
         (id, org_id, customer_id, priority, match_severity, match_customer_id, route_assignee, route_team, route_destination)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?, ?
         FROM customers c
        WHERE c.id = ? AND c.org_id = ? AND c.status = 'active'`,
    ).bind(
      id,
      input.priority,
      matchSeverity,
      matchCustomerId,
      routeAssignee,
      routeTeam,
      routeDestination,
      scope.customerId,
      scope.orgId,
    ).run();

    const stored = await db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM case_routing_rules WHERE id = ? AND org_id = ? AND customer_id = ? LIMIT 1`,
    ).bind(id, scope.orgId, scope.customerId).first<RuleRow>();
    if (stored === null) throw new CaseRoutingRepositoryError("SCOPE_NOT_FOUND");
    return mapRow(stored);
  }

  public async list(scope: CaseRoutingTenantScope): Promise<readonly StoredCaseRoutingRule[]> {
    assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM case_routing_rules
        WHERE org_id = ? AND customer_id = ?
        ORDER BY priority ASC, id ASC`,
    ).bind(scope.orgId, scope.customerId).all<RuleRow>();
    return (rows.results ?? []).map(mapRow);
  }

  public async remove(scope: CaseRoutingTenantScope, ruleId: string): Promise<boolean> {
    assertScope(scope);
    if (!/^croute_[a-f0-9]{32}$/u.test(ruleId)) throw new CaseRoutingRepositoryError("INVALID_INPUT");
    const db = await this.ready();
    const existing = await db.prepare(
      `SELECT id FROM case_routing_rules WHERE id = ? AND org_id = ? AND customer_id = ? LIMIT 1`,
    ).bind(ruleId, scope.orgId, scope.customerId).first<{ id: string }>();
    if (existing === null) return false;
    await db.prepare(
      `DELETE FROM case_routing_rules WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(ruleId, scope.orgId, scope.customerId).run();
    return true;
  }
}
