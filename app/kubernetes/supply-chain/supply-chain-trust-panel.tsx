"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  SupplyChainTrustReport,
  SupplyChainVerificationState,
} from "../../../lib/supply-chain-verification";

// The verification engine runs server-side in
// /api/v1/kubernetes/supply-chain/trust, which loads the same stored evidence
// for the same (connection, cluster, limit=200) scope, collapses it to one
// artifact per image digest with the same adapter, and passes the same empty
// VEX/vulnerability inputs. Only the report *type* is imported here, so there
// is a single implementation and the engine no longer ships to the browser.
const EVIDENCE_LIMIT = 200;

interface TrustBody extends SupplyChainTrustReport {
  readonly connectionId: string;
  readonly clusterId: string;
  readonly configured: boolean;
  readonly error?: { readonly message?: string };
}

function stateClass(state: SupplyChainVerificationState): string {
  if (state === "verified") return "settings-pill is-good";
  if (state === "failed") return "settings-pill is-risk";
  return "settings-pill";
}

function stateLabel(state: SupplyChainVerificationState): string {
  return state === "verified" ? "Verified" : state === "failed" ? "Failed" : "Not configured";
}

function scoreClass(score: number): string {
  if (score >= 80) return "settings-pill is-good";
  if (score >= 50) return "compliance-status compliance-status-unknown";
  return "settings-pill is-risk";
}

function shortDigest(digest: string): string {
  return digest.startsWith("sha256:") ? `sha256:${digest.slice(7, 19)}…` : digest.slice(0, 19);
}

export function SupplyChainTrustPanel({
  connectionId,
  clusterId,
}: {
  readonly connectionId: string | null;
  readonly clusterId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<TrustBody | null>(null);

  const refresh = useCallback(async () => {
    if (connectionId === null || clusterId === null) {
      setReport(null);
      return;
    }
    try {
      const response = await fetch(
        `/api/v1/kubernetes/supply-chain/trust?connectionId=${encodeURIComponent(connectionId)}` +
          `&clusterId=${encodeURIComponent(clusterId)}&limit=${EVIDENCE_LIMIT}`,
        { cache: "no-store", credentials: "same-origin" },
      );
      const body = await response.json().catch(() => null) as TrustBody | null;
      if (!response.ok || body === null || body.schema !== "sutra.supply-chain-verification.v1") {
        setReport(null);
        return;
      }
      setReport(body);
    } catch {
      // The surrounding workspace already reports evidence-load failures; the
      // derived trust panel simply stays hidden rather than claiming a state.
      setReport(null);
    }
  }, [clusterId, connectionId]);

  useEffect(() => {
    const task = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(task);
  }, [refresh]);

  // `configured` is the route's report of whether any stored evidence exists in
  // this scope — the same condition the panel used to check locally.
  if (report === null || !report.configured) return null;

  const { totals } = report;
  const fullyVerified = report.artifacts.filter((a) => a.signatureState === "verified" && a.provenanceState === "verified").length;
  const avgTrust = report.artifacts.length === 0
    ? 0
    : Math.round(report.artifacts.reduce((sum, a) => sum + a.trustScore, 0) / report.artifacts.length);

  return (
    <section className="panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Cosign signing · SLSA provenance</p><h2>Supply-chain trust verification</h2></div>
        <span className="result-count">{fullyVerified}/{report.artifacts.length} fully verified</span>
      </div>
      <p className="panel-footnote">A two-axis trust score per image from the <strong>submitted</strong> Cosign signature and SLSA build-provenance attestations. A &ldquo;verified&rdquo; state is only accepted with its key/builder evidence; a verified signature or provenance does not by itself establish source-code safety.</p>

      <div className="inventory-stats">
        <article><small>Fleet trust score</small><strong>{avgTrust}/100</strong><span>{report.artifacts.length} image{report.artifacts.length === 1 ? "" : "s"} scored</span></article>
        <article><small>Signature verified</small><strong>{totals.signatureVerified}</strong><span>{totals.signatureFailed} failed · {totals.signatureNotConfigured} not configured</span></article>
        <article><small>Provenance verified</small><strong>{totals.provenanceVerified}</strong><span>{totals.provenanceFailed} failed · {totals.provenanceNotConfigured} not configured</span></article>
        <article><small>VEX suppressions</small><strong>{totals.vulnerabilitiesSuppressed}</strong><span>{totals.vexRejected > 0 ? `${totals.vexRejected} rejected` : "no VEX statements ingested"}</span></article>
      </div>

      <div className="heading-actions" style={{ marginTop: 8 }}>
        <button className="button button-secondary button-small" onClick={() => setOpen(!open)} type="button">{open ? "Hide per-image trust" : `Show ${report.artifacts.length} images`}</button>
      </div>
      {open ? <div className="vuln-delta-list" style={{ marginTop: 10 }}>
        {report.artifacts.map((artifact) => <article className="vuln-delta-row" key={artifact.imageDigest}>
          <span className={scoreClass(artifact.trustScore)}>{artifact.trustScore}/100</span>
          <div>
            <strong><code>{shortDigest(artifact.imageDigest)}</code></strong>
            <small>{artifact.rationale.join(" · ")}</small>
          </div>
          <div className="supply-chain-trust-states">
            <span className={stateClass(artifact.signatureState)}>Sig: {stateLabel(artifact.signatureState)}</span>
            <span className={stateClass(artifact.provenanceState)}>Prov: {stateLabel(artifact.provenanceState)}{artifact.provenance.slsaLevel !== null ? ` · SLSA ${artifact.provenance.slsaLevel}` : ""}</span>
          </div>
        </article>)}
      </div> : null}
    </section>
  );
}
