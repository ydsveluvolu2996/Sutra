import type {
  CollectedControlResult,
  CollectedControlState,
  FrameworkReadinessControl,
  ReadinessScope,
  ReadinessState,
} from "./compliance-frameworks.ts";
import { UNKNOWN_READINESS_SCOPE } from "./compliance-frameworks.ts";

/**
 * User-defined ("custom") compliance frameworks: an operator maps their own
 * control catalog onto collected Sutra control ids. Definitions are validated
 * strictly at save time; evaluation mirrors the built-in framework engine's
 * evidence-honest semantics exactly (a parity test in
 * tests/compliance-custom-framework.test.ts pins the two engines together):
 * never PASS unless every mapped id was collected and passed, UNKNOWN
 * contaminates, NOT_COLLECTED when no mapped evidence exists at all.
 * A custom mapping is the operator's assertion, not licensed framework
 * content — the disclaimer says so on every result.
 */

export interface CustomFrameworkControlDefinition {
  readonly controlId: string;
  readonly title: string;
  readonly sutraControlIds: readonly string[];
}

export interface CustomFrameworkDefinition {
  readonly name: string;
  readonly title: string;
  readonly claimBoundary: string;
  readonly controls: readonly CustomFrameworkControlDefinition[];
}

export interface CustomFrameworkValidation {
  readonly definition: CustomFrameworkDefinition | null;
  readonly errors: readonly string[];
}

export interface CustomFrameworkReadiness {
  readonly schema: "sutra.compliance-custom-framework-readiness.v1";
  readonly framework: {
    readonly id: string;
    readonly title: string;
    readonly availability: "user-defined-mapping";
    readonly claimBoundary: string;
  };
  readonly scope: ReadinessScope;
  readonly controls: readonly FrameworkReadinessControl[];
  readonly summary: Readonly<Record<ReadinessState, number>>;
  readonly unmappedControlIds: readonly string[];
  readonly disclaimer: string;
}

export const CUSTOM_FRAMEWORK_DISCLAIMER =
  "This readiness view evaluates an operator-defined control mapping against collected evidence. " +
  "The mapping is the operator's own assertion — it is not licensed framework content, a " +
  "certification, or an audit opinion. Controls without collected evidence are reported as " +
  "NOT_COLLECTED, never as passing.";

export const CUSTOM_FRAMEWORK_MAX_CONTROLS = 200;
export const CUSTOM_FRAMEWORK_MAX_MAPPED_IDS = 20;

const NAME = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const CONTROL_ID = /^[A-Za-z0-9][A-Za-z0-9 ().:_/-]{0,63}$/u;
const SUTRA_CONTROL_ID = /^[A-Z0-9][A-Z0-9._-]{1,127}$/iu;
const MAX_TITLE = 160;
const MAX_CLAIM = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate an untrusted custom-framework definition, reporting every problem. */
export function validateCustomFrameworkDefinition(input: unknown): CustomFrameworkValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { definition: null, errors: ["definition must be an object"] };
  if (typeof input.name !== "string" || !NAME.test(input.name)) {
    errors.push("name must be 2-64 lowercase letters, digits or hyphens");
  }
  if (typeof input.title !== "string" || input.title.trim().length === 0 || input.title.length > MAX_TITLE) {
    errors.push("title must be a non-empty string of at most 160 characters");
  }
  const claimBoundary = input.claimBoundary === undefined
    ? "Operator-defined mapping; readiness view only."
    : input.claimBoundary;
  if (typeof claimBoundary !== "string" || claimBoundary.length === 0 || claimBoundary.length > MAX_CLAIM) {
    errors.push("claimBoundary must be a non-empty string of at most 500 characters");
  }
  if (!Array.isArray(input.controls) || input.controls.length === 0) {
    errors.push("controls must be a non-empty array");
    return { definition: null, errors };
  }
  if (input.controls.length > CUSTOM_FRAMEWORK_MAX_CONTROLS) {
    errors.push(`controls exceeds the maximum of ${CUSTOM_FRAMEWORK_MAX_CONTROLS}`);
  }
  const seenControlIds = new Set<string>();
  const controls: CustomFrameworkControlDefinition[] = [];
  input.controls.forEach((raw, index) => {
    const label = `controls[${index}]`;
    if (!isRecord(raw)) { errors.push(`${label} must be an object`); return; }
    if (typeof raw.controlId !== "string" || !CONTROL_ID.test(raw.controlId)) {
      errors.push(`${label}.controlId is missing or malformed`);
      return;
    }
    if (seenControlIds.has(raw.controlId)) { errors.push(`${label}.controlId duplicates ${raw.controlId}`); return; }
    if (typeof raw.title !== "string" || raw.title.trim().length === 0 || raw.title.length > MAX_TITLE) {
      errors.push(`${label}.title must be a non-empty string of at most 160 characters`);
      return;
    }
    if (!Array.isArray(raw.sutraControlIds) || raw.sutraControlIds.length === 0) {
      errors.push(`${label}.sutraControlIds must be a non-empty array`);
      return;
    }
    if (raw.sutraControlIds.length > CUSTOM_FRAMEWORK_MAX_MAPPED_IDS) {
      errors.push(`${label}.sutraControlIds exceeds the maximum of ${CUSTOM_FRAMEWORK_MAX_MAPPED_IDS}`);
      return;
    }
    const mapped: string[] = [];
    for (const id of raw.sutraControlIds) {
      if (typeof id !== "string" || !SUTRA_CONTROL_ID.test(id)) {
        errors.push(`${label}.sutraControlIds contains a malformed id`);
        return;
      }
      mapped.push(id);
    }
    seenControlIds.add(raw.controlId);
    controls.push({ controlId: raw.controlId, title: raw.title, sutraControlIds: mapped });
  });
  if (errors.length > 0) return { definition: null, errors };
  return {
    definition: {
      name: input.name as string,
      title: (input.title as string).trim(),
      claimBoundary: claimBoundary as string,
      controls,
    },
    errors: [],
  };
}

