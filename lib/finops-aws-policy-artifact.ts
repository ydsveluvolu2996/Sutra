import { createHash } from "node:crypto";

import {
  assertFinopsCollectorReadOnly,
  type AwsPartition,
  type FinopsActionApproval,
  type FinopsIamStatement,
  type FinopsPermissionBoundary,
  type FinopsPermissionPlan,
  type FinopsRolePlan,
  type FinopsWriteCapability,
} from "./finops-aws-permissions.ts";
import type {
  FinopsCapabilityId,
  FinopsSourceId,
} from "./finops-source-health.ts";

export const FINOPS_AWS_POLICY_ARTIFACT_SCHEMA_VERSION =
  "sutra.finops.aws-iam-policy-artifact/1" as const;
export const AWS_IAM_POLICY_LANGUAGE_VERSION = "2012-10-17" as const;

const ROLE_NAME_BY_BOUNDARY: Readonly<Record<FinopsPermissionBoundary, string>> = {
  collector: "SutraFinopsCollectorRole",
  provisioner: "SutraFinopsProvisionerRole",
  action: "SutraFinopsApprovedActionRole",
};

const SID_PATTERN_BY_BOUNDARY: Readonly<Record<FinopsPermissionBoundary, RegExp>> = {
  collector: /^SutraFinopsReadOnly[A-Za-z0-9]+$/u,
  provisioner: /^SutraFinops(?:OneTime|Provision)[A-Za-z0-9]+$/u,
  action: /^SutraFinopsTimeBoundApproved[A-Za-z0-9]+$/u,
};

const APPROVED_ACTIONS: Readonly<Record<FinopsWriteCapability, readonly string[]>> = {
  manage_aws_budgets: ["aws-portal:ModifyBilling", "budgets:ModifyBudget"],
  acknowledge_cost_anomaly: ["ce:UpdateAnomalySubscription"],
  update_cost_optimization_preferences: [
    "cost-optimization-hub:UpdateEnrollmentStatus",
    "cost-optimization-hub:UpdatePreferences",
  ],
};

type IamConditionValue = string | readonly string[];
type IamConditionMap = Readonly<Record<string, Readonly<Record<string, IamConditionValue>>>>;

export interface AwsIamPolicyStatement {
  readonly Sid: string;
  readonly Effect: "Allow";
  readonly Action: readonly string[];
  readonly Resource: readonly string[];
  readonly Condition?: IamConditionMap;
}

export interface AwsIamPolicyDocument {
  readonly Version: typeof AWS_IAM_POLICY_LANGUAGE_VERSION;
  readonly Statement: readonly AwsIamPolicyStatement[];
}

export interface FinopsAwsPolicyBindingScope {
  readonly tenantId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly region: string;
}

export interface FinopsAwsPolicyArtifactVersions {
  readonly collector: string;
  readonly provisioner?: string;
  readonly action?: string;
}

export interface FinopsAwsPolicyResourceReference {
  readonly statementIndex: number;
  readonly sid: string;
  /**
   * Exact IAM Resource strings, in policy order. A literal IAM wildcard is
   * retained as data; unresolved CloudFormation substitutions are rejected.
   */
  readonly resources: readonly string[];
}

export interface FinopsApprovedActionBinding {
  readonly capability: FinopsWriteCapability;
  readonly actions: readonly string[];
  readonly approvedBy: string;
  readonly approvedAtIso: string;
  readonly expiresAtIso: string;
  readonly changeTicket: string;
}

export interface FinopsAwsPolicyArtifactBinding extends FinopsAwsPolicyBindingScope {
  readonly capabilityIds: readonly FinopsCapabilityId[];
  readonly sourceIds: readonly FinopsSourceId[];
  readonly exactResourceReferences: readonly FinopsAwsPolicyResourceReference[];
  readonly approvedActions: readonly FinopsApprovedActionBinding[];
}

