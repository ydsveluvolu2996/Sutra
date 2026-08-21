"use client";

import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { BarChart, ShareBar } from "../components/charts";
import { EndpointBoundary, StateBadge, formatBasisPoints } from "./finops-foundational-panels";
import { EMPTY_KPI_FILTERS, useKpiEndpoint } from "./finops-foundational-endpoint";
import { FINOPS_KPI_SHEETS, type FinopsSheetDescriptor } from "./finops-foundational-sheets";
import {
  FinopsSheetBlock,
  FinopsSheetShell,
  foundationalStyles as styles,
} from "./finops-foundational-sheet-shell";
import { basisPointsToPercent, formatCount, formatPercent } from "./finops-foundational-money";
import type { FinopsKpiResult } from "../../lib/finops-kpi";

/**
 * FND-03 KPI and Modernization, presented as the ten sheets AWS publishes at
 * definition v2.2.1.
 *
 * Each service sheet shows exactly the governed formulas the official definition
 * assigns to it, so a KPI never appears on a sheet the audit does not place it
 * on. Ratios are exact: the engine emits an integer numerator, denominator and
 * basis-point value, and this view formats those rather than recomputing them.
 *
 * Goals are managed as immutable effective-dated versions through the existing
 * tenant-resolved API. The native controls do not imitate transient QuickSight
 * sliders: every accepted change has an audit reference and server-created RBAC
 * evidence, while overlaps and stale version attempts fail closed.
 */

type KpiReport = Extract<FinopsKpiResult, { readonly ok: true }>;
type KpiMeasurement = KpiReport["measurements"][number];
type KpiFormula = KpiReport["formulaRegistry"][number];

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const GOAL_ID = /^fkg_[a-f0-9]{32}$/u;
const PERCENT = /^(?:100(?:\.0{1,2})?|(?:\d|[1-9]\d)(?:\.\d{1,2})?)$/u;

interface StoredKpiGoal {
  readonly id: string;
  readonly version: number;
  readonly kpiId: string;
  readonly targetDirection: "higher_is_better" | "lower_is_better";
  readonly targetBasisPoints: number;
  readonly effectiveFromIso: string;
  readonly effectiveToIso: string | null;
  readonly actorId: string;
  readonly auditReference: string;
  readonly rbacDecisionId: string;
  readonly createdAtIso: string;
}

type GoalHistoryState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly goals: readonly StoredKpiGoal[] };

interface GoalDraft {
  readonly kpiId: string;
  readonly targetPercent: string;
  readonly effectiveFromLocal: string;
  readonly effectiveToLocal: string;
  readonly auditReference: string;
}

function record(
  value: unknown,
  keys: ReadonlySet<string>,
): Readonly<Record<string, unknown>> | null {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.has(key))
  ) return null;
  return value as Readonly<Record<string, unknown>>;
}

function validText(value: unknown, maximum = 1_024): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !value.includes("\0");
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Parse a percentage into exact integer basis points without float rounding. */
export function parseKpiGoalPercent(value: string): number | null {
  const normalized = value.trim();
  if (!PERCENT.test(normalized)) return null;
  const [whole = "", fraction = ""] = normalized.split(".");
  const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(basisPoints) && basisPoints <= 10_000
    ? basisPoints
    : null;
}

