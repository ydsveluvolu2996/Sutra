/**
 * Durable tenant configuration for Foundational FinOps.
 *
 * KPI goals are immutable versions scoped only to tenant/customer/connection;
 * billing periods and generations remain exclusively on the separately
 * authorized canonical billing scope used by the KPI engine.
 * Taxonomy snapshots and children are immutable; publication atomically moves
 * the one mutable head pointer after every normalized row has been inserted.
 */
import {
  FINOPS_KPI_FORMULAS,
  type FinopsKpiGoalVersion,
  type FinopsKpiId,
  type FinopsKpiRbacDecisionEvidence,
} from "../lib/finops-kpi.ts";
import {
  FINOPS_TAXONOMY_DIMENSIONS,
  type FinopsOrganizationTaxonomy,
  type FinopsTaxonomyAllowLists,
  type FinopsTaxonomyAssignment,
  type FinopsTaxonomyDimension,
  type FinopsTaxonomyTenantScope,
} from "../lib/finops-cost-intelligence.ts";
import type { FinopsReconciliationScope } from "../lib/finops-reconciliation.ts";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const GOAL_ID = /^fkg_[a-f0-9]{32}$/u;
const SNAPSHOT_ID = /^fts_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const MAX_GOALS = 2_000;
const MAX_ASSIGNMENTS = 10_000;
const MAX_VALUES_PER_DIMENSION = 500;
const MAX_TOTAL_VALUES = 2_500;
const INSERT_CHUNK = 50;

export interface FinopsFoundationalTenantScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface StoredFinopsKpiGoalVersion {
  readonly scope: FinopsFoundationalTenantScope;
  readonly id: string;
  readonly version: number;
  readonly kpiId: FinopsKpiId;
  readonly targetDirection: FinopsKpiGoalVersion["targetDirection"];
  readonly targetBasisPoints: number;
  readonly effectiveFromIso: string;
  readonly effectiveToIso: string | null;
  readonly actorId: string;
  readonly auditReference: string;
  readonly rbacDecision: FinopsKpiRbacDecisionEvidence;
  readonly createdAtIso: string;
}

export interface SaveFinopsKpiGoalInput {
  readonly id?: string;
  readonly version: number;
  readonly kpiId: FinopsKpiId;
  readonly targetDirection: FinopsKpiGoalVersion["targetDirection"];
  readonly targetBasisPoints: number;
  readonly effectiveFromIso: string;
  readonly effectiveToIso: string | null;
  readonly actorId: string;
  readonly auditReference: string;
  readonly rbacDecision: FinopsKpiRbacDecisionEvidence;
}

export interface PublishFinopsTaxonomyInput {
  readonly snapshotId?: string;
  readonly version: number;
  readonly taxonomy: FinopsOrganizationTaxonomy;
  readonly actorId: string;
  readonly auditReference: string;
}

export interface PublishedFinopsTaxonomy {
  readonly snapshotId: string;
  readonly version: number;
  readonly taxonomy: FinopsOrganizationTaxonomy;
  readonly createdBy: string;
  readonly auditReference: string;
  readonly promotedAtIso: string;
}

export class FinopsFoundationalConfigRepositoryError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "SCOPE_NOT_FOUND"
    | "OVERLAPPING_GOAL"
    | "VERSION_CONFLICT";

  public constructor(code: FinopsFoundationalConfigRepositoryError["code"]) {
    super("Foundational FinOps configuration operation rejected");
    this.name = "FinopsFoundationalConfigRepositoryError";
    this.code = code;
  }
}

interface GoalRow {
  id: string;
  org_id: string;
  customer_id: string;
  connection_id: string;
  kpi_id: string;
  version: number | string;
  target_direction: "higher_is_better" | "lower_is_better";
  target_basis_points: number | string;
  effective_from: string;
  effective_to: string | null;
  actor_id: string;
  audit_reference: string;
  rbac_decision_id: string;
  rbac_decision: "allow";
  rbac_action: "finops:kpi-goal:write";
  rbac_resource: string;
  rbac_actor_id: string;
  rbac_decided_at: string;
  rbac_policy_version: string;
  rbac_evidence_reference: string;
  created_at: number | string;
}