export interface FinopsAwsPolicyArtifact {
  readonly schemaVersion: typeof FINOPS_AWS_POLICY_ARTIFACT_SCHEMA_VERSION;
  readonly artifactVersion: string;
  readonly boundary: FinopsPermissionBoundary;
  readonly roleName: string;
  readonly binding: FinopsAwsPolicyArtifactBinding;
  readonly policyDocument: AwsIamPolicyDocument;
  /** SHA-256 of the canonical JSON envelope excluding this digest field. */
  readonly canonicalSha256: string;
}

export interface FinopsAwsPolicyArtifactSet {
  readonly collector: FinopsAwsPolicyArtifact;
  readonly provisioner: FinopsAwsPolicyArtifact | null;
  readonly action: FinopsAwsPolicyArtifact | null;
}

export interface BuildFinopsAwsPolicyArtifactsInput {
  readonly plan: FinopsPermissionPlan;
  readonly binding: FinopsAwsPolicyBindingScope;
  readonly versions: FinopsAwsPolicyArtifactVersions;
  readonly actionApprovals?: readonly FinopsActionApproval[];
  readonly nowIso?: string;
}

export interface VerifyFinopsAwsPolicyArtifactsInput
  extends BuildFinopsAwsPolicyArtifactsInput {
  readonly artifacts: FinopsAwsPolicyArtifactSet;
}

export class FinopsAwsPolicyArtifactError extends Error {
  public readonly code:
    | "INVALID_INPUT"
    | "INVALID_PERMISSION_PLAN"
    | "BOUNDARY_VIOLATION"
    | "WILDCARD_ACTION"
    | "UNRESOLVED_TEMPLATE_REFERENCE"
    | "APPROVAL_MISMATCH"
    | "CROSS_TENANT_BINDING"
    | "ATTESTATION_MISMATCH";

  public constructor(
    code: FinopsAwsPolicyArtifactError["code"],
    message: string,
  ) {
    super(message);
    this.name = "FinopsAwsPolicyArtifactError";
    this.code = code;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new FinopsAwsPolicyArtifactError(
      "INVALID_INPUT",
      "The policy artifact must be JSON serializable.",
    );
  }
  return serialized;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function assertCanonicalIdentifier(label: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u.test(value)) {
    throw new FinopsAwsPolicyArtifactError(
      "INVALID_INPUT",
      `${label} must be a non-empty canonical identifier.`,
    );
  }
}

function assertArtifactVersion(boundary: FinopsPermissionBoundary, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) {
    throw new FinopsAwsPolicyArtifactError(
      "INVALID_INPUT",
      `${boundary} policy artifact version is invalid.`,
    );
  }
}

function assertBindingScope(binding: FinopsAwsPolicyBindingScope): void {
  assertCanonicalIdentifier("Tenant ID", binding.tenantId);
  assertCanonicalIdentifier("Customer ID", binding.customerId);
  assertCanonicalIdentifier("Connection ID", binding.connectionId);
  if (!/^\d{12}$/u.test(binding.accountId)) {
    throw new FinopsAwsPolicyArtifactError(
      "INVALID_INPUT",
      "AWS account ID must contain exactly 12 digits.",
    );
  }
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(binding.region)) {
    throw new FinopsAwsPolicyArtifactError("INVALID_INPUT", "AWS Region is invalid.");
  }
  if (!(["aws", "aws-us-gov", "aws-cn"] as const).includes(binding.partition)) {
    throw new FinopsAwsPolicyArtifactError("INVALID_INPUT", "AWS partition is invalid.");
  }
}

function assertNoUnresolvedTemplateReference(value: string): void {
  if (
    value.includes("${")
    || value.includes("{{")
    || value.includes("}}")
    || value.includes("AWS::")
    || /^!(?:Ref|Sub|GetAtt)\b/u.test(value)
  ) {
    throw new FinopsAwsPolicyArtifactError(
      "UNRESOLVED_TEMPLATE_REFERENCE",
      `Policy value ${value} contains an unresolved template reference.`,
    );
  }
}

function assertAction(action: string): void {
  if (!/^[a-z0-9-]+:[A-Za-z0-9]+$/u.test(action)) {
    throw new FinopsAwsPolicyArtifactError(
      action.includes("*") ? "WILDCARD_ACTION" : "INVALID_PERMISSION_PLAN",
      `IAM action ${action} must be one explicit service operation.`,
    );
  }
  assertNoUnresolvedTemplateReference(action);
}

