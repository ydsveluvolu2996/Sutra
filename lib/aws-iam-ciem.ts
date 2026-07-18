// AWS IAM CIEM (Cloud Infrastructure Entitlement Management): resolves the
// *effective* permissions of each IAM principal by subtracting explicit Deny
// from Allow at action granularity (with '*' wildcards), flags the dangerous
// grants (admin, privilege escalation, data access), scores the residual risk,
// and suggests right-sizing for services that last-access evidence shows unused.
// The cloud-IAM analogue of kubernetes-ciem.ts: pure and deterministic, every
// entitlement traced to a collected statement, nothing inferred. A principal
// whose statements were never collected is reported unresolved, never assumed
// to hold no permissions; conditions are surfaced but never evaluated.

export type IamEffect = "Allow" | "Deny";

export interface IamStatement {
  readonly effect: IamEffect;
  readonly actions: readonly string[];
  readonly resources: readonly string[];
  readonly conditionPresent?: boolean;
}

export interface IamPrincipal {
  readonly ref: string;
  readonly kind: "user" | "role";
  // `null` (or an empty list) means the policy evidence was not collected: it is
  // reported as unresolved, never assumed to grant nothing.
  readonly statements: readonly IamStatement[] | null;
  readonly tenant?: string | null;
}

export interface IamServiceLastAccessed {
  readonly serviceLastUsedDays?: number | null;
}

export interface AwsIamCiemInput {
  readonly principals: readonly IamPrincipal[];
  readonly lastAccessed?: Readonly<Record<string, IamServiceLastAccessed>>;
}

export type IamResolution = "resolved" | "unresolved";
export type IamConditionState = "none-present" | "conditions not evaluated";
export type IamRightSizeStatus = "unused-candidate" | "recently-used" | "unknown";

// TriState flags: a boolean when the statements were collected, `null` when the
// principal is unresolved and the fact cannot be decided from the evidence.
export interface IamEffectiveFlags {
  readonly adminLike: boolean | null;
  readonly privilegeEscalation: boolean | null;
  readonly dataAccess: boolean | null;
  readonly wildcardAction: boolean | null;
}

export interface IamRightSize {
  readonly status: IamRightSizeStatus;
  readonly serviceLastUsedDays: number | null;
  readonly thresholdDays: 90;
  readonly unusedServices: readonly string[];
  readonly note: string;
}

export interface AwsIamCiemPrincipalResult {
  readonly ref: string;
  readonly kind: "user" | "role";
  readonly tenant: string | null;
  readonly resolution: IamResolution;
  // `null` when unresolved: an unresolved principal has an unknown effective set,
  // never an empty one.
  readonly effectiveAllowed: readonly string[] | null;
  readonly deniedActions: readonly string[] | null;
  readonly flags: IamEffectiveFlags;
  readonly matchedEscalationActions: readonly string[];
  readonly matchedDataActions: readonly string[];
  readonly conditions: IamConditionState;
  readonly conditionalStatementCount: number;
  readonly riskScore: number | null;
  readonly rightSize: IamRightSize;
  readonly unresolvedReason: string | null;
}

export interface AwsIamCiemReport {
  readonly schema: "sutra.aws-iam-ciem.v1";
  readonly principals: readonly AwsIamCiemPrincipalResult[];
  readonly totals: {
    readonly principals: number;
    readonly resolved: number;
    readonly unresolved: number;
    readonly adminLike: number;
    readonly privilegeEscalation: number;
    readonly dataAccess: number;
    readonly rightSizeCandidates: number;
    readonly rightSizeUnknown: number;
  };
  readonly disclaimer: string;
}

const RIGHT_SIZE_THRESHOLD_DAYS = 90 as const;

const ESCALATION_ACTIONS: readonly string[] = [
  "iam:PassRole",
  "iam:CreatePolicyVersion",
  "iam:AttachRolePolicy",
  "iam:AttachUserPolicy",
  "iam:PutRolePolicy",
  "iam:PutUserPolicy",
  "iam:CreateAccessKey",
  "iam:UpdateAssumeRolePolicy",
  "iam:CreateLoginProfile",
];

const DATA_ACTIONS: readonly string[] = [
  "s3:GetObject",
  "s3:PutObject",
  "s3:DeleteObject",
  "secretsmanager:GetSecretValue",
  "dynamodb:GetItem",
  "dynamodb:PutItem",
  "dynamodb:UpdateItem",
  "dynamodb:DeleteItem",
  "dynamodb:Query",
  "dynamodb:Scan",
  "dynamodb:BatchGetItem",
  "dynamodb:BatchWriteItem",
  "rds-data:ExecuteStatement",
  "rds-data:BatchExecuteStatement",
  "rds-data:ExecuteSql",
  "rds-db:connect",
];

const RISK_WEIGHT = {
  adminLike: 100,
  privilegeEscalation: 60,
  dataAccess: 35,
  wildcardAction: 25,
} as const;

