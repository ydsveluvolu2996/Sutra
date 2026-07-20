"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { RegistryInventoryResult } from "../../../lib/registry-inventory";
import { usePilotState } from "../../components/use-pilot-state";

interface RegistryInventoryResponse {
  readonly inventory: RegistryInventoryResult;
  readonly inputs: {
    readonly clusters: number;
    readonly observedImages: number;
    readonly repositoriesRepresented: number;
  };
  readonly connectionId: string;
  readonly error?: { readonly message?: string };
}

function findingLabel(kind: string): string {
  return kind === "latest-tag-in-use"
    ? "Mutable latest tag"
    : kind === "unpinned-tag"
      ? "Unpinned tag (no digest)"
      : "Stale repository (no tags)";
}

export function RegistryInventoryBrowser() {
  const { state, loading, error, refresh } = usePilotState();
  const connection = state?.connection ?? null;
  const connectionId = connection?.id ?? null;
  const [data, setData] = useState<RegistryInventoryResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (connectionId === null) { setData(null); setLoadError(null); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/registry/inventory?connectionId=${encodeURIComponent(connectionId)}`, { cache: "no-store", credentials: "same-origin" });
      const body = await response.json() as RegistryInventoryResponse;
      if (!response.ok || body.inventory === undefined) throw new Error(body.error?.message ?? "Registry inventory is unavailable");
      setData(body);
      setLoadError(null);
    } catch (caught) {
      setData(null);
      setLoadError(caught instanceof Error ? caught.message : "Registry inventory is unavailable");
    } finally {
      setBusy(false);
    }
  }, [connectionId]);
  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const inventory = data?.inventory ?? null;
  const findings = inventory?.coverage === "complete" ? inventory.findings : [];
  const digests = inventory?.coverage === "complete" ? inventory.digests : [];

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Registry inventory &amp; policy</p>
          <h1>Registry inventory</h1>
          <p className="page-subtitle">Repository, tag, and digest inventory over the container images already observed in your Kubernetes supply-chain evidence, with tag/digest hygiene policy: mutable <code>latest</code> tags, tags with no captured digest, and repositories that returned no tags. Inventory and policy only — this is not image CVE scanning.</p>
        </div>
        <div className="heading-actions">
          <Link className="button button-secondary" href="/kubernetes/supply-chain">Supply chain</Link>
          <button className="button button-primary" disabled={busy} onClick={() => { void refresh(); void load(); }} type="button">{busy ? "Refreshing…" : "Refresh"}</button>
        </div>
      </section>

      <div className="trust-strip" role="note"><span className="trust-icon">!</span><span><strong>Inventory and tag/digest policy only, not a CVE scan.</strong> {inventory?.disclaimer ?? "Image CVE scanning remains gated on a verified Trivy runtime."} When no image references have been collected the coverage is reported as &ldquo;unknown&rdquo; — the absence of findings must never be read as a clean registry.</span></div>

      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Evidence unavailable</strong><span>{error}</span><button onClick={() => void refresh()} type="button">Retry</button></div> : null}
      {loadError ? <div className="page-alert page-alert-error" role="alert"><strong>Registry inventory unavailable</strong><span>{loadError}</span><button onClick={() => void load()} type="button">Retry</button></div> : null}
      {(loading || busy) && data === null ? <div className="loading-state" role="status"><span className="loading-spinner" />Inventorying observed image references…</div> : null}

      {!loading && connection === null ? (
        <section className="panel empty-workspace"><span className="empty-workspace-icon">RG</span><h2>No AWS account is connected</h2><p>Connect and validate a customer account so Sutra can inventory the container images observed in its collected Kubernetes supply-chain evidence.</p><a className="button button-primary" href="/onboard">Connect AWS account</a></section>
      ) : null}

      {inventory !== null ? (
        <>
          <section className="metric-row">
            <div className="metric-card"><span className="metric-label">Repositories observed</span><span className="metric-value">{inventory.repositoriesObserved}</span></div>
            <div className="metric-card"><span className="metric-label">Digest inventory</span><span className="metric-value">{digests.length}</span></div>
            <div className="metric-card"><span className="metric-label">Policy findings</span><span className="metric-value">{findings.length}</span></div>
            <div className="metric-card">
              <span className="metric-label">Coverage</span>
              <span className={`compliance-status compliance-status-${inventory.coverage === "complete" ? "pass" : "unknown"}`}>
                {inventory.coverage === "complete" ? "Complete" : "Unknown coverage"}
              </span>
            </div>
          </section>

          {inventory.coverage === "unknown-coverage" ? (
            <section className="panel">
              <h2>Coverage is unknown</h2>
              <p>No representable registry catalog was collected for this connection (reason: <code>{inventory.reason}</code>). Sutra observed no complete tag/digest evidence, so <strong>no policy findings are shown and the registry must not be assumed clean</strong>. Registry inventory lights up once container images are observed in this connection&rsquo;s Kubernetes supply-chain evidence.</p>
            </section>
          ) : findings.length === 0 && digests.length === 0 ? (
            <section className="panel"><h2>No image references collected</h2><p>This connection&rsquo;s collected evidence contains no container image references yet. Scan a Kubernetes cluster so its observed images are available for inventory and tag/digest policy.</p></section>
          ) : (
            <>
              <section className="panel">
                <h2>Tag / digest policy findings</h2>
                {findings.length === 0 ? (
                  <p>No tag or digest policy violations across the observed repositories.</p>
                ) : (
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead><tr><th>Repository</th><th>Tag</th><th>Finding</th><th>Severity</th><th>Evidence</th></tr></thead>
                      <tbody>
                        {findings.map((finding, index) => (
                          <tr key={`${finding.repository}-${finding.kind}-${finding.tag ?? "none"}-${index}`}>
                            <td><code>{finding.repository}</code></td>
                            <td>{finding.tag ?? "—"}</td>
                            <td>{findingLabel(finding.kind)}</td>
                            <td><span className={`compliance-status compliance-status-${finding.severity === "medium" ? "fail" : "unknown"}`}>{finding.severity}</span></td>
                            <td className="cell-detail">{finding.evidence}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="panel">
                <h2>Digest inventory</h2>
                {digests.length === 0 ? (
                  <p>No captured manifest digests. Every observed tag was referenced without a valid digest.</p>
                ) : (
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead><tr><th>Repository</th><th>Tag</th><th>Digest</th></tr></thead>
                      <tbody>
                        {digests.map((entry) => (
                          <tr key={`${entry.repository}-${entry.tag}`}>
                            <td><code>{entry.repository}</code></td>
                            <td>{entry.tag}</td>
                            <td className="cell-detail"><code>{entry.digest}</code></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}

          <p className="page-footnote">Inputs: {data?.inputs.clusters ?? 0} clusters · {data?.inputs.observedImages ?? 0} observed images · {data?.inputs.repositoriesRepresented ?? 0} repositories represented · collected {inventory.fetchedAt}</p>
        </>
      ) : null}
    </>
  );
}