function assertResourceMatchesBinding(
  resource: string,
  binding: FinopsAwsPolicyBindingScope,
): void {
  assertNoUnresolvedTemplateReference(resource);
  if (resource === "*") return;
  if (!resource.startsWith("arn:")) {
    throw new FinopsAwsPolicyArtifactError(
      "INVALID_PERMISSION_PLAN",
      `IAM resource ${resource} must be an ARN or the literal IAM wildcard.`,
    );
  }
  const arnParts = resource.split(":", 6);
  if (arnParts[1] !== binding.partition) {
    throw new FinopsAwsPolicyArtifactError(
      "CROSS_TENANT_BINDING",
      `IAM resource ${resource} does not match the bound AWS partition.`,
    );
  }
  const resourceAccount = arnParts[4] ?? "";
  if (
    resourceAccount !== ""
    && resourceAccount !== "*"
    && /^\d{12}$/u.test(resourceAccount)
    && resourceAccount !== binding.accountId
  ) {
    throw new FinopsAwsPolicyArtifactError(
      "CROSS_TENANT_BINDING",
      `IAM resource ${resource} does not match the bound AWS account.`,
    );
  }
}

function cloneConditions(
  conditions: FinopsIamStatement["conditions"],
): IamConditionMap | undefined {
  if (conditions === undefined) return undefined;
  const cloned: Record<string, Readonly<Record<string, IamConditionValue>>> = {};
  for (const [operator, entries] of Object.entries(conditions)) {
    if (operator !== "StringLike" && operator !== "StringEquals") {
      throw new FinopsAwsPolicyArtifactError(
        "INVALID_PERMISSION_PLAN",
        `IAM condition operator ${operator} is unsupported.`,
      );
    }
    const clonedEntries: Record<string, IamConditionValue> = {};
    for (const [key, rawValue] of Object.entries(entries)) {
      assertNoUnresolvedTemplateReference(key);
      if (typeof rawValue === "string") {
        assertNoUnresolvedTemplateReference(rawValue);
        clonedEntries[key] = rawValue;
        continue;
      }
      if (
        !Array.isArray(rawValue)
        || rawValue.length === 0
        || rawValue.some((value) => typeof value !== "string")
      ) {
        throw new FinopsAwsPolicyArtifactError(
          "INVALID_PERMISSION_PLAN",
          `IAM condition ${operator}.${key} must contain strings.`,
        );
      }
      for (const value of rawValue) assertNoUnresolvedTemplateReference(value);
      clonedEntries[key] = [...rawValue];
    }
    cloned[operator] = clonedEntries;
  }
  return cloned;
}

function policyDocumentForRole(
  role: FinopsRolePlan,
  binding: FinopsAwsPolicyBindingScope,
): AwsIamPolicyDocument {
  const statementSids = new Set<string>();
  const statements = role.statements.map((statement) => {
    if (
      statement.effect !== "Allow"
      || statement.actions.length === 0
      || statement.resources.length === 0
      || statementSids.has(statement.sid)
    ) {
      throw new FinopsAwsPolicyArtifactError(
        "INVALID_PERMISSION_PLAN",
        `${role.boundary} policy contains an invalid or duplicate statement.`,
      );
    }
    if (!SID_PATTERN_BY_BOUNDARY[role.boundary].test(statement.sid)) {
      throw new FinopsAwsPolicyArtifactError(
        "BOUNDARY_VIOLATION",
        `Statement ${statement.sid} is not valid for the ${role.boundary} boundary.`,
      );
    }
    statementSids.add(statement.sid);
    const actions = [...statement.actions];
    const resources = [...statement.resources];
    if (new Set(actions).size !== actions.length || new Set(resources).size !== resources.length) {
      throw new FinopsAwsPolicyArtifactError(
        "INVALID_PERMISSION_PLAN",
        `Statement ${statement.sid} contains duplicate actions or resources.`,
      );
    }
    for (const action of actions) assertAction(action);
    for (const resource of resources) assertResourceMatchesBinding(resource, binding);
    const Condition = cloneConditions(statement.conditions);
    return {
      Sid: statement.sid,
      Effect: statement.effect,
      Action: actions,
      Resource: resources,
      ...(Condition === undefined ? {} : { Condition }),
    };
  });
  return {
    Version: AWS_IAM_POLICY_LANGUAGE_VERSION,
    Statement: statements,
  };
}