const CIEM_DISCLAIMER =
  "Effective permissions are the Allow action patterns of the collected policy " +
  "statements minus the Deny patterns that fully cover them, matched at action " +
  "granularity with '*' wildcards. Deny is applied by action across the " +
  "principal; per-resource and per-condition scoping is not modeled, and a Deny " +
  "that only narrows part of a wildcard grant leaves the broad Allow in place. " +
  "Conditions are surfaced but never evaluated. A principal whose statements " +
  "were not collected is reported unresolved, never assumed to hold no " +
  "permissions; 'unused' is asserted only with last-used evidence, otherwise " +
  "unknown.";

function lc(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function byLocale(left: string, right: string): number {
  return left.localeCompare(right, "en-US");
}

// L(sub) subseteq L(sup) for '*'-only globs (the AWS action wildcard language).
// A literal in `sup` covers only the same literal in `sub`; a '*' in `sup`
// absorbs any run of `sub` characters, including a '*' in `sub`; a '*' in `sub`
// aligned against a literal in `sup` can produce characters the literal cannot
// match, so it is never covered.
function globSubset(sub: string, sup: string): boolean {
  const memo = new Map<number, boolean>();
  const solve = (i: number, j: number): boolean => {
    const key = i * (sup.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let out: boolean;
    if (j === sup.length) out = i === sub.length;
    else if (sup[j] === "*") out = solve(i, j + 1) || (i < sub.length && solve(i + 1, j));
    else if (i === sub.length) out = false;
    else if (sub[i] === "*") out = false;
    else out = sub[i] === sup[j] && solve(i + 1, j + 1);
    memo.set(key, out);
    return out;
  };
  return solve(0, 0);
}

function isBroadResource(resource: string): boolean {
  return resource === "*" || resource.includes("*");
}

function unusedNote(days: number): string {
  return `Allowed services show no recorded use in ${days} days (> ${RIGHT_SIZE_THRESHOLD_DAYS}); candidate for right-sizing.`;
}

interface AllowGrant {
  readonly action: string;
  readonly resources: readonly string[];
}

function unresolvedResult(principal: IamPrincipal): AwsIamCiemPrincipalResult {
  return {
    ref: principal.ref,
    kind: principal.kind,
    tenant: principal.tenant ?? null,
    resolution: "unresolved",
    effectiveAllowed: null,
    deniedActions: null,
    flags: { adminLike: null, privilegeEscalation: null, dataAccess: null, wildcardAction: null },
    matchedEscalationActions: [],
    matchedDataActions: [],
    conditions: "none-present",
    conditionalStatementCount: 0,
    riskScore: null,
    rightSize: {
      status: "unknown",
      serviceLastUsedDays: null,
      thresholdDays: RIGHT_SIZE_THRESHOLD_DAYS,
      unusedServices: [],
      note: "Policy statements were not collected; effective permissions are unresolved.",
    },
    unresolvedReason: "policy statements not collected",
  };
}

function resolvePrincipal(
  principal: IamPrincipal,
  statements: readonly IamStatement[],
  lastAccessed: IamServiceLastAccessed | undefined,
): AwsIamCiemPrincipalResult {
  const allowStatements = statements.filter((statement) => statement.effect === "Allow");
  const denyStatements = statements.filter((statement) => statement.effect === "Deny");
  const denyPatterns = [...new Set(denyStatements.flatMap((statement) => statement.actions.map(lc)))];
  const survives = (patternLower: string): boolean =>
    !denyPatterns.some((deny) => globSubset(patternLower, deny));

  const allowGrants: AllowGrant[] = [];
  const seen = new Set<string>();
  const effectiveAllowed: string[] = [];
  for (const statement of allowStatements) {
    for (const action of statement.actions) {
      const actionLower = lc(action);
      if (!survives(actionLower)) continue;
      allowGrants.push({ action: actionLower, resources: statement.resources.map(lc) });
      if (seen.has(actionLower)) continue;
      seen.add(actionLower);
      effectiveAllowed.push(action);
    }
  }
  effectiveAllowed.sort(byLocale);
  const effectiveAllowedLower = effectiveAllowed.map(lc);

  const covers = (concrete: string): boolean => {
    const target = lc(concrete);
    return effectiveAllowedLower.some((pattern) => globSubset(target, pattern));
  };
  const coversBroadly = (concrete: string): boolean => {
    const target = lc(concrete);
    return allowGrants.some(
      (grant) => globSubset(target, grant.action) && grant.resources.some(isBroadResource),
    );
  };

  const starSurvives = effectiveAllowedLower.includes("*");
  const hasStarOnStar = allowStatements.some(
    (statement) =>
      statement.actions.some((action) => lc(action) === "*") &&
      statement.resources.some((resource) => resource === "*"),
  );
  const adminLike = hasStarOnStar && starSurvives;
  const wildcardAction = effectiveAllowedLower.some((pattern) => pattern.includes("*"));

  const matchedEscalationActions = ESCALATION_ACTIONS.filter(covers);
  if (coversBroadly("sts:AssumeRole")) matchedEscalationActions.push("sts:AssumeRole");
  if (covers("lambda:CreateFunction") && covers("iam:PassRole")) {
    matchedEscalationActions.push("lambda:CreateFunction+iam:PassRole");
  }
  matchedEscalationActions.sort(byLocale);
  const privilegeEscalation = matchedEscalationActions.length > 0;

  const matchedDataActions = DATA_ACTIONS.filter(covers).sort(byLocale);
  const dataAccess = matchedDataActions.length > 0;

  const conditionalStatementCount = statements.filter((statement) => statement.conditionPresent === true).length;
  const conditions: IamConditionState =
    conditionalStatementCount > 0 ? "conditions not evaluated" : "none-present";

  const riskScore =
    (adminLike ? RISK_WEIGHT.adminLike : 0) +
    (privilegeEscalation ? RISK_WEIGHT.privilegeEscalation : 0) +
    (dataAccess ? RISK_WEIGHT.dataAccess : 0) +
    (wildcardAction ? RISK_WEIGHT.wildcardAction : 0);

  const deniedActions = [...new Set(denyStatements.flatMap((statement) => statement.actions))].sort(byLocale);
  const effectiveServices = [...new Set(
    effectiveAllowedLower.map((pattern) => (pattern === "*" ? "*" : pattern.split(":", 1)[0] ?? pattern)),
  )].sort(byLocale);

  const rightSize = resolveRightSize(effectiveServices, lastAccessed);

  return {
    ref: principal.ref,
    kind: principal.kind,
    tenant: principal.tenant ?? null,
    resolution: "resolved",
    effectiveAllowed,
    deniedActions,
    flags: { adminLike, privilegeEscalation, dataAccess, wildcardAction },
    matchedEscalationActions,
    matchedDataActions,
    conditions,
    conditionalStatementCount,
    riskScore,
    rightSize,
    unresolvedReason: null,
  };
}

function resolveRightSize(
  effectiveServices: readonly string[],
  lastAccessed: IamServiceLastAccessed | undefined,
): IamRightSize {
  const days = lastAccessed?.serviceLastUsedDays;
  if (days === undefined || days === null) {
    return {
      status: "unknown",
      serviceLastUsedDays: null,
      thresholdDays: RIGHT_SIZE_THRESHOLD_DAYS,
      unusedServices: [],
      note: "No last-used evidence for this principal; usage is unknown, not assumed unused.",
    };
  }
  if (effectiveServices.length === 0) {
    return {
      status: "unknown",
      serviceLastUsedDays: days,
      thresholdDays: RIGHT_SIZE_THRESHOLD_DAYS,
      unusedServices: [],
      note: "No effective allowed services to evaluate for right-sizing.",
    };
  }
  if (days > RIGHT_SIZE_THRESHOLD_DAYS) {
    return {
      status: "unused-candidate",
      serviceLastUsedDays: days,
      thresholdDays: RIGHT_SIZE_THRESHOLD_DAYS,
      unusedServices: effectiveServices,
      note: unusedNote(days),
    };
  }
  return {
    status: "recently-used",
    serviceLastUsedDays: days,
    thresholdDays: RIGHT_SIZE_THRESHOLD_DAYS,
    unusedServices: [],
    note: `Last recorded service use ${days} days ago (<= ${RIGHT_SIZE_THRESHOLD_DAYS}).`,
  };
}

/**
 * True/false when the principal's collected statements decide it, `null` when the
 * principal is unresolved and the answer cannot be decided from the evidence.
 */
export function principalAllows(result: AwsIamCiemPrincipalResult, action: string): boolean | null {
  if (result.resolution === "unresolved" || result.effectiveAllowed === null) return null;
  const target = lc(action);
  return result.effectiveAllowed.some((pattern) => globSubset(target, lc(pattern)));
}

export function buildAwsIamCiem(input: AwsIamCiemInput): AwsIamCiemReport {
  const lastAccessed = input.lastAccessed ?? {};
  const principals = input.principals.map((principal) => {
    const statements = principal.statements;
    if (statements === null || statements.length === 0) return unresolvedResult(principal);
    return resolvePrincipal(principal, statements, lastAccessed[principal.ref]);
  });

  principals.sort((left, right) => {
    const leftScore = left.riskScore ?? -1;
    const rightScore = right.riskScore ?? -1;
    return rightScore - leftScore || byLocale(left.ref, right.ref);
  });

  const isFlag = (result: AwsIamCiemPrincipalResult, flag: keyof IamEffectiveFlags): boolean =>
    result.flags[flag] === true;

  return {
    schema: "sutra.aws-iam-ciem.v1",
    principals,
    totals: {
      principals: principals.length,
      resolved: principals.filter((result) => result.resolution === "resolved").length,
      unresolved: principals.filter((result) => result.resolution === "unresolved").length,
      adminLike: principals.filter((result) => isFlag(result, "adminLike")).length,
      privilegeEscalation: principals.filter((result) => isFlag(result, "privilegeEscalation")).length,
      dataAccess: principals.filter((result) => isFlag(result, "dataAccess")).length,
      rightSizeCandidates: principals.filter((result) => result.rightSize.status === "unused-candidate").length,
      rightSizeUnknown: principals.filter((result) => result.rightSize.status === "unknown").length,
    },
    disclaimer: CIEM_DISCLAIMER,
  };
}
