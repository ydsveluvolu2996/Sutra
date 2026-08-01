"use client";

import { useEffect, useState } from "react";
import type { FinopsDashboardCatalogEntry } from "../../lib/finops-dashboard-catalog";
import {
  TRUSTED_ADVISOR_ORGANIZATIONAL_OFFICIAL_DEFINITION,
  type TrustedAdvisorOrganizationalOfficialDefinition,
} from "../../lib/finops-trusted-advisor-organizational-official-definition";
import {
  FinopsCapabilityShell,
  type FinopsCapabilityEvidence,
  type FinopsCapabilityViewState,
} from "./finops-capability-shell";
import styles from "./costs.module.css";

type SourceState = "configuration_required" | "waiting" | "empty" | "partial" | "stale" | "failed" | "complete";
type ResourceStatus = "ok" | "warning" | "error";

interface TrustedAdvisorDashboardEnvelope {
  readonly schema: "sutra.finops-trusted-advisor-organizational-dashboard.v1";
  readonly connectionId: string;
  readonly source: "AWS_SUPPORT_TRUSTED_ADVISOR_STANDARD_CHECKS";
  readonly sourceState: SourceState;
  readonly officialDefinition: TrustedAdvisorOrganizationalOfficialDefinition;
  readonly freshness?: {
    readonly dataThroughAt: string | null;
    readonly collectedAt: string;
    readonly ageHours: number | null;
    readonly staleAfterHours: number;
  };
  readonly coverage?: {
    readonly expectedAccounts: number;
    readonly acceptedAccounts: number;
    readonly rejectedAccounts: number;
    readonly acceptedChecks: number;
    readonly acceptedResources: number;
    readonly rejectedRecords: number;
  };
  readonly filters?: {
    readonly accountId: string | null;
    readonly checkId: string | null;
    readonly status: ResourceStatus | null;
    readonly region: string | null;
    readonly category: string | null;
    readonly suppressed: boolean | null;
  };
  readonly accounts?: readonly {
    readonly accountId: string;
    readonly collectedAtIso: string;
    readonly dataThroughAtIso: string | null;
    readonly checkCount: number;
    readonly resourceCount: number;
    readonly rejectedRecordCount: number;
  }[];
  readonly accountsTruncated?: boolean;
  readonly checks?: readonly {
    readonly checkId: string;
    readonly name: string;
    readonly category: string;
    readonly status: ResourceStatus | "not_available";
    readonly accountCount: number;
    readonly processedCount: number;
    readonly flaggedCount: number;
    readonly ignoredCount: number;
    readonly suppressedCount: number;
  }[];
  readonly checksTruncated?: boolean;
  readonly resources?: readonly {
    readonly resourceKey: string;
    readonly accountId: string;
    readonly checkId: string;
    readonly checkName: string;
    readonly checkCategory: string;
    readonly resourceId: string;
    readonly region: string | null;
    readonly status: ResourceStatus;
    readonly suppressed: boolean;
    readonly metadata: readonly { readonly name: string; readonly value: string }[];
    readonly metadataSha256: string;
  }[];
  readonly resourcesTruncated?: boolean;
  readonly history?: readonly {
    readonly generationId: string;
    readonly status: "complete" | "partial" | "failed";
    readonly collectedAtIso: string;
    readonly expectedAccountCount: number;
    readonly acceptedAccountCount: number;
    readonly rejectedAccountCount: number;
    readonly checkCount: number;
    readonly resourceCount: number;
  }[];
  readonly evidence?: {
    readonly generationId: string;
    readonly manifestId: string;
    readonly contentSha256: string;
  };
  readonly activation: { readonly available: false; readonly reason: string };
  readonly limitations?: readonly string[];
}

interface Filters {
  readonly accountId: string;
  readonly checkId: string;
  readonly status: string;
  readonly region: string;
  readonly category: string;
  readonly suppressed: string;
}

type RequestState =
  | { readonly status: "loading"; readonly connectionId: string | null }
  | { readonly status: "failed"; readonly connectionId: string; readonly message: string }
  | { readonly status: "loaded"; readonly envelope: TrustedAdvisorDashboardEnvelope };

