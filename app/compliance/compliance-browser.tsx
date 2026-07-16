"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { ComplianceFrameworkDefinition } from "../../lib/compliance-catalog";
import type {
  ComplianceAssessment,
  ComplianceControlResult,
  ComplianceStatus,
} from "../../lib/compliance-engine";
import {
  compactIdentifier,
  formatTimestamp,
  postPilot,
  snapshotOriginLabel,
  usePilotState,
} from "../components/use-pilot-state";

interface ComplianceApiResponse {
  readonly schemaVersion: "sutra.compliance-report.v1";
  readonly assessment: ComplianceAssessment;
  readonly frameworks: readonly ComplianceFrameworkDefinition[];
  readonly reportSha256: string;
  readonly error?: { readonly message?: string };
}

const statusOrder: readonly ComplianceStatus[] = [
  "FAIL",
  "UNKNOWN",
  "EXCEPTED",
  "PASS",
  "NOT_APPLICABLE",
];

const statusLabels: Readonly<Record<ComplianceStatus, string>> = {
  PASS: "Pass",
  FAIL: "Fail",
  UNKNOWN: "Unknown",
  NOT_APPLICABLE: "Not applicable",
  EXCEPTED: "Excepted",
};

function errorMessage(value: unknown): string {
  return value instanceof Error
    ? value.message
    : "Sutra could not load the compliance assessment";
}

async function loadAssessment(connectionId: string | null): Promise<ComplianceApiResponse> {
  const query = connectionId === null
    ? ""
    : `?connectionId=${encodeURIComponent(connectionId)}`;
  const response = await fetch(`/api/v1/compliance${query}`, {
    cache: "no-store",
    credentials: "same-origin",
  });
  const body = await response.json().catch(() => null) as ComplianceApiResponse | null;
  if (!response.ok || body?.assessment === undefined) {
    throw new Error(body?.error?.message ?? "Sutra could not load the compliance assessment");
  }
  return body;
}

function frameworkState(framework: ComplianceFrameworkDefinition): string {
  if (framework.key === "sutra-aws-baseline") return "Assessed";
  if (framework.key === "nist-csf-2.0") return "Supporting map";
  if (framework.availability === "licensed-content-required") return "License gated";
  return "Review gated";
}

function scoreTone(score: number | null): string {
  if (score === null) return "unknown";
  if (score >= 90) return "good";
  if (score >= 70) return "medium";
  return "risk";
}

function assessmentHref(
  format: "json" | "csv",
  connectionId: string | null,
): string {
  const query = new URLSearchParams({ format });
  if (connectionId !== null) query.set("connectionId", connectionId);
  return `/api/v1/compliance?${query.toString()}`;
}

function coverageLabel(result: ComplianceControlResult): string {
  const incomplete = result.evidence.coverage.filter(
    (item) => item.conclusion !== "COMPLETE",
  ).length;
  if (result.evidence.coverage.length === 0) return "No collector contract";
  if (incomplete > 0) return `${incomplete} evidence gap${incomplete === 1 ? "" : "s"}`;
  return `${result.evidence.coverage.length} collector contract${result.evidence.coverage.length === 1 ? "" : "s"} complete`;
}

