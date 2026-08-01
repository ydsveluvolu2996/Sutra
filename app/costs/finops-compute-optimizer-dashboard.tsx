"use client";

import { useEffect, useMemo, useState } from "react";
import type { ComputeOptimizerDashboardFilters } from
  "../../lib/finops-compute-optimizer-export-history";
import type { FinopsComputeOptimizerOfficialDefinition } from
  "../../lib/finops-compute-optimizer-official-definition";
import styles from "./finops-compute-optimizer-dashboard.module.css";

type Report = ReturnType<typeof import(
  "../../lib/finops-compute-optimizer-export-history"
).buildComputeOptimizerExportDashboard> & {
  readonly connectionId: string;
  readonly sourceState: string;
  readonly freshness: {
    readonly dataThroughAt: string;
    readonly ageHours: number;
    readonly staleAfterHours: number;
  };
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly officialDefinition: FinopsComputeOptimizerOfficialDefinition;
  readonly collection: {
    readonly available: false;
    readonly reason: string;
  };
};

const EMPTY: ComputeOptimizerDashboardFilters = {
  accountId: null,
  region: null,
  resourceType: null,
  utilization: null,
  primaryOwner: null,
  secondaryOwner: null,
  team: null,
  businessUnit: null,
  eligibilityTagKey: null,
  eligibilityTagValue: null,
  search: null,
};

const MODULE_TYPES: Readonly<Record<string, readonly string[]>> = {
  "EC2 instance": ["EC2_INSTANCE"],
  "Auto Scaling group": ["AUTO_SCALING_GROUP"],
  "EBS volume": ["EBS_VOLUME"],
  "Lambda function": ["LAMBDA_FUNCTION"],
  "RDS instance": ["RDS_DB_INSTANCE"],
  "RDS storage": ["RDS_DB_STORAGE", "AURORA_DB_CLUSTER_STORAGE"],
  "ECS service": ["ECS_SERVICE"],
  License: ["LICENSE"],
  "Idle resource": ["IDLE_RESOURCE"],
};

function Select({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly options: readonly string[];
  readonly onChange: (value: string | null) => void;
}) {
  return (
    <label>
      {label}
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option}>{option.replaceAll("_", " ")}</option>
        ))}
      </select>
    </label>
  );
}

function money(values: Readonly<Record<string, number>>): string {
  const entries = Object.entries(values);
  return entries.length > 0
    ? entries.map(([currency, value]) =>
      `${currency} ${value.toLocaleString(undefined, {
        maximumFractionDigits: 2,
      })}`).join(" · ")
    : "No estimated savings";
}

function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

function exportCsv(report: Report): void {
  const rows = report.rows.map((row) => [
    row.observedAt,
    row.recommendation.accountId,
    row.recommendation.region,
    row.recommendation.resourceType,
    row.recommendation.resourceId,
    row.utilization,
    row.recommendation.finding,
    row.ownership?.primaryOwner ?? "",
    row.ownership?.secondaryOwner ?? "",
    row.ownership?.team ?? "",
    row.ownership?.businessUnit ?? "",
    row.bestOption?.targetConfiguration ?? "",
    row.bestOption?.performanceRisk ?? "",
    row.bestOption?.savings?.estimatedMonthlySavings ?? "",
    row.bestOption?.savings?.currency ?? "",
    row.exportJobId,
    row.exportObjectSha256,
  ].map((value) => csvCell(String(value))).join(","));
  const header = "observed_at,account,region,resource_type,resource_id,utilization,finding,primary_owner,secondary_owner,team,business_unit,target,performance_risk,monthly_savings,currency,export_job,export_sha256";
  const url = URL.createObjectURL(new Blob(
    [[header, ...rows].join("\n")],
    { type: "text/csv;charset=utf-8" },
  ));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "sutra-compute-optimizer-export-history.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

function findingCounts(report: Report) {
  return [
    ["Overprovisioned", report.summary.overutilizedCount],
    ["Underprovisioned", report.summary.underutilizedCount],
    ["Idle", report.summary.idleCount],
    ["Optimized", report.rows.filter(({ utilization }) =>
      utilization === "OPTIMIZED").length],
    ["Other", report.rows.filter(({ utilization }) =>
      utilization === "OTHER").length],
  ] as const;
}

function riskCounts(report: Report) {
  const counts = new Map<string, number>();
  for (const row of report.rows) {
    const risk = row.recommendation.currentPerformanceRisk;
    const label = risk === null ? "Unavailable" : `${risk} · provider risk`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) =>
    left.localeCompare(right));
}