function localInputToIso(value: string): string | null {
  if (value.trim() === "") return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

function parseStoredGoal(
  value: unknown,
  expectedConnectionId: string,
  formulas: ReadonlyMap<string, KpiFormula>,
): StoredKpiGoal | null {
  const goal = record(value, new Set([
    "scope", "id", "version", "kpiId", "targetDirection",
    "targetBasisPoints", "effectiveFromIso", "effectiveToIso", "actorId",
    "auditReference", "rbacDecision", "createdAtIso",
  ]));
  if (goal === null) return null;
  const scope = record(goal.scope, new Set([
    "organizationId", "customerId", "connectionId",
  ]));
  const decision = record(goal.rbacDecision, new Set([
    "decisionId", "decision", "action", "resource", "actorId",
    "decidedAtIso", "policyVersion", "evidenceReference",
  ]));
  const formula = typeof goal.kpiId === "string"
    ? formulas.get(goal.kpiId)
    : undefined;
  if (
    scope === null
    || scope.connectionId !== expectedConnectionId
    || !validText(scope.organizationId, 256)
    || !validText(scope.customerId, 256)
    || !GOAL_ID.test(String(goal.id))
    || formula === undefined
    || !Number.isSafeInteger(goal.version)
    || Number(goal.version) < 1
    || Number(goal.version) > 1_000_000
    || goal.targetDirection !== formula.targetDirection
    || !Number.isSafeInteger(goal.targetBasisPoints)
    || Number(goal.targetBasisPoints) < 0
    || Number(goal.targetBasisPoints) > 10_000
    || !validIso(goal.effectiveFromIso)
    || (goal.effectiveToIso !== null && !validIso(goal.effectiveToIso))
    || (
      typeof goal.effectiveToIso === "string"
      && Date.parse(goal.effectiveToIso) <= Date.parse(goal.effectiveFromIso as string)
    )
    || !validText(goal.actorId, 256)
    || !validText(goal.auditReference)
    || !validIso(goal.createdAtIso)
    || decision === null
    || !validText(decision.decisionId, 256)
    || decision.decision !== "allow"
    || decision.action !== "finops:kpi-goal:write"
    || decision.actorId !== goal.actorId
    || !validIso(decision.decidedAtIso)
    || Date.parse(decision.decidedAtIso as string) > Date.parse(goal.effectiveFromIso as string)
    || !validText(decision.policyVersion, 256)
    || !validText(decision.evidenceReference)
    || decision.resource !== [
      "finops-kpi",
      scope.organizationId,
      scope.customerId,
      expectedConnectionId,
      goal.kpiId,
    ].join(":")
  ) return null;
  return {
    id: goal.id as string,
    version: Number(goal.version),
    kpiId: goal.kpiId as string,
    targetDirection: goal.targetDirection as StoredKpiGoal["targetDirection"],
    targetBasisPoints: Number(goal.targetBasisPoints),
    effectiveFromIso: goal.effectiveFromIso as string,
    effectiveToIso: goal.effectiveToIso as string | null,
    actorId: goal.actorId as string,
    auditReference: goal.auditReference as string,
    rbacDecisionId: decision.decisionId as string,
    createdAtIso: goal.createdAtIso as string,
  };
}

function parseGoalList(
  value: unknown,
  expectedConnectionId: string,
  formulas: ReadonlyMap<string, KpiFormula>,
): readonly StoredKpiGoal[] | null {
  if (!Array.isArray(value) || value.length > 2_000) return null;
  const goals = value.map((goal) =>
    parseStoredGoal(goal, expectedConnectionId, formulas));
  if (!goals.every((goal): goal is StoredKpiGoal => goal !== null)) return null;
  const ids = new Set(goals.map((goal) => goal.id));
  const versions = new Set(goals.map((goal) => `${goal.kpiId}:${goal.version}`));
  return ids.size === goals.length && versions.size === goals.length ? goals : null;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("Sutra returned an unreadable KPI goal response.");
  }
}

async function goalApiError(response: Response, body: unknown): Promise<never> {
  const envelope = record(body, new Set(["error", "requestId"]));
  const error = envelope === null
    ? null
    : record(envelope.error, new Set(["code", "message"]));
  if (response.status === 403) {
    throw new Error("Connection manage access is required to save KPI goals.");
  }
  if (response.status === 409) {
    throw new Error(
      typeof error?.message === "string"
        ? error.message
        : "The goal history changed or the effective window overlaps an existing version.",
    );
  }
  throw new Error(
    typeof error?.message === "string"
      ? error.message
      : `Sutra could not complete the KPI goal request (${response.status}).`,
  );
}

function goalOverlaps(
  goal: StoredKpiGoal,
  fromIso: string,
  toIso: string | null,
): boolean {
  const proposedEnd = toIso === null
    ? Date.parse("9999-12-31T23:59:59.999Z")
    : Date.parse(toIso);
  const existingEnd = goal.effectiveToIso === null
    ? Date.parse("9999-12-31T23:59:59.999Z")
    : Date.parse(goal.effectiveToIso);
  return Date.parse(goal.effectiveFromIso) < proposedEnd
    && Date.parse(fromIso) < existingEnd;
}

function Tile({
  label, value, detail,
}: { readonly label: string; readonly value: string; readonly detail?: string }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      {detail === undefined ? null : <span className={styles.tileDetail}>{detail}</span>}
    </div>
  );
}

function NoEvidence({ reason }: { readonly reason: string }) {
  return (
    <div className={styles.coverage} data-support="PARTIAL" role="status">
      <div className={styles.coverageHead}>
        <strong>Not measurable from the active generation</strong>
      </div>
      <ul className={styles.coverageGaps}><li>{reason}</li></ul>
    </div>
  );
}

