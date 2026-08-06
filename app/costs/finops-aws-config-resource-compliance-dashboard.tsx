"use client";

import { useEffect, useState } from "react";
import {
  AWS_CONFIG_COMPLIANCE_OFFICIAL_DEFINITION,
  type AwsConfigComplianceOfficialDefinition,
} from "../../lib/finops-aws-config-compliance-official-definition";
import type { FinopsDashboardCatalogEntry } from "../../lib/finops-dashboard-catalog";
import { RankingBars, type RankingBarsItem } from "../components/charts";
import {
  FinopsCapabilityShell,
  type FinopsCapabilityViewState,
} from "./finops-capability-shell";
import styles from "./finops-aws-config-resource-compliance-dashboard.module.css";

type SourceState =
  | "configuration_required"
  | "collecting"
  | "partial"
  | "stale"
  | "failed"
  | "empty"
  | "complete";
type Filters = {
  accountId: string;
  region: string;
  ruleName: string;
  complianceType: string;
  resourceType: string;
};
const EMPTY_FILTERS: Filters = {
  accountId: "",
  region: "",
  ruleName: "",
  complianceType: "",
  resourceType: "",
};

export interface NonCompliantRuleRanking {
  readonly items: readonly RankingBarsItem[];
  /**
   * Non-compliant rules whose contributor count was never collected. They are
   * excluded from the ranking rather than plotted as zero — an uncollected
   * count is not a measurement of no offending resources.
   */
  readonly unavailableRuleCount: number;
  /**
   * True when at least one plotted total is a lower bound, because AWS capped a
   * deployment's contributor count or because some deployments of that rule
   * reported no count at all.
   */
  readonly anyLowerBound: boolean;
  /** True when the rule rows themselves were truncated, so the ranking is partial. */
  readonly truncated: boolean;
}

/**
 * Ranks non-compliant Config rules by how many resources contribute to the
 * violation, aggregated across every account/region the rule is deployed to.
 *
 * The rule list already names which rules are non-compliant; it does not say
 * which ones are non-compliant *at scale*. That ordering is what makes a chart
 * worth adding here. Two truth rules shape the aggregation:
 *
 * 1. A null contributorCount is unavailable, never zero. A rule with no
 *    collected count anywhere is left out of the plot and counted separately.
 * 2. A capped count is a floor, not a value. Any rule whose total absorbs a
 *    capped deployment — or drops an uncollected one — is marked as a lower
 *    bound so the bar is never read as an exact census.
 */
export function nonCompliantRuleRanking(report: {
  readonly rules?: readonly {
    readonly ruleName: string;
    readonly complianceType: string;
    readonly contributorCount: number | null;
    readonly contributorCountCapped: boolean;
  }[];
  readonly rulesTruncated?: boolean;
}): NonCompliantRuleRanking {
  const grouped = new Map<
    string,
    { collected: number[]; deployments: number; capped: boolean }
  >();
  for (const rule of report.rules ?? []) {
    if (rule.complianceType !== "NON_COMPLIANT") continue;
    const group = grouped.get(rule.ruleName) ?? {
      collected: [],
      deployments: 0,
      capped: false,
    };
    group.deployments += 1;
    if (typeof rule.contributorCount === "number" && Number.isFinite(rule.contributorCount)) {
      group.collected.push(rule.contributorCount);
      if (rule.contributorCountCapped) group.capped = true;
    }
    grouped.set(rule.ruleName, group);
  }

  const items: RankingBarsItem[] = [];
  let unavailableRuleCount = 0;
  let anyLowerBound = false;
  for (const [ruleName, group] of grouped) {
    if (group.collected.length === 0) {
      unavailableRuleCount += 1;
      continue;
    }
    const total = group.collected.reduce((sum, value) => sum + value, 0);
    const uncollected = group.deployments - group.collected.length;
    const lowerBound = group.capped || uncollected > 0;
    if (lowerBound) anyLowerBound = true;
    const scope = `${group.deployments} deployment${group.deployments === 1 ? "" : "s"}`;
    items.push({
      id: ruleName,
      label: ruleName,
      value: total,
      tone: "red",
      detail: lowerBound
        ? `at least — ${scope}${uncollected > 0 ? `, ${uncollected} without a count` : ""}${
            group.capped ? ", count capped by AWS" : ""
          }`
        : scope,
    });
  }

  items.sort((left, right) => right.value - left.value || left.label.localeCompare(right.label));
  return {
    items,
    unavailableRuleCount,
    anyLowerBound,
    truncated: report.rulesTruncated === true,
  };
}

