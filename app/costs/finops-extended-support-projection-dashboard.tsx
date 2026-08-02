"use client";
import { useEffect, useState } from "react";
import type { FinopsDashboardCatalogEntry } from "../../lib/finops-dashboard-catalog";
import {
  EXTENDED_SUPPORT_OFFICIAL_DEFINITION,
  type ExtendedSupportOfficialDefinition,
} from "../../lib/finops-extended-support-official-definition";
import {
  FinopsCapabilityShell,
  type FinopsCapabilityViewState,
} from "./finops-capability-shell";
import styles from "./finops-extended-support-projection-dashboard.module.css";
type Filters = {
  service: string;
  accountId: string;
  region: string;
  lifecycleState: string;
  engine: string;
  horizon: "3" | "6" | "12";
};
const EMPTY: Filters = {
  service: "",
  accountId: "",
  region: "",
  lifecycleState: "",
  engine: "",
  horizon: "3",
};
interface Money {
  currency: string;
  amountMicros: string;
}
interface Service {
  service: string;
  state: string;
  resourceCount: number;
  currentExtended: number;
  endOfSupport: number;
  configurationRequired: number;
  actualCosts: Money[];
  horizon: {
    months: number;
    windowStartAt: string;
    windowEndAt: string;
    currentlyExtendedResources: number;
    enteringExtendedSupportResources: number;
    endOfSupportResources: number;
    completeResourceProjections: number;
    partialResourceProjections: number;
    configurationRequiredResources: number;
    projectedIncrementalCosts: Money[];
  };
}
interface Resource {
  service: string;
  resourceType: string;
  accountId: string;
  region: string;
  resourceId: string;
  engine: string;
  engineVersion: string | null;
  supportVersionKey: string | null;
  supportEnrollment: string;
  lifecycleState: string;
  standardSupportEndAt: string | null;
  extendedSupportStartAt: string | null;
  chargeableFromAt: string | null;
  extendedSupportEndAt: string | null;
  calendarEffectiveAt: string | null;
  calendarFreshness: string;
  pricingRateIds: string[];
  pricingFreshness: string;
  latestObservedAt: string;
  observationFreshness: string;
  projectionBasis: {
    unit: string;
    unitsPerHour: number;
    observedAt: string;
  } | null;
  observedActualCosts: Money[];
  horizon: {
    months: number;
    windowStartAt: string;
    windowEndAt: string;
    supportUnitHours: number | null;
    pricingCoveredUnitHours: number | null;
    projectionState: string;
    projectedIncrementalCostMicros: string | null;
    currency: string | null;
    reasonCodes: string[];
  };
  sourceReferenceIds: string[];
}
interface Report {
  schema: string;
  connectionId: string;
  sourceState: string;
  officialDefinition: ExtendedSupportOfficialDefinition;
  dashboard: {
    filters: Record<string, unknown>;
    filterOptions: {
      services: string[];
      accounts: string[];
      regions: string[];
      lifecycleStates: string[];
      engines: string[];
    };
    labels: { actual: string; projection: string };
    services: Service[];
    resources: Resource[];
    resourcesTruncated: boolean;
    resultCount: number;
    limitations: string[];
  };
  history: {
    generationId: string;
    collectionId: string;
    state: string;
    collectedAt: string;
    resourceCount: number;
    readyServiceCount: number;
    partialServiceCount: number;
    configurationRequiredServiceCount: number;
  }[];
  freshness: { collectedAt: string; ageHours: number; staleAfterHours: number };
  coverage: {
    service: string;
    state: string;
    status: string;
    readPermissionsValidated: boolean;
    accountCount: number;
    regionCount: number;
    recordCount: number;
    errorCode: string | null;
  }[];
  provenance: {
    generationId: string;
    activeGenerationId: string | null;
    latestGenerationId: string | null;
    newerIncomplete: boolean;
    collectionId: string;
    contentSha256: string;
    managementAccountId: string;
    partition: string;
    accountCount: number;
    regionCount: number;
    sourceReferences: {
      id: string;
      kind: string;
      operation: string;
      retrievedAt: string;
      effectiveAt: string;
      sha256: string;
    }[];
  };
  semantics: {
    actualCostLabel: string;
    projectionLabel: string;
    moneyRepresentation: string;
    projectionIsInvoice: false;
    projectionIsSavingsPromise: false;
  };
  collection: {
    jobContractAvailable: true;
    providerAdapterAvailable: false;
    reason: string;
  };
}
function money(micros: string | null, currency: string | null) {
  if (micros === null || currency === null) return "Unavailable";
  const n = micros.startsWith("-"),
    d = (n ? micros.slice(1) : micros).padStart(7, "0"),
    w = d.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/gu, ","),
    f = d.slice(-6).replace(/0+$/u, "");
  return `${n ? "-" : ""}${currency} ${w}${f ? `.${f}` : ""}`;
}
function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange(v: string): void;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((x) => (
          <option key={x}>{x.replaceAll("_", " ")}</option>
        ))}
      </select>
    </label>
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExtendedSupportOfficialDefinition(value: unknown): value is ExtendedSupportOfficialDefinition {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.totals)) return false;
  return value.source.commit === EXTENDED_SUPPORT_OFFICIAL_DEFINITION.source.commit
    && value.source.sha256 === EXTENDED_SUPPORT_OFFICIAL_DEFINITION.source.sha256
    && value.totals.sheets === EXTENDED_SUPPORT_OFFICIAL_DEFINITION.totals.sheets
    && value.totals.visuals === EXTENDED_SUPPORT_OFFICIAL_DEFINITION.totals.visuals
    && value.totals.parameterControls === EXTENDED_SUPPORT_OFFICIAL_DEFINITION.totals.parameterControls
    && value.totals.filterControls === EXTENDED_SUPPORT_OFFICIAL_DEFINITION.totals.filterControls
    && Array.isArray(value.sheets)
    && value.sheets.length === EXTENDED_SUPPORT_OFFICIAL_DEFINITION.sheets.length
    && value.sheets.every((sheet, index) => isRecord(sheet)
      && sheet.name === EXTENDED_SUPPORT_OFFICIAL_DEFINITION.sheets[index]?.name);
}

