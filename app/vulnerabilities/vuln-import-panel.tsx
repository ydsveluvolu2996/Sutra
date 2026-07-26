"use client";

// Operator control for importing a third-party scanner export into the unified
// vulnerability queue. It follows the FinOps CUR/FOCUS upload precedent in
// app/costs/finops-panels.tsx: paste (or load a local file into) the export, submit
// it as JSON to a bounded, same-origin endpoint, and surface what was accepted AND
// what was rejected — a rejected record is always disclosed, never silently dropped.
//
// The report never leaves the browser except as the POST body to
// /api/v1/vulnerabilities/imports; the panel never asks for a URL to fetch, and it
// never asks for scanner credentials — producing the export is an out-of-band,
// scanner-side step.

import { useCallback, useEffect, useState } from "react";

type ImportSource = "qualys" | "rapid7" | "registry" | "grype" | "osv";

interface ImportContract {
  readonly operation: string;
  readonly sources: readonly ImportSource[];
  readonly limits: { readonly maxBodyBytes: number; readonly maxFindings: number };
  readonly permissions: { readonly canImport: boolean };
}

interface ImportReject {
  readonly kind: string;
  readonly locator: string;
}

interface ImportResult {
  readonly source: string;
  readonly imported: number;
  readonly rejected: readonly ImportReject[];
  readonly rejectedCount: number;
  readonly coverage: string;
}

const SOURCE_LABELS: Readonly<Record<ImportSource, string>> = {
  qualys: "Qualys VM/VMDR host detections",
  rapid7: "Rapid7 InsightVM asset export",
  registry: "Trivy container image (trivy image --format json)",
  grype: "Grype (grype -o json)",
  osv: "OSV-Scanner (osv-scanner --format json)",
};

const SOURCE_HINTS: Readonly<Record<ImportSource, string>> = {
  qualys: "Expected shape: { \"hosts\": [ { fqdn | ip | assetId, detections: [ { qid, severity, cveIds } ] } ] }, or a bare array of hosts. Replaces this connection's Qualys findings only.",
  rapid7: "Expected shape: { \"assets\": [ { hostName | ip | id, vulnerabilities: [ { id, severity, cves } ] } ] }, or a bare array of assets. Replaces this connection's Rapid7 findings only.",
  registry: "Paste the output of `trivy image --format json <ref>` for ONE image. Replaces that image's findings only; a report with no findings resolves them rather than declaring the image clean.",
  grype: "Paste the output of `grype -o json <target>`. The resource key is stored verbatim as the CMDB key, so use the same key the resource is inventoried under.",
  osv: "Paste the output of `osv-scanner --format json <target>`. A GHSA-only advisory is stored with cveId null — a CVE is never invented.",
};

function errorMessage(value: unknown, fallback: string): string {
  return value instanceof Error && value.message.length > 0 ? value.message : fallback;
}