interface ConfigComplianceReport {
  readonly schema: "sutra.finops-aws-config-resource-compliance.v1";
  readonly connectionId: string;
  readonly source: "AWS_CONFIG_ORGANIZATION_AGGREGATOR";
  readonly sourceState: SourceState;
  readonly officialDefinition: AwsConfigComplianceOfficialDefinition;
  readonly dashboard?: null;
  readonly freshness?: {
    readonly capturedAt: string;
    readonly ageHours: number | null;
    readonly staleAfterHours: number;
  };
  readonly coverage?: {
    readonly status: "COMPLETE" | "PARTIAL" | "NONE";
    readonly expectedAccountCount: number;
    readonly expectedRegionCount: number;
    readonly expectedAccountRegionCount: number;
    readonly synchronizedAccountRegionCount: number;
    readonly recordingAccountRegionCount: number;
    readonly ruleInventoryAccountRegionCount: number;
    readonly missingAccountRegions: readonly string[];
  };
  readonly channelStates?: Readonly<Record<string, string>>;
  readonly counts?: {
    readonly rules: number;
    readonly compliantRules: number;
    readonly nonCompliantRules: number;
    readonly rulesWithoutResults: number;
    readonly rulesWithEvaluationErrors: number;
    readonly duplicateRuleDeployments: number;
    readonly currentEvaluations: number;
    readonly nonCompliantResources: number;
    readonly conformancePacks: number;
    readonly insufficientDataPacks: number;
    readonly discoveredResources: string;
  };
  readonly rules?: readonly {
    readonly accountId: string;
    readonly region: string;
    readonly ruleName: string;
    readonly complianceType: string;
    readonly lifecycle: string;
    readonly contributorCount: number | null;
    readonly contributorCountCapped: boolean;
    readonly resourceTypes: readonly string[];
    readonly duplicateSignatureCount: number;
  }[];
  readonly rulesTruncated?: boolean;
  readonly evaluations?: readonly {
    readonly accountId: string;
    readonly region: string;
    readonly ruleName: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly complianceType: string;
    readonly recordedAt: string;
    readonly annotationPresent: boolean;
  }[];
  readonly evaluationsTruncated?: boolean;
  readonly conformancePacks?: readonly {
    readonly accountId: string;
    readonly region: string;
    readonly packName: string;
    readonly complianceType: string;
    readonly compliantRuleCount: number;
    readonly nonCompliantRuleCount: number;
    readonly totalRuleCount: number;
  }[];
  readonly resourceCounts?: readonly {
    readonly accountId: string;
    readonly region: string;
    readonly resourceType: string;
    readonly resourceCount: number;
  }[];
  readonly inventory?: readonly {
    readonly accountId: string;
    readonly region: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly captureTime: string;
    readonly itemStatus: string;
  }[];
  readonly inventoryTruncated?: boolean;
  readonly activity?: {
    readonly configurationItemChanges: string;
    readonly ruleEvaluations: string;
  };
  readonly actualCosts?: readonly {
    readonly currency: string;
    readonly billedCostMicros: string;
    readonly amortizedCostMicros: string | null;
    readonly rowCount: number;
  }[];
  readonly evidence?: {
    readonly snapshotId: string;
    readonly captureId: string;
    readonly contentSha256: string;
  };
  readonly history?: readonly {
    readonly snapshotId: string;
    readonly state: string;
    readonly capturedAt: string;
    readonly rules: number;
    readonly nonCompliantResources: number;
  }[];
  readonly collection?: {
    readonly state: "unavailable" | "collecting" | "failed" | "ready";
    readonly reason: string;
    readonly lastAttemptAt: string | null;
  };
  readonly activation: { readonly available: true; readonly reason: string };
  readonly limitations?: readonly string[];
}