interface SnapshotRow {
  id: string;
  version: number | string;
  source: FinopsOrganizationTaxonomy["evidence"]["source"];
  source_evidence_id: string;
  observed_at: string;
  created_by: string;
  audit_reference: string;
  promoted_at: number | string;
}

interface AssignmentRow {
  account_id: string;
  company: string | null;
  business_unit: string | null;
  environment: string | null;
  cost_center: string | null;
  owner: string | null;
}

interface AllowedValueRow {
  dimension: FinopsTaxonomyDimension;
  value: string;
}

const FORMULA_BY_ID = new Map(
  FINOPS_KPI_FORMULAS.map((formula) => [formula.id, formula]),
);

function reject(
  code: FinopsFoundationalConfigRepositoryError["code"] = "INVALID_INPUT",
): never {
  throw new FinopsFoundationalConfigRepositoryError(code);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validText(value: unknown, maximum = 1_024): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !value.includes("\0");
}

function normalizedIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function assertScope(scope: FinopsFoundationalTenantScope): void {
  if (
    scope === null
    || typeof scope !== "object"
    || !IDENTIFIER.test(scope.organizationId)
    || !IDENTIFIER.test(scope.customerId)
    || !CONNECTION_ID.test(scope.connectionId)
  ) reject();
}

function sameTaxonomyScope(
  left: FinopsFoundationalTenantScope,
  right: FinopsTaxonomyTenantScope,
): boolean {
  return left.organizationId === right.organizationId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

function goalResource(
  scope: FinopsFoundationalTenantScope,
  kpiId: FinopsKpiId,
): string {
  return [
    "finops-kpi",
    scope.organizationId,
    scope.customerId,
    scope.connectionId,
    kpiId,
  ].join(":");
}

function epoch(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) reject();
  return parsed;
}

function toStoredGoal(row: GoalRow): StoredFinopsKpiGoalVersion {
  return {
    scope: {
      organizationId: row.org_id,
      customerId: row.customer_id,
      connectionId: row.connection_id,
    },
    id: row.id,
    version: Number(row.version),
    kpiId: row.kpi_id as FinopsKpiId,
    targetDirection: row.target_direction,
    targetBasisPoints: Number(row.target_basis_points),
    effectiveFromIso: row.effective_from,
    effectiveToIso: row.effective_to,
    actorId: row.actor_id,
    auditReference: row.audit_reference,
    rbacDecision: {
      decisionId: row.rbac_decision_id,
      decision: row.rbac_decision,
      action: row.rbac_action,
      resource: row.rbac_resource,
      actorId: row.rbac_actor_id,
      decidedAtIso: row.rbac_decided_at,
      policyVersion: row.rbac_policy_version,
      evidenceReference: row.rbac_evidence_reference,
    },
    createdAtIso: new Date(epoch(row.created_at)).toISOString(),
  };
}

function normalizeGoal(
  scope: FinopsFoundationalTenantScope,
  input: SaveFinopsKpiGoalInput,
): SaveFinopsKpiGoalInput & {
  readonly id: string;
  readonly effectiveFromIso: string;
  readonly effectiveToIso: string | null;
  readonly rbacDecision: FinopsKpiRbacDecisionEvidence;
} {
  const formula = FORMULA_BY_ID.get(input.kpiId);
  const effectiveFromIso = normalizedIso(input.effectiveFromIso);
  const effectiveToIso = input.effectiveToIso === null
    ? null
    : normalizedIso(input.effectiveToIso);
  const decidedAtIso = normalizedIso(input.rbacDecision?.decidedAtIso);
  const id = input.id ?? `fkg_${crypto.randomUUID().replaceAll("-", "")}`;
  if (
    !GOAL_ID.test(id)
    || formula === undefined
    || !Number.isSafeInteger(input.version)
    || input.version < 1
    || input.targetDirection !== formula.targetDirection
    || !Number.isSafeInteger(input.targetBasisPoints)
    || input.targetBasisPoints < 0
    || input.targetBasisPoints > 10_000
    || effectiveFromIso === null
    || (
      input.effectiveToIso !== null
      && (
        effectiveToIso === null
        || Date.parse(effectiveToIso) <= Date.parse(effectiveFromIso)
      )
    )
    || !validText(input.actorId, 256)
    || !validText(input.auditReference)
    || input.rbacDecision === null
    || typeof input.rbacDecision !== "object"
    || !validText(input.rbacDecision.decisionId, 256)
    || input.rbacDecision.decision !== "allow"
    || input.rbacDecision.action !== "finops:kpi-goal:write"
    || input.rbacDecision.resource !== goalResource(scope, input.kpiId)
    || input.rbacDecision.actorId !== input.actorId
    || decidedAtIso === null
    || Date.parse(decidedAtIso) > Date.parse(effectiveFromIso)
    || !validText(input.rbacDecision.policyVersion, 256)
    || !validText(input.rbacDecision.evidenceReference)
  ) reject();
  return {
    ...input,
    id,
    effectiveFromIso,
    effectiveToIso,
    rbacDecision: { ...input.rbacDecision, decidedAtIso },
  };
}