function roleForBoundary(
  plan: FinopsPermissionPlan,
  boundary: FinopsPermissionBoundary,
): FinopsRolePlan | null {
  if (boundary === "collector") return plan.collector;
  return plan[boundary];
}

function assertRoleBoundary(
  role: FinopsRolePlan,
  boundary: FinopsPermissionBoundary,
): void {
  if (
    role.boundary !== boundary
    || role.roleName !== ROLE_NAME_BY_BOUNDARY[boundary]
  ) {
    throw new FinopsAwsPolicyArtifactError(
      "BOUNDARY_VIOLATION",
      `${boundary} policy must retain its dedicated role and boundary.`,
    );
  }
}

function assertPermissionPlan(
  plan: FinopsPermissionPlan,
  binding: FinopsAwsPolicyBindingScope,
): void {
  if (plan.enabledCapabilityIds.length === 0 || plan.requiredSourceIds.length === 0) {
    throw new FinopsAwsPolicyArtifactError(
      "INVALID_PERMISSION_PLAN",
      "The FinOps permission plan must contain capability and source bindings.",
    );
  }
  assertRoleBoundary(plan.collector, "collector");
  if (plan.provisioner !== null) assertRoleBoundary(plan.provisioner, "provisioner");
  if (plan.action !== null) assertRoleBoundary(plan.action, "action");

  const allSids = new Set<string>();
  for (const boundary of ["collector", "provisioner", "action"] as const) {
    const role = roleForBoundary(plan, boundary);
    if (role === null) continue;
    policyDocumentForRole(role, binding);
    for (const statement of role.statements) {
      if (allSids.has(statement.sid)) {
        throw new FinopsAwsPolicyArtifactError(
          "BOUNDARY_VIOLATION",
          `Statement ${statement.sid} is reused across role boundaries.`,
        );
      }
      allSids.add(statement.sid);
    }
  }
  try {
    assertFinopsCollectorReadOnly(plan.collector.statements);
  } catch {
    throw new FinopsAwsPolicyArtifactError(
      "BOUNDARY_VIOLATION",
      "The permanent collector artifact must remain explicitly read-only.",
    );
  }
}

function validateApprovals(
  plan: FinopsPermissionPlan,
  approvals: readonly FinopsActionApproval[],
  nowIso: string | undefined,
): readonly FinopsApprovedActionBinding[] {
  if (plan.action === null) {
    if (approvals.length > 0) {
      throw new FinopsAwsPolicyArtifactError(
        "APPROVAL_MISMATCH",
        "Action approvals cannot be bound when the permission plan has no action role.",
      );
    }
    return [];
  }
  const now = Date.parse(nowIso ?? new Date().toISOString());
  if (!Number.isFinite(now) || approvals.length === 0) {
    throw new FinopsAwsPolicyArtifactError(
      "APPROVAL_MISMATCH",
      "An action policy requires current, attributable approval bindings.",
    );
  }
  const seen = new Set<FinopsWriteCapability>();
  const bindings = approvals.map((approval) => {
    const actions = APPROVED_ACTIONS[approval.capability];
    const approvedAt = Date.parse(approval.approvedAtIso);
    const expiresAt = Date.parse(approval.expiresAtIso);
    if (
      actions === undefined
      || seen.has(approval.capability)
      || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u.test(approval.approvedBy)
      || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/u.test(approval.changeTicket)
      || !Number.isFinite(approvedAt)
      || !Number.isFinite(expiresAt)
      || approvedAt > now
      || expiresAt <= now
      || expiresAt - approvedAt > 31 * 24 * 60 * 60 * 1_000
    ) {
      throw new FinopsAwsPolicyArtifactError(
        "APPROVAL_MISMATCH",
        "Action approvals must be unique, current, attributable, ticketed, and expire within 31 days.",
      );
    }
    seen.add(approval.capability);
    return {
      capability: approval.capability,
      actions: [...actions],
      approvedBy: approval.approvedBy,
      approvedAtIso: approval.approvedAtIso,
      expiresAtIso: approval.expiresAtIso,
      changeTicket: approval.changeTicket,
    };
  }).sort((left, right) => left.capability.localeCompare(right.capability));

  const approvedActions = uniqueSorted(bindings.flatMap((approval) => approval.actions));
  const plannedActions = uniqueSorted(plan.action.statements.flatMap((statement) => statement.actions));
  if (canonicalJson(approvedActions) !== canonicalJson(plannedActions)) {
    throw new FinopsAwsPolicyArtifactError(
      "APPROVAL_MISMATCH",
      "The action policy does not exactly match the approved action set.",
    );
  }
  return bindings;
}

