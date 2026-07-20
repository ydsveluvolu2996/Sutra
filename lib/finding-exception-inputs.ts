// Pure adapters between Sutra's persisted finding + exception-rule shapes and the
// finding-exception engine. Storage keeps absolute millisecond timestamps, but the
// engine reads no clock: it takes day numbers. These adapters convert ms to whole
// days (floor) so the caller passes a single `nowDays` alongside rules whose
// createdAtDays/expiresAtDays are derived the same way — never a wall clock read
// inside the engine. A stored scope field contributes a match dimension only when
// it is actually set; an absent field is left undefined (a wildcard within the
// tenant), so nothing is synthesized into the scope.
import type { Finding, FindingException, FindingSeverity } from "./finding-exceptions.ts";
import type { StoredFindingException } from "../db/finding-exception-repository.ts";

const DAY_MS = 86_400_000;

/** Whole days since the Unix epoch for an absolute millisecond timestamp. */
export function msToDays(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

// A stored finding as loaded from the active snapshot. Decoupled from PilotFinding
// so the adapter stays testable, but the field names match verbatim.
export interface SuppressibleFindingLike {
  readonly fingerprint: string;
  readonly controlKey: string;
  readonly resourceKey: string | null;
  readonly severity: FindingSeverity | "informational";
}

// The engine partitions by severity for display only; it never matches on it. The
// snapshot's 'informational' tier has no engine equivalent, so it maps to 'low'
// (the least severe) rather than being dropped.
function engineSeverity(severity: SuppressibleFindingLike["severity"]): FindingSeverity {
  return severity === "informational" ? "low" : severity;
}

export function findingToEngineFinding(item: SuppressibleFindingLike, tenant: string): Finding {
  return {
    id: item.fingerprint,
    ruleId: item.controlKey,
    resourceRef: item.resourceKey ?? "",
    severity: engineSeverity(item.severity),
    tenant,
  };
}

export function storedExceptionToEngineException(rule: StoredFindingException): FindingException {
  const scope: { ruleId?: string; resourceRef?: string } = {};
  if (rule.ruleId !== null) scope.ruleId = rule.ruleId;
  if (rule.resourceRef !== null) scope.resourceRef = rule.resourceRef;

  const createdAtDays = msToDays(rule.createdAtMs);
  // Engine expiry is a day count relative to createdAtDays (expired when
  // createdAtDays + expiresAtDays <= nowDays); null means it never expires.
  const expiresAtDays = rule.expiresAtMs === null ? null : msToDays(rule.expiresAtMs) - createdAtDays;

  return {
    id: rule.id,
    scope,
    justification: rule.justification,
    approvedBy: rule.approvedBy,
    createdAtDays,
    expiresAtDays,
  };
}
