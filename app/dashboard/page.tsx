"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { isAllEnabledAwsRegionSelection } from "../../lib/aws-region-selection.ts";
import { AppShell } from "../components/app-shell";
import { formatTimestamp, postPilot, snapshotOriginLabel, usePilotState } from "../components/use-pilot-state";

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Sutra could not run inventory collection";
}

const SEVERITY_KEYS = ["critical", "high", "medium", "low"] as const;
const SLA_TARGET_DAYS: Readonly<Record<(typeof SEVERITY_KEYS)[number], number>> = {
  critical: 3, high: 30, medium: 90, low: 180,
};

function scoreBand(value: number): "good" | "warn" | "risk" {
  return value >= 80 ? "good" : value >= 55 ? "warn" : "risk";
}

// Semicircular gauge drawn with a single arc whose dash length encodes the
// fraction, so the value reads at a glance without any charting dependency.
// Healthy scores stroke with the signature aurora gradient (cyan→blue→violet);
// warn/risk bands fall back to their solid semantic colors from the stylesheet.
function ScoreGauge({ value, caption }: { readonly value: number; readonly caption: string }) {
  const gradientId = useId();
  const clamped = Math.max(0, Math.min(100, value));
  const radius = 52;
  const length = Math.PI * radius;
  const band = scoreBand(clamped);
  return (
    <div className={`score-gauge score-gauge-${band}`}>
      <svg viewBox="0 0 128 74" role="img" aria-label={`${caption}: ${clamped} out of 100`}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#22d3ee" />
            <stop offset="52%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#8b5cf6" />
          </linearGradient>
        </defs>
        <path className="score-gauge-track" d="M 12 66 A 52 52 0 0 1 116 66" fill="none" strokeWidth="10" strokeLinecap="round" />
        <path className="score-gauge-value" d="M 12 66 A 52 52 0 0 1 116 66" fill="none" strokeWidth="10" strokeLinecap="round"
          style={band === "good" ? { stroke: `url(#${gradientId})` } : undefined}
          strokeDasharray={`${(clamped / 100) * length} ${length}`} />
        <text x="64" y="58" textAnchor="middle" className="score-gauge-number">{clamped}</text>
      </svg>
      <span className="score-gauge-caption">{caption}</span>
    </div>
  );
}

// --- Platform posture band -------------------------------------------------
// Each KPI tile fetches ONE vertical's real summary independently (own
// AbortController), so a slow or failing source never blanks its neighbours.
// A parser returns `null` whenever the source is unconfigured or empty — the
// tile then shows an explicit "no data" state and never a fabricated number.

interface TileData {
  readonly value: string;
  readonly detail: string;
  readonly alert?: boolean;
}

type SignalState = { readonly phase: "loading" } | { readonly phase: "empty" } | { readonly phase: "ready"; readonly data: TileData };

function usePlatformSignal(url: string | null, parse: (body: unknown) => TileData | null): SignalState {
  // The resolved state is tagged with the URL it belongs to; loading and the
  // no-connection empty state are DERIVED during render, so the effect never
  // calls setState synchronously (only inside the async fetch callbacks).
  const [resolved, setResolved] = useState<{ readonly url: string; readonly state: SignalState } | null>(null);
  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    void fetch(url, { cache: "no-store", credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        // 400/401/403/5xx all degrade honestly to "no data" rather than throwing.
        if (!response.ok) return null;
        const body = await response.json().catch(() => null) as unknown;
        return body === null ? null : parse(body);
      })
      .then((parsed) => {
        if (!controller.signal.aborted) setResolved({ url, state: parsed === null ? { phase: "empty" } : { phase: "ready", data: parsed } });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResolved({ url, state: { phase: "empty" } });
      });
    return () => controller.abort();
  }, [url, parse]);
  if (url === null) return { phase: "empty" };
  // Stale result from a previous connection → treat as still loading.
  return resolved !== null && resolved.url === url ? resolved.state : { phase: "loading" };
}