function normalizeAllowList(
  value: readonly string[],
): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_VALUES_PER_DIMENSION) reject();
  const normalized = new Set<string>();
  for (const entry of value) {
    if (!validText(entry, 256)) reject();
    normalized.add(entry);
  }
  if (normalized.size !== value.length) reject();
  return [...normalized].sort(compareText);
}

function normalizeAssignment(
  assignment: FinopsTaxonomyAssignment,
  allowLists: FinopsTaxonomyAllowLists,
): FinopsTaxonomyAssignment {
  if (
    assignment === null
    || typeof assignment !== "object"
    || !ACCOUNT_ID.test(assignment.accountId)
  ) reject();
  const fields = [
    ["company", assignment.company, allowLists.company],
    ["businessUnit", assignment.businessUnit, allowLists.business_unit],
    ["environment", assignment.environment, allowLists.environment],
    ["costCenter", assignment.costCenter, allowLists.cost_center],
  ] as const;
  for (const [, value, allowed] of fields) {
    if (
      value !== undefined
      && value !== null
      && (!validText(value, 256) || !allowed.includes(value))
    ) reject();
  }
  if (
    assignment.owner !== undefined
    && assignment.owner !== null
    && !validText(assignment.owner, 256)
  ) reject();
  if (!allowLists.account.includes(assignment.accountId)) reject();
  return {
    accountId: assignment.accountId,
    company: assignment.company ?? null,
    businessUnit: assignment.businessUnit ?? null,
    environment: assignment.environment ?? null,
    costCenter: assignment.costCenter ?? null,
    owner: assignment.owner ?? null,
  };
}

function normalizeTaxonomy(
  scope: FinopsFoundationalTenantScope,
  taxonomy: FinopsOrganizationTaxonomy,
): FinopsOrganizationTaxonomy {
  if (
    taxonomy === null
    || typeof taxonomy !== "object"
    || !sameTaxonomyScope(scope, taxonomy.scope)
    || taxonomy.evidence === null
    || typeof taxonomy.evidence !== "object"
    || !new Set(["aws_organizations", "operator_map", "cmdb"]).has(
      taxonomy.evidence.source,
    )
    || !validText(taxonomy.evidence.sourceEvidenceId)
    || normalizedIso(taxonomy.evidence.observedAtIso) === null
    || taxonomy.allowLists === null
    || typeof taxonomy.allowLists !== "object"
    || !Array.isArray(taxonomy.assignments)
    || taxonomy.assignments.length > MAX_ASSIGNMENTS
  ) reject();
  const allowLists: FinopsTaxonomyAllowLists = {
    company: normalizeAllowList(taxonomy.allowLists.company),
    business_unit: normalizeAllowList(taxonomy.allowLists.business_unit),
    environment: normalizeAllowList(taxonomy.allowLists.environment),
    cost_center: normalizeAllowList(taxonomy.allowLists.cost_center),
    account: normalizeAllowList(taxonomy.allowLists.account),
  };
  if (
    Object.values(allowLists).reduce((sum, values) => sum + values.length, 0)
    > MAX_TOTAL_VALUES
  ) reject();
  const accounts = new Set<string>();
  const assignments = taxonomy.assignments
    .map((assignment) => normalizeAssignment(assignment, allowLists))
    .sort((left, right) => compareText(left.accountId, right.accountId));
  for (const assignment of assignments) {
    if (accounts.has(assignment.accountId)) reject();
    accounts.add(assignment.accountId);
  }
  return {
    scope: { ...scope },
    evidence: {
      source: taxonomy.evidence.source,
      sourceEvidenceId: taxonomy.evidence.sourceEvidenceId,
      observedAtIso: normalizedIso(taxonomy.evidence.observedAtIso) as string,
    },
    allowLists,
    assignments,
  };
}