function resourceSavings(report: Report) {
  const grouped = new Map<string, Map<string, number>>();
  for (const row of report.rows) {
    const savings = row.bestOption?.savings;
    if (savings === null || savings === undefined) continue;
    const currencies = grouped.get(row.recommendation.resourceType)
      ?? new Map<string, number>();
    currencies.set(
      savings.currency,
      (currencies.get(savings.currency) ?? 0) + savings.estimatedMonthlySavings,
    );
    grouped.set(row.recommendation.resourceType, currencies);
  }
  return [...grouped.entries()].map(([name, currencies]) => ({
    name,
    savingsByCurrency: Object.fromEntries([...currencies.entries()].sort()),
  })).sort((left, right) => left.name.localeCompare(right.name));
}

export function ComputeOptimizerReportView({
  report,
  filters,
  onFiltersChange,
}: {
  readonly report: Report;
  readonly filters: ComputeOptimizerDashboardFilters;
  readonly onFiltersChange: (filters: ComputeOptimizerDashboardFilters) => void;
}) {
  const set = <K extends keyof ComputeOptimizerDashboardFilters>(
    key: K,
    value: ComputeOptimizerDashboardFilters[K],
  ) => onFiltersChange({ ...filters, [key]: value });
  const findings = findingCounts(report);
  const risks = riskCounts(report);
  const savingsByResource = resourceSavings(report);
  const maxFinding = Math.max(1, ...findings.map(([, count]) => count));
  const observedResourceTypes = new Set(report.filterOptions.resourceTypes);

  return (
    <section className={styles.root} aria-label="Compute Optimizer organization dashboard">
      <div className={styles.disclosure}>
        <strong>Export history only.</strong> Every trend and recommendation
        below comes from a completed, hash-addressed organization S3 export.
        Current direct API data and discovery status are never substituted.
      </div>
      {report.sourceState === "STALE" ? (
        <div role="status" className={styles.warning}>
          The newest accepted export is older than 48 hours.
        </div>
      ) : null}

      <section className={styles.definition} aria-label="Official AWS Compute Optimizer Dashboard coverage">
        <header>
          <div>
            <small>Immutable AWS audit · {report.officialDefinition.source.version}</small>
            <h3>Published Compute Optimizer modules</h3>
          </div>
          <span>
            Template {report.officialDefinition.source.templateId} ·{" "}
            {report.officialDefinition.source.commit.slice(0, 12)}
          </span>
        </header>
        <p>{report.officialDefinition.quickSightDefinition.disclosure}</p>
        <div className={styles.moduleGrid}>
          {report.officialDefinition.publishedModuleFamilies.map((module) => {
            const observed = (MODULE_TYPES[module] ?? []).some((type) =>
              observedResourceTypes.has(type as never));
            return (
              <article key={module}>
                <strong>{module}</strong>
                <span>{observed ? "Observed in accepted exports" : "No accepted rows"}</span>
              </article>
            );
          })}
        </div>
        <details className={styles.previewInventory}>
          <summary>Published preview visual inventory</summary>
          <ul>
            {report.officialDefinition.documentedPreviewVisuals.map((visual) => (
              <li key={visual}>{visual}</li>
            ))}
          </ul>
        </details>
        <small>
          Public definition state: not publicly committed · exact sheet,
          visual, filter-control, and parameter-control counts are unavailable
          and are not inferred from the preview image.
        </small>
      </section>

      <div className={styles.filters} aria-label="Compute Optimizer evidence filters">
        <Select label="Account" value={filters.accountId} options={report.filterOptions.accounts} onChange={(value) => set("accountId", value)} />
        <Select label="Region" value={filters.region} options={report.filterOptions.regions} onChange={(value) => set("region", value)} />
        <Select label="Resource type" value={filters.resourceType} options={report.filterOptions.resourceTypes} onChange={(value) => set("resourceType", value as ComputeOptimizerDashboardFilters["resourceType"])} />
        <Select label="Utilization" value={filters.utilization} options={["OVER", "UNDER", "IDLE", "OPTIMIZED", "OTHER"]} onChange={(value) => set("utilization", value as ComputeOptimizerDashboardFilters["utilization"])} />
        <Select label="Primary owner" value={filters.primaryOwner} options={report.filterOptions.primaryOwners} onChange={(value) => set("primaryOwner", value)} />
        <Select label="Secondary owner" value={filters.secondaryOwner} options={report.filterOptions.secondaryOwners} onChange={(value) => set("secondaryOwner", value)} />
        <Select label="Team" value={filters.team} options={report.filterOptions.teams} onChange={(value) => set("team", value)} />
        <Select label="Business unit" value={filters.businessUnit} options={report.filterOptions.businessUnits} onChange={(value) => set("businessUnit", value)} />
        <Select label="Eligibility tag" value={filters.eligibilityTagKey} options={report.filterOptions.eligibilityTagKeys} onChange={(value) => set("eligibilityTagKey", value)} />
        <Select label="Eligibility value" value={filters.eligibilityTagValue} options={report.filterOptions.eligibilityTagValues} onChange={(value) => set("eligibilityTagValue", value)} />
        <label>
          Search
          <input value={filters.search ?? ""} maxLength={128} onChange={(event) => set("search", event.target.value || null)} />
        </label>
      </div>

      <section className={styles.section}>
        <header>
          <h3>Organization right-sizing overview</h3>
          <button type="button" onClick={() => exportCsv(report)}>
            Export visible recommendations
          </button>
        </header>
        <div className={styles.cards}>
          <article><span>Recommendations</span><strong>{report.summary.recommendationCount}</strong><small>{report.summary.exportGenerationCount} immutable exports</small></article>
          <article><span>Underutilized</span><strong>{report.summary.underutilizedCount}</strong></article>
          <article><span>Overutilized</span><strong>{report.summary.overutilizedCount}</strong></article>
          <article><span>Idle</span><strong>{report.summary.idleCount}</strong></article>
          <article><span>Operational risk</span><strong>{report.summary.operationalRiskCount}</strong><small>provider performance risk &gt; 0</small></article>
          <article><span>Estimated monthly savings</span><strong>{money(report.summary.savingsByCurrency)}</strong><small>AWS estimate</small></article>
        </div>
      </section>

      <section className={styles.visualGrid}>
        <article className={styles.section}>
          <h3>Findings</h3>
          <div className={styles.bars}>
            {findings.map(([name, count]) => (
              <div key={name}>
                <span>{name}</span><b>{count}</b>
                <i aria-hidden="true"><em style={{ width: `${(count * 100) / maxFinding}%` }} /></i>
              </div>
            ))}
          </div>
        </article>
        <article className={styles.section}>
          <h3>Operational risk distribution</h3>
          {risks.map(([name, count]) => (
            <div className={styles.rank} key={name}>
              <strong>{name}</strong><span>{count}</span>
            </div>
          ))}
        </article>
        <article className={styles.section}>
          <h3>Potential savings by resource type</h3>
          {savingsByResource.length === 0 ? (
            <p className={styles.empty}>No provider savings estimates.</p>
          ) : savingsByResource.map((item) => (
            <div className={styles.rank} key={item.name}>
              <strong>{item.name.replaceAll("_", " ")}</strong>
              <small>{money(item.savingsByCurrency)}</small>
            </div>
          ))}
        </article>
      </section>

      <section className={styles.grid3}>
        <article className={styles.section}>
          <h3>Progress over time</h3>
          {report.progress.map((item) => <div className={styles.rank} key={item.name}><strong>{item.name}</strong><span>{item.count} recommendations</span><small>{money(item.savingsByCurrency)}</small></div>)}
        </article>
        <article className={styles.section}>
          <h3>By account</h3>
          {report.byAccount.map((item) => <div className={styles.rank} key={item.name}><strong>{item.name}</strong><span>{item.count}</span><small>{money(item.savingsByCurrency)}</small></div>)}
        </article>
        <article className={styles.section}>
          <h3>Team / business unit</h3>
          {report.byTeam.map((item) => <div className={styles.rank} key={`t:${item.name}`}><strong>Team · {item.name}</strong><span>{item.count}</span></div>)}
          {report.byBusinessUnit.map((item) => <div className={styles.rank} key={`b:${item.name}`}><strong>Business unit · {item.name}</strong><span>{item.count}</span></div>)}
        </article>
      </section>

      <section className={styles.section}>
        <header><h3>Right-sizing and risk recommendations</h3><span>EC2 · ASG · EBS · Lambda · all modeled services</span></header>
        <div className={styles.scroll} tabIndex={0} role="region" aria-label="Scrollable Compute Optimizer recommendation table">
          <table>
            <caption>Provider recommendations from accepted organization S3 exports</caption>
            <thead><tr><th>Export date</th><th>Account / Region</th><th>Resource</th><th>Finding</th><th>Owners</th><th>Recommended option</th><th>Savings / risk</th><th>Lineage</th></tr></thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={`${row.generationId}:${row.recommendation.resourceArn}`}>
                  <td>{row.observedAt}</td>
                  <td>{row.recommendation.accountId}<small>{row.recommendation.region}</small></td>
                  <td>{row.recommendation.resourceType}<small>{row.recommendation.resourceId}</small></td>
                  <td>{row.utilization}<small>{row.recommendation.finding} · {row.recommendation.findingReasonCodes.join(", ")}</small></td>
                  <td>{row.ownership?.primaryOwner ?? "Unassigned"}<small>Secondary: {row.ownership?.secondaryOwner ?? "Unassigned"} · {row.ownership?.team ?? "No team"} · {row.ownership?.businessUnit ?? "No business unit"}</small></td>
                  <td>{row.bestOption?.targetConfiguration ?? "No rank-1 option"}<small>Current {row.recommendation.currentConfiguration ?? "unavailable"} · Migration effort {row.bestOption?.migrationEffort ?? "unavailable"}</small></td>
                  <td>{row.bestOption?.savings ? `${row.bestOption.savings.currency} ${row.bestOption.savings.estimatedMonthlySavings}` : "No savings estimate"}<small>Performance risk {row.bestOption?.performanceRisk ?? row.recommendation.currentPerformanceRisk ?? "unavailable"}</small></td>
                  <td>{row.exportJobId}<small>{row.exportObjectSha256}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <details className={`${styles.section} ${styles.evidence}`}>
        <summary>Immutable export objects, hashes and limitations</summary>
        <pre>{JSON.stringify({
          officialDefinition: report.officialDefinition,
          freshness: report.freshness,
          lineage: report.lineage,
          evidence: report.evidence,
          collection: report.collection,
          limitations: report.limitations,
        }, null, 2)}</pre>
      </details>
    </section>
  );
}