/** One governed KPI: its exact ratio, its goal and why it may be unmeasured. */
function KpiRow({
  measurement, formula,
}: { readonly measurement: KpiMeasurement; readonly formula: KpiFormula | undefined }) {
  const goal = measurement.selectedGoal;
  const segment = measurement.segments[0] ?? null;
  const current = segment === null ? null : basisPointsToPercent(segment.currentBasisPoints);
  const target = goal === null ? null : basisPointsToPercent(goal.targetBasisPoints);

  return (
    <div className={styles.goalRow}>
      <span className={styles.goalName}>{formula?.label ?? measurement.kpiId}</span>
      <span className={styles.goalFigures}>
        <span className={styles.goalCurrent}>
          {current === null ? "Not measured" : formatPercent(current)}
        </span>
        {target === null
          ? <span className={styles.goalTarget}>no goal</span>
          : (
            <span className={styles.goalTarget}>
              goal {formatPercent(target)} ({goal!.targetDirection.replace(/_/gu, " ")})
            </span>
          )}
        <StateBadge state={segment?.goalStatus ?? measurement.state} />
      </span>

      {current === null ? null : (
        <span className={styles.goalTrack}>
          <ShareBar
            ariaLabel={`${formula?.label ?? measurement.kpiId} is ${formatPercent(current)}${
              target === null ? "" : ` against a goal of ${formatPercent(target)}`}`}
            formatValue={(value) => formatPercent(value)}
            segments={[
              { id: "current", label: "Measured", value: current, tone: "teal" },
              { id: "remainder", label: "Remainder", value: Math.max(0, 100 - current), tone: "slate" },
            ]}
          />
        </span>
      )}

      <span className={styles.goalMeta}>
        {segment === null
          ? null
          : (
            <>
              Exact ratio {segment.numerator} / {segment.denominator} on the{" "}
              {segment.basis.replace(/_/gu, " ")} basis
              {segment.usageUnit === null ? "" : ` in ${segment.usageUnit}`}
              {segment.gapBasisPoints === null
                ? ""
                : ` · gap ${formatBasisPoints(segment.gapBasisPoints)}`}
              {" · "}
            </>
          )}
        Evidence {measurement.evidenceCompleteness} · {formatCount(measurement.classifiableLineCount)} of{" "}
        {formatCount(measurement.eligibleLineCount)} eligible lines classifiable
        {measurement.reasonCodes.length === 0
          ? ""
          : ` · ${measurement.reasonCodes.map((code) => code.replace(/_/gu, " ").toLowerCase()).join("; ")}`}
      </span>

      {formula === undefined ? null : (
        <span className={`${styles.goalMeta} ${styles.goalFormula}`}>
          {formula.numeratorDefinition} ÷ {formula.denominatorDefinition}
        </span>
      )}
    </div>
  );
}

/** The governed KPIs assigned to one official sheet. */
function KpiSheet({
  report, sheet,
}: { readonly report: KpiReport; readonly sheet: FinopsSheetDescriptor }) {
  const byId = new Map(report.measurements.map((entry) => [entry.kpiId as string, entry]));
  const formulas = new Map(report.formulaRegistry.map((entry) => [entry.id as string, entry]));

  // The tracker, goals and summary sheets govern every formula; a service sheet
  // governs only the formulas the official definition assigns to it.
  const ids = sheet.formulaIds.length > 0
    ? sheet.formulaIds
    : report.formulaRegistry.map(({ id }) => id as string);

  const measurements = ids.flatMap((id) => {
    const measurement = byId.get(id);
    return measurement === undefined ? [] : [measurement];
  });

  if (measurements.length === 0) {
    return (
      <NoEvidence
        reason={`No measurement was produced for the ${ids.length} formula${ids.length === 1 ? "" : "s"} this sheet governs.`}
      />
    );
  }

  const measured = measurements.flatMap((measurement) => {
    const segment = measurement.segments[0];
    const percent = segment === undefined ? null : basisPointsToPercent(segment.currentBasisPoints);
    return percent === null ? [] : [{ measurement, percent }];
  });

  return (
    <div className={styles.blocks}>
      {measured.length === 0 ? null : (
        <FinopsSheetBlock
          description="Measured percentage against the governed goal for every KPI on this sheet. An unmeasured KPI is omitted from the chart and listed below with its reason."
          title="KPI position"
        >
          <BarChart
            ariaLabel={`Measured percentage for the ${measured.length} KPIs on the ${sheet.name} sheet`}
            categories={measured.map(({ measurement }) =>
              formulas.get(measurement.kpiId as string)?.label ?? measurement.kpiId)}
            formatValue={(value) => formatPercent(value)}
            series={[
              {
                id: "current",
                label: "Measured",
                values: measured.map(({ percent }) => percent),
                tone: "teal",
              },
              {
                id: "goal",
                label: "Goal",
                values: measured.map(({ measurement }) =>
                  measurement.selectedGoal === null
                    ? null
                    : basisPointsToPercent(measurement.selectedGoal.targetBasisPoints)),
                tone: "amber",
              },
            ]}
          />
        </FinopsSheetBlock>
      )}

      <FinopsSheetBlock
        description={`${measurements.length} governed formula${measurements.length === 1 ? "" : "s"}, each with its exact integer ratio and evidence completeness.`}
        title="Governed KPIs"
      >
        <div className={styles.goals}>
          {measurements.map((measurement) => (
            <KpiRow
              formula={formulas.get(measurement.kpiId as string)}
              key={measurement.kpiId}
              measurement={measurement}
            />
          ))}
        </div>
      </FinopsSheetBlock>
    </div>
  );
}