export function VulnImportPanel({ connectionId }: { readonly connectionId: string | null }) {
  const [contract, setContract] = useState<ImportContract | null>(null);
  const [source, setSource] = useState<ImportSource>("qualys");
  const [imageRef, setImageRef] = useState("");
  const [resourceKey, setResourceKey] = useState("");
  const [resourceKind, setResourceKind] = useState("container-image");
  const [report, setReport] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const loadContract = useCallback(async () => {
    if (connectionId === null) return;
    try {
      const response = await fetch(
        `/api/v1/vulnerabilities/imports?connectionId=${encodeURIComponent(connectionId)}`,
        { cache: "no-store", credentials: "same-origin" },
      );
      if (!response.ok) { setContract(null); return; }
      setContract(await response.json() as ImportContract);
    } catch {
      setContract(null);
    }
  }, [connectionId]);

  useEffect(() => {
    const task = window.setTimeout(() => void loadContract(), 0);
    return () => window.clearTimeout(task);
  }, [loadContract]);

  const readFile = useCallback(async (file: File | undefined) => {
    if (file === undefined) return;
    setFailure(null);
    try {
      setReport(await file.text());
    } catch (caught) {
      setFailure(errorMessage(caught, "That file could not be read"));
    }
  }, []);

  const submit = useCallback(async () => {
    if (connectionId === null) return;
    setBusy(true);
    setFailure(null);
    setResult(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(report);
      } catch {
        throw new Error("The export is not valid JSON — paste the scanner's JSON output verbatim.");
      }
      const body: Record<string, unknown> = {
        operation: contract?.operation ?? "publish-normalized-evidence",
        source,
        connectionId,
        report: parsed,
      };
      if (source === "registry") body.imageRef = imageRef.trim();
      if (source === "grype" || source === "osv") {
        body.resourceKey = resourceKey.trim();
        body.resourceKind = resourceKind.trim();
      }
      const response = await fetch("/api/v1/vulnerabilities/imports", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as ImportResult & { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "The import was rejected");
      setResult(payload);
      setReport("");
    } catch (caught) {
      setFailure(errorMessage(caught, "The import was rejected"));
    } finally {
      setBusy(false);
    }
  }, [connectionId, contract, imageRef, report, resourceKey, resourceKind, source]);

  if (connectionId === null || contract === null || !contract.permissions.canImport) return null;

  const needsImageRef = source === "registry";
  const needsBinding = source === "grype" || source === "osv";
  const ready = report.trim().length > 0 &&
    (!needsImageRef || imageRef.trim().length > 0) &&
    (!needsBinding || (resourceKey.trim().length > 0 && resourceKind.trim().length > 0));

  return (
    <section className="panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Operator import · third-party scanners</p><h2>Import a vulnerability export</h2></div>
        <span className="result-count">{contract.sources.length} sources</span>
      </div>
      <p className="panel-footnote">Sutra does not run these scanners. Export the report from the scanner you already operate, then import it here: it is normalized into the same model as Amazon Inspector and ranked in the queue above by CISA KEV, then EPSS, then CVSS/severity. Every record that cannot be represented is rejected and listed below — nothing is silently dropped or repaired. Reports are capped at {Math.round(contract.limits.maxBodyBytes / 1024)} KiB and {contract.limits.maxFindings} findings per import; use the CLI ingest runners for anything larger.</p>

      <div className="filter-bar">
        <label><span className="sr-only">Scanner source</span>
          <select className="filter-control" value={source} disabled={busy} onChange={(event) => { setSource(event.target.value as ImportSource); setResult(null); setFailure(null); }}>
            {contract.sources.map((option) => <option key={option} value={option}>{SOURCE_LABELS[option]}</option>)}
          </select>
        </label>
        {needsImageRef ? <label><span className="sr-only">Image reference</span><input className="filter-control" placeholder="registry/repo:tag or repo@sha256:…" value={imageRef} disabled={busy} onChange={(event) => setImageRef(event.target.value)} /></label> : null}
        {needsBinding ? <>
          <label><span className="sr-only">CMDB resource key</span><input className="filter-control" placeholder="CMDB resource key (verbatim)" value={resourceKey} disabled={busy} onChange={(event) => setResourceKey(event.target.value)} /></label>
          <label><span className="sr-only">Resource kind</span><input className="filter-control" placeholder="resource kind, e.g. container-image" value={resourceKind} disabled={busy} onChange={(event) => setResourceKind(event.target.value)} /></label>
        </> : null}
        <label><span className="sr-only">Load the export from a local file</span><input className="filter-control" type="file" accept="application/json,.json" disabled={busy} onChange={(event) => void readFile(event.target.files?.[0])} /></label>
        <button className="button button-primary button-small" type="button" disabled={busy || !ready} onClick={() => void submit()}>{busy ? "Importing…" : "Import export"}</button>
      </div>
      <p className="panel-footnote">{SOURCE_HINTS[source]}</p>
      <textarea className="cmpw-controls" aria-label="Scanner export JSON" rows={6} placeholder="Paste the scanner's JSON export here" value={report} disabled={busy} onChange={(event) => setReport(event.target.value)} />

      {failure !== null ? <div className="page-alert page-alert-error" role="alert"><strong>Nothing was stored</strong><span>{failure}</span></div> : null}

      {result !== null ? <>
        <div className="inventory-stats">
          <article><small>Findings stored</small><strong>{result.imported}</strong><span>source {result.source}</span></article>
          <article><small>Records rejected</small><strong>{result.rejectedCount}</strong><span>{result.rejectedCount === 0 ? "every record was representable" : "disclosed below, not ingested"}</span></article>
        </div>
        <p className="panel-footnote">{result.coverage}</p>
        {result.rejected.length > 0 ? <ul className="panel-footnote">
          {result.rejected.map((reject, index) => <li key={`${reject.kind}:${reject.locator}:${index}`}><code>{reject.kind}</code> · {reject.locator}</li>)}
        </ul> : null}
        {result.rejectedCount > result.rejected.length ? <p className="panel-footnote">Showing the first {result.rejected.length} of {result.rejectedCount} rejected records.</p> : null}
      </> : null}
    </section>
  );
}