// Integer micro-units → display string, matching the FinOps workspace exactly
// (currencies are never summed together; each allocation carries its own).
function moneyFromMicros(micros: string, currency: string): string {
  const negative = micros.startsWith("-");
  const padded = (negative ? micros.slice(1) : micros).padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return `${negative ? "-" : ""}${whole}.${padded.slice(-6, -4)} ${currency}`;
}

// Response shapes (partial — only the fields each tile reads).
interface VulnBody { readonly queue?: { readonly summary?: { readonly open?: number; readonly bySeverity?: Readonly<Record<string, number>> }; readonly items?: readonly { readonly knownExploited?: boolean }[] } }
interface ComplianceBody { readonly frameworks?: readonly { readonly summary?: Readonly<Record<string, number>> }[] }
interface FleetBody { readonly totals?: { readonly clusters?: number; readonly online?: number; readonly degraded?: number; readonly offline?: number; readonly notEnrolled?: number } }
interface FinopsBody { readonly period?: string | null; readonly allocation?: readonly { readonly currency: string; readonly totalMicros: string }[]; readonly commitment?: { readonly recommendations?: readonly unknown[] } | null }
interface CasesBody { readonly cases?: readonly { readonly status?: string }[] }
interface DetectionsBody { readonly report?: { readonly summary?: { readonly detections?: number; readonly bySeverity?: Readonly<Record<string, number>> } }; readonly coverage?: { readonly zeroCoverage?: boolean } }
interface ExposureBody { readonly exposure?: { readonly summary?: { readonly resources?: number; readonly internetExposed?: number; readonly unknown?: number } } }

function parseVulnerabilities(body: unknown): TileData | null {
  const summary = (body as VulnBody).queue?.summary;
  if (summary === undefined || typeof summary.open !== "number") return null;
  const critical = summary.bySeverity?.critical ?? 0;
  const high = summary.bySeverity?.high ?? 0;
  const kev = ((body as VulnBody).queue?.items ?? []).filter((item) => item.knownExploited === true).length;
  return {
    value: summary.open.toLocaleString(),
    detail: `${(critical + high).toLocaleString()} critical/high · ${kev} KEV/exploitable`,
    alert: critical > 0 || kev > 0,
  };
}

function complianceScore(counts: Readonly<Record<string, number>> | undefined): number | null {
  if (counts === undefined) return null;
  const scorable = (counts.PASS ?? 0) + (counts.FAIL ?? 0);
  return scorable === 0 ? null : Math.round(((counts.PASS ?? 0) / scorable) * 1000) / 10;
}

function parseCompliance(body: unknown): TileData | null {
  const frameworks = (body as ComplianceBody).frameworks;
  if (!Array.isArray(frameworks)) return null;
  const scores = frameworks.map((framework) => complianceScore(framework.summary)).filter((score): score is number => score !== null);
  if (scores.length === 0) {
    return { value: "—", detail: `${frameworks.length} mapped · not yet scorable` };
  }
  const worst = Math.min(...scores);
  return { value: `${worst}%`, detail: `worst of ${frameworks.length} frameworks`, alert: worst < 55 };
}

function parseFleet(body: unknown): TileData | null {
  const totals = (body as FleetBody).totals;
  if (totals === undefined || typeof totals.clusters !== "number") return null;
  const offline = totals.offline ?? 0;
  const degraded = totals.degraded ?? 0;
  const notEnrolled = totals.notEnrolled ?? 0;
  const online = totals.online ?? 0;
  const worst = totals.clusters === 0 ? "no clusters enrolled"
    : offline > 0 ? "offline present"
    : degraded > 0 ? "degraded present"
    : notEnrolled > 0 ? "not-enrolled present"
    : "all online";
  return { value: totals.clusters.toLocaleString(), detail: `${online} online · ${worst}`, alert: offline > 0 || degraded > 0 };
}