function KpiGoalManager({
  connectionId,
  onGoalsChanged,
  report,
}: {
  readonly connectionId: string | null;
  readonly onGoalsChanged?: () => void;
  readonly report: KpiReport;
}) {
  const formulas = useMemo(
    () => new Map(report.formulaRegistry.map((formula) => [formula.id as string, formula])),
    [report.formulaRegistry],
  );
  const firstFormula = report.formulaRegistry[0];
  const [draft, setDraft] = useState<GoalDraft>({
    kpiId: firstFormula?.id as string ?? "",
    targetPercent: "",
    effectiveFromLocal: "",
    effectiveToLocal: "",
    auditReference: "",
  });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [loaded, setLoaded] = useState<{
    readonly connectionId: string;
    readonly state: GoalHistoryState;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [mutation, setMutation] = useState<{
    readonly tone: "success" | "error";
    readonly message: string;
  } | null>(null);
  const connectionReady = connectionId !== null
    && CONNECTION_ID.test(connectionId)
    && report.scope.connectionId === connectionId;

  useEffect(() => {
    if (!connectionReady || connectionId === null) return;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        const query = new URLSearchParams({ connectionId });
        const response = await fetch(`/api/v1/finops/kpi-goals?${query.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        const body = await responseJson(response);
        if (!response.ok) await goalApiError(response, body);
        const envelope = record(body, new Set(["connectionId", "goals"]));
        const goals = envelope === null
          ? null
          : parseGoalList(envelope.goals, connectionId, formulas);
        if (envelope?.connectionId !== connectionId || goals === null) {
          throw new Error("Sutra returned invalid KPI goal history.");
        }
        if (active) {
          setLoaded({ connectionId, state: { status: "ready", goals } });
        }
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setLoaded({
          connectionId,
          state: {
            status: "failed",
            message: error instanceof Error
              ? error.message
              : "Sutra could not load KPI goal history.",
          },
        });
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [connectionId, connectionReady, formulas, reloadNonce]);

  const history: GoalHistoryState = connectionReady
    && connectionId !== null
    && loaded?.connectionId === connectionId
    ? loaded.state
    : { status: "loading" };
  const selectedFormula = formulas.get(draft.kpiId) ?? firstFormula;
  const goals = history.status === "ready" ? history.goals : [];
  const nextVersion = Math.max(
    0,
    ...goals
      .filter((goal) => goal.kpiId === selectedFormula?.id)
      .map((goal) => goal.version),
  ) + 1;
  const targetBasisPoints = parseKpiGoalPercent(draft.targetPercent);
  const effectiveFromIso = localInputToIso(draft.effectiveFromLocal);
  const effectiveToIso = draft.effectiveToLocal.trim() === ""
    ? null
    : localInputToIso(draft.effectiveToLocal);
  const overlapping = effectiveFromIso === null || history.status !== "ready"
    ? null
    : goals.find((goal) =>
      goal.kpiId === selectedFormula?.id
      && goalOverlaps(goal, effectiveFromIso, effectiveToIso));
  const validationMessage = !connectionReady
    ? "Select the same active AWS connection as this evidence generation before managing goals."
    : history.status === "loading"
      ? "Goal history is loading; saving remains disabled until version and overlap checks complete."
      : history.status === "failed"
        ? "Goal history is unavailable; saving is disabled rather than guessing the next version."
        : selectedFormula === undefined
          ? "Select a governed KPI formula."
          : targetBasisPoints === null
            ? "Enter a target from 0.00% through 100.00%, with at most two decimal places."
            : effectiveFromIso === null
              ? "Enter the local date and time when this immutable version starts."
              : draft.effectiveToLocal.trim() !== "" && effectiveToIso === null
                ? "Enter a valid optional end date and time."
                : effectiveToIso !== null
                  && Date.parse(effectiveToIso) <= Date.parse(effectiveFromIso)
                  ? "The optional end must be after the start."
                  : overlapping !== undefined && overlapping !== null
                    ? `The proposed window overlaps immutable version ${overlapping.version}; choose a non-overlapping future interval.`
                    : !validText(draft.auditReference)
                      ? "Enter a non-secret audit reference for this governed change."
                      : null;

  const updateDraft = (change: Partial<GoalDraft>) => {
    setDraft((current) => ({ ...current, ...change }));
    setMutation(null);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      connectionId === null
      || selectedFormula === undefined
      || targetBasisPoints === null
      || effectiveFromIso === null
      || validationMessage !== null
    ) {
      setMutation({ tone: "error", message: validationMessage ?? "The KPI goal is invalid." });
      return;
    }
    if (Date.parse(effectiveFromIso) < Date.now()) {
      setMutation({
        tone: "error",
        message: "The effective start must be in the future so the server authorization decision predates it.",
      });
      return;
    }
    setSaving(true);
    setMutation(null);
    try {
      const response = await fetch("/api/v1/finops/kpi-goals", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId,
          version: nextVersion,
          kpiId: selectedFormula.id,
          targetDirection: selectedFormula.targetDirection,
          targetBasisPoints,
          effectiveFromIso,
          effectiveToIso,
          auditReference: draft.auditReference,
        }),
      });
      const body = await responseJson(response);
      if (!response.ok) await goalApiError(response, body);
      const envelope = record(body, new Set(["saved", "goals"]));
      const saved = envelope === null
        ? null
        : parseStoredGoal(envelope.saved, connectionId, formulas);
      const savedGoals = envelope === null
        ? null
        : parseGoalList(envelope.goals, connectionId, formulas);
      if (
        saved === null
        || savedGoals === null
        || !savedGoals.some((goal) => goal.id === saved.id)
      ) throw new Error("Sutra returned invalid saved KPI goal evidence.");
      setLoaded({ connectionId, state: { status: "ready", goals: savedGoals } });
      setDraft((current) => ({
        ...current,
        targetPercent: "",
        effectiveFromLocal: "",
        effectiveToLocal: "",
        auditReference: "",
      }));
      setMutation({
        tone: "success",
        message: `Saved immutable ${saved.kpiId} goal version ${saved.version} with server authorization evidence.`,
      });
      onGoalsChanged?.();
    } catch (error) {
      setMutation({
        tone: "error",
        message: error instanceof Error
          ? error.message
          : "Sutra could not save the KPI goal.",
      });
      setLoaded(null);
      setReloadNonce((current) => current + 1);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <FinopsSheetBlock
        description="Create a non-overlapping, immutable effective-dated version. Sutra derives tenant, customer, actor and RBAC evidence from the signed-in session; this form never accepts AWS credentials."
        title="Governed goal change"
      >
        <form className={styles.blockGrid} onSubmit={(event) => void save(event)}>
          <div className={styles.field}>
            <label htmlFor="kpi-goal-formula">Governed KPI</label>
            <select
              disabled={!connectionReady || saving}
              id="kpi-goal-formula"
              onChange={(event) => updateDraft({ kpiId: event.target.value })}
              value={selectedFormula?.id ?? ""}
            >
              {report.formulaRegistry.map((formula) => (
                <option key={formula.id} value={formula.id}>{formula.label}</option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor="kpi-goal-direction">Target direction</label>
            <input
              id="kpi-goal-direction"
              readOnly
              value={selectedFormula?.targetDirection.replace(/_/gu, " ") ?? "Unavailable"}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="kpi-goal-version">Next immutable version</label>
            <input
              id="kpi-goal-version"
              readOnly
              value={history.status === "ready" ? nextVersion : "Unavailable until history loads"}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="kpi-goal-target">Target percentage</label>
            <input
              disabled={!connectionReady || saving}
              id="kpi-goal-target"
              inputMode="decimal"
              max="100"
              min="0"
              onChange={(event) => updateDraft({ targetPercent: event.target.value })}
              placeholder="75.00"
              step="0.01"
              type="number"
              value={draft.targetPercent}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="kpi-goal-from">Effective from (local time)</label>
            <input
              disabled={!connectionReady || saving}
              id="kpi-goal-from"
              onChange={(event) => updateDraft({ effectiveFromLocal: event.target.value })}
              type="datetime-local"
              value={draft.effectiveFromLocal}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="kpi-goal-to">Effective to (optional, local time)</label>
            <input
              disabled={!connectionReady || saving}
              id="kpi-goal-to"
              onChange={(event) => updateDraft({ effectiveToLocal: event.target.value })}
              type="datetime-local"
              value={draft.effectiveToLocal}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="kpi-goal-audit">Audit reference</label>
            <input
              autoComplete="off"
              disabled={!connectionReady || saving}
              id="kpi-goal-audit"
              maxLength={1_024}
              onChange={(event) => updateDraft({ auditReference: event.target.value })}
              placeholder="Change ticket or approval reference"
              type="text"
              value={draft.auditReference}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor="kpi-goal-save">Governed action</label>
            <button
              className={`${styles.tab} ${styles.tabActive}`}
              disabled={saving || validationMessage !== null}
              id="kpi-goal-save"
              type="submit"
            >
              {saving ? "Saving…" : "Save immutable version"}
            </button>
          </div>
        </form>
        <p className={styles.goalMeta}>
          An open-ended version remains in force indefinitely and blocks every
          successor for that KPI. Supply an end when the target is expected to
          change later; persisted versions are never edited or deleted.
        </p>
        {validationMessage === null ? null : (
          <p className={styles.goalMeta} role="status">{validationMessage}</p>
        )}
        {mutation === null ? null : (
          <div
            className={styles.coverage}
            data-support={mutation.tone === "success" ? "SUPPORTED" : "PARTIAL"}
            role={mutation.tone === "success" ? "status" : "alert"}
          >
            <div className={styles.coverageHead}><strong>{mutation.message}</strong></div>
          </div>
        )}
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description="Every returned row is tenant- and connection-scoped, immutable, and carries the server-created authorization decision that accepted it."
        title="Goal version history"
      >
        {!connectionReady ? (
          <NoEvidence reason="Goal history is unavailable until this report is bound to the selected active AWS connection." />
        ) : history.status === "loading" ? (
          <div className={styles.coverage} role="status">
            <div className={styles.coverageHead}><strong>Loading governed goal history…</strong></div>
          </div>
        ) : history.status === "failed" ? (
          <div className={styles.coverage} data-support="PARTIAL" role="alert">
            <div className={styles.coverageHead}><strong>Goal history unavailable</strong></div>
            <ul className={styles.coverageGaps}><li>{history.message}</li></ul>
            <button
              className={styles.tab}
              onClick={() => {
                setLoaded(null);
                setReloadNonce((current) => current + 1);
              }}
              type="button"
            >
              Retry history
            </button>
          </div>
        ) : history.goals.length === 0 ? (
          <div className={styles.coverage} data-support="SUPPORTED" role="status">
            <div className={styles.coverageHead}><strong>No persisted goal versions were returned for this connection.</strong></div>
          </div>
        ) : (
          <div className={styles.tableWrap} tabIndex={0}>
            <table className={styles.table}>
              <caption>{history.goals.length} immutable goal versions, including past and scheduled windows.</caption>
              <thead>
                <tr>
                  <th scope="col">KPI</th>
                  <th className={styles.numeric} scope="col">Version</th>
                  <th className={styles.numeric} scope="col">Target</th>
                  <th scope="col">Effective window</th>
                  <th scope="col">Audit reference</th>
                  <th scope="col">Authorization</th>
                </tr>
              </thead>
              <tbody>
                {history.goals.map((goal) => (
                  <tr key={goal.id}>
                    <th scope="row">{formulas.get(goal.kpiId)?.label ?? goal.kpiId}</th>
                    <td className={styles.numeric}>{formatCount(goal.version)}</td>
                    <td className={styles.numeric}>{formatBasisPoints(goal.targetBasisPoints)}</td>
                    <td>
                      {goal.effectiveFromIso} — {goal.effectiveToIso ?? "open ended"}
                      <br />created {goal.createdAtIso} by {goal.actorId}
                    </td>
                    <td>{goal.auditReference}</td>
                    <td>{goal.rbacDecisionId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FinopsSheetBlock>
    </>
  );
}

/** Set KPI Goals: the versioned, RBAC-governed goals currently in force. */
function GoalsSheet({
  connectionId,
  goalsConfigured,
  onGoalsChanged,
  report,
}: {
  readonly connectionId: string | null;
  readonly report: KpiReport;
  readonly goalsConfigured: number;
  readonly onGoalsChanged?: () => void;
}) {
  const withGoals = report.measurements.filter((measurement) => measurement.selectedGoal !== null);
  const formulas = new Map(report.formulaRegistry.map((entry) => [entry.id as string, entry]));

  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock
        description="Goals are immutable, effective-dated and RBAC-protected server-side. The controls below create audited versions instead of transient slider values."
        title="Goals in force"
      >
        <div className={styles.tiles}>
          <Tile label="Goal versions stored" value={formatCount(goalsConfigured)} />
          <Tile label="KPIs with a goal in force" value={formatCount(withGoals.length)} />
          <Tile label="Governed formulas" value={formatCount(report.formulaRegistry.length)} />
        </div>
      </FinopsSheetBlock>

      <KpiGoalManager
        connectionId={connectionId}
        onGoalsChanged={onGoalsChanged}
        report={report}
      />

      {withGoals.length === 0 ? (
        <NoEvidence reason="No goal version is in force for the evidence window, so no KPI is measured against a target." />
      ) : (
        <FinopsSheetBlock
          description="Every goal carries the actor, audit reference and authorization decision that created it."
          title="Goal governance"
        >
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>Versioned goals with their authorization evidence.</caption>
              <thead>
                <tr>
                  <th scope="col">KPI</th>
                  <th className={styles.numeric} scope="col">Version</th>
                  <th className={styles.numeric} scope="col">Target</th>
                  <th scope="col">Direction</th>
                  <th scope="col">Effective from</th>
                  <th scope="col">Authorization</th>
                </tr>
              </thead>
              <tbody>
                {withGoals.map((measurement) => {
                  const goal = measurement.selectedGoal!;
                  return (
                    <tr key={measurement.kpiId}>
                      <th scope="row">
                        {formulas.get(measurement.kpiId as string)?.label ?? measurement.kpiId}
                      </th>
                      <td className={styles.numeric}>{formatCount(goal.version)}</td>
                      <td className={styles.numeric}>{formatBasisPoints(goal.targetBasisPoints)}</td>
                      <td>{goal.targetDirection.replace(/_/gu, " ")}</td>
                      <td>{goal.effectiveFromIso}</td>
                      <td>{goal.rbacDecisionId}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </FinopsSheetBlock>
      )}
    </div>
  );
}

/** About: the formula registry, evidence window and candidate opportunities. */
function AboutSheet({ report }: { readonly report: KpiReport }) {
  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock title="Evidence window and lineage">
        <div className={styles.tiles}>
          <Tile label="Billing period" value={report.scope.billingPeriod} />
          <Tile label="Window start" value={report.evidenceWindow.startIso} />
          <Tile label="Window end" value={report.evidenceWindow.endIso} />
          <Tile label="Evaluated at" value={report.evidenceWindow.evaluatedAtIso} />
        </div>
        <p className={styles.goalMeta}>
          Source evidence {report.evidenceWindow.sourceEvidenceId} · generation{" "}
          {report.scope.generationId}
        </p>
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description={`${report.formulaRegistry.length} governed formulas. Every measurement is a CUR-derived candidate estimate requiring validation, never an authoritative inventory fact.`}
        title="Formula registry"
      >
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>Exact numerator and denominator definitions at formula version 1.0.0.</caption>
            <thead>
              <tr>
                <th scope="col">KPI</th>
                <th scope="col">Numerator</th>
                <th scope="col">Denominator</th>
                <th scope="col">Direction</th>
                <th scope="col">Needs authoritative evidence</th>
              </tr>
            </thead>
            <tbody>
              {report.formulaRegistry.map((formula) => (
                <tr key={formula.id}>
                  <th scope="row">{formula.label}</th>
                  <td>{formula.numeratorDefinition}</td>
                  <td>{formula.denominatorDefinition}</td>
                  <td>{formula.targetDirection.replace(/_/gu, " ")}</td>
                  <td>{formula.authoritativeEvidenceRequired ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </FinopsSheetBlock>

      <FinopsSheetBlock
        description={`${report.opportunities.length} candidate${report.opportunities.length === 1 ? "" : "s"}${report.opportunitiesTruncated ? ", list truncated" : ""}. Estimated savings are withheld unless an approved assumption supplies a rate.`}
        title="Modernization candidates"
      >
        {report.opportunities.length === 0 ? (
          <NoEvidence reason="No modernization candidate was observed in the active generation." />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>Candidate estimates requiring validation.</caption>
              <thead>
                <tr>
                  <th scope="col">KPI</th>
                  <th scope="col">Resource</th>
                  <th scope="col">Confidence</th>
                  <th className={styles.numeric} scope="col">Estimated savings</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {report.opportunities.map((opportunity, index) => (
                  <tr key={`${opportunity.kpiId}-${opportunity.sourceLineId}-${index}`}>
                    <th scope="row">{opportunity.kpiId}</th>
                    <td>{opportunity.resourceId ?? "Not supplied"}</td>
                    <td>{opportunity.confidence}</td>
                    <td className={styles.numeric}>
                      {opportunity.estimatedSavingsMicros === null
                        ? "Withheld"
                        : opportunity.estimatedSavingsMicros}
                    </td>
                    <td>{opportunity.reasonCode.replace(/_/gu, " ").toLowerCase()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FinopsSheetBlock>
    </div>
  );
}

/** One sheet's content, exported so any sheet can be rendered and asserted. */
export function FinopsKpiSheetContent({
  connectionId = null,
  goalsConfigured,
  onGoalsChanged,
  report,
  sheet,
}: {
  readonly report: KpiReport;
  readonly sheet: FinopsSheetDescriptor;
  readonly goalsConfigured: number;
  readonly connectionId?: string | null;
  readonly onGoalsChanged?: () => void;
}) {
  if (sheet.key === "about") return <AboutSheet report={report} />;
  if (sheet.key === "set-kpi-goals") {
    return (
      <GoalsSheet
        connectionId={connectionId}
        goalsConfigured={goalsConfigured}
        onGoalsChanged={onGoalsChanged}
        report={report}
      />
    );
  }
  return <KpiSheet report={report} sheet={sheet} />;
}

/** Presentation for a loaded KPI report. */
export function FinopsKpiSheets({
  connectionId = null,
  envelope,
  initialSheetKey,
  onGoalsChanged,
}: {
  readonly envelope: { readonly report: unknown; readonly goalsConfigured: number };
  readonly initialSheetKey?: string;
  readonly connectionId?: string | null;
  readonly onGoalsChanged?: () => void;
}) {
  const [sheetKey, setSheetKey] = useState<string>(
    initialSheetKey ?? FINOPS_KPI_SHEETS.sheets[0]!.key,
  );
  const sheet = useMemo(
    () => FINOPS_KPI_SHEETS.sheets.find((entry) => entry.key === sheetKey)
      ?? FINOPS_KPI_SHEETS.sheets[0]!,
    [sheetKey],
  );

  const report = envelope.report;
  if (report === null || typeof report !== "object" || (report as KpiReport).ok !== true) {
    return null;
  }

  return (
    <FinopsSheetShell
      activeKey={sheet.key}
      idPrefix="kpi"
      inventory={FINOPS_KPI_SHEETS}
      onSelectSheet={setSheetKey}
    >
      <FinopsKpiSheetContent
        connectionId={connectionId}
        goalsConfigured={envelope.goalsConfigured}
        onGoalsChanged={onGoalsChanged}
        report={report as KpiReport}
        sheet={sheet}
      />
    </FinopsSheetShell>
  );
}

export function FinopsKpiSheetsDashboard({
  connectionId,
}: { readonly connectionId: string | null }) {
  const { state, reload } = useKpiEndpoint(connectionId, EMPTY_KPI_FILTERS);
  const envelope = state.status === "ready" && "envelope" in state ? state.envelope : null;

  return (
    <section aria-label="KPI and Modernization dashboard" className={styles.shell}>
      <EndpointBoundary onRetry={reload} state={state} title="the KPI and Modernization dashboard" />
      {envelope === null ? null : (
        <FinopsKpiSheets
          connectionId={connectionId}
          envelope={envelope}
          onGoalsChanged={reload}
        />
      )}
    </section>
  );
}