type RequestState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "loaded"; readonly report: ConfigComplianceReport };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPinnedOfficialDefinition(
  value: unknown,
): value is AwsConfigComplianceOfficialDefinition {
  if (
    !isRecord(value) ||
    !isRecord(value.cidFrameworkAudit) ||
    !isRecord(value.totals) ||
    !Array.isArray(value.artifacts) ||
    !isRecord(value.artifacts[1])
  )
    return false;
  return (
    value.schema === AWS_CONFIG_COMPLIANCE_OFFICIAL_DEFINITION.schema &&
    value.sourceCommit ===
      AWS_CONFIG_COMPLIANCE_OFFICIAL_DEFINITION.sourceCommit &&
    value.cidFrameworkAudit.commit ===
      AWS_CONFIG_COMPLIANCE_OFFICIAL_DEFINITION.cidFrameworkAudit.commit &&
    value.artifacts[1].sha256 ===
      AWS_CONFIG_COMPLIANCE_OFFICIAL_DEFINITION.artifacts[1]?.sha256 &&
    value.completeDefinitionPublished === true &&
    value.totals.sheets === 7 &&
    value.totals.visuals === 124
  );
}

function parseReport(
  value: unknown,
  connectionId: string,
): ConfigComplianceReport {
  if (
    !isRecord(value) ||
    value.schema !== "sutra.finops-aws-config-resource-compliance.v1" ||
    value.connectionId !== connectionId ||
    value.source !== "AWS_CONFIG_ORGANIZATION_AGGREGATOR" ||
    typeof value.sourceState !== "string" ||
    ![
      "configuration_required",
      "collecting",
      "partial",
      "stale",
      "failed",
      "empty",
      "complete",
    ].includes(value.sourceState) ||
    !hasPinnedOfficialDefinition(value.officialDefinition) ||
    !isRecord(value.activation) ||
    value.activation.available !== true ||
    typeof value.activation.reason !== "string" ||
    (value.rules !== undefined && !Array.isArray(value.rules)) ||
    (value.evaluations !== undefined && !Array.isArray(value.evaluations)) ||
    (value.inventory !== undefined && !Array.isArray(value.inventory))
  ) {
    throw new Error("Sutra returned invalid AWS Config compliance evidence.");
  }
  return value as unknown as ConfigComplianceReport;
}

async function loadReport(
  connectionId: string,
  filters: Filters,
  signal: AbortSignal,
): Promise<ConfigComplianceReport> {
  const query = new URLSearchParams({ connectionId });
  for (const [key, value] of Object.entries(filters))
    if (value !== "") query.set(key, value);
  const response = await fetch(
    `/api/v1/finops/aws-config-resource-compliance?${query.toString()}`,
    { credentials: "same-origin", signal },
  );
  const body = (await response.json()) as unknown;
  if (!response.ok)
    throw new Error(
      isRecord(body) &&
      isRecord(body.error) &&
      typeof body.error.message === "string"
        ? body.error.message
        : "AWS Config compliance evidence could not be loaded.",
    );
  return parseReport(body, connectionId);
}