function chunks<T>(values: readonly T[]): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += INSERT_CHUNK) {
    result.push(values.slice(index, index + INSERT_CHUNK));
  }
  return result;
}

export class FinopsFoundationalConfigRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  private async assertLiveScope(
    scope: FinopsFoundationalTenantScope,
  ): Promise<D1Database> {
    assertScope(scope);
    const database = await this.ready();
    const row = await database.prepare(
      `SELECT c.id
         FROM aws_connections c
         JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
         JOIN customers cu
           ON cu.id = c.customer_id AND cu.org_id = c.org_id AND cu.status = 'active'
        WHERE c.org_id = ? AND c.customer_id = ? AND c.id = ?
          AND c.source_kind = 'aws_trust_role' AND c.status = 'active'
        LIMIT 1`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
    ).first<{ id: string }>();
    if (row === null) reject("SCOPE_NOT_FOUND");
    return database;
  }

  public async listKpiGoals(
    scope: FinopsFoundationalTenantScope,
  ): Promise<readonly StoredFinopsKpiGoalVersion[]> {
    const database = await this.assertLiveScope(scope);
    const rows = await database.prepare(
      `SELECT *
         FROM finops_kpi_goal_versions
        WHERE org_id = ? AND customer_id = ? AND connection_id = ?
        ORDER BY kpi_id ASC, effective_from ASC, version ASC, id ASC
        LIMIT ?`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      MAX_GOALS,
    ).all<GoalRow>();
    return (rows.results ?? []).map(toStoredGoal);
  }

  /**
   * Exact adapter to the pure KPI engine. The stored goal and the returned
   * engine configuration remain tenant/connection scoped and never copy
   * period or generation identifiers out of the active billing scope.
   */
  public async goalsForEvaluation(
    evaluationScope: FinopsReconciliationScope,
  ): Promise<readonly FinopsKpiGoalVersion[]> {
    const stored = await this.listKpiGoals({
      organizationId: evaluationScope.organizationId,
      customerId: evaluationScope.customerId,
      connectionId: evaluationScope.connectionId,
    });
    return stored.map((goal) => ({
      organizationId: evaluationScope.organizationId,
      customerId: evaluationScope.customerId,
      connectionId: evaluationScope.connectionId,
      id: goal.id,
      version: goal.version,
      kpiId: goal.kpiId,
      targetDirection: goal.targetDirection,
      targetBasisPoints: goal.targetBasisPoints,
      effectiveFromIso: goal.effectiveFromIso,
      effectiveToIso: goal.effectiveToIso,
      actorId: goal.actorId,
      auditReference: goal.auditReference,
      rbacDecision: goal.rbacDecision,
    }));
  }

  public async saveKpiGoal(
    scope: FinopsFoundationalTenantScope,
    input: SaveFinopsKpiGoalInput,
    nowMs = Date.now(),
  ): Promise<StoredFinopsKpiGoalVersion> {
    const database = await this.assertLiveScope(scope);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) reject();
    const goal = normalizeGoal(scope, input);
    const overlapping = await database.prepare(
      `SELECT id
         FROM finops_kpi_goal_versions
        WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND kpi_id = ?
          AND effective_from < ?
          AND ? < COALESCE(effective_to, '9999-12-31T23:59:59.999Z')
        LIMIT 1`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      goal.kpiId,
      goal.effectiveToIso ?? "9999-12-31T23:59:59.999Z",
      goal.effectiveFromIso,
    ).first<{ id: string }>();
    if (overlapping !== null) reject("OVERLAPPING_GOAL");
    try {
      await database.prepare(
        `INSERT INTO finops_kpi_goal_versions (
          id, org_id, customer_id, connection_id, kpi_id, version,
          target_direction, target_basis_points, effective_from, effective_to,
          actor_id, audit_reference, rbac_decision_id, rbac_decision,
          rbac_action, rbac_resource, rbac_actor_id, rbac_decided_at,
          rbac_policy_version, rbac_evidence_reference, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'allow',
                  'finops:kpi-goal:write', ?, ?, ?, ?, ?, ?)`,
      ).bind(
        goal.id,
        scope.organizationId,
        scope.customerId,
        scope.connectionId,
        goal.kpiId,
        goal.version,
        goal.targetDirection,
        goal.targetBasisPoints,
        goal.effectiveFromIso,
        goal.effectiveToIso,
        goal.actorId,
        goal.auditReference,
        goal.rbacDecision.decisionId,
        goal.rbacDecision.resource,
        goal.rbacDecision.actorId,
        goal.rbacDecision.decidedAtIso,
        goal.rbacDecision.policyVersion,
        goal.rbacDecision.evidenceReference,
        nowMs,
      ).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/FINOPS_KPI_GOAL_OVERLAP/iu.test(message)) reject("OVERLAPPING_GOAL");
      if (/UNIQUE|duplicate/iu.test(message)) reject("VERSION_CONFLICT");
      throw error;
    }
    const row = await database.prepare(
      `SELECT * FROM finops_kpi_goal_versions
        WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND id = ?
        LIMIT 1`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      goal.id,
    ).first<GoalRow>();
    if (row === null) reject("VERSION_CONFLICT");
    return toStoredGoal(row);
  }

  public async activeTaxonomy(
    scope: FinopsFoundationalTenantScope,
  ): Promise<PublishedFinopsTaxonomy | null> {
    const database = await this.assertLiveScope(scope);
    const snapshot = await database.prepare(
      `SELECT s.id, s.version, s.source, s.source_evidence_id, s.observed_at,
              s.created_by, s.audit_reference, h.promoted_at
         FROM finops_taxonomy_heads h
         JOIN finops_taxonomy_snapshots s
           ON s.id = h.snapshot_id
          AND s.org_id = h.org_id
          AND s.customer_id = h.customer_id
          AND s.connection_id = h.connection_id
        WHERE h.org_id = ? AND h.customer_id = ? AND h.connection_id = ?
        LIMIT 1`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
    ).first<SnapshotRow>();
    if (snapshot === null) return null;
    const [assignmentResult, allowedResult] = await Promise.all([
      database.prepare(
        `SELECT account_id, company, business_unit, environment, cost_center, owner
           FROM finops_taxonomy_assignments
          WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND snapshot_id = ?
          ORDER BY account_id ASC
          LIMIT ?`,
      ).bind(
        scope.organizationId,
        scope.customerId,
        scope.connectionId,
        snapshot.id,
        MAX_ASSIGNMENTS,
      ).all<AssignmentRow>(),
      database.prepare(
        `SELECT dimension, value
           FROM finops_taxonomy_allowed_values
          WHERE org_id = ? AND customer_id = ? AND connection_id = ? AND snapshot_id = ?
          ORDER BY dimension ASC, value ASC
          LIMIT ?`,
      ).bind(
        scope.organizationId,
        scope.customerId,
        scope.connectionId,
        snapshot.id,
        MAX_TOTAL_VALUES,
      ).all<AllowedValueRow>(),
    ]);
    const allowLists: Record<FinopsTaxonomyDimension, string[]> = {
      company: [],
      business_unit: [],
      environment: [],
      cost_center: [],
      account: [],
    };
    for (const row of allowedResult.results ?? []) {
      allowLists[row.dimension].push(row.value);
    }
    return {
      snapshotId: snapshot.id,
      version: Number(snapshot.version),
      taxonomy: {
        scope: { ...scope },
        evidence: {
          source: snapshot.source,
          sourceEvidenceId: snapshot.source_evidence_id,
          observedAtIso: snapshot.observed_at,
        },
        allowLists,
        assignments: (assignmentResult.results ?? []).map((row) => ({
          accountId: row.account_id,
          company: row.company,
          businessUnit: row.business_unit,
          environment: row.environment,
          costCenter: row.cost_center,
          owner: row.owner,
        })),
      },
      createdBy: snapshot.created_by,
      auditReference: snapshot.audit_reference,
      promotedAtIso: new Date(epoch(snapshot.promoted_at)).toISOString(),
    };
  }

  public async publishTaxonomy(
    scope: FinopsFoundationalTenantScope,
    input: PublishFinopsTaxonomyInput,
    nowMs = Date.now(),
  ): Promise<PublishedFinopsTaxonomy> {
    const database = await this.assertLiveScope(scope);
    const snapshotId =
      input.snapshotId ?? `fts_${crypto.randomUUID().replaceAll("-", "")}`;
    if (
      !SNAPSHOT_ID.test(snapshotId)
      || !Number.isSafeInteger(input.version)
      || input.version < 1
      || !validText(input.actorId, 256)
      || !validText(input.auditReference)
      || !Number.isSafeInteger(nowMs)
      || nowMs < 0
    ) reject();
    const taxonomy = normalizeTaxonomy(scope, input.taxonomy);
    if (Date.parse(taxonomy.evidence.observedAtIso) > nowMs) reject();
    const statements: D1PreparedStatement[] = [
      database.prepare(
        `INSERT INTO finops_taxonomy_snapshots (
          id, org_id, customer_id, connection_id, version, source,
          source_evidence_id, observed_at, created_by, audit_reference, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        snapshotId,
        scope.organizationId,
        scope.customerId,
        scope.connectionId,
        input.version,
        taxonomy.evidence.source,
        taxonomy.evidence.sourceEvidenceId,
        taxonomy.evidence.observedAtIso,
        input.actorId,
        input.auditReference,
        nowMs,
      ),
    ];
    const allowedRows = FINOPS_TAXONOMY_DIMENSIONS.flatMap((dimension) =>
      taxonomy.allowLists[dimension].map((value) => ({ dimension, value })));
    for (const chunk of chunks(allowedRows)) {
      const values = chunk.flatMap(({ dimension, value }) => [
        snapshotId,
        scope.organizationId,
        scope.customerId,
        scope.connectionId,
        dimension,
        value,
      ]);
      statements.push(database.prepare(
        `INSERT INTO finops_taxonomy_allowed_values (
          snapshot_id, org_id, customer_id, connection_id, dimension, value
        ) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`,
      ).bind(...values));
    }
    for (const chunk of chunks(taxonomy.assignments)) {
      const values = chunk.flatMap((assignment) => [
        snapshotId,
        scope.organizationId,
        scope.customerId,
        scope.connectionId,
        assignment.accountId,
        assignment.company ?? null,
        assignment.businessUnit ?? null,
        assignment.environment ?? null,
        assignment.costCenter ?? null,
        assignment.owner ?? null,
      ]);
      statements.push(database.prepare(
        `INSERT INTO finops_taxonomy_assignments (
          snapshot_id, org_id, customer_id, connection_id, account_id,
          company, business_unit, environment, cost_center, owner
        ) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
      ).bind(...values));
    }
    statements.push(database.prepare(
      `INSERT INTO finops_taxonomy_heads (
        org_id, customer_id, connection_id, snapshot_id, promoted_by, promoted_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (org_id, customer_id, connection_id) DO UPDATE SET
        snapshot_id = excluded.snapshot_id,
        promoted_by = excluded.promoted_by,
        promoted_at = excluded.promoted_at`,
    ).bind(
      scope.organizationId,
      scope.customerId,
      scope.connectionId,
      snapshotId,
      input.actorId,
      nowMs,
    ));
    try {
      await database.batch(statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/UNIQUE|duplicate/iu.test(message)) reject("VERSION_CONFLICT");
      throw error;
    }
    const active = await this.activeTaxonomy(scope);
    if (active === null || active.snapshotId !== snapshotId) {
      reject("VERSION_CONFLICT");
    }
    return active;
  }
}