const EMPTY_FILTERS: Filters = {
  accountId: "", checkId: "", status: "", region: "", category: "", suppressed: "",
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validIso(value: unknown, nullable = false): boolean {
  return nullable && value === null
    ? true
    : typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validArray(value: unknown, predicate: (entry: Readonly<Record<string, unknown>>) => boolean): boolean {
  return value === undefined || (Array.isArray(value) && value.every((entry) => isRecord(entry) && predicate(entry)));
}

function validCounts(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && keys.every((key) => safeCount(value[key]));
}

function parseEnvelope(value: unknown, connectionId: string): TrustedAdvisorDashboardEnvelope {
  if (
    !isRecord(value)
    || value.schema !== "sutra.finops-trusted-advisor-organizational-dashboard.v1"
    || value.connectionId !== connectionId
    || value.source !== "AWS_SUPPORT_TRUSTED_ADVISOR_STANDARD_CHECKS"
    || !isRecord(value.officialDefinition)
    || value.officialDefinition.sourceCommit !== TRUSTED_ADVISOR_ORGANIZATIONAL_OFFICIAL_DEFINITION.sourceCommit
    || value.officialDefinition.manifestSha256 !== TRUSTED_ADVISOR_ORGANIZATIONAL_OFFICIAL_DEFINITION.manifestSha256
    || value.officialDefinition.definitionSha256 !== TRUSTED_ADVISOR_ORGANIZATIONAL_OFFICIAL_DEFINITION.definitionSha256
    || !isRecord(value.officialDefinition.totals)
    || value.officialDefinition.totals.sheets !== 11
    || value.officialDefinition.totals.visuals !== 147
    || !Array.isArray(value.officialDefinition.sheets)
    || value.officialDefinition.sheets.length !== 11
    || typeof value.sourceState !== "string"
    || !new Set(["configuration_required", "waiting", "empty", "partial", "stale", "failed", "complete"])
      .has(value.sourceState)
    || !isRecord(value.activation) || value.activation.available !== false
    || typeof value.activation.reason !== "string"
    || (value.freshness !== undefined && (
      !isRecord(value.freshness)
      || !validIso(value.freshness.dataThroughAt, true)
      || !validIso(value.freshness.collectedAt)
      || (value.freshness.ageHours !== null && typeof value.freshness.ageHours !== "number")
      || !safeCount(value.freshness.staleAfterHours)
    ))
    || (value.coverage !== undefined && !validCounts(value.coverage, [
      "expectedAccounts", "acceptedAccounts", "rejectedAccounts",
      "acceptedChecks", "acceptedResources", "rejectedRecords",
    ]))
    || !validArray(value.accounts, (entry) =>
      typeof entry.accountId === "string" && safeCount(entry.checkCount)
      && safeCount(entry.resourceCount) && safeCount(entry.rejectedRecordCount)
      && validIso(entry.collectedAtIso) && validIso(entry.dataThroughAtIso, true))
    || !validArray(value.checks, (entry) =>
      typeof entry.checkId === "string" && typeof entry.name === "string"
      && typeof entry.category === "string" && typeof entry.status === "string"
      && ["ok", "warning", "error", "not_available"].includes(entry.status)
      && ["accountCount", "processedCount", "flaggedCount", "ignoredCount", "suppressedCount"]
        .every((key) => safeCount(entry[key])))
    || !validArray(value.resources, (entry) =>
      typeof entry.resourceKey === "string" && typeof entry.accountId === "string"
      && typeof entry.checkId === "string" && typeof entry.checkName === "string"
      && typeof entry.checkCategory === "string"
      && typeof entry.resourceId === "string" && (entry.region === null || typeof entry.region === "string")
      && typeof entry.status === "string" && ["ok", "warning", "error"].includes(entry.status)
      && typeof entry.suppressed === "boolean" && typeof entry.metadataSha256 === "string"
      && Array.isArray(entry.metadata) && entry.metadata.every((metadata) =>
        isRecord(metadata) && typeof metadata.name === "string" && typeof metadata.value === "string"))
    || !validArray(value.history, (entry) =>
      typeof entry.generationId === "string" && typeof entry.status === "string"
      && ["complete", "partial", "failed"].includes(entry.status)
      && validIso(entry.collectedAtIso)
      && ["expectedAccountCount", "acceptedAccountCount", "rejectedAccountCount", "checkCount", "resourceCount"]
        .every((key) => safeCount(entry[key])))
  ) throw new Error("Sutra returned an invalid Trusted Advisor organization report.");
  return value as unknown as TrustedAdvisorDashboardEnvelope;
}

async function loadReport(connectionId: string, filters: Filters, signal: AbortSignal): Promise<TrustedAdvisorDashboardEnvelope> {
  const parameters = new URLSearchParams({ connectionId });
  if (filters.accountId !== "") parameters.set("accountId", filters.accountId);
  if (filters.checkId !== "") parameters.set("checkId", filters.checkId);
  if (filters.status !== "") parameters.set("status", filters.status);
  if (filters.region !== "") parameters.set("region", filters.region);
  if (filters.category !== "") parameters.set("category", filters.category);
  if (filters.suppressed !== "") parameters.set("suppressed", filters.suppressed);
  const response = await fetch(
    `/api/v1/finops/trusted-advisor-organizational?${parameters.toString()}`,
    { credentials: "same-origin", signal },
  );
  const body = await response.json() as unknown;
  if (!response.ok) {
    const message = isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
      ? body.error.message
      : "Sutra could not load Trusted Advisor standard-check evidence.";
    throw new Error(message);
  }
  return parseEnvelope(body, connectionId);
}

function timestamp(value: string | null | undefined): string {
  if (value === null || value === undefined) return "Not reported";
  const epoch = Date.parse(value);
  return Number.isFinite(epoch)
    ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })
      .format(new Date(epoch)) + " UTC"
    : "Invalid timestamp";
}

