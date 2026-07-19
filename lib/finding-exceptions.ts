// Finding exception / suppression engine: partitions collected findings into
// those still active and those suppressed by an accepted-risk exception, without
// ever synthesizing a clock. The caller passes "now" as a day number; this
// module reads no wall clock. Two honesty rules keep suppression trustworthy:
//   * A finding is suppressed only by a scope-matching exception that is VALID
//     (non-empty justification AND approver) and UNEXPIRED at nowDays. Anything
//     less is not silently dropped: a structurally broken exception is reported
//     in invalidExceptions with a cited reason, and its target finding stays
//     active.
//   * An exception with an empty scope is invalid ('empty-scope') rather than a
//     wildcard, so a missing scope can never blanket-suppress the whole fleet by
//     accident. Only explicitly present scope fields constrain; absent fields are
//     wildcards. Nothing is suppressed without a matching, valid, unexpired
//     exception, and every suppression cites the exception it came from.

export type FindingSeverity = "critical" | "high" | "medium" | "low";

export interface Finding {
  readonly id: string;
  readonly ruleId: string;
  readonly resourceRef: string;
  readonly severity: FindingSeverity;
  readonly tenant?: string;
}

export interface ExceptionScope {
  readonly ruleId?: string;
  readonly resourceRef?: string;
  readonly tenant?: string;
}

export interface FindingException {
  readonly id: string;
  readonly scope: ExceptionScope;
  readonly justification: string;
  readonly approvedBy: string;
  readonly createdAtDays: number;
  readonly expiresAtDays?: number | null;
}

export type InvalidExceptionReason =
  | "empty-scope"
  | "missing-justification"
  | "missing-approver"
  | "invalid-expiry";

export interface InvalidException {
  readonly id: string;
  readonly reason: InvalidExceptionReason;
}

export interface SuppressedFinding {
  readonly finding: Finding;
  readonly exceptionId: string;
  readonly justification: string;
  // Days until the citing exception expires, or null when it never expires.
  readonly expiresInDays: number | null;
}

export interface FindingExceptionSummary {
  readonly findings: number;
  readonly active: number;
  readonly suppressed: number;
  readonly exceptions: number;
  readonly activeExceptions: number;
  readonly expiredExceptions: number;
  readonly invalidExceptions: number;
  readonly appliedExceptions: number;
  readonly unusedExceptions: number;
}

export interface FindingExceptionReport {
  readonly schema: "sutra.finding-exceptions.v1";
  readonly active: readonly Finding[];
  readonly suppressed: readonly SuppressedFinding[];
  readonly invalidExceptions: readonly InvalidException[];
  readonly summary: FindingExceptionSummary;
  readonly disclaimer: string;
}

const FINDING_EXCEPTION_DISCLAIMER =
  "A finding is suppressed only by a scope-matching exception that carries a " +
  "non-empty justification and approver and has not expired at the caller-" +
  "provided nowDays. An exception with an empty scope, missing justification, " +
  "missing approver, or a non-finite created/expires day is reported as invalid " +
  "and suppresses nothing; an expired exception leaves its finding active. " +
  "Suppression is an accepted-risk record, not evidence the underlying finding " +
  "was fixed.";

function isEmptyScope(scope: ExceptionScope): boolean {
  return scope.ruleId === undefined && scope.resourceRef === undefined && scope.tenant === undefined;
}

/** Returns the reason an exception is structurally invalid, or null when it is well-formed. */
function invalidReason(exception: FindingException): InvalidExceptionReason | null {
  if (isEmptyScope(exception.scope)) return "empty-scope";
  if (exception.justification.trim().length === 0) return "missing-justification";
  if (exception.approvedBy.trim().length === 0) return "missing-approver";
  if (!Number.isFinite(exception.createdAtDays)) return "invalid-expiry";
  if (exception.expiresAtDays !== null && exception.expiresAtDays !== undefined && !Number.isFinite(exception.expiresAtDays)) {
    return "invalid-expiry";
  }
  return null;
}

/** A null/undefined expiry never expires; otherwise expired when created + expires <= nowDays. */
function isExpired(exception: FindingException, nowDays: number): boolean {
  if (exception.expiresAtDays === null || exception.expiresAtDays === undefined) return false;
  return exception.createdAtDays + exception.expiresAtDays <= nowDays;
}

function expiresInDaysOf(exception: FindingException, nowDays: number): number | null {
  if (exception.expiresAtDays === null || exception.expiresAtDays === undefined) return null;
  return exception.createdAtDays + exception.expiresAtDays - nowDays;
}

/** Each present scope field must equal the finding's; an absent scope field is a wildcard. */
function scopeMatches(scope: ExceptionScope, finding: Finding): boolean {
  if (scope.ruleId !== undefined && scope.ruleId !== finding.ruleId) return false;
  if (scope.resourceRef !== undefined && scope.resourceRef !== finding.resourceRef) return false;
  if (scope.tenant !== undefined && scope.tenant !== finding.tenant) return false;
  return true;
}

export function applyFindingExceptions(
  findings: readonly Finding[],
  exceptions: readonly FindingException[],
  nowDays: number,
): FindingExceptionReport {
  const invalidExceptions: InvalidException[] = [];
  const activeExceptions: FindingException[] = [];
  let expiredExceptions = 0;

  for (const exception of exceptions) {
    const reason = invalidReason(exception);
    if (reason !== null) {
      invalidExceptions.push({ id: exception.id, reason });
      continue;
    }
    if (isExpired(exception, nowDays)) {
      expiredExceptions += 1;
      continue;
    }
    activeExceptions.push(exception);
  }

  const active: Finding[] = [];
  const suppressed: SuppressedFinding[] = [];
  const appliedExceptionIds = new Set<string>();

  for (const finding of findings) {
    const match = activeExceptions.find((exception) => scopeMatches(exception.scope, finding));
    if (match === undefined) {
      active.push(finding);
      continue;
    }
    appliedExceptionIds.add(match.id);
    suppressed.push({
      finding,
      exceptionId: match.id,
      justification: match.justification,
      expiresInDays: expiresInDaysOf(match, nowDays),
    });
  }

  const summary: FindingExceptionSummary = {
    findings: findings.length,
    active: active.length,
    suppressed: suppressed.length,
    exceptions: exceptions.length,
    activeExceptions: activeExceptions.length,
    expiredExceptions,
    invalidExceptions: invalidExceptions.length,
    appliedExceptions: appliedExceptionIds.size,
    unusedExceptions: activeExceptions.length - appliedExceptionIds.size,
  };

  return {
    schema: "sutra.finding-exceptions.v1",
    active,
    suppressed,
    invalidExceptions,
    summary,
    disclaimer: FINDING_EXCEPTION_DISCLAIMER,
  };
}
