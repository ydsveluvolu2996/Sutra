"use client";

import { useCallback, useEffect, useState } from "react";
import type { NetworkExposureReport, ResourceExposure } from "../../lib/aws-network-exposure";
import type { LatencyReport } from "../../lib/reachability-latency";
import { usePilotState } from "../components/use-pilot-state";

interface NetworkExposureResponse {
  readonly exposure: NetworkExposureReport;
  readonly latency: LatencyReport;
  readonly inputs: {
    readonly networkInterfaces: number;
    readonly securityGroups: number;
    readonly subnets: number;
    readonly routeTables: number;
    readonly internetGateways: number;
    readonly loadBalancers: number;
    readonly dnsRecords: number;
    readonly latencySamples: number;
  };
  readonly scannedAt: string | null;
  readonly error?: { readonly message?: string };
}

const EXPOSURE_ORDER: readonly ResourceExposure["exposure"][] = ["internet-exposed", "unknown", "not-exposed"];

function statusClass(exposure: ResourceExposure["exposure"]): string {
  const suffix = exposure === "internet-exposed" ? "fail" : exposure === "unknown" ? "unknown" : "pass";
  return `compliance-status compliance-status-${suffix}`;
}

function statusLabel(exposure: ResourceExposure["exposure"]): string {
  return exposure === "internet-exposed" ? "Internet-exposed" : exposure === "unknown" ? "Unknown" : "Not exposed";
}