function statePresentation(
  connectionId: string | null,
  request: RequestState,
): { readonly view: FinopsCapabilityViewState; readonly title: string; readonly detail: string } {
  if (connectionId === null) return {
    view: "configuration_required",
    title: "An active AWS trust-role connection is required",
    detail: "Connect the AWS accounts that belong to the organization. Trusted Advisor Priority is never substituted for standard account checks.",
  };
  if (
    request.status === "loading"
    || (request.status === "loaded" && request.envelope.connectionId !== connectionId)
    || (request.status === "failed" && request.connectionId !== connectionId)
  ) return {
    view: "loading",
    title: "Loading accepted standard-check evidence",
    detail: "Reading the bounded same-tenant organization, account, check, and resource projection.",
  };
  if (request.status === "failed") return {
    view: "failed",
    title: "Trusted Advisor evidence could not be verified",
    detail: request.message,
  };
  const { sourceState } = request.envelope;
  if (sourceState === "configuration_required") return {
    view: "configuration_required",
    title: "Server-owned account discovery is not configured",
    detail: "The signed server-owned AWS Organizations taxonomy and fan-out contracts exist, but their production adapter and durable handlers are not registered. A browser-provided account list is never accepted.",
  };
  if (sourceState === "waiting") return {
    view: "waiting",
    title: "Waiting for the first complete organization generation",
    detail: "Collection is in progress. Incomplete generations do not advance the active dashboard head.",
  };
  if (sourceState === "empty") return {
    view: "empty",
    title: "No resources match the selected filters",
    detail: "The accepted generation is complete, but the selected account, check, status, Region, category, or suppression filters produced no matching resource rows.",
  };
  if (sourceState === "partial") return {
    view: "partial",
    title: "Standard-check coverage is partial",
    detail: "Retained accepted evidence remains visible where available; missing accounts, records, or timestamps remain explicit.",
  };
  if (sourceState === "stale") return {
    view: "stale",
    title: "Accepted standard-check evidence is stale",
    detail: "The last complete data-through timestamp exceeds the 24-hour freshness target. Retained evidence is not presented as current.",
  };
  if (sourceState === "failed") return {
    view: "failed",
    title: "The latest organization collection failed",
    detail: "The last complete generation is retained where available and the failed attempt did not replace it.",
  };
  return {
    view: "complete",
    title: "Complete standard-check organization evidence loaded",
    detail: "The active immutable generation covers every account frozen in its server-owned manifest.",
  };
}

function evidenceFor(envelope: TrustedAdvisorDashboardEnvelope | null): FinopsCapabilityEvidence | null {
  if (envelope?.evidence === undefined || envelope.coverage === undefined || envelope.freshness === undefined) return null;
  return {
    sourceLabel: "AWS Support API standard Trusted Advisor checks",
    collectedAt: envelope.freshness.collectedAt,
    dataThroughAt: envelope.freshness.dataThroughAt,
    freshnessAgeHours: envelope.freshness.ageHours,
    freshnessSlaHours: envelope.freshness.staleAfterHours,
    acceptedRecords: envelope.coverage.acceptedResources,
    rejectedRecords: envelope.coverage.rejectedRecords,
    generationId: envelope.evidence.generationId,
    contentSha256: envelope.evidence.contentSha256,
    limitations: envelope.limitations ?? [],
  };
}