function statePresentation(
  connectionId: string | null,
  request: RequestState,
): { view: FinopsCapabilityViewState; title: string; detail: string } {
  if (connectionId === null)
    return {
      view: "configuration_required",
      title: "An active AWS trust-role connection is required",
      detail:
        "Connect the AWS Config aggregator account before organization evidence can be read.",
    };
  if (request.status === "loading")
    return {
      view: "loading",
      title: "Loading accepted AWS Config evidence",
      detail:
        "Reading the immutable same-tenant generation and bounded compliance projection.",
    };
  if (request.status === "failed")
    return {
      view: "failed",
      title: "AWS Config evidence could not be verified",
      detail: request.message,
    };
  const state = request.report.sourceState;
  if (state === "collecting")
    return {
      view: "loading",
      title: "AWS Config collection is in progress",
      detail:
        "The durable collector owns an active lease; the last accepted generation is never replaced until normalization and persistence complete.",
    };
  if (state === "configuration_required")
    return {
      view: state,
      title: "AWS Config evidence is not configured",
      detail:
        "Configure the exact organization aggregator, account evidence, expected Regions, and role connections before collection starts.",
    };
  if (state === "partial")
    return {
      view: state,
      title: "AWS Config organization coverage is partial",
      detail:
        "The last complete generation remains visible while incomplete account, Region, source, or paginator coverage is explicit.",
    };
  if (state === "stale")
    return {
      view: state,
      title: "Accepted AWS Config evidence is stale",
      detail:
        "The immutable accepted generation exceeds the 48-hour freshness target and is not presented as current.",
    };
  if (state === "failed")
    return {
      view: state,
      title: "The latest AWS Config collection failed",
      detail:
        "A failed attempt never replaces the last complete accepted generation.",
    };
  if (state === "empty")
    return {
      view: state,
      title: "No records match the selected scope",
      detail:
        "The accepted generation was read successfully; the selected filters contain no matching evidence.",
    };
  return {
    view: "complete",
    title: "Complete AWS Config organization evidence loaded",
    detail:
      "The active generation passed exact account/Region coverage and all required source-channel checks.",
  };
}

function amount(micros: string, currency: string): string {
  try {
    const zero = BigInt(0);
    const scale = BigInt(1_000_000);
    const value = BigInt(micros);
    const sign = value < zero ? "-" : "";
    const absolute = value < zero ? -value : value;
    return `${sign}${currency} ${(absolute / scale).toString()}.${(absolute % scale).toString().padStart(6, "0")}`;
  } catch {
    return `${currency} invalid`;
  }
}

export function AwsConfigOfficialDefinitionPanel({
  definition,
}: {
  readonly definition: AwsConfigComplianceOfficialDefinition;
}) {
  return (
    <section
      className={styles.official}
      aria-label="Official AWS Config Resource Compliance definition coverage"
    >
      <header>
        <div>
          <small>
            Official CRCD {definition.version} · complete public definition
          </small>
          <h3>
            {definition.totals.sheets} sheets · {definition.totals.visuals}{" "}
            QuickSight visuals audited
          </h3>
          <p>
            AWS Guidance points to the separately pinned official sample
            repository. The CID framework commit contains{" "}
            {definition.cidFrameworkAudit.dashboardSpecificArtifactCount} CRCD
            artifacts; exact objects come from the complete linked definition,
            not screenshot inference.
          </p>
        </div>
        <dl>
          <div>
            <dt>Controls</dt>
            <dd>
              {definition.totals.parameterControls +
                definition.totals.filterControls}
            </dd>
          </div>
          <div>
            <dt>Datasets</dt>
            <dd>{definition.totals.datasets}</dd>
          </div>
          <div>
            <dt>Athena views</dt>
            <dd>{definition.totals.views}</dd>
          </div>
          <div>
            <dt>Filter groups</dt>
            <dd>{definition.totals.filterGroups}</dd>
          </div>
        </dl>
      </header>
      <div
        className={styles.officialArtifacts}
        aria-label="Published AWS Config Resource Compliance artifacts"
      >
        {definition.artifacts.map((artifact) => (
          <article key={artifact.kind}>
            <strong>{artifact.kind.replaceAll("_", " ")}</strong>
            <code>{artifact.sha256.slice(0, 16)}…</code>
            <small>
              {artifact.count} · {artifact.hashBasis}
            </small>
          </article>
        ))}
      </div>
      <div className={styles.officialSheets}>
        {definition.sheets.map((sheet) => (
          <details
            key={sheet.id}
            open={sheet.name === "Compliance" || sheet.name === "About"}
          >
            <summary>
              <span>
                <strong>{sheet.name}</strong>
                <small>
                  {sheet.visualCount} visuals ·{" "}
                  {sheet.parameterControlCount + sheet.filterControlCount}{" "}
                  controls
                </small>
              </span>
              <b data-state={sheet.nativeCoverage}>
                {sheet.nativeCoverage.toLocaleLowerCase()}
              </b>
            </summary>
            <p>{sheet.documentedPurpose}</p>
            <dl>
              <div>
                <dt>Published visual types</dt>
                <dd>
                  {Object.entries(sheet.visualTypes)
                    .map(
                      ([type, count]) =>
                        `${count} ${type.replace("Visual", "")}`,
                    )
                    .join(" · ") || "None"}
                </dd>
              </div>
              <div>
                <dt>Published control purposes</dt>
                <dd>{sheet.publishedControlTitles.join(" · ") || "None"}</dd>
              </div>
              <div>
                <dt>Native evidence</dt>
                <dd>{sheet.nativeEvidence}</dd>
              </div>
              {sheet.remainingGap === null ? null : (
                <div>
                  <dt>Remaining gap</dt>
                  <dd>{sheet.remainingGap}</dd>
                </div>
              )}
            </dl>
          </details>
        ))}
      </div>
      <p className={styles.officialBoundary}>
        <strong>Evidence boundary:</strong> exact counts and hashes are
        reproducible from immutable public source. Sutra maps documented
        purposes only and does not claim QuickSight geometry or pixel parity.
      </p>
    </section>
  );
}