/* Aggregation semantics below intentionally mirror lib/compliance-frameworks.ts
 * (resolveCollectedState / aggregateControlState). Do not "improve" one side
 * without the other — the parity test pins them together. */

function resolveCollectedState(states: readonly CollectedControlState[]): CollectedControlState {
  if (states.some((state) => state === "UNKNOWN")) return "UNKNOWN";
  if (states.some((state) => state === "FAIL")) return "FAIL";
  return "PASS";
}

function aggregateControlState(counts: {
  readonly passCount: number;
  readonly failCount: number;
  readonly unknownCount: number;
  readonly notCollectedCount: number;
}): ReadinessState {
  if (counts.passCount + counts.failCount + counts.unknownCount === 0) return "NOT_COLLECTED";
  if (counts.unknownCount > 0) return "UNKNOWN";
  if (counts.failCount > 0) return "FAIL";
  if (counts.notCollectedCount > 0) return "UNKNOWN";
  return "PASS";
}

/** Evaluate a validated custom framework against collected control results. */
export function buildCustomFrameworkReadiness(
  collectedControlResults: readonly CollectedControlResult[],
  definition: CustomFrameworkDefinition,
  scope: ReadinessScope = UNKNOWN_READINESS_SCOPE,
): CustomFrameworkReadiness {
  const statesById = new Map<string, CollectedControlState[]>();
  for (const result of collectedControlResults) {
    const existing = statesById.get(result.controlId);
    if (existing === undefined) statesById.set(result.controlId, [result.state]);
    else existing.push(result.state);
  }
  const resolvedById = new Map<string, CollectedControlState>();
  for (const [controlId, states] of statesById) resolvedById.set(controlId, resolveCollectedState(states));

  const mappedSutraIds = new Set<string>();
  const controls: FrameworkReadinessControl[] = definition.controls.map((control) => {
    let passCount = 0;
    let failCount = 0;
    let unknownCount = 0;
    let notCollectedCount = 0;
    const mappedEvidence = control.sutraControlIds.map((sutraControlId) => {
      mappedSutraIds.add(sutraControlId);
      const resolved = resolvedById.get(sutraControlId);
      if (resolved === undefined) {
        notCollectedCount += 1;
        return { sutraControlId, state: "NOT_COLLECTED" as ReadinessState };
      }
      if (resolved === "PASS") passCount += 1;
      else if (resolved === "FAIL") failCount += 1;
      else unknownCount += 1;
      return { sutraControlId, state: resolved as ReadinessState };
    });
    return {
      controlId: control.controlId,
      title: control.title,
      state: aggregateControlState({ passCount, failCount, unknownCount, notCollectedCount }),
      mappedSutraControlIds: control.sutraControlIds,
      mappedEvidence,
      passCount,
      failCount,
      unknownCount,
      notCollectedCount,
    };
  });

  const summary: Record<ReadinessState, number> = { PASS: 0, FAIL: 0, UNKNOWN: 0, NOT_COLLECTED: 0 };
  for (const control of controls) summary[control.state] += 1;
  const unmappedControlIds = [...resolvedById.keys()]
    .filter((controlId) => !mappedSutraIds.has(controlId))
    .sort((left, right) => left.localeCompare(right, "en-US"));

  return {
    schema: "sutra.compliance-custom-framework-readiness.v1",
    framework: {
      id: `custom:${definition.name}`,
      title: definition.title,
      availability: "user-defined-mapping",
      claimBoundary: definition.claimBoundary,
    },
    scope,
    controls,
    summary,
    unmappedControlIds,
    disclaimer: CUSTOM_FRAMEWORK_DISCLAIMER,
  };
}