export function ExtendedSupportOfficialDefinitionPanel({ definition }: {
  readonly definition: ExtendedSupportOfficialDefinition;
}) {
  return (
    <section
      className={styles.panel}
      aria-label="Official AWS Extended Support coverage"
    >
      <header>
        <h3>Official AWS definition coverage</h3>
        <span>
          {definition.totals.sheets} sheets ·{" "}
          {definition.totals.visuals} visuals ·{" "}
          {definition.totals.parameterControls} controls
        </span>
      </header>
      <div className={styles.serviceGrid}>
        {definition.sheets.map((sheet) => (
          <article key={sheet.name}>
            <header>
              <strong>{sheet.name}</strong>
              <span>{sheet.support}</span>
            </header>
            <dl>
              <div>
                <dt>Visuals</dt>
                <dd>{sheet.visualCount}</dd>
              </div>
              <div>
                <dt>Controls</dt>
                <dd>{sheet.parameterControlCount}</dd>
              </div>
            </dl>
            <p>{sheet.note}</p>
          </article>
        ))}
      </div>
      <small>
        Immutable definition{" "}
        {definition.source.commit.slice(0, 12)} ·{" "}
        {definition.source.sha256.slice(0, 16)}…
      </small>
    </section>
  );
}
function shell(s: string): FinopsCapabilityViewState {
  return s === "complete"
    ? "complete"
    : s === "empty"
      ? "empty"
      : s === "stale"
        ? "stale"
        : s === "partial"
          ? "partial"
          : s === "configuration_required"
            ? "configuration_required"
            : "failed";
}
export function ExtendedSupportProjectionReportView({
  report,
  filters,
  onFiltersChange,
}: {
  report: Report;
  filters: Filters;
  onFiltersChange(v: Filters): void;
}) {
  const d = report.dashboard,
    set = (k: keyof Filters, v: string) =>
      onFiltersChange({ ...filters, [k]: v } as Filters),
    projected = d.services.flatMap((s) =>
      s.horizon.projectedIncrementalCosts.map((x) => ({
        ...x,
        service: s.service,
      })),
    );
  return (
    <section
      className={styles.root}
      aria-label="Extended Support Cost Projection"
    >
      <div className={styles.notice}>
        <strong>Incremental projection, not a bill or savings promise.</strong>{" "}
        Estimates assume resource configuration, version, enrollment,
        authoritative calendars and prices do not change. Reconciled actual
        Extended Support charges remain separate from future projections.
      </div>
      {report.sourceState === "partial" ? (
        <div role="status" className={styles.warning}>
          Coverage is partial or a newer incomplete collection exists. The prior
          READY accepted head is retained where available.
        </div>
      ) : null}
      <ExtendedSupportOfficialDefinitionPanel definition={report.officialDefinition} />
      <section className={styles.filters} aria-label="Extended Support filters">
        <Select
          label="Service"
          value={filters.service}
          options={d.filterOptions.services}
          onChange={(v) => set("service", v)}
        />
        <Select
          label="Account"
          value={filters.accountId}
          options={d.filterOptions.accounts}
          onChange={(v) => set("accountId", v)}
        />
        <Select
          label="Region"
          value={filters.region}
          options={d.filterOptions.regions}
          onChange={(v) => set("region", v)}
        />
        <Select
          label="Lifecycle"
          value={filters.lifecycleState}
          options={d.filterOptions.lifecycleStates}
          onChange={(v) => set("lifecycleState", v)}
        />
        <Select
          label="Engine"
          value={filters.engine}
          options={d.filterOptions.engines}
          onChange={(v) => set("engine", v)}
        />
        <label>
          Projection horizon
          <select
            value={filters.horizon}
            onChange={(e) => set("horizon", e.target.value)}
          >
            <option value="3">3 months</option>
            <option value="6">6 months</option>
            <option value="12">12 months</option>
          </select>
        </label>
        <button type="button" onClick={() => onFiltersChange(EMPTY)}>
          Clear filters
        </button>
      </section>
      <section className={styles.cards} aria-label="Extended Support summary">
        <article>
          <span>Resources in scope</span>
          <strong>{d.resultCount}</strong>
          <small>
            {report.provenance.accountCount} accounts ·{" "}
            {report.provenance.regionCount} Regions
          </small>
        </article>
        <article>
          <span>Currently extended</span>
          <strong>
            {d.services.reduce((n, s) => n + s.currentExtended, 0)}
          </strong>
          <small>Authoritative lifecycle evidence</small>
        </article>
        <article>
          <span>Entering in {filters.horizon} months</span>
          <strong>
            {d.services.reduce(
              (n, s) => n + s.horizon.enteringExtendedSupportResources,
              0,
            )}
          </strong>
          <small>Planning candidates</small>
        </article>
        {projected.map((x) => (
          <article key={`${x.service}:${x.currency}`}>
            <span>{x.service} projected incremental</span>
            <strong>{money(x.amountMicros, x.currency)}</strong>
            <small>Complete projections only</small>
          </article>
        ))}
      </section>
      <section className={styles.panel}>
        <header>
          <h3>Service projection portfolio</h3>
          <span>ElastiCache · EKS · RDS/Aurora · OpenSearch</span>
        </header>
        <div className={styles.serviceGrid}>
          {d.services.map((s) => (
            <article key={s.service} data-state={s.state}>
              <header>
                <strong>{s.service}</strong>
                <span>{s.state}</span>
              </header>
              <dl>
                <div>
                  <dt>Resources</dt>
                  <dd>{s.resourceCount}</dd>
                </div>
                <div>
                  <dt>Currently extended</dt>
                  <dd>{s.currentExtended}</dd>
                </div>
                <div>
                  <dt>Entering horizon</dt>
                  <dd>{s.horizon.enteringExtendedSupportResources}</dd>
                </div>
                <div>
                  <dt>End of support</dt>
                  <dd>{s.endOfSupport}</dd>
                </div>
                <div>
                  <dt>Complete projections</dt>
                  <dd>{s.horizon.completeResourceProjections}</dd>
                </div>
                <div>
                  <dt>Needs evidence</dt>
                  <dd>
                    {s.horizon.configurationRequiredResources +
                      s.horizon.partialResourceProjections}
                  </dd>
                </div>
              </dl>
              <p>
                {s.horizon.projectedIncrementalCosts
                  .map((x) => money(x.amountMicros, x.currency))
                  .join(" · ") || "No complete projected amount"}
              </p>
            </article>
          ))}
        </div>
      </section>
      <section className={styles.panel}>
        <header>
          <h3>Engine/version eligibility and remediation plan</h3>
          <span>
            {d.resultCount}
            {d.resourcesTruncated ? "+" : ""} resources
          </span>
        </header>
        <div
          className={styles.scroll}
          role="region"
          tabIndex={0}
          aria-label="Extended Support resource drilldown"
        >
          <table>
            <thead>
              <tr>
                <th>Service / resource</th>
                <th>Account / Region</th>
                <th>Engine / version</th>
                <th>Lifecycle and effective dates</th>
                <th>Enrollment / basis</th>
                <th>{filters.horizon}-month projection</th>
                <th>Remediation planning</th>
              </tr>
            </thead>
            <tbody>
              {d.resources.map((r) => (
                <tr
                  key={`${r.service}:${r.accountId}:${r.region}:${r.resourceId}`}
                >
                  <td>
                    {r.service}
                    <small>
                      {r.resourceId} · {r.resourceType}
                    </small>
                  </td>
                  <td>
                    {r.accountId}
                    <small>{r.region}</small>
                  </td>
                  <td>
                    {r.engine}
                    <small>
                      {r.engineVersion ?? "Version missing"} · key{" "}
                      {r.supportVersionKey ?? "missing"}
                    </small>
                  </td>
                  <td>
                    {r.lifecycleState.replaceAll("_", " ")}
                    <small>
                      Standard end: {r.standardSupportEndAt ?? "not announced"}
                      <br />
                      Chargeable: {r.chargeableFromAt ?? "not announced"}
                      <br />
                      Calendar effective: {r.calendarEffectiveAt ?? "missing"}
                    </small>
                  </td>
                  <td>
                    {r.supportEnrollment}
                    <small>
                      {r.projectionBasis === null
                        ? "Usage basis missing"
                        : `${r.projectionBasis.unitsPerHour} ${r.projectionBasis.unit} per hour`}
                      <br />
                      Calendar {r.calendarFreshness.toLowerCase()} · pricing{" "}
                      {r.pricingFreshness.toLowerCase()}
                    </small>
                  </td>
                  <td>
                    {money(
                      r.horizon.projectedIncrementalCostMicros,
                      r.horizon.currency,
                    )}
                    <small>
                      {r.horizon.projectionState} ·{" "}
                      {r.horizon.supportUnitHours ?? "?"} unit-hours
                    </small>
                  </td>
                  <td>
                    <strong>
                      {r.lifecycleState === "EXTENDED_SUPPORT" ||
                      r.lifecycleState === "END_OF_SUPPORT"
                        ? "Prioritize upgrade or migration"
                        : r.horizon.projectionState !== "COMPLETE"
                          ? "Resolve evidence before decision"
                          : "Plan upgrade before chargeable date"}
                    </strong>
                    <small>
                      {r.horizon.reasonCodes.join(", ").replaceAll("_", " ")}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className={styles.panel}>
        <header>
          <h3>Monthly planning timeline</h3>
          <span>3 / 6 / 12 month scenario switcher</span>
        </header>
        <div className={styles.timeline}>
          {d.resources.slice(0, 100).map((r) => (
            <div key={`${r.resourceId}:${r.service}`}>
              <span>
                {r.resourceId}
                <small>
                  {r.service} · {r.engineVersion ?? "unknown version"}
                </small>
              </span>
              <i data-state={r.lifecycleState} />
              <strong>
                {r.extendedSupportStartAt?.slice(0, 10) ?? "Date unavailable"}
              </strong>
            </div>
          ))}
        </div>
      </section>
      <details className={styles.evidence}>
        <summary>
          Authoritative evidence, accepted history and projection semantics
        </summary>
        <dl>
          <div>
            <dt>Accepted generation</dt>
            <dd>{report.provenance.activeGenerationId ?? "No READY head"}</dd>
          </div>
          <div>
            <dt>Collection</dt>
            <dd>{report.provenance.collectionId}</dd>
          </div>
          <div>
            <dt>Collected</dt>
            <dd>
              {report.freshness.collectedAt} · {report.freshness.ageHours} hours
            </dd>
          </div>
          <div>
            <dt>Money seal</dt>
            <dd>{report.semantics.moneyRepresentation}</dd>
          </div>
          <div>
            <dt>Projection label</dt>
            <dd>{report.semantics.projectionLabel}</dd>
          </div>
          <div>
            <dt>Provider adapter</dt>
            <dd>{report.collection.reason}</dd>
          </div>
        </dl>
        <h4>Coverage</h4>
        <ul>
          {report.coverage.map((x) => (
            <li key={x.service}>
              {x.service}: {x.state} · {x.accountCount} accounts ·{" "}
              {x.regionCount} Regions · {x.recordCount} records
              {x.errorCode ? ` · ${x.errorCode}` : ""}
            </li>
          ))}
        </ul>
        <h4>Immutable history</h4>
        <ul>
          {report.history.map((x) => (
            <li key={x.generationId}>
              {x.collectedAt}: {x.state} · {x.resourceCount} resources
            </li>
          ))}
        </ul>
        <h4>Source references</h4>
        <ul>
          {report.provenance.sourceReferences.map((x) => (
            <li key={x.id}>
              {x.kind} · {x.operation} · effective {x.effectiveAt} · retrieved{" "}
              {x.retrievedAt}
            </li>
          ))}
        </ul>
        <ul>
          {d.limitations.map((x) => (
            <li key={x}>{x.replaceAll("_", " ")}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
export function FinopsExtendedSupportProjectionDashboard({
  connectionId,
  dashboard,
}: {
  connectionId: string | null;
  dashboard: FinopsDashboardCatalogEntry;
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY),
    [state, setState] = useState<{
      connectionId: string | null;
      loading: boolean;
      report: Report | null;
      error: string | null;
      officialDefinition: ExtendedSupportOfficialDefinition;
    }>({ connectionId: null, loading: true, report: null, error: null, officialDefinition: EXTENDED_SUPPORT_OFFICIAL_DEFINITION });
  useEffect(() => {
    if (connectionId === null) return;
    const c = new AbortController(),
      p = new URLSearchParams({ connectionId, horizon: filters.horizon });
    for (const [k, v] of Object.entries(filters))
      if (v && k !== "horizon") p.set(k, v);
    const frame = window.requestAnimationFrame(() => {
      void fetch(`/api/v1/finops/extended-support-projection?${p}`, {
        signal: c.signal,
        credentials: "same-origin",
      })
        .then(async (r) => {
          if (!r.ok) throw new Error("Extended Support request failed");
          return r.json() as Promise<unknown>;
        })
        .then((x) => {
            if (!isRecord(x)
              || x.schema !== "sutra.finops-extended-support-dashboard.v1"
              || x.connectionId !== connectionId
              || !hasExtendedSupportOfficialDefinition(x.officialDefinition)) {
              throw new Error("Sutra returned an unrecognized official Extended Support definition");
            }
            setState(x.dashboard === null
              ? { connectionId, loading: false, report: null, error: null, officialDefinition: x.officialDefinition }
              : { connectionId, loading: false, report: x as unknown as Report, error: null, officialDefinition: x.officialDefinition });
        })
        .catch((e: unknown) => {
          if (!c.signal.aborted)
            setState((current) => ({
              connectionId,
              loading: false,
              report: null,
              error:
                e instanceof Error
                  ? e.message
                  : "Extended Support request failed",
              officialDefinition: current.officialDefinition,
            }));
        });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      c.abort();
    };
  }, [connectionId, filters]);
  const r = state.report?.connectionId === connectionId ? state.report : null;
  const shown =
    connectionId === null
      ? {
          state: "configuration_required" as const,
          title: "Connect AWS to configure Extended Support projections",
          detail:
            "An active trust-role connection and server-pinned organization boundary are required.",
        }
      : state.connectionId === connectionId && state.error
        ? {
            state: "failed" as const,
            title: "Extended Support evidence could not be verified",
            detail: state.error,
          }
        : state.connectionId !== connectionId || state.loading
          ? {
              state: "loading" as const,
              title: "Loading Extended Support projection",
              detail:
                "Reading immutable inventory, lifecycle, pricing and CUR2 evidence.",
            }
          : r === null
            ? {
                state: "configuration_required" as const,
                title: "Extended Support collection is not configured",
                detail:
                  "Deploy and bind the multi-account inventory, lifecycle, pricing and CUR2 materializer.",
              }
            : {
                state: shell(r.sourceState),
                title: "Extended Support Cost Projection",
                detail:
                  "Engine/version eligibility, effective dates, incremental projection and remediation planning.",
              };
  const e =
      r === null
        ? null
        : {
            sourceLabel:
              "AWS inventory + lifecycle calendars + Price List + reconciled CUR2",
            collectedAt: r.freshness.collectedAt,
            dataThroughAt: r.freshness.collectedAt,
            freshnessAgeHours: r.freshness.ageHours,
            freshnessSlaHours: 48,
            acceptedRecords: r.dashboard.resultCount,
            rejectedRecords: null,
            generationId: r.provenance.generationId,
            contentSha256: r.provenance.contentSha256,
            limitations: r.dashboard.limitations,
          };
  return (
    <>
      <FinopsCapabilityShell
        dashboard={dashboard}
        state={shown.state}
        stateTitle={shown.title}
        stateDetail={shown.detail}
        evidence={e}
      >
        {r ? (
          <ExtendedSupportProjectionReportView
            report={r}
            filters={filters}
            onFiltersChange={setFilters}
          />
        ) : null}
      </FinopsCapabilityShell>
      {r === null ? <ExtendedSupportOfficialDefinitionPanel definition={state.officialDefinition} /> : null}
    </>
  );
}