export function FinopsComputeOptimizerDashboard({
  connectionId,
}: {
  readonly connectionId: string | null;
}) {
  const [filters, setFilters] = useState(EMPTY);
  const [state, setState] = useState<{
    readonly report: Report | null;
    readonly error: string | null;
    readonly configuration: boolean;
  }>({ report: null, error: null, configuration: false });
  const query = useMemo(() => {
    if (connectionId === null) return null;
    const parameters = new URLSearchParams({ connectionId });
    for (const [key, value] of Object.entries(filters)) {
      if (value !== null) parameters.set(key, value);
    }
    return parameters;
  }, [connectionId, filters]);

  useEffect(() => {
    if (connectionId === null || query === null) return;
    const controller = new AbortController();
    fetch(`/api/v1/finops/compute-optimizer?${query.toString()}`, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error("Compute Optimizer export history request failed");
      }
      return response.json();
    }).then((value) => {
      if (value.dashboard === null) {
        setState({ report: null, error: null, configuration: true });
      } else {
        setState({ report: value as Report, error: null, configuration: false });
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setState({
          report: null,
          error: error instanceof Error ? error.message : "Request failed",
          configuration: false,
        });
      }
    });
    return () => controller.abort();
  }, [connectionId, query]);

  if (connectionId === null) {
    return <div role="status" className={styles.warning}>Connect an active AWS trust-role account.</div>;
  }
  if (state.configuration) {
    return <div role="status" className={styles.warning}>No accepted organization S3 export history exists. Discovery cannot substitute for export objects.</div>;
  }
  if (state.error !== null) {
    return <div role="alert" className={styles.error}>{state.error}</div>;
  }
  if (state.report === null || state.report.connectionId !== connectionId) {
    return <div role="status" className={styles.warning}>Loading immutable Compute Optimizer exports…</div>;
  }
  return (
    <ComputeOptimizerReportView
      report={state.report}
      filters={filters}
      onFiltersChange={setFilters}
    />
  );
}