function parseFinops(body: unknown): TileData | null {
  const finops = body as FinopsBody;
  if (typeof finops.period !== "string") return null;
  const allocation = Array.isArray(finops.allocation) ? finops.allocation : [];
  const opportunities = finops.commitment?.recommendations?.length ?? 0;
  const oppText = `${opportunities} cost ${opportunities === 1 ? "opportunity" : "opportunities"}`;
  if (allocation.length === 0) {
    return { value: "—", detail: `${oppText} · ${finops.period}` };
  }
  const extra = allocation.length - 1;
  const suffix = extra > 0 ? ` · +${extra} more currenc${extra === 1 ? "y" : "ies"}` : "";
  return { value: moneyFromMicros(allocation[0].totalMicros, allocation[0].currency), detail: `${oppText} · ${finops.period}${suffix}` };
}

function parseCases(body: unknown): TileData | null {
  const cases = (body as CasesBody).cases;
  if (!Array.isArray(cases)) return null;
  const open = cases.filter((item) => item.status === "open").length;
  const investigating = cases.filter((item) => item.status === "investigating").length;
  return { value: (open + investigating).toLocaleString(), detail: `${open} open · ${investigating} investigating`, alert: open > 0 };
}

function parseDetections(body: unknown): TileData | null {
  const detections = body as DetectionsBody;
  const summary = detections.report?.summary;
  if (summary === undefined || typeof summary.detections !== "number") return null;
  if (detections.coverage?.zeroCoverage === true) {
    return { value: "—", detail: "Zero coverage · single-source (CloudTrail)" };
  }
  const critHigh = (summary.bySeverity?.critical ?? 0) + (summary.bySeverity?.high ?? 0);
  return { value: summary.detections.toLocaleString(), detail: `${critHigh} critical/high · single-source (CloudTrail)`, alert: critHigh > 0 };
}

function parseExposure(body: unknown): TileData | null {
  const summary = (body as ExposureBody).exposure?.summary;
  if (summary === undefined || typeof summary.internetExposed !== "number") return null;
  return {
    value: summary.internetExposed.toLocaleString(),
    detail: `${summary.unknown ?? 0} unknown · of ${(summary.resources ?? 0).toLocaleString()} interfaces`,
    alert: summary.internetExposed > 0,
  };
}

function PlatformTile({ label, glyph, href, state }: { readonly label: string; readonly glyph: string; readonly href: string; readonly state: SignalState }) {
  return (
    <a className="metric-card" href={href} aria-label={`${label} — open vertical`}>
      <div className="metric-topline">
        <span>{label}</span>
        <span className={`metric-glyph${state.phase === "ready" && state.data.alert === true ? " metric-glyph-alert" : ""}`}>{glyph}</span>
      </div>
      {state.phase === "loading"
        ? <><strong className="metric-value" aria-hidden="true">…</strong><p><span className="loading-spinner" style={{ width: 10, height: 10, marginRight: 6, verticalAlign: "middle" }} />Loading…</p></>
        : state.phase === "empty"
          ? <><strong className="metric-value">—</strong><p>Not configured or no data yet</p></>
          : <><strong className="metric-value">{state.data.value}</strong><p>{state.data.detail}</p></>}
    </a>
  );
}

const EXPLORE_LINKS: readonly { readonly href: string; readonly glyph: string; readonly label: string; readonly blurb: string }[] = [
  { href: "/registry/inventory", glyph: "RG", label: "Registry inventory", blurb: "Container image registries and their scanned contents" },
  { href: "/iac-scan", glyph: "IAC", label: "IaC scan", blurb: "Terraform / CloudFormation misconfiguration scanning" },
  { href: "/kubernetes/supply-chain", glyph: "SC", label: "Supply chain", blurb: "SBOM inventory and artifact provenance trust" },
  { href: "/kubernetes/attack-paths", glyph: "AP", label: "Attack paths", blurb: "Reachable cross-plane attack chains" },
  { href: "/kubernetes/permissions", glyph: "EP", label: "Effective permissions", blurb: "CIEM effective-access analysis" },
  { href: "/cases/routing", glyph: "CR", label: "Case routing", blurb: "Automatic case assignment routing rules" },
  { href: "/findings/exceptions", glyph: "FE", label: "Finding exceptions", blurb: "Governed, time-boxed risk acceptances" },
  { href: "/vulnerabilities/exploitability", glyph: "XP", label: "Exploitability", blurb: "KEV-first, EPSS-ranked exploitability" },
];