export function FinopsAwsConfigResourceComplianceReportView({
  report,
  filters,
  onFiltersChange,
}: {
  readonly report: ConfigComplianceReport;
  readonly filters: Filters;
  readonly onFiltersChange: (filters: Filters) => void;
}) {
  const rules = report.rules ?? [];
  const ruleRanking = nonCompliantRuleRanking(report);
  const evaluations = report.evaluations ?? [];
  const inventory = report.inventory ?? [];
  const counts = report.counts;
  const coverage = report.coverage;
  const history = report.history ?? [];
  const maximumTrend = Math.max(
    1,
    ...history.map((entry) => entry.nonCompliantResources),
  );
  const accounts = [
    ...new Set([
      ...rules.map((entry) => entry.accountId),
      ...inventory.map((entry) => entry.accountId),
    ]),
  ].sort();
  const regions = [
    ...new Set([
      ...rules.map((entry) => entry.region),
      ...inventory.map((entry) => entry.region),
    ]),
  ].sort();
  const ruleNames = [...new Set(rules.map((entry) => entry.ruleName))].sort();
  const resourceTypes = [
    ...new Set([
      ...rules.flatMap((entry) => entry.resourceTypes),
      ...inventory.map((entry) => entry.resourceType),
    ]),
  ].sort();
  return (
    <div className={styles.workspace}>
      <section className={styles.panel} aria-label="AWS Config collection runtime status">
        <header>
          <div>
            <p>Collection runtime</p>
            <h3>{report.collection?.state ?? "unavailable"}</h3>
          </div>
          <span>{report.collection?.reason ?? report.activation.reason}</span>
        </header>
        <p>
          Credential-owning collection is enabled. Tag, threat-informed, and configuration-item event
          projections remain explicitly unavailable until their authoritative versioned contracts exist.
        </p>
      </section>
      <section
        className={styles.filters}
        aria-label="AWS Config compliance filters"
      >
        <label>
          Account
          <select
            value={filters.accountId}
            onChange={(event) =>
              onFiltersChange({ ...filters, accountId: event.target.value })
            }
          >
            <option value="">All accounts</option>
            {accounts.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Region
          <select
            value={filters.region}
            onChange={(event) =>
              onFiltersChange({ ...filters, region: event.target.value })
            }
          >
            <option value="">All Regions</option>
            {regions.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Rule
          <select
            value={filters.ruleName}
            onChange={(event) =>
              onFiltersChange({ ...filters, ruleName: event.target.value })
            }
          >
            <option value="">All rules</option>
            {ruleNames.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Compliance
          <select
            value={filters.complianceType}
            onChange={(event) =>
              onFiltersChange({
                ...filters,
                complianceType: event.target.value,
              })
            }
          >
            <option value="">All states</option>
            <option>COMPLIANT</option>
            <option>NON_COMPLIANT</option>
            <option>NO_RESULTS</option>
          </select>
        </label>
        <label>
          Resource type
          <select
            value={filters.resourceType}
            onChange={(event) =>
              onFiltersChange({ ...filters, resourceType: event.target.value })
            }
          >
            <option value="">All resource types</option>
            {resourceTypes.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => onFiltersChange(EMPTY_FILTERS)}>
          Clear filters
        </button>
      </section>

      {counts === undefined || coverage === undefined ? null : (
        <section
          className={styles.kpis}
          aria-label="AWS Config organization compliance summary"
        >
          <article>
            <span>Non-compliant resources</span>
            <strong>{counts.nonCompliantResources.toLocaleString()}</strong>
            <small>Provider evaluation evidence only</small>
          </article>
          <article>
            <span>Rules</span>
            <strong>
              {counts.compliantRules} / {counts.rules}
            </strong>
            <small>
              Compliant / observed · {counts.rulesWithoutResults} without
              results
            </small>
          </article>
          <article>
            <span>Account / Region coverage</span>
            <strong>
              {coverage.recordingAccountRegionCount} /{" "}
              {coverage.expectedAccountRegionCount}
            </strong>
            <small>{coverage.status.toLowerCase()} recorder coverage</small>
          </article>
          <article>
            <span>Discovered resources</span>
            <strong>{counts.discoveredResources}</strong>
            <small>Aggregate resource-count evidence</small>
          </article>
          <article>
            <span>Conformance packs</span>
            <strong>{counts.conformancePacks}</strong>
            <small>{counts.insufficientDataPacks} insufficient data</small>
          </article>
        </section>
      )}

      <section className={styles.twoColumn}>
        <article className={styles.panel}>
          <header>
            <div>
              <p>Compliance trend</p>
              <h3>Non-compliant resources by accepted generation</h3>
            </div>
            <span>{history.length} generations</span>
          </header>
          <div
            className={styles.trend}
            role="img"
            aria-label="AWS Config non-compliant resource history"
          >
            {history.length === 0 ? (
              <p>No accepted history yet.</p>
            ) : (
              history
                .slice()
                .reverse()
                .map((entry) => (
                  <div
                    key={entry.snapshotId}
                    title={`${entry.capturedAt}: ${entry.nonCompliantResources}`}
                  >
                    <i
                      style={{
                        height: `${Math.max(4, Math.round((entry.nonCompliantResources / maximumTrend) * 100))}%`,
                      }}
                    />
                    <small>{entry.capturedAt.slice(5, 10)}</small>
                  </div>
                ))
            )}
          </div>
        </article>
        <article className={styles.panel}>
          <header>
            <div>
              <p>Evidence planes</p>
              <h3>Independent channel status</h3>
            </div>
          </header>
          <div className={styles.channels}>
            {Object.entries(report.channelStates ?? {}).map(([name, state]) => (
              <div key={name} data-state={state}>
                <span>{name.replace(/([A-Z])/gu, " $1")}</span>
                <strong>{state}</strong>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className={styles.panel}>
        <header>
          <div>
            <p>Rule compliance</p>
            <h3>Non-compliant rules by contributing resources</h3>
          </div>
          <span>
            {ruleRanking.items.length} ranked
          </span>
        </header>
        {ruleRanking.items.length === 0 ? (
          <p className={styles.note}>
            No non-compliant rule reports a collected contributor count, so there is nothing to
            rank. An absent count is not a count of zero.
          </p>
        ) : (
          <RankingBars
            ariaLabel="Non-compliant Config rules by contributing resource count"
            caption={`Resource counts, summed across every account and Region the rule is deployed to. Bars scale against the largest count in the set, not against total resources.${
              ruleRanking.anyLowerBound
                ? " Rows marked “at least” are lower bounds: AWS capped a deployment's contributor count, or some deployments reported none."
                : ""
            }`}
            formatValue={(value) => `${value.toLocaleString("en-US")} resources`}
            items={ruleRanking.items}
          />
        )}
        {ruleRanking.unavailableRuleCount > 0 ? (
          <p className={styles.note}>
            {ruleRanking.unavailableRuleCount} non-compliant rule
            {ruleRanking.unavailableRuleCount === 1 ? "" : "s"} report no contributor count and{" "}
            {ruleRanking.unavailableRuleCount === 1 ? "is" : "are"} excluded from the ranking rather
            than drawn as zero.
          </p>
        ) : null}
        {ruleRanking.truncated ? (
          <p className={styles.note}>
            The rule rows behind this ranking were truncated by the collector, so a rule outside the
            returned set could outrank everything shown.
          </p>
        ) : null}
      </section>

      <section className={styles.panel}>
        <header>
          <div>
            <p>Rule compliance</p>
            <h3>Rule lifecycle and duplicate signals</h3>
          </div>
          <span>
            {rules.length}
            {report.rulesTruncated ? "+" : ""} rows
          </span>
        </header>
        <div className={styles.ruleGrid}>
          {rules.length === 0 ? (
            <p>No rule rows match the filters.</p>
          ) : (
            rules.map((rule) => (
              <button
                key={`${rule.accountId}:${rule.region}:${rule.ruleName}`}
                type="button"
                data-state={rule.complianceType}
                onClick={() =>
                  onFiltersChange({ ...filters, ruleName: rule.ruleName })
                }
              >
                <span>
                  {rule.accountId} · {rule.region}
                </span>
                <strong>{rule.ruleName}</strong>
                <small>
                  {rule.complianceType} · {rule.lifecycle}
                  {rule.duplicateSignatureCount > 1
                    ? ` · ${rule.duplicateSignatureCount} potential duplicates`
                    : ""}
                </small>
              </button>
            ))
          )}
        </div>
      </section>

      <section className={styles.panel}>
        <header>
          <div>
            <p>Resource drilldown</p>
            <h3>Current Config evaluation results</h3>
          </div>
          <span>
            {evaluations.length}
            {report.evaluationsTruncated ? "+" : ""} rows
          </span>
        </header>
        <div
          className={styles.tableWrap}
          tabIndex={0}
          role="region"
          aria-label="AWS Config resource compliance table"
        >
          <table>
            <caption>
              Provider-reported evaluation evidence from the active generation
            </caption>
            <thead>
              <tr>
                <th>Status</th>
                <th>Account</th>
                <th>Region</th>
                <th>Rule</th>
                <th>Resource type</th>
                <th>Resource</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              {evaluations.map((item) => (
                <tr
                  key={`${item.accountId}:${item.region}:${item.ruleName}:${item.resourceType}:${item.resourceId}`}
                >
                  <td>
                    <span data-state={item.complianceType}>
                      {item.complianceType}
                    </span>
                  </td>
                  <td>{item.accountId}</td>
                  <td>{item.region}</td>
                  <td>{item.ruleName}</td>
                  <td>{item.resourceType}</td>
                  <td>
                    <code>{item.resourceId}</code>
                  </td>
                  <td>{item.recordedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.twoColumn}>
        <article className={styles.panel}>
          <header>
            <div>
              <p>Configuration activity</p>
              <h3>Cost-driver evidence</h3>
            </div>
          </header>
          <dl className={styles.metrics}>
            <div>
              <dt>Configuration item changes</dt>
              <dd>
                {report.activity?.configurationItemChanges ?? "Not configured"}
              </dd>
            </div>
            <div>
              <dt>Rule evaluations</dt>
              <dd>{report.activity?.ruleEvaluations ?? "Not configured"}</dd>
            </div>
          </dl>
          <small>Activity counts are not invoice amounts.</small>
        </article>
        <article className={styles.panel}>
          <header>
            <div>
              <p>Actual AWS Config cost</p>
              <h3>Reconciled CUR 2.0 totals</h3>
            </div>
          </header>
          <div className={styles.costs}>
            {(report.actualCosts ?? []).length === 0 ? (
              <p>Reconciled CUR 2.0 cost is not configured.</p>
            ) : (
              report.actualCosts?.map((cost) => (
                <div key={cost.currency}>
                  <strong>
                    {amount(cost.billedCostMicros, cost.currency)}
                  </strong>
                  <small>
                    {cost.amortizedCostMicros === null
                      ? "Amortized cost incomplete"
                      : `${amount(cost.amortizedCostMicros, cost.currency)} amortized`}
                  </small>
                </div>
              ))
            )}
          </div>
        </article>
      </section>

      <details className={styles.evidence}>
        <summary>Generation evidence, gaps, and activation boundary</summary>
        <dl>
          <div>
            <dt>Snapshot</dt>
            <dd>{report.evidence?.snapshotId ?? "Not accepted"}</dd>
          </div>
          <div>
            <dt>Capture</dt>
            <dd>{report.evidence?.captureId ?? "Not accepted"}</dd>
          </div>
          <div>
            <dt>SHA-256</dt>
            <dd>{report.evidence?.contentSha256 ?? "Not accepted"}</dd>
          </div>
          <div>
            <dt>Collector activation</dt>
            <dd>{report.activation.reason}</dd>
          </div>
        </dl>
        <ul>
          {report.limitations?.map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export function FinopsAwsConfigResourceComplianceDashboard({
  connectionId,
  dashboard,
}: {
  readonly connectionId: string | null;
  readonly dashboard: FinopsDashboardCatalogEntry;
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [request, setRequest] = useState<RequestState>({ status: "loading" });
  useEffect(() => {
    if (connectionId === null) return;
    const abort = new AbortController();
    const frame = window.requestAnimationFrame(() => {
      setRequest({ status: "loading" });
      void loadReport(connectionId, filters, abort.signal).then(
        (report) => setRequest({ status: "loaded", report }),
        (error: unknown) => {
          if (!abort.signal.aborted)
            setRequest({
              status: "failed",
              message:
                error instanceof Error
                  ? error.message
                  : "AWS Config request failed.",
            });
        },
      );
    });
    return () => {
      window.cancelAnimationFrame(frame);
      abort.abort();
    };
  }, [connectionId, filters]);
  const presentation = statePresentation(connectionId, request);
  const report =
    request.status === "loaded" && request.report.connectionId === connectionId
      ? request.report
      : null;
  const definition =
    report?.officialDefinition ?? AWS_CONFIG_COMPLIANCE_OFFICIAL_DEFINITION;
  const evidence =
    report?.evidence === undefined
      ? null
      : {
          sourceLabel:
            "AWS Config organization aggregator plus optional Config delivery and reconciled CUR 2.0",
          collectedAt: report.freshness?.capturedAt ?? null,
          dataThroughAt: report.freshness?.capturedAt ?? null,
          freshnessAgeHours: report.freshness?.ageHours ?? null,
          freshnessSlaHours: report.freshness?.staleAfterHours ?? 48,
          acceptedRecords: report.counts?.currentEvaluations ?? null,
          rejectedRecords: null,
          generationId: report.evidence.snapshotId,
          contentSha256: report.evidence.contentSha256,
          limitations: report.limitations ?? [],
        };
  return (
    <FinopsCapabilityShell
      dashboard={dashboard}
      state={presentation.view}
      stateTitle={presentation.title}
      stateDetail={presentation.detail}
      evidence={evidence}
    >
      <div className={styles.workspace}>
        <AwsConfigOfficialDefinitionPanel definition={definition} />
        {report?.coverage === undefined ? (
          <p className={styles.officialNullState} role="status">
            Official source coverage remains available. No provider compliance
            state is synthesized while the accepted dashboard generation is
            unavailable.
          </p>
        ) : (
          <FinopsAwsConfigResourceComplianceReportView
            report={report}
            filters={filters}
            onFiltersChange={setFilters}
          />
        )}
      </div>
    </FinopsCapabilityShell>
  );
}