function officialCoverageLabel(value: string): string {
  if (value === "NATIVE_STANDARD_CHECKS") return "Native standard checks";
  if (value === "CONDITIONAL_STANDARD_CHECKS") return "Conditional evidence";
  if (value === "PROVIDER_SOURCE_REQUIRED") return "Provider source required";
  return "Definition evidence";
}

export function FinopsTrustedAdvisorOrganizationalReportView({
  report,
  filters,
  onFiltersChange,
}: {
  readonly report: TrustedAdvisorDashboardEnvelope;
  readonly filters: Filters;
  readonly onFiltersChange: (filters: Filters) => void;
}) {
  const [activeSheetId, setActiveSheetId] = useState(report.officialDefinition.sheets[0]?.id ?? "");
  const accounts = report.accounts ?? [];
  const checks = report.checks ?? [];
  const resources = report.resources ?? [];
  const history = report.history ?? [];
  const coverage = report.coverage;
  const accountOptions = [...new Set([
    ...accounts.map((entry) => entry.accountId),
    ...(filters.accountId === "" ? [] : [filters.accountId]),
  ])].sort();
  const checkOptions = checks
    .map((entry) => ({ id: entry.checkId, label: entry.name }))
    .concat(filters.checkId === "" || checks.some((entry) => entry.checkId === filters.checkId)
      ? [] : [{ id: filters.checkId, label: filters.checkId }])
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index)
    .sort((left, right) => left.label.localeCompare(right.label));
  const regionOptions = [...new Set([
    ...resources.flatMap((entry) => entry.region === null ? [] : [entry.region]),
    ...(filters.region === "" ? [] : [filters.region]),
  ])].sort();
  const maximumHistoryResources = Math.max(1, ...history.map((entry) => entry.resourceCount));
  const activeSheet = report.officialDefinition.sheets.find((sheet) => sheet.id === activeSheetId)
    ?? report.officialDefinition.sheets[0];
  const categorySummary = [...checks.reduce((summary, check) => {
    const current = summary.get(check.category) ?? { category: check.category, checks: 0, flagged: 0, processed: 0 };
    current.checks += 1;
    current.flagged += check.flaggedCount;
    current.processed += check.processedCount;
    summary.set(check.category, current);
    return summary;
  }, new Map<string, { category: string; checks: number; flagged: number; processed: number }>()).values()]
    .sort((left, right) => right.flagged - left.flagged || left.category.localeCompare(right.category));
  const statusSummary = (["error", "warning", "ok"] as const).map((status) => ({
    status,
    count: resources.filter((resource) => resource.status === status).length,
  }));
  const regionSummary = [...resources.reduce((summary, resource) => {
    const region = resource.region ?? "Global";
    summary.set(region, (summary.get(region) ?? 0) + 1);
    return summary;
  }, new Map<string, number>()).entries()]
    .map(([region, count]) => ({ region, count }))
    .sort((left, right) => right.count - left.count || left.region.localeCompare(right.region))
    .slice(0, 12);
  const maximumCategoryFlagged = Math.max(1, ...categorySummary.map((entry) => entry.flagged));
  const maximumStatusCount = Math.max(1, ...statusSummary.map((entry) => entry.count));
  const maximumRegionCount = Math.max(1, ...regionSummary.map((entry) => entry.count));

  function selectOfficialSheet(sheetId: string, category: string | null): void {
    setActiveSheetId(sheetId);
    onFiltersChange({ ...filters, category: category ?? "", checkId: "" });
  }

  return (
    <div className={styles.taoWorkspace}>
      <section className={styles.taoOfficialHeader} aria-label="Official AWS TAO definition coverage">
        <div>
          <p className="eyebrow">AWS CID TAO {report.officialDefinition.version} · immutable definition</p>
          <h3>{report.officialDefinition.totals.sheets} sheets · {report.officialDefinition.totals.visuals} upstream visuals mapped</h3>
          <p>Definition <code>{report.officialDefinition.definitionSha256.slice(0, 12)}…</code> at commit <code>{report.officialDefinition.sourceCommit.slice(0, 12)}…</code>. Counts below describe AWS’s source dashboard; native results remain bounded to accepted Sutra evidence.</p>
        </div>
        <dl><div><dt>Controls</dt><dd>{report.officialDefinition.totals.parameterControls + report.officialDefinition.totals.filterControls}</dd></div><div><dt>Calculated fields</dt><dd>{report.officialDefinition.totals.calculatedFields}</dd></div><div><dt>Filter groups</dt><dd>{report.officialDefinition.totals.filterGroups}</dd></div></dl>
      </section>

      <nav className={styles.taoSheetNav} aria-label="Official Trusted Advisor dashboard sheets">
        {report.officialDefinition.sheets.map((sheet) => (
          <button
            key={sheet.id}
            aria-current={activeSheet?.id === sheet.id ? "page" : undefined}
            data-coverage={sheet.coverage}
            onClick={() => selectOfficialSheet(sheet.id, sheet.category)}
            type="button"
          >
            <strong>{sheet.name}</strong>
            <small>{sheet.visualCount} visual{sheet.visualCount === 1 ? "" : "s"} · {officialCoverageLabel(sheet.coverage)}</small>
          </button>
        ))}
      </nav>

      {activeSheet === undefined ? null : (
        <section className={styles.taoSheetEvidence} data-coverage={activeSheet.coverage} aria-live="polite">
          <div><p className="eyebrow">Selected official sheet</p><h3>{activeSheet.name}</h3><p>{activeSheet.evidenceNote}</p></div>
          <dl>
            <div><dt>Upstream visuals</dt><dd>{activeSheet.visualCount}</dd></div>
            <div><dt>Types</dt><dd>{Object.entries(activeSheet.visualTypes).map(([name, count]) => `${count} ${name}`).join(" · ")}</dd></div>
            <div><dt>Controls</dt><dd>{[...activeSheet.parameterControls, ...activeSheet.filterControls].join(" · ") || "None"}</dd></div>
          </dl>
        </section>
      )}

      {activeSheet?.coverage === "PROVIDER_SOURCE_REQUIRED" ? (
        <section className={styles.taoProviderGap} role="status">
          <strong>{activeSheet.name} is not available from the active standard-check source</strong>
          <p>{activeSheet.evidenceNote} No standard-check chart or resource is displayed as a substitute for this sheet.</p>
        </section>
      ) : null}

      <div className={styles.taoNativeEvidence} hidden={activeSheet?.coverage === "PROVIDER_SOURCE_REQUIRED"}>
      <section className={styles.taoFilters} aria-label="Trusted Advisor organization filters">
        <label>Account<select value={filters.accountId} onChange={(event) => onFiltersChange({ ...filters, accountId: event.target.value })}>
          <option value="">All accepted accounts</option>
          {accountOptions.map((accountId) => <option key={accountId} value={accountId}>{accountId}</option>)}
        </select></label>
        <label>Check<select value={filters.checkId} onChange={(event) => onFiltersChange({ ...filters, checkId: event.target.value })}>
          <option value="">All standard checks</option>
          {checkOptions.map((check) => <option key={check.id} value={check.id}>{check.label}</option>)}
        </select></label>
        <label>Resource status<select value={filters.status} onChange={(event) => onFiltersChange({ ...filters, status: event.target.value })}>
          <option value="">All statuses</option><option value="error">Error</option><option value="warning">Warning</option><option value="ok">OK</option>
        </select></label>
        <label>Region<select value={filters.region} onChange={(event) => onFiltersChange({ ...filters, region: event.target.value })}>
          <option value="">All regions</option>
          {regionOptions.map((region) => <option key={region} value={region}>{region}</option>)}
        </select></label>
        <label>Category<select value={filters.category} onChange={(event) => onFiltersChange({ ...filters, category: event.target.value, checkId: "" })}>
          <option value="">All categories</option>
          <option value="security">Security</option><option value="cost_optimizing">Cost optimization</option><option value="fault_tolerance">Fault tolerance</option><option value="performance">Performance</option><option value="service_limits">Service limits</option>
        </select></label>
        <label>IsSuppressed<select value={filters.suppressed} onChange={(event) => onFiltersChange({ ...filters, suppressed: event.target.value })}>
          <option value="">All resources</option><option value="false">Not suppressed</option><option value="true">Suppressed</option>
        </select></label>
        <button className="button button-secondary" onClick={() => onFiltersChange(EMPTY_FILTERS)} type="button">Clear filters</button>
      </section>

      {coverage === undefined ? null : (
        <section className={styles.taoKpis} aria-label="Organization coverage summary">
          <article><span>Accepted accounts</span><strong>{coverage.acceptedAccounts} / {coverage.expectedAccounts}</strong><small>{coverage.rejectedAccounts} rejected or unavailable</small></article>
          <article><span>Standard checks</span><strong>{coverage.acceptedChecks.toLocaleString()}</strong><small>Across accepted account snapshots</small></article>
          <article><span>Flagged resources</span><strong>{coverage.acceptedResources.toLocaleString()}</strong><small>{coverage.rejectedRecords.toLocaleString()} normalized records rejected</small></article>
          <article><span>Data through</span><strong>{report.freshness?.ageHours === null ? "Unknown" : `${report.freshness?.ageHours ?? 0}h ago`}</strong><small>{timestamp(report.freshness?.dataThroughAt)}</small></article>
        </section>
      )}

      <section className={styles.taoInsightGrid} aria-label="Evidence-backed Trusted Advisor visual summaries">
        <article className={styles.taoPanel}>
          <header><div><p className="eyebrow">Category summary</p><h3>Flagged checks by pillar</h3></div><span>{categorySummary.length} categories</span></header>
          <div className={styles.taoHorizontalBars}>{categorySummary.length === 0 ? <p>No category evidence is available.</p> : categorySummary.map((entry) => <div key={entry.category}><span>{entry.category.replaceAll("_", " ")}</span><i><b style={{ width: `${Math.max(2, Math.round((entry.flagged / maximumCategoryFlagged) * 100))}%` }} /></i><strong>{entry.flagged.toLocaleString()}</strong><small>{entry.checks} checks · {entry.processed.toLocaleString()} processed</small></div>)}</div>
        </article>
        <article className={styles.taoPanel}>
          <header><div><p className="eyebrow">Resource status</p><h3>Accepted rows by status</h3></div><span>Bounded view</span></header>
          <div className={styles.taoHorizontalBars}>{statusSummary.map((entry) => <div key={entry.status}><span>{entry.status}</span><i><b data-status={entry.status} style={{ width: `${Math.max(entry.count === 0 ? 0 : 2, Math.round((entry.count / maximumStatusCount) * 100))}%` }} /></i><strong>{entry.count.toLocaleString()}</strong></div>)}</div>
        </article>
        <article className={styles.taoPanel}>
          <header><div><p className="eyebrow">Region distribution</p><h3>Flagged resources by Region</h3></div><span>Top 12</span></header>
          <div className={styles.taoHorizontalBars}>{regionSummary.length === 0 ? <p>No regional resource evidence is available.</p> : regionSummary.map((entry) => <div key={entry.region}><span>{entry.region}</span><i><b style={{ width: `${Math.max(2, Math.round((entry.count / maximumRegionCount) * 100))}%` }} /></i><strong>{entry.count.toLocaleString()}</strong></div>)}</div>
        </article>
      </section>

      <section className={styles.taoSplitGrid}>
        <article className={styles.taoPanel}>
          <header><div><p className="eyebrow">Organization trend</p><h3>Accepted resource coverage by generation</h3></div><span>{history.length} generations</span></header>
          <div className={styles.taoHistoryChart} role="img" aria-label="Trusted Advisor accepted organization resource history">
            {history.length === 0 ? <p>No accepted history is available.</p> : history.slice().reverse().map((entry) => (
              <div key={entry.generationId} title={`${timestamp(entry.collectedAtIso)} · ${entry.resourceCount} resources`}>
                <i style={{ height: `${Math.max(4, Math.round((entry.resourceCount / maximumHistoryResources) * 100))}%` }} />
                <small>{new Date(entry.collectedAtIso).toISOString().slice(5, 10)}</small>
              </div>
            ))}
          </div>
        </article>
        <article className={styles.taoPanel}>
          <header><div><p className="eyebrow">Account drilldown</p><h3>Frozen manifest coverage</h3></div>{report.accountsTruncated === true ? <span>First 200</span> : null}</header>
          <div className={styles.taoAccountList} tabIndex={0} role="region" aria-label="Trusted Advisor account drilldown">
            {accounts.map((account) => <button key={account.accountId} aria-pressed={filters.accountId === account.accountId} onClick={() => onFiltersChange({ ...filters, accountId: account.accountId })} type="button">
              <strong>{account.accountId}</strong><span>{account.checkCount} checks · {account.resourceCount} resources</span><small>Through {timestamp(account.dataThroughAtIso)}</small>
            </button>)}
          </div>
        </article>
      </section>

      <section className={styles.taoPanel}>
        <header><div><p className="eyebrow">Check drilldown</p><h3>Risk and optimization checks</h3></div>{report.checksTruncated === true ? <span>Bounded result</span> : null}</header>
        <div className={styles.taoCheckGrid}>
          {checks.length === 0 ? <p>No check rows match the selected filters.</p> : checks.map((check) => (
            <button key={`${check.checkId}:${check.status}`} aria-pressed={filters.checkId === check.checkId} data-status={check.status} onClick={() => onFiltersChange({ ...filters, checkId: check.checkId })} type="button">
              <span>{check.category.replaceAll("_", " ")}</span><strong>{check.name}</strong><small>{check.flaggedCount.toLocaleString()} flagged · {check.accountCount} accounts · {check.processedCount.toLocaleString()} processed</small>
            </button>
          ))}
        </div>
      </section>

      <section className={styles.taoPanel}>
        <header><div><p className="eyebrow">Resource drilldown</p><h3>Bounded standard-check resources</h3></div><span>{resources.length}{report.resourcesTruncated === true ? "+" : ""} rows</span></header>
        <div className={styles.taoTableWrap} tabIndex={0} role="region" aria-label="Trusted Advisor resource drilldown table">
          <table><caption>Accepted resources from the active standard-check generation</caption><thead><tr><th>Status</th><th>Account</th><th>Check</th><th>Resource</th><th>Region</th><th>Evidence</th></tr></thead>
            <tbody>{resources.map((resource) => <tr key={resource.resourceKey}>
              <td><span data-status={resource.status}>{resource.status}</span>{resource.suppressed ? <small> suppressed</small> : null}</td>
              <td>{resource.accountId}</td><td>{resource.checkName}</td><td><code>{resource.resourceId}</code></td><td>{resource.region ?? "Global"}</td>
              <td><details><summary>{resource.metadata.length} fields</summary><dl>{resource.metadata.map((entry) => <div key={entry.name}><dt>{entry.name}</dt><dd>{entry.value}</dd></div>)}</dl><small title={resource.metadataSha256}>SHA-256 {resource.metadataSha256.slice(0, 10)}…</small></details></td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>
      </div>

      <aside className={styles.taoActivationNote} role="note">
        <strong>Collection activation is intentionally server-owned</strong>
        <p>The dashboard cannot start account fan-out from a browser-provided list. Activation remains configuration required until the signed Organizations adapter and durable handlers are registered and can freeze an accepted manifest. Priority recommendations are supplemental only.</p>
      </aside>
    </div>
  );
}

export function FinopsTrustedAdvisorOrganizationalDashboard({
  connectionId,
  dashboard,
}: {
  readonly connectionId: string | null;
  readonly dashboard: FinopsDashboardCatalogEntry;
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [request, setRequest] = useState<RequestState>({ status: "loading", connectionId });
  useEffect(() => {
    if (connectionId === null) return;
    const abort = new AbortController();
    const frame = window.requestAnimationFrame(() => {
      setRequest({ status: "loading", connectionId });
      void loadReport(connectionId, filters, abort.signal).then(
        (envelope) => setRequest({ status: "loaded", envelope }),
        (error: unknown) => {
          if (abort.signal.aborted) return;
          setRequest({ status: "failed", connectionId, message: error instanceof Error ? error.message : "Trusted Advisor evidence request failed." });
        },
      );
    });
    return () => {
      window.cancelAnimationFrame(frame);
      abort.abort();
    };
  }, [connectionId, filters]);
  const presentation = statePresentation(connectionId, request);
  const envelope = request.status === "loaded" && request.envelope.connectionId === connectionId
    ? request.envelope : null;
  return (
    <FinopsCapabilityShell dashboard={dashboard} state={presentation.view} stateTitle={presentation.title} stateDetail={presentation.detail} evidence={evidenceFor(envelope)}>
      {envelope === null || envelope.coverage === undefined ? null : (
        <FinopsTrustedAdvisorOrganizationalReportView report={envelope} filters={filters} onFiltersChange={setFilters} />
      )}
    </FinopsCapabilityShell>
  );
}