export function ComplianceBrowser() {
  const {
    state,
    health,
    loading: stateLoading,
    refreshing,
    error: stateError,
    refresh: refreshState,
  } = usePilotState();
  const [report, setReport] = useState<ComplianceApiResponse | null>(null);
  const [reportLoading, setReportLoading] = useState(true);
  const [reportError, setReportError] = useState<{
    readonly requestKey: string;
    readonly message: string;
  } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ComplianceStatus | "ALL">("ALL");
  const connection = state?.connection ?? null;
  const connectionId = connection?.id ?? null;
  const snapshotId = state?.activeSnapshot?.id ?? null;
  const requestKey = `${connectionId ?? "no-connection"}:${snapshotId ?? "no-snapshot"}`;

  const refreshReport = useCallback(async () => {
    setReportLoading(true);
    try {
      setReport(await loadAssessment(connectionId));
      setReportError(null);
    } catch (caught) {
      setReportError({ requestKey, message: errorMessage(caught) });
    } finally {
      setReportLoading(false);
    }
  }, [connectionId, requestKey]);

  useEffect(() => {
    let current = true;
    void loadAssessment(connectionId)
      .then((loaded) => {
        if (!current) return;
        setReport(loaded);
        setReportError(null);
      })
      .catch((caught: unknown) => {
        if (current) {
          setReportError({ requestKey, message: errorMessage(caught) });
        }
      })
      .finally(() => {
        if (current) setReportLoading(false);
      });
    return () => {
      current = false;
    };
  }, [connectionId, requestKey]);

  const reportMatchesSelection =
    report?.assessment.provenance.connectionId === connectionId &&
    report?.assessment.provenance.snapshotId === snapshotId;
  const currentReportError = reportError?.requestKey === requestKey
    ? reportError.message
    : null;
  const assessment = reportMatchesSelection ? report?.assessment ?? null : null;
  const reportSha256 = reportMatchesSelection ? report?.reportSha256 ?? null : null;
  const frameworks = reportMatchesSelection ? report?.frameworks ?? [] : [];
  const results = useMemo(() => assessment?.results ?? [], [assessment?.results]);
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
    return results.filter((result) => {
      const haystack = `${result.controlKey} ${result.title} ${result.description} ${result.service} ${result.reason}`
        .toLocaleLowerCase("en-US");
      return (status === "ALL" || result.status === status) && haystack.includes(normalizedQuery);
    });
  }, [query, results, status]);
  const summary = assessment?.summary ?? null;
  const score = summary?.scorePercent ?? null;
  const mappedNistControls = results.filter((result) =>
    result.frameworkMappings.some((mapping) => mapping.frameworkKey === "nist-csf-2.0"),
  ).length;

  async function runAssessment(): Promise<void> {
    if (connection === null) return;
    setSyncing(true);
    setActionError(null);
    try {
      await postPilot("/api/pilot/connections/sync", { connectionId: connection.id });
      await refreshState();
      await refreshReport();
    } catch (caught) {
      setActionError(errorMessage(caught));
      await refreshState();
    } finally {
      setSyncing(false);
    }
  }

  const loading =
    stateLoading ||
    reportLoading ||
    (!reportMatchesSelection && currentReportError === null);
  const error = actionError ?? stateError ?? currentReportError;

  return (
    <>
      <section className="page-heading compliance-heading">
        <div>
          <p className="eyebrow">Continuous evidence</p>
          <h1>Compliance posture</h1>
          <p className="page-subtitle">
            Snapshot-pinned CSPM results, evidence gaps, framework support, and exportable audit evidence.
          </p>
        </div>
        <div className="heading-actions">
          <a
            className="button button-secondary"
            href={assessmentHref("json", connectionId)}
          >
            Export JSON
          </a>
          <a
            className="button button-secondary"
            href={assessmentHref("csv", connectionId)}
          >
            Export CSV
          </a>
          {connection?.sourceKind === "aws_trust_role" ? (
            <button
              className="button button-primary"
              disabled={connection.status !== "active" || syncing || refreshing}
              onClick={() => void runAssessment()}
              type="button"
            >
              {syncing ? "Assessing…" : "Run live assessment"}
            </button>
          ) : connection ? (
            <a className="button button-primary" href="/operations">Run simulation</a>
          ) : null}
        </div>
      </section>

      <div className="trust-strip" role="note">
        <span className="trust-icon">✓</span>
        <span>
          <strong>
            {state?.activeSnapshot
              ? `${snapshotOriginLabel(state.activeSnapshot.origin)}.`
              : health?.mode === "live"
                ? "AWS collector ready; no evidence snapshot selected."
                : "No immutable evidence snapshot selected."}
          </strong>{" "}
          A pass is issued only when the required collector coverage is complete. Missing or partial evidence becomes unknown, never pass.
        </span>
        <a href="/controls">Review controls</a>
      </div>

      {error ? (
        <div className="page-alert page-alert-error" role="alert">
          <strong>Compliance evidence needs attention</strong>
          <span>{error}</span>
          <button type="button" onClick={() => void refreshReport()}>Retry</button>
        </div>
      ) : null}
      {loading ? (
        <div className="loading-state" role="status">
          <span className="loading-spinner" />Building the snapshot-pinned assessment…
        </div>
      ) : null}

      {!loading && connection === null ? (
        <section className="panel empty-workspace">
          <span className="empty-workspace-icon">GRC</span>
          <h2>No AWS account is connected</h2>
          <p>Connect a customer account to create an evidence-backed compliance assessment.</p>
          <a className="button button-primary" href="/onboard">Connect AWS account</a>
        </section>
      ) : null}

      {!loading && connection !== null && assessment !== null ? (
        <>
          <section className="compliance-overview-grid">
            <article className={`panel compliance-score-card score-${scoreTone(score)}`}>
              <div className="compliance-score-ring" style={{ "--score": score ?? 0 } as CSSProperties}>
                <span><strong>{score === null ? "—" : Math.round(score)}</strong><small>{score === null ? "no score" : "% pass"}</small></span>
              </div>
              <div className="compliance-score-copy">
                <p className="eyebrow">Tested pass rate</p>
                <h2>{assessment.catalog.name} · v{assessment.catalog.version}</h2>
                <p>Pass ÷ (pass + fail). Unknown, not applicable, and excepted controls are displayed separately and excluded.</p>
                <div className="compliance-score-meta">
                  <span><b>{summary?.scoredControls ?? 0}</b> tested</span>
                  <span><b>{summary?.total ?? 0}</b> total</span>
                  <span><b>{mappedNistControls}</b> NIST-supporting</span>
                </div>
              </div>
            </article>
            <article className="panel compliance-provenance-card">
              <div className="panel-heading">
                <div><p className="eyebrow">Evidence provenance</p><h2>Immutable assessment source</h2></div>
                <span className="status-pill status-positive">SHA-256</span>
              </div>
              <dl className="compliance-provenance-list">
                <div><dt>Account</dt><dd>{assessment.provenance.awsAccountId ?? "Not connected"}</dd></div>
                <div><dt>Snapshot</dt><dd title={assessment.provenance.snapshotId ?? ""}>{compactIdentifier(assessment.provenance.snapshotId ?? "Not available", 18)}</dd></div>
                <div><dt>Collected</dt><dd>{formatTimestamp(assessment.provenance.snapshotCollectedAt)}</dd></div>
                <div><dt>Snapshot hash</dt><dd title={assessment.provenance.snapshotSha256 ?? ""}>{compactIdentifier(assessment.provenance.snapshotSha256 ?? "Not available", 18)}</dd></div>
                <div><dt>Report hash</dt><dd title={reportSha256 ?? ""}>{compactIdentifier(reportSha256 ?? "Not available", 18)}</dd></div>
              </dl>
            </article>
          </section>

          <section className="compliance-kpi-grid" aria-label="Compliance result summary">
            {statusOrder.map((item) => {
              const value = item === "PASS"
                ? summary?.pass
                : item === "FAIL"
                  ? summary?.fail
                  : item === "UNKNOWN"
                    ? summary?.unknown
                    : item === "EXCEPTED"
                      ? summary?.excepted
                      : summary?.notApplicable;
              return (
                <button
                  className={`compliance-kpi compliance-kpi-${item.toLocaleLowerCase("en-US").replace("_", "-")} ${status === item ? "active" : ""}`}
                  key={item}
                  onClick={() => setStatus(status === item ? "ALL" : item)}
                  type="button"
                >
                  <small>{statusLabels[item]}</small><strong>{value ?? 0}</strong><span>controls</span>
                </button>
              );
            })}
          </section>

          <section className="panel compliance-framework-panel">
            <div className="panel-heading">
              <div><p className="eyebrow">Framework registry</p><h2>Available mappings and claim boundaries</h2></div>
              <span className="status-pill status-medium">Version pinned</span>
            </div>
            <div className="compliance-framework-grid">
              {frameworks.map((framework) => (
                <article key={framework.key} className={framework.availability === "available" ? "available" : "gated"}>
                  <div><code>{framework.version === null ? "MANUAL" : `v${framework.version}`}</code><span>{frameworkState(framework)}</span></div>
                  <h3>{framework.name}</h3>
                  <p>{framework.description}</p>
                  <small>{framework.claimBoundary}</small>
                </article>
              ))}
            </div>
          </section>

          <section className="panel compliance-results-panel">
            <div className="panel-heading">
              <div><p className="eyebrow">Control results</p><h2>Evidence-backed assessment</h2></div>
              <span className="result-count">{filtered.length} of {results.length} controls</span>
            </div>
            <div className="filter-bar">
              <label className="search-field">
                <span className="sr-only">Search compliance controls</span>
                <input
                  className="filter-control"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search control, service, reason or key"
                  value={query}
                />
              </label>
              <label>
                <span className="sr-only">Filter by result</span>
                <select
                  className="filter-control"
                  onChange={(event) => setStatus(event.target.value as ComplianceStatus | "ALL")}
                  value={status}
                >
                  <option value="ALL">All results</option>
                  {statusOrder.map((item) => <option key={item} value={item}>{statusLabels[item]}</option>)}
                </select>
              </label>
              {query || status !== "ALL" ? (
                <button className="button button-secondary button-small" onClick={() => { setQuery(""); setStatus("ALL"); }} type="button">Clear</button>
              ) : null}
            </div>
            <div className="compliance-result-list">
              {filtered.map((result) => (
                <details className="compliance-result" key={result.controlKey}>
                  <summary>
                    <span className={`compliance-status compliance-status-${result.status.toLocaleLowerCase("en-US").replace("_", "-")}`}>{statusLabels[result.status]}</span>
                    <span className="compliance-result-title"><strong>{result.title}</strong><small>{result.controlKey} · v{result.controlVersion}</small></span>
                    <span className="compliance-result-service"><strong>{result.service}</strong><small>{result.scope} scope</small></span>
                    <span className={`severity-badge severity-${result.severity}`}>{result.severity}</span>
                    <span className="finding-chevron">⌄</span>
                  </summary>
                  <div className="compliance-result-detail">
                    <div>
                      <p className="eyebrow">Conclusion</p>
                      <p>{result.reason}</p>
                      <span className="compliance-evidence-chip">{result.evidence.applicableResourceCount} applicable</span>
                      <span className="compliance-evidence-chip">{result.evidence.matchingFindings.length} findings</span>
                      <span className="compliance-evidence-chip">{coverageLabel(result)}</span>
                    </div>
                    <div>
                      <p className="eyebrow">Collector evidence</p>
                      <dl>
                        {result.evidence.coverage.map((coverage) => (
                          <div key={`${result.controlKey}:${coverage.collectorKey}`}>
                            <dt>{coverage.collectorKey}</dt>
                            <dd className={`coverage-${coverage.conclusion.toLocaleLowerCase("en-US")}`}>{coverage.conclusion.toLocaleLowerCase("en-US")}</dd>
                          </div>
                        ))}
                      </dl>
                      {result.frameworkMappings.length > 0 ? <p className="limitation-note">NIST CSF 2.0 supporting categories: {result.frameworkMappings.flatMap((mapping) => mapping.categories).join(", ")}</p> : null}
                    </div>
                    <div>
                      <p className="eyebrow">Suggested remediation</p>
                      <p>{result.remediation}</p>
                      <p className="limitation-note"><strong>Boundary:</strong> {result.limitation}</p>
                    </div>
                  </div>
                </details>
              ))}
              {filtered.length === 0 ? (
                <div className="empty-state"><strong>No matching controls</strong><span>Adjust the result filter or search.</span></div>
              ) : null}
            </div>
          </section>

          <div className="trust-strip compliance-disclaimer" role="note">
            <span className="trust-icon">i</span><span>{assessment.disclaimer}</span>
          </div>
        </>
      ) : null}
    </>
  );
}