function resourceReferences(
  policyDocument: AwsIamPolicyDocument,
): readonly FinopsAwsPolicyResourceReference[] {
  return policyDocument.Statement.map((statement, statementIndex) => ({
    statementIndex,
    sid: statement.Sid,
    resources: [...statement.Resource],
  }));
}

function buildArtifact(
  role: FinopsRolePlan,
  artifactVersion: string,
  plan: FinopsPermissionPlan,
  bindingScope: FinopsAwsPolicyBindingScope,
  approvedActions: readonly FinopsApprovedActionBinding[],
): FinopsAwsPolicyArtifact {
  const policyDocument = policyDocumentForRole(role, bindingScope);
  const binding: FinopsAwsPolicyArtifactBinding = {
    tenantId: bindingScope.tenantId,
    customerId: bindingScope.customerId,
    connectionId: bindingScope.connectionId,
    accountId: bindingScope.accountId,
    partition: bindingScope.partition,
    region: bindingScope.region,
    capabilityIds: [...plan.enabledCapabilityIds],
    sourceIds: [...plan.requiredSourceIds],
    exactResourceReferences: resourceReferences(policyDocument),
    approvedActions: role.boundary === "action" ? approvedActions : [],
  };
  const core = {
    schemaVersion: FINOPS_AWS_POLICY_ARTIFACT_SCHEMA_VERSION,
    artifactVersion,
    boundary: role.boundary,
    roleName: role.roleName,
    binding,
    policyDocument,
  };
  return {
    ...core,
    canonicalSha256: sha256(canonicalJson(core)),
  };
}

function assertVersionShape(
  plan: FinopsPermissionPlan,
  versions: FinopsAwsPolicyArtifactVersions,
): void {
  assertArtifactVersion("collector", versions.collector);
  if (plan.provisioner === null) {
    if (versions.provisioner !== undefined) {
      throw new FinopsAwsPolicyArtifactError(
        "BOUNDARY_VIOLATION",
        "A provisioner artifact version was supplied without a provisioner role.",
      );
    }
  } else if (versions.provisioner === undefined) {
    throw new FinopsAwsPolicyArtifactError(
      "BOUNDARY_VIOLATION",
      "The provisioner role requires its own artifact version.",
    );
  } else {
    assertArtifactVersion("provisioner", versions.provisioner);
  }
  if (plan.action === null) {
    if (versions.action !== undefined) {
      throw new FinopsAwsPolicyArtifactError(
        "BOUNDARY_VIOLATION",
        "An action artifact version was supplied without an approved action role.",
      );
    }
  } else if (versions.action === undefined) {
    throw new FinopsAwsPolicyArtifactError(
      "BOUNDARY_VIOLATION",
      "The approved action role requires its own artifact version.",
    );
  } else {
    assertArtifactVersion("action", versions.action);
  }
}

