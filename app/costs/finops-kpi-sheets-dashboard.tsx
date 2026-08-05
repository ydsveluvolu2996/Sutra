"use client";

import { useMemo, useState } from "react";
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
 * Goals are read-only here. They are versioned and RBAC-protected server-side,
 * and the official QuickSight parameter sliders are deliberately not reproduced
 * as if they mutated anything.
 */

type KpiReport = Extract<FinopsKpiResult, { readonly ok: true }>;
type KpiMeasurement = KpiReport["measurements"][number];
type KpiFormula = KpiReport["formulaRegistry"][number];

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

/** Set KPI Goals: the versioned, RBAC-governed goals currently in force. */
function GoalsSheet({ report, goalsConfigured }: {
  readonly report: KpiReport;
  readonly goalsConfigured: number;
}) {
  const withGoals = report.measurements.filter((measurement) => measurement.selectedGoal !== null);
  const formulas = new Map(report.formulaRegistry.map((entry) => [entry.id as string, entry]));

  return (
    <div className={styles.blocks}>
      <FinopsSheetBlock
        description="Goals are versioned and RBAC-protected server-side. This panel is deliberately read-only: it does not reproduce the official QuickSight sliders as if they changed a stored goal."
        title="Goals in force"
      >
        <div className={styles.tiles}>
          <Tile label="Goal versions stored" value={formatCount(goalsConfigured)} />
          <Tile label="KPIs with a goal in force" value={formatCount(withGoals.length)} />
          <Tile label="Governed formulas" value={formatCount(report.formulaRegistry.length)} />
        </div>
      </FinopsSheetBlock>

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
  report, sheet, goalsConfigured,
}: {
  readonly report: KpiReport;
  readonly sheet: FinopsSheetDescriptor;
  readonly goalsConfigured: number;
}) {
  if (sheet.key === "about") return <AboutSheet report={report} />;
  if (sheet.key === "set-kpi-goals") {
    return <GoalsSheet goalsConfigured={goalsConfigured} report={report} />;
  }
  return <KpiSheet report={report} sheet={sheet} />;
}

/** Presentation for a loaded KPI report. */
export function FinopsKpiSheets({
  envelope, initialSheetKey,
}: {
  readonly envelope: { readonly report: unknown; readonly goalsConfigured: number };
  readonly initialSheetKey?: string;
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
        goalsConfigured={envelope.goalsConfigured}
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
      {envelope === null ? null : <FinopsKpiSheets envelope={envelope} />}
    </section>
  );
}
