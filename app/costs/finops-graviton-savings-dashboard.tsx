"use client";
import { useEffect, useState } from "react";
import {
  GRAVITON_SAVINGS_OFFICIAL_DEFINITION,
  type GravitonSavingsOfficialDefinition,
} from "../../lib/finops-graviton-savings-official-definition";
import type {
  GravitonOpportunity,
  GravitonUsagePeriod,
} from "../../lib/finops-graviton-savings";
import styles from "./finops-graviton-savings-dashboard.module.css";
interface Filters {
  readonly accountId?: string;
  readonly region?: string;
  readonly resourceType?: string;
  readonly state?: string;
  readonly currency?: string;
}
interface Period {
  readonly periodStartAt: string;
  readonly periodEndAt: string;
  readonly currency: string;
  readonly amountMicros: string;
}
interface Summary {
  readonly resources: number;
  readonly ready: number;
  readonly reviewRequired: number;
  readonly blocked: number;
  readonly configurationRequired: number;
  readonly modeledPotentialByPeriod: readonly Period[];
  readonly measuredRealizedByPeriod: readonly Period[];
}
export interface GravitonDashboardEnvelope {
  readonly connectionId: string;
  readonly sourceState:
    | "complete"
    | "partial"
    | "stale"
    | "empty"
    | "configuration_required";
  readonly officialDefinition: GravitonSavingsOfficialDefinition;
  readonly resultCount: number;
  readonly opportunities: readonly GravitonOpportunity[];
  readonly summary: Summary;
  readonly existingUsage: {
    readonly series: readonly GravitonUsagePeriod[];
    readonly arm64ByService: readonly {
      readonly resourceType: string;
      readonly periods: readonly GravitonUsagePeriod[];
      readonly resourceCount: number;
    }[];
  };
  readonly serviceSummaries: readonly {
    readonly resourceType: string;
    readonly currency: string;
    readonly opportunities: number;
    readonly ready: number;
    readonly providerEstimateMicros: string;
    readonly modeledPotentialMicros: string;
    readonly realizedMicros: string;
  }[];
  readonly history: readonly Readonly<Record<string, unknown>>[];
  readonly filterOptions: {
    readonly accounts: readonly string[];
    readonly regions: readonly string[];
    readonly resourceTypes: readonly string[];
    readonly states: readonly string[];
    readonly currencies: readonly string[];
  };
  readonly freshness: Readonly<Record<string, unknown>>;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly collection: Readonly<Record<string, unknown>>;
  readonly disclosures: readonly string[];
}
function money(value: string | null, currency: string) {
  if (value === null) return "Unavailable";
  const n = BigInt(value),
    whole = n / BigInt(1_000_000),
    fraction = (n % BigInt(1_000_000)).toString().padStart(6, "0").slice(0, 2);
  return `${currency} ${whole}.${fraction}`;
}
function stateMessage(state: GravitonDashboardEnvelope["sourceState"]) {
  if (state === "complete") return null;
  if (state === "partial")
    return "Some opportunities are blocked, require review, or a newer incomplete collection is retained as audit history.";
  if (state === "stale")
    return "The accepted cross-service evidence is older than the 48-hour objective.";
  if (state === "empty")
    return "No existing Graviton usage or migration opportunities match this scope.";
  return "Deploy the cross-service collector and provide complete compatibility, CUR2, metadata, pricing, and recommendation evidence.";
}
function cell(value: string) {
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
function exportCsv(rows: readonly GravitonOpportunity[]) {
  const header = [
      "account",
      "region",
      "service",
      "resource",
      "state",
      "current",
      "target",
      "provider_estimate_micros",
      "modeled_potential_micros",
      "realized_micros",
      "currency",
      "blockers",
    ],
    body = rows.map((row) =>
      [
        row.accountId,
        row.region,
        row.resourceType,
        row.resourceId,
        row.state,
        row.currentConfiguration,
        row.targetConfiguration,
        row.providerEstimate?.savings.amountMicros ?? "",
        row.potentialSavings?.savings.amountMicros ?? "",
        row.realizedSavings?.observedSavings.amountMicros ?? "",
        row.potentialSavings?.savings.currency ??
          row.providerEstimate?.savings.currency ??
          row.realizedSavings?.observedSavings.currency ??
          "",
        row.blockerReasons.map((item) => item.code).join("|"),
      ]
        .map(cell)
        .join(","),
    ),
    url = URL.createObjectURL(
      new Blob([[header.join(","), ...body].join("\n")], {
        type: "text/csv;charset=utf-8",
      }),
    ),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "sutra-graviton-opportunities.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}
function Select({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string | undefined;
  readonly options: readonly string[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function coverageLabel(value: string): string {
  if (value === "NATIVE_EVIDENCE_PARTIAL") return "Native evidence · partial parity";
  if (value === "MODEL_ONLY") return "Model evidence only";
  return "Definition and provenance";
}

function OfficialDefinitionPanel({
  definition,
  report,
}: {
  readonly definition: GravitonSavingsOfficialDefinition;
  readonly report?: GravitonDashboardEnvelope;
}) {
  const [selectedId, setSelectedId] = useState(definition.sheets[0]?.id ?? "");
  const selected = definition.sheets.find((sheet) => sheet.id === selectedId)
    ?? definition.sheets[0];
  const visibleResourceTypes = new Set<string>([
    ...(report?.opportunities.map((item) => item.resourceType) ?? []),
    ...(report?.existingUsage.series.map((item) => item.resourceType) ?? []),
  ]);
  const mappedTypes = selected?.nativeResourceTypes.filter((type) => visibleResourceTypes.has(type)) ?? [];
  return (
    <section className={styles.official} aria-label="Official Graviton Savings definition coverage">
      <header>
        <div>
          <small>AWS CID {definition.version} · immutable definition</small>
          <h3>{definition.totals.sheets} sheets · {definition.totals.visuals} upstream visuals mapped</h3>
          <p>Commit <code>{definition.sourceCommit.slice(0, 12)}…</code> · definition SHA-256 <code>{definition.definitionSha256.slice(0, 12)}…</code>. Object counts describe the pinned QuickSight source; Sutra does not claim exact layout parity.</p>
        </div>
        <dl>
          <div><dt>Controls</dt><dd>{definition.totals.parameterControls + definition.totals.filterControls}</dd></div>
          <div><dt>Parameters</dt><dd>{definition.totals.parameterDeclarations}</dd></div>
          <div><dt>Calculated fields</dt><dd>{definition.totals.calculatedFields}</dd></div>
          <div><dt>Filter groups</dt><dd>{definition.totals.filterGroups}</dd></div>
        </dl>
      </header>
      <nav aria-label="Official Graviton Savings sheets">
        {definition.sheets.map((sheet) => <button key={sheet.id} aria-current={selected?.id === sheet.id ? "page" : undefined} data-coverage={sheet.coverage} onClick={() => setSelectedId(sheet.id)} type="button"><strong>{sheet.name}</strong><small>{sheet.visualCount} visuals · {coverageLabel(sheet.coverage)}</small></button>)}
      </nav>
      {selected === undefined ? null : <article data-coverage={selected.coverage}>
        <div><small>Selected official sheet</small><h4>{selected.name}</h4><p>{selected.evidenceNote}</p><p className={styles.gap}><strong>Remaining:</strong> {selected.remainingGap}</p></div>
        <dl>
          <div><dt>Visual objects</dt><dd>{selected.visualCount}</dd></div>
          <div><dt>Visual types</dt><dd>{Object.entries(selected.visualTypes).map(([type, count]) => `${count} ${type.replace("Visual", "")}`).join(" · ") || "None"}</dd></div>
          <div><dt>Official controls</dt><dd>{[...selected.parameterControls, ...selected.filterControls].map((item) => item.title).join(" · ") || "None"}</dd></div>
          <div><dt>Visible mapped types</dt><dd>{mappedTypes.join(" · ") || (selected.nativeResourceTypes.length === 0 ? "Not a workload sheet" : "No matching accepted rows")}</dd></div>
        </dl>
      </article>}
    </section>
  );
}

function hasPinnedOfficialDefinition(definition: GravitonSavingsOfficialDefinition): boolean {
  return definition.sourceCommit === GRAVITON_SAVINGS_OFFICIAL_DEFINITION.sourceCommit
    && definition.manifestSha256 === GRAVITON_SAVINGS_OFFICIAL_DEFINITION.manifestSha256
    && definition.definitionSha256 === GRAVITON_SAVINGS_OFFICIAL_DEFINITION.definitionSha256
    && definition.totals.sheets === 7
    && definition.totals.visuals === 122;
}

export function FinopsGravitonSavingsReportView({
  report,
  filters,
  onFiltersChange,
}: {
  readonly report: GravitonDashboardEnvelope;
  readonly filters: Filters;
  readonly onFiltersChange: (filters: Filters) => void;
}) {
  const status = stateMessage(report.sourceState),
    set = (key: keyof Filters, value: string) =>
      onFiltersChange({ ...filters, [key]: value || undefined });
  return (
    <section
      className={styles.root}
      aria-label="AWS Graviton savings dashboard"
    >
      <OfficialDefinitionPanel definition={report.officialDefinition} report={report} />
      <div className={styles.notice}>
        <strong>Evidence-backed migration economics.</strong> Existing Arm
        usage, AWS provider estimates, modeled potential savings, and measured
        realized savings are separate. A Graviton-looking family name never
        proves compatibility.
      </div>
      {status ? (
        <div role="status" className={`${styles.state} ${styles.warning}`}>
          {status}
        </div>
      ) : null}
      <div className={styles.filters} aria-label="Graviton filters">
        <Select
          label="Account"
          value={filters.accountId}
          options={report.filterOptions.accounts}
          onChange={(v) => set("accountId", v)}
        />
        <Select
          label="Region"
          value={filters.region}
          options={report.filterOptions.regions}
          onChange={(v) => set("region", v)}
        />
        <Select
          label="Service"
          value={filters.resourceType}
          options={report.filterOptions.resourceTypes}
          onChange={(v) => set("resourceType", v)}
        />
        <Select
          label="Eligibility"
          value={filters.state}
          options={report.filterOptions.states}
          onChange={(v) => set("state", v)}
        />
        <Select
          label="Currency"
          value={filters.currency}
          options={report.filterOptions.currencies}
          onChange={(v) => set("currency", v)}
        />
      </div>
      <section className={styles.panel} aria-label="Existing Graviton usage">
        <h3>Existing Graviton usage</h3>
        <div className={styles.grid}>
          {report.existingUsage.arm64ByService.map((service) => (
            <article className={styles.card} key={service.resourceType}>
              <small>{service.resourceType.replaceAll("_", " ")}</small>
              <strong>{service.resourceCount} resources</strong>
              <span>{service.periods.length} monthly ARM64 usage groups</span>
            </article>
          ))}
        </div>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Period</th>
                <th>Account / Region</th>
                <th>Service / configuration</th>
                <th>Architecture</th>
                <th>Usage hours</th>
                <th>Canonical cost</th>
              </tr>
            </thead>
            <tbody>
              {report.existingUsage.series.map((item) => (
                <tr
                  key={`${item.periodStartAt}:${item.accountId}:${item.resourceType}:${item.configuration}:${item.architecture}:${item.costBasis}`}
                >
                  <td>{item.periodStartAt.slice(0, 7)}</td>
                  <td>
                    {item.accountId}
                    <br />
                    {item.region}
                  </td>
                  <td>
                    {item.resourceType}
                    <br />
                    {item.configuration}
                  </td>
                  <td>
                    <span className={styles.pill}>{item.architecture}</span>
                  </td>
                  <td>{money(item.usageQuantityMicros, "hours")}</td>
                  <td>
                    {money(item.costMicros, item.currency)}
                    <br />
                    {item.costBasis.replaceAll("_", " ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className={styles.panel} aria-label="Service savings summary">
        <h3>EC2, RDS/Aurora, OpenSearch, and ElastiCache</h3>
        <div className={styles.grid}>
          {report.serviceSummaries.map((item) => (
            <article
              className={styles.card}
              key={`${item.resourceType}:${item.currency}`}
            >
              <small>
                {item.resourceType.replaceAll("_", " ")} · {item.currency}
              </small>
              <strong>
                {money(item.modeledPotentialMicros, item.currency)} modeled
              </strong>
              <span>
                {money(item.providerEstimateMicros, item.currency)} provider
                estimate
              </span>
              <span>
                {money(item.realizedMicros, item.currency)} measured realized
              </span>
              <span>
                {item.ready}/{item.opportunities} ready
              </span>
            </article>
          ))}
        </div>
      </section>
      <section className={styles.panel} aria-label="Monthly Graviton trends">
        <h3>Monthly savings trends</h3>
        <div className={styles.grid}>
          {report.summary.modeledPotentialByPeriod.map((item) => (
            <article
              className={styles.card}
              key={`p:${item.periodStartAt}:${item.currency}`}
            >
              <small>
                {item.periodStartAt.slice(0, 7)} · modeled potential
              </small>
              <strong>{money(item.amountMicros, item.currency)}</strong>
              <span>pricing model, not promise</span>
            </article>
          ))}
          {report.summary.measuredRealizedByPeriod.map((item) => (
            <article
              className={styles.card}
              key={`r:${item.periodStartAt}:${item.currency}`}
            >
              <small>
                {item.periodStartAt.slice(0, 7)} · measured realized
              </small>
              <strong>{money(item.amountMicros, item.currency)}</strong>
              <span>comparable observed evidence</span>
            </article>
          ))}
        </div>
      </section>
      <section
        className={styles.panel}
        aria-label="Graviton workload opportunities"
      >
        <div className={styles.head}>
          <h3>Workload drilldown · {report.resultCount}</h3>
          <button
            type="button"
            className={styles.button}
            onClick={() => exportCsv(report.opportunities)}
          >
            Export visible rows
          </button>
        </div>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Account / Region</th>
                <th>Service / resource</th>
                <th>Current → target</th>
                <th>Eligibility</th>
                <th>Savings evidence</th>
                <th>Compatibility and blockers</th>
              </tr>
            </thead>
            <tbody>
              {report.opportunities.map((row) => (
                <tr key={row.recommendationId}>
                  <td>
                    {row.accountId}
                    <br />
                    {row.region}
                  </td>
                  <td>
                    {row.resourceType}
                    <br />
                    {row.resourceId}
                  </td>
                  <td>
                    {row.currentConfiguration}
                    <br />→ {row.targetConfiguration}
                  </td>
                  <td>
                    <span className={styles.pill}>{row.state}</span>
                    <br />
                    {row.migrationEffort} effort
                    <br />
                    {row.recommendationAuthority.replaceAll("_", " ")}
                  </td>
                  <td>
                    Provider:{" "}
                    {money(
                      row.providerEstimate?.savings.amountMicros ?? null,
                      row.providerEstimate?.savings.currency ?? "",
                    )}
                    <br />
                    Modeled:{" "}
                    {money(
                      row.potentialSavings?.savings.amountMicros ?? null,
                      row.potentialSavings?.savings.currency ?? "",
                    )}
                    <br />
                    Realized:{" "}
                    {money(
                      row.realizedSavings?.observedSavings.amountMicros ?? null,
                      row.realizedSavings?.observedSavings.currency ?? "",
                    )}
                  </td>
                  <td>
                    {row.blockerReasons.length
                      ? row.blockerReasons.map((item) => item.code).join(", ")
                      : "All five compatibility dimensions and economics evidenced"}
                    <br />
                    {row.evidenceIds.length} evidence references
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <details className={`${styles.panel} ${styles.evidence}`}>
        <summary>
          Provenance, freshness, collection, history, and disclosures
        </summary>
        <pre>
          {JSON.stringify(
            {
              freshness: report.freshness,
              evidence: report.evidence,
              collection: report.collection,
              history: report.history,
              disclosures: report.disclosures,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  );
}
export function FinopsGravitonSavingsDashboard({
  connectionId,
}: {
  readonly connectionId: string | null;
}) {
  const [filters, setFilters] = useState<Filters>({}),
    [state, setState] = useState<{
      report: GravitonDashboardEnvelope | null;
      error: string | null;
      configurationRequired: boolean;
      configurationDefinition?: GravitonSavingsOfficialDefinition;
    }>({ report: null, error: null, configurationRequired: false });
  useEffect(() => {
    if (connectionId === null) return;
    const controller = new AbortController(),
      parameters = new URLSearchParams({ connectionId });
    for (const [key, value] of Object.entries(filters))
      if (value) parameters.set(key, value);
    fetch(`/api/v1/finops/graviton-savings?${parameters.toString()}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Graviton dashboard request failed");
        return response.json() as Promise<GravitonDashboardEnvelope | {
          readonly dashboard: null;
          readonly officialDefinition: GravitonSavingsOfficialDefinition;
        }>;
      })
      .then((report) => {
        if ("dashboard" in report && report.dashboard === null) {
          if (!hasPinnedOfficialDefinition(report.officialDefinition)) {
            throw new Error("Sutra returned an unrecognized Graviton dashboard definition");
          }
          setState({ report: null, error: null, configurationRequired: true, configurationDefinition: report.officialDefinition });
          return;
        }
        if (!hasPinnedOfficialDefinition(report.officialDefinition)) {
          throw new Error("Sutra returned an unrecognized Graviton dashboard definition");
        }
        setState({
          report: report as GravitonDashboardEnvelope,
          error: null,
          configurationRequired: false,
        });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            report: null,
            error:
              error instanceof Error
                ? error.message
                : "Graviton dashboard request failed",
            configurationRequired: false,
          });
      });
    return () => controller.abort();
  }, [connectionId, filters]);
  if (connectionId === null)
    return (
      <div role="status" className={`${styles.state} ${styles.warning}`}>
        Connect an active AWS trust-role payer before collecting Graviton
        evidence.
      </div>
    );
  if (state.configurationRequired)
    return (
      <section className={styles.root}>
        <OfficialDefinitionPanel definition={state.configurationDefinition ?? GRAVITON_SAVINGS_OFFICIAL_DEFINITION} />
        <div role="status" className={`${styles.state} ${styles.warning}`}>
          Deploy the cross-service materializer and bind Compute Optimizer or
          authoritative service evidence, CUR2, pricing, inventory, and
          compatibility. The official sheet inventory remains available above,
          but no workload values are synthesized.
        </div>
      </section>
    );
  if (state.error !== null)
    return (
      <div role="alert" className={`${styles.state} ${styles.error}`}>
        {state.error}
      </div>
    );
  if (state.report === null || state.report.connectionId !== connectionId)
    return (
      <div role="status" className={styles.state}>
        Loading Graviton evidence…
      </div>
    );
  return (
    <FinopsGravitonSavingsReportView
      report={state.report}
      filters={filters}
      onFiltersChange={setFilters}
    />
  );
}
