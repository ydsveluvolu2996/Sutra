"use client";

import { useMemo, useState } from "react";
import type { KubernetesSupplyChainEvidence } from "../../../lib/kubernetes-supply-chain";
import { evidenceToArtifact } from "../../../lib/supply-chain-trust-inputs";
import {
  verifySupplyChainTrust,
  type SupplyChainVerificationState,
} from "../../../lib/supply-chain-verification";

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

export function SupplyChainTrustPanel({ evidence }: { readonly evidence: readonly KubernetesSupplyChainEvidence[] }) {
  const [open, setOpen] = useState(false);

  const report = useMemo(() => {
    // One artifact per image digest (evidence may carry history for a digest).
    const byDigest = new Map<string, KubernetesSupplyChainEvidence>();
    for (const record of evidence) {
      if (!byDigest.has(record.image.digest)) byDigest.set(record.image.digest, record);
    }
    return verifySupplyChainTrust({
      artifacts: [...byDigest.values()].map((record) => evidenceToArtifact(record)),
      vexStatements: [],
      vulnerabilities: [],
    });
  }, [evidence]);

  if (evidence.length === 0) return null;

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