export function buildFinopsAwsPolicyArtifacts(
  input: BuildFinopsAwsPolicyArtifactsInput,
): FinopsAwsPolicyArtifactSet {
  assertBindingScope(input.binding);
  assertVersionShape(input.plan, input.versions);
  assertPermissionPlan(input.plan, input.binding);
  const approvedActions = validateApprovals(
    input.plan,
    input.actionApprovals ?? [],
    input.nowIso,
  );
  return {
    collector: buildArtifact(
      input.plan.collector,
      input.versions.collector,
      input.plan,
      input.binding,
      approvedActions,
    ),
    provisioner: input.plan.provisioner === null
      ? null
      : buildArtifact(
          input.plan.provisioner,
          input.versions.provisioner as string,
          input.plan,
          input.binding,
          approvedActions,
        ),
    action: input.plan.action === null
      ? null
      : buildArtifact(
          input.plan.action,
          input.versions.action as string,
          input.plan,
          input.binding,
          approvedActions,
        ),
  };
}

function bindingScopeFromArtifact(
  artifact: FinopsAwsPolicyArtifact,
): FinopsAwsPolicyBindingScope {
  return {
    tenantId: artifact.binding.tenantId,
    customerId: artifact.binding.customerId,
    connectionId: artifact.binding.connectionId,
    accountId: artifact.binding.accountId,
    partition: artifact.binding.partition,
    region: artifact.binding.region,
  };
}

function assertSameBinding(
  artifact: FinopsAwsPolicyArtifact,
  expected: FinopsAwsPolicyBindingScope,
): void {
  if (canonicalJson(bindingScopeFromArtifact(artifact)) !== canonicalJson(expected)) {
    throw new FinopsAwsPolicyArtifactError(
      "CROSS_TENANT_BINDING",
      `${artifact.boundary} policy artifact does not match the expected tenant connection and AWS account.`,
    );
  }
}

function artifactCore(artifact: FinopsAwsPolicyArtifact): Omit<FinopsAwsPolicyArtifact, "canonicalSha256"> {
  return Object.fromEntries(
    Object.entries(artifact).filter(([key]) => key !== "canonicalSha256"),
  ) as Omit<FinopsAwsPolicyArtifact, "canonicalSha256">;
}

function assertSelfAttested(artifact: FinopsAwsPolicyArtifact): void {
  if (
    !/^[a-f0-9]{64}$/u.test(artifact.canonicalSha256)
    || sha256(canonicalJson(artifactCore(artifact))) !== artifact.canonicalSha256
  ) {
    throw new FinopsAwsPolicyArtifactError(
      "ATTESTATION_MISMATCH",
      `${artifact.boundary} policy artifact digest is invalid.`,
    );
  }
}

export function verifyFinopsAwsPolicyArtifacts(
  input: VerifyFinopsAwsPolicyArtifactsInput,
): void {
  const expected = buildFinopsAwsPolicyArtifacts(input);
  for (const boundary of ["collector", "provisioner", "action"] as const) {
    const actualArtifact = input.artifacts[boundary];
    const expectedArtifact = expected[boundary];
    if (actualArtifact === null || expectedArtifact === null) {
      if (actualArtifact !== expectedArtifact) {
        throw new FinopsAwsPolicyArtifactError(
          "ATTESTATION_MISMATCH",
          `${boundary} policy artifact presence does not match the validated plan.`,
        );
      }
      continue;
    }
    assertSameBinding(actualArtifact, input.binding);
    assertSelfAttested(actualArtifact);
    if (canonicalJson(actualArtifact) !== canonicalJson(expectedArtifact)) {
      throw new FinopsAwsPolicyArtifactError(
        "ATTESTATION_MISMATCH",
        `${boundary} policy artifact is missing, reordered, widened, or otherwise differs from the validated plan.`,
      );
    }
  }
}

export function serializeFinopsAwsPolicyArtifact(
  artifact: FinopsAwsPolicyArtifact,
): string {
  assertSelfAttested(artifact);
  return canonicalJson(artifact);
}

export function serializeFinopsIamPolicyDocument(
  artifact: FinopsAwsPolicyArtifact,
): string {
  assertSelfAttested(artifact);
  return canonicalJson(artifact.policyDocument);
}