export function NetworkExposureBrowser() {
  const { state, loading, error, refresh } = usePilotState();
  const connection = state?.connection ?? null;
  const connectionId = connection?.id ?? null;
  const [data, setData] = useState<NetworkExposureResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (connectionId === null) { setData(null); setLoadError(null); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/network-exposure?connectionId=${encodeURIComponent(connectionId)}`, { cache: "no-store", credentials: "same-origin" });
      const body = await response.json() as NetworkExposureResponse;
      if (!response.ok || body.exposure === undefined) throw new Error(body.error?.message ?? "Network exposure analysis is unavailable");
      setData(body);
      setLoadError(null);
    } catch (caught) {
      setData(null);
      setLoadError(caught instanceof Error ? caught.message : "Network exposure analysis is unavailable");
    } finally {
      setBusy(false);
    }
  }, [connectionId]);
  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const exposed = (data?.exposure.resources ?? [])
    .slice()
    .sort((a, b) => EXPOSURE_ORDER.indexOf(a.exposure) - EXPOSURE_ORDER.indexOf(b.exposure) || a.ref.localeCompare(b.ref, "en-US"));

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Reachability &amp; exposure</p>
          <h1>Network exposure</h1>
          <p className="page-subtitle">For each collected network interface, whether a complete internet allow-path exists — reachability (an internet-gateway route to a public IP, or an internet-facing load balancer) AND a permitting security group — with open vs NACL-filtered ports, DNS entry points, and endpoint latency. Static path analysis over collected evidence, not a live probe.</p>
        </div>
        <div className="heading-actions">
          <a className="button button-secondary" href="/findings">Posture findings</a>
          <button className="button button-primary" disabled={busy} onClick={() => { void refresh(); void load(); }} type="button">{busy ? "Refreshing…" : "Refresh"}</button>
        </div>
      </section>

      <div className="trust-strip" role="note"><span className="trust-icon">!</span><span><strong>Reachability, not a live scan.</strong> A resource is internet-exposed only when every hop of the allow-path is present in the collected evidence; when the subnet, route table, gateway, or a referenced security group is missing, exposure is &ldquo;unknown&rdquo; — never a fabricated &ldquo;not exposed&rdquo;. When no Network ACL is collected, AWS&rsquo;s default allow-all is assumed. This is not proof of live reachability.</span></div>

      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Evidence unavailable</strong><span>{error}</span><button onClick={() => void refresh()} type="button">Retry</button></div> : null}
      {loadError ? <div className="page-alert page-alert-error" role="alert"><strong>Network exposure unavailable</strong><span>{loadError}</span><button onClick={() => void load()} type="button">Retry</button></div> : null}
      {(loading || busy) && data === null ? <div className="loading-state" role="status"><span className="loading-spinner" />Tracing internet allow-paths over collected evidence…</div> : null}

      {!loading && connection === null ? (
        <section className="panel empty-workspace"><span className="empty-workspace-icon">NX</span><h2>No AWS account is connected</h2><p>Connect and validate a customer account so Sutra can trace internet reachability over its collected network evidence.</p><a className="button button-primary" href="/onboard">Connect AWS account</a></section>
      ) : null}

      {data !== null ? (
        <>
          <section className="metric-row">
            <div className="metric-card"><span className="metric-label">Internet-exposed</span><span className="metric-value">{data.exposure.summary.internetExposed}</span></div>
            <div className="metric-card"><span className="metric-label">Unknown</span><span className="metric-value">{data.exposure.summary.unknown}</span></div>
            <div className="metric-card"><span className="metric-label">Not exposed</span><span className="metric-value">{data.exposure.summary.notExposed}</span></div>
            <div className="metric-card"><span className="metric-label">Interfaces analyzed</span><span className="metric-value">{data.exposure.summary.resources}</span></div>
          </section>

          {data.exposure.summary.resources === 0 ? (
            <section className="panel"><h2>No network interfaces collected</h2><p>This connection has no collected <code>network-interface</code> resources yet. Run an AWS collection so route tables, security groups, and interfaces are available for path analysis.</p></section>
          ) : (
            <section className="panel">
              <h2>Reachability by interface</h2>
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Interface</th><th>Exposure</th><th>Open ports</th><th>Filtered ports</th><th>DNS entry points</th><th>Path / missing evidence</th></tr></thead>
                  <tbody>
                    {exposed.map((row) => (
                      <tr key={row.ref}>
                        <td><code>{row.ref}</code></td>
                        <td><span className={statusClass(row.exposure)}>{statusLabel(row.exposure)}</span></td>
                        <td>{row.openPorts.length > 0 ? row.openPorts.join(", ") : "—"}</td>
                        <td>{row.filteredPorts.length > 0 ? row.filteredPorts.join(", ") : "—"}</td>
                        <td>{row.dnsNames.length > 0 ? row.dnsNames.join(", ") : "—"}</td>
                        <td className="cell-detail">{row.exposure === "unknown" ? <em>missing: {row.missingEvidence.join("; ")}</em> : row.path.length > 0 ? row.path.join(" → ") : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="panel">
            <h2>Endpoint latency</h2>
            {data.latency.summary.endpoints === 0 ? (
              <p>No latency samples have been collected yet, so every endpoint is <strong>unknown</strong> — response, application, and database latency light up once a CloudWatch/APM latency collector is configured. Sutra never fabricates timings.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Endpoint</th><th>Worst</th><th>Response p95</th><th>Application p95</th><th>Database p95</th></tr></thead>
                  <tbody>
                    {data.latency.endpoints.map((endpoint) => (
                      <tr key={endpoint.endpointRef}>
                        <td><code>{endpoint.endpointRef}</code></td>
                        <td>{endpoint.worstStatus}</td>
                        <td>{endpoint.metrics.response.p95Ms ?? "—"}</td>
                        <td>{endpoint.metrics.application.p95Ms ?? "—"}</td>
                        <td>{endpoint.metrics.database.p95Ms ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="page-footnote">Inputs: {data.inputs.networkInterfaces} interfaces · {data.inputs.securityGroups} security groups · {data.inputs.subnets} subnets · {data.inputs.routeTables} route tables · {data.inputs.internetGateways} internet gateways · {data.inputs.loadBalancers} load balancers · {data.inputs.dnsRecords} DNS records{data.scannedAt !== null ? ` · collected ${data.scannedAt}` : ""}</p>
        </>
      ) : null}
    </>
  );
}