export default function Home() {
  const { state, health, loading, refreshing, error, refresh } = usePilotState();
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const connection = state?.connection ?? null;
  const canRunAwsSync = connection?.sourceKind === "aws_trust_role";
  const cmdbHref = connection ? `/cmdb?connectionId=${encodeURIComponent(connection.id)}` : "/onboard";
  const resources = useMemo(() => state?.resources ?? [], [state?.resources]);
  const findings = useMemo(() => state?.findings ?? [], [state?.findings]);
  const openFindings = findings.filter((finding) => finding.status === "open");
  const resourceMap = useMemo(() => new Map(resources.map((resource) => [resource.resourceKey, resource])), [resources]);
  const serviceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const resource of resources) counts.set(resource.service, (counts.get(resource.service) ?? 0) + 1);
    return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 7);
  }, [resources]);
  const maxServiceCount = Math.max(...serviceCounts.map(([, count]) => count), 1);
  const succeededCoverage = state?.coverage.filter((entry) => entry.status === "succeeded").length ?? 0;
  const totalCoverage = state?.coverage.length ?? 0;
  const coveredRegions = useMemo(() => [...new Set(
    (state?.coverage ?? [])
      .map((entry) => entry.region)
      .filter((region) => region !== "global"),
  )].sort(), [state?.coverage]);
  const allEnabledRegionScope = connection
    ? isAllEnabledAwsRegionSelection(connection.enabledRegions)
    : false;
  const coveragePercent = totalCoverage ? Math.round((succeededCoverage / totalCoverage) * 100) : 0;
  const priorityFindings = openFindings.filter((finding) => finding.severity === "critical" || finding.severity === "high").slice(0, 5);
  const openBySeverity = {
    critical: openFindings.filter((finding) => finding.severity === "critical").length,
    high: openFindings.filter((finding) => finding.severity === "high").length,
    medium: openFindings.filter((finding) => finding.severity === "medium").length,
    low: openFindings.filter((finding) => finding.severity === "low").length,
  };
  const maxSeverityCount = Math.max(1, openBySeverity.critical, openBySeverity.high, openBySeverity.medium, openBySeverity.low);
  // Deterministic security score: 100 minus a bounded penalty from the open
  // finding severity mix. Purely from current evidence; trend over time arrives
  // with the posture-history work.
  const securityScore = Math.max(
    2,
    Math.round(100 - Math.min(98, openBySeverity.critical * 14 + openBySeverity.high * 6 + openBySeverity.medium * 2 + openBySeverity.low * 0.5)),
  );
  const resolvedCount = findings.filter((finding) => finding.status === "resolved" || finding.status === "suppressed").length;

  // Platform posture: one query per vertical, each carrying the active
  // connection. Built once per connection so a re-render never re-fires fetches.
  const connectionId = connection?.id ?? null;
  const signalUrls = useMemo(() => {
    if (connectionId === null) return null;
    const query = `?connectionId=${encodeURIComponent(connectionId)}`;
    return {
      vulnerabilities: `/api/v1/cloud/vulnerabilities${query}`,
      compliance: `/api/v1/compliance/frameworks${query}`,
      fleet: `/api/v1/kubernetes/fleet${query}`,
      finops: `/api/v1/finops/insights${query}`,
      cases: `/api/v1/cases${query}`,
      detections: `/api/v1/cloud-detections${query}`,
      exposure: `/api/v1/network-exposure${query}`,
    };
  }, [connectionId]);
  const vulnState = usePlatformSignal(signalUrls?.vulnerabilities ?? null, parseVulnerabilities);
  const complianceState = usePlatformSignal(signalUrls?.compliance ?? null, parseCompliance);
  const fleetState = usePlatformSignal(signalUrls?.fleet ?? null, parseFleet);
  const finopsState = usePlatformSignal(signalUrls?.finops ?? null, parseFinops);
  const casesState = usePlatformSignal(signalUrls?.cases ?? null, parseCases);
  const detectionsState = usePlatformSignal(signalUrls?.detections ?? null, parseDetections);
  const exposureState = usePlatformSignal(signalUrls?.exposure ?? null, parseExposure);
  const withConn = (href: string): string => (connectionId === null ? href : `${href}?connectionId=${encodeURIComponent(connectionId)}`);

  async function runSync() {
    if (!connection) return;
    setSyncing(true);
    setActionError(null);
    try {
      await postPilot("/api/pilot/connections/sync", { connectionId: connection.id });
      await refresh();
    } catch (caught) {
      setActionError(errorMessage(caught));
      await refresh();
    } finally {
      setSyncing(false);
    }
  }

  return (
    <AppShell active="overview">
      <section className="page-heading dashboard-hero">
        <div>
          <p className="eyebrow">MSP operations</p>
          <h1>{connection ? `${connection.customerName} cloud overview` : "Your AWS cloud workspace"}</h1>
          <p className="page-subtitle">AWS trust health, collection outcomes, active inventory coverage, asset context, and explainable security priorities.</p>
        </div>
        <div className="heading-actions">
          {connection && canRunAwsSync ? <button className="button button-secondary" type="button" disabled={syncing || refreshing || connection.status !== "active"} onClick={() => void runSync()}>{syncing ? "Collecting…" : "Sync now"}</button> : null}
          <a className="button button-primary" href={cmdbHref}>{connection ? "Open CMDB" : "Onboard AWS account"}</a>
        </div>
      </section>

      <div className="trust-strip" role="note">
        <span className="trust-icon">✓</span>
        <span><strong>{state?.activeSnapshot ? `${snapshotOriginLabel(state.activeSnapshot.origin)}.` : health?.mode === "live" ? "AWS collector ready." : health?.mode === "fixture" ? "Fixture collector ready." : "Collector status unavailable."}</strong> Customer infrastructure is never modified, and only a complete collection can replace the active CMDB projection.</span>
        <a href="/controls">See boundaries</a>
      </div>

      {error || actionError ? <div className="page-alert page-alert-error" role="alert"><strong>Workspace needs attention</strong><span>{actionError ?? error}</span><button type="button" onClick={() => void refresh()}>Retry</button></div> : null}
      {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading the cloud workspace…</div> : null}

      {!loading && !connection ? (
        <section className="panel dbe" aria-label="Connect your first customer account">
          <div className="dbe-copy">
            <span className="dbe-kicker">Get started</span>
            <h2>Connect your first customer account</h2>
            <p>Sutra validates a customer-owned IAM role, collects selected AWS metadata with temporary STS credentials, builds the asset graph, and evaluates deterministic posture checks — read-only from the first minute, with nothing in your account changed.</p>
            <ol className="dbe-steps">
              <li><span>01</span><div><strong>Create the customer workspace</strong><em>Name the customer and choose a collector pack</em></div></li>
              <li><span>02</span><div><strong>Deploy the CloudFormation role</strong><em>Customer-owned, read-only by default, unique ExternalId</em></div></li>
              <li><span>03</span><div><strong>Run the first collection</strong><em>Assets, relationships and findings appear right here</em></div></li>
            </ol>
            <div className="dbe-actions">
              <a className="button button-primary" href="/onboard">Start secure onboarding</a>
              <a className="button button-secondary" href="/controls#architecture">Review the trust model</a>
            </div>
          </div>
          <div className="dbe-preview" aria-hidden="true">
            <div className="dbe-preview-bar"><i /><i /><i /><span>live evidence pipeline</span></div>
            <div className="dbe-steps">
              <div className="dbe-tile"><small>01</small><b>Validate</b><em>Customer role and External ID</em></div>
              <div className="dbe-tile"><small>02</small><b>Collect</b><em>Read-only AWS API evidence</em></div>
              <div className="dbe-tile"><small>03</small><b>Publish</b><em>Only complete immutable snapshots</em></div>
              <div className="dbe-tile"><small>04</small><b>Analyze</b><em>Tenant-scoped posture and CMDB</em></div>
            </div>
            <div className="dbe-note">No sample metrics — values appear only after collection</div>
          </div>
        </section>
      ) : null}

      {connection ? (
        <>
          <section className="panel" aria-label="Platform posture" style={{ marginBottom: 13 }}>
            <div className="panel-heading"><div><p className="eyebrow">Cross-vertical overview</p><h2>Platform posture</h2></div><span className="result-count">Live signals · every source independent</span></div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 13, marginTop: 4 }}>
              <PlatformTile label="Vulnerabilities" glyph="VULN" href={withConn("/vulnerabilities")} state={vulnState} />
              <PlatformTile label="Compliance" glyph="CMPL" href={withConn("/compliance-frameworks")} state={complianceState} />
              <PlatformTile label="Kubernetes fleet" glyph="K8S" href={withConn("/kubernetes/fleet")} state={fleetState} />
              <PlatformTile label="FinOps spend" glyph="COST" href={withConn("/costs")} state={finopsState} />
              <PlatformTile label="Remediation cases" glyph="CASE" href={withConn("/cases")} state={casesState} />
              <PlatformTile label="Cloud detections" glyph="CDR" href={withConn("/cloud-detections")} state={detectionsState} />
              <PlatformTile label="Internet exposure" glyph="NET" href={withConn("/network-exposure")} state={exposureState} />
            </div>
            <p className="panel-footnote">Each tile queries its vertical directly for the active connection and degrades to &ldquo;no data&rdquo; on an empty or unavailable source — never a fabricated number. Cloud detections are single-source (collected CloudTrail management events only) and do not claim full-coverage CDR.</p>
          </section>

          <section className="metrics-grid" aria-label="Cloud workspace summary">
            <article className="metric-card metric-card-featured">
              <div className="metric-topline"><span>Trust health</span><span className={`status-pill ${connection.status === "active" ? "status-positive" : "status-medium"}`}>{connection.status.replace("_", " ")}</span></div>
              <strong className="connection-account">{connection.awsAccountId}</strong>
              <p>{allEnabledRegionScope ? (coveredRegions.length > 0 ? `${coveredRegions.length} AWS-discovered enabled regions` : "All account-enabled Regions") : `${connection.enabledRegions.length} explicitly selected regions`} · {connection.sourceKind === "simulated_fixture" ? `fixture ${connection.fixtureVersion ?? "not published"}` : `validated ${formatTimestamp(connection.lastValidatedAt)}`}</p>
            </article>
            <article className="metric-card">
              <div className="metric-topline"><span>Managed assets</span><span className="metric-glyph">CMDB</span></div>
              <strong className="metric-value">{resources.length.toLocaleString()}</strong>
              <p>From the latest complete snapshot</p>
            </article>
            <article className="metric-card">
              <div className="metric-topline"><span>Open findings</span><span className="metric-glyph metric-glyph-alert">!</span></div>
              <strong className="metric-value">{openFindings.length.toLocaleString()}</strong>
              <p><span className="severity-dot severity-critical" /> {openFindings.filter((finding) => finding.severity === "critical" || finding.severity === "high").length} critical or high</p>
            </article>
            <article className="metric-card">
              <div className="metric-topline"><span>Active snapshot coverage</span><span className="metric-glyph">AWS</span></div>
              <strong className="metric-value">{totalCoverage ? `${coveragePercent}%` : "—"}</strong>
              <p>{succeededCoverage} of {totalCoverage} checks succeeded</p>
            </article>
          </section>

          <section className="exec-cards" aria-label="Security posture summary">
            <article className="panel exec-card exec-card-score">
              <div className="panel-heading"><div><p className="eyebrow">Posture</p><h2>Security score</h2></div></div>
              <ScoreGauge value={securityScore} caption="Computed from open findings" />
              <p className="panel-footnote">100 minus a bounded penalty from the open-finding severity mix. Trend over time arrives with posture history.</p>
            </article>
            <article className="panel exec-card">
              <div className="panel-heading"><div><p className="eyebrow">Open issues</p><h2>By severity</h2></div><span className="result-count">{openFindings.length} open</span></div>
              <div className="severity-bars">
                {SEVERITY_KEYS.map((severity) => <div className="severity-bar" key={severity}>
                  <span className={`severity-badge severity-${severity}`}>{severity}</span>
                  <i><b className={`severity-fill severity-fill-${severity}`} style={{ width: `${(openBySeverity[severity] / maxSeverityCount) * 100}%` }} /></i>
                  <strong>{openBySeverity[severity]}</strong>
                </div>)}
              </div>
            </article>
            <article className="panel exec-card">
              <div className="panel-heading"><div><p className="eyebrow">Remediation</p><h2>Open vs. SLA target</h2></div></div>
              <div className="sla-list">
                {SEVERITY_KEYS.map((severity) => <div className="sla-row" key={severity}>
                  <span className={`severity-dot severity-${severity}`} />
                  <div><strong>{severity}</strong><small>SLA target {SLA_TARGET_DAYS[severity]} days</small></div>
                  <b>{openBySeverity[severity]} open</b>
                </div>)}
              </div>
              <p className="panel-footnote">Per-issue age and SLA-breach tracking arrive with posture history.</p>
            </article>
            <article className="panel exec-card">
              <div className="panel-heading"><div><p className="eyebrow">Coverage &amp; throughput</p><h2>Collection</h2></div></div>
              <ScoreGauge value={coveragePercent} caption="Collector checks succeeded" />
              <div className="throughput-row"><div><small>Open</small><strong>{openFindings.length}</strong></div><div><small>Resolved / excepted</small><strong>{resolvedCount}</strong></div></div>
            </article>
          </section>

          <section className="dashboard-grid">
            <article className="panel asset-mix-panel">
              <div className="panel-heading"><div><p className="eyebrow">Active snapshot</p><h2>Observed assets by service</h2></div><span className="status-pill status-positive">{state?.activeSnapshot ? formatTimestamp(state.activeSnapshot.collectedAt) : "No snapshot"}</span></div>
              {serviceCounts.length ? <div className="asset-mix-list">{serviceCounts.map(([service, count]) => <div key={service}><span>{service.toUpperCase()}</span><i><b style={{ width: `${Math.max(6, (count / maxServiceCount) * 100)}%` }} /></i><strong>{count}</strong></div>)}</div> : <div className="empty-state"><strong>No inventory published</strong><span>Validate the trust role and run the first complete sync.</span></div>}
            </article>

            <article className="panel signal-panel">
              <div className="panel-heading"><div><p className="eyebrow">Current capabilities</p><h2>What this collection checks</h2></div></div>
              <div className="signal-list">
                <div><span className="signal-icon signal-green">01</span><p><strong>Configuration posture</strong><small>Exposure, encryption, logging, IAM and native-service coverage</small></p><b>Included</b></div>
                <div><span className="signal-icon signal-blue">02</span><p><strong>Asset relationships</strong><small>Account, region, network, identity and service context</small></p><b>Included</b></div>
                <div><span className="signal-icon signal-amber">03</span><p><strong>Native threat &amp; CVE services</strong><small>Import existing GuardDuty, Security Hub and Inspector findings when those services are already enabled</small></p><b className="muted-status">Read-only import</b></div>
              </div>
              <p className="panel-footnote">Sutra’s deterministic recommendations are not runtime behavior analytics or package vulnerability scanning.</p>
            </article>
          </section>

          <section className="panel table-panel">
            <div className="panel-heading"><div><p className="eyebrow">Priority queue</p><h2>Critical and high findings</h2></div><a className="text-link" href="/findings">View all findings →</a></div>
            <div className="data-table" role="table" aria-label="Priority findings">
              <div className="data-row data-header" role="row"><span>Severity</span><span>Finding</span><span>Resource</span><span>Status</span><span aria-label="Actions" /></div>
              {priorityFindings.map((finding) => {
                const resource = finding.resourceKey ? resourceMap.get(finding.resourceKey) : null;
                return <div className="data-row" role="row" key={finding.fingerprint}>
                  <span><span className={`severity-badge severity-${finding.severity}`}>{finding.severity}</span></span>
                  <span className="primary-cell"><strong>{finding.title}</strong><small>{finding.controlKey}</small></span>
                  <span className="primary-cell"><strong>{resource?.name ?? resource?.nativeId ?? "Account level"}</strong><small>{resource?.region ?? connection.awsAccountId}</small></span>
                  <span className="muted-cell">{finding.status}</span>
                  <span><a className="row-action" href="/findings" aria-label={`Open ${finding.title}`}>→</a></span>
                </div>;
              })}
              {priorityFindings.length === 0 ? <div className="empty-state"><strong>No open critical or high findings</strong><span>This reflects the active snapshot and configured control coverage only.</span></div> : null}
            </div>
          </section>

          <section className="dashboard-bottom-grid">
            <article className="panel customer-live-card">
              <div className="panel-heading"><div><p className="eyebrow">Managed customer</p><h2>{connection.customerName}</h2></div><span className="customer-avatar large">{connection.customerName.slice(0, 2).toUpperCase()}</span></div>
              <dl><div><dt>AWS account</dt><dd>{connection.awsAccountId}</dd></div><div><dt>Region scope</dt><dd>{allEnabledRegionScope ? (coveredRegions.length > 0 ? coveredRegions.join(", ") : "All account-enabled Regions (discovered during sync)") : connection.enabledRegions.join(", ")}</dd></div><div><dt>Last successful sync</dt><dd>{formatTimestamp(connection.lastSuccessfulSyncAt)}</dd></div><div><dt>Permission pack</dt><dd>{connection.permissionPackVersion}</dd></div></dl>
              <a className="text-link" href="/customers">Open customer workspace →</a>
            </article>
            <article className="panel sync-history-card">
              <div className="panel-heading"><div><p className="eyebrow">Collection history</p><h2>Recent runs</h2></div></div>
              <div className="sync-run-list">{(state?.syncRuns ?? []).slice(0, 5).map((run) => <div key={run.id}><span className={`coverage-state coverage-${run.status === "succeeded" ? "succeeded" : run.status === "partial" ? "partial" : "failed"}`} /><p><strong>{run.status}</strong><small>{formatTimestamp(run.finishedAt ?? run.createdAt)}</small></p><b>{run.coverageState}</b></div>)}{(state?.syncRuns.length ?? 0) === 0 ? <div className="empty-state"><strong>No sync runs yet</strong><span>Run the first inventory collection from onboarding.</span></div> : null}</div>
            </article>
          </section>

          <section className="panel" aria-label="Explore the platform">
            <div className="panel-heading"><div><p className="eyebrow">Launchpad</p><h2>Explore the platform</h2></div><span className="result-count">{EXPLORE_LINKS.length} more capabilities</span></div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginTop: 4 }}>
              {EXPLORE_LINKS.map((link) => (
                <a className="metric-card" key={link.href} href={withConn(link.href)} style={{ minHeight: 0, padding: "13px 15px" }}>
                  <div className="metric-topline"><span>{link.label}</span><span className="metric-glyph">{link.glyph}</span></div>
                  <p style={{ marginTop: 8 }}>{link.blurb}</p>
                </a>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </AppShell>
  );
}
