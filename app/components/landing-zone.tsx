"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";

import CookieConsent, { openCookieSettings } from "./cookie-consent";
import ThemeToggle, { THEME_CHANGED_EVENT } from "./theme-toggle";

/* ================================================================== *
 * Sutra landing zone — cinematic dark page with a flowing bokeh
 * background, a scroll cue, and a Wiz-style feature explorer.
 * All styles are scoped under `.lz` in globals.css (lz-* keyframes),
 * so nothing here can collide with the authenticated app shell.
 * ================================================================== */

type Row = { dot?: string; k: string; em?: string; v: string; tone?: string };
function pvRows(bar: string, rows: Row[]): string {
  return (
    '<div class="lx-pv"><div class="lx-pv-bar"><i></i><i></i><i></i><span>' + bar + "</span></div><div class=\"lx-pv-body\">" +
    rows
      .map(
        (r) =>
          '<div class="lx-pv-row"><span class="k">' +
          (r.dot ? '<span class="dot" style="background:' + r.dot + '"></span>' : "") +
          r.k +
          (r.em ? " <em>" + r.em + "</em>" : "") +
          '</span><span class="lx-pv-badge ' + (r.tone || "") + '">' + r.v + "</span></div>"
      )
      .join("") +
    "</div></div>"
  );
}

/* Wiz-style inventory table: icon + name/sub + resource count per row */
type InvRow = { ico: string; t: string; nm: string; sub: string; count: string };
const STACK_ICO = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="5" rx="1.4"/><rect x="3" y="12" width="18" height="5" rx="1.4"/><path d="M6.5 6.5h.01M6.5 14.5h.01"/></svg>';
function pvInventory(bar: string, rows: InvRow[]): string {
  return (
    '<div class="lx-pv"><div class="lx-pv-bar"><i></i><i></i><i></i><span>' + bar + '</span></div><div class="lx-pv-body">' +
    '<div class="lx-pv-hdr"><span>Resource</span><span>Collected</span></div>' +
    rows
      .map(
        (r) =>
          '<div class="lx-pv-row"><span class="k"><span class="lx-pv-ico" style="--tt:' + r.t + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">' + r.ico + '</svg></span><span class="nm"><b>' + r.nm + '</b><em>' + r.sub + '</em></span></span><span class="lx-pv-count">' + STACK_ICO + r.count + '</span></div>'
      )
      .join('') +
    '</div></div>'
  );
}
const PV_INVENTORY = pvInventory("cmdb · product workspace", [
  { ico: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/><rect x="9" y="9" width="6" height="6" rx="1"/>', t: "#f0842e", nm: "EC2 Instances", sub: "Virtual machines", count: "208" },
  { ico: '<path d="M12 2 20.5 7v10L12 22 3.5 17V7z"/><circle cx="12" cy="12" r="3.4"/>', t: "#3b82f6", nm: "EKS Clusters", sub: "Container orchestrators", count: "4" },
  { ico: '<path d="M12 3 20 6v6c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V6z"/><circle cx="12" cy="10" r="2.4"/><path d="M12 12.4V15"/>', t: "#8b5cf6", nm: "IAM Roles", sub: "Identities & trust policies", count: "61" },
  { ico: '<path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 6c0 1.7 3.6 3 8 3s8-1.3 8-3"/>', t: "#34d399", nm: "S3 Buckets", sub: "Object storage", count: "37" },
  { ico: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 12h.01M11 12h.01M15 12h.01"/>', t: "#22d3ee", nm: "Network Interfaces", sub: "ENIs · routes · NACLs", count: "143" },
  { ico: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5a14 14 0 0 1 0 17 14 14 0 0 1 0-17Z"/>', t: "#fb7185", nm: "Load Balancers", sub: "ALB · listeners · targets", count: "9" },
]);

const GDEF =
  '<defs><linearGradient id="pvg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset=".5" stop-color="#3b82f6"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>';

const PV_GRAPH =
  '<div class="lx-pv"><div class="lx-pv-bar"><i></i><i></i><i></i><span>security-graph · live</span></div><div class="lx-pv-graph"><svg viewBox="0 0 460 190" preserveAspectRatio="xMidYMid meet">' +
  GDEF +
  '<path class="pvl" d="M44 132 C 110 132 118 96 168 92" fill="none" stroke="url(#pvg)" stroke-width="1.6"/><path class="pvl pd2" d="M168 92 C 236 88 250 50 316 46" fill="none" stroke="url(#pvg)" stroke-width="1.6"/><path class="pvl pd3" d="M168 92 C 240 96 300 118 416 120" fill="none" stroke="url(#pvg)" stroke-width="1.6"/><path class="pvl pd4" d="M168 92 C 200 66 250 62 292 118" fill="none" stroke="#fb7185" stroke-width="1.4" opacity=".7"/>' +
  '<g class="pvn nd1"><circle cx="44" cy="132" r="11" fill="#0c1326" stroke="#3b82f6" stroke-width="1.6"/><text x="44" y="156" text-anchor="middle" font-family="monospace" font-size="8.5" fill="#808db2">internet</text></g>' +
  '<g class="pvn nd2"><circle cx="168" cy="92" r="13" fill="#0c1326" stroke="#3b82f6" stroke-width="1.6"/><text x="168" y="118" text-anchor="middle" font-family="monospace" font-size="8.5" fill="#f4f7ff">api-gateway</text></g>' +
  '<g class="pvn nd3"><circle cx="316" cy="46" r="11" fill="#0c1326" stroke="#22d3ee" stroke-width="1.6"/><text x="316" y="30" text-anchor="middle" font-family="monospace" font-size="8.5" fill="#808db2">payments-sa</text></g>' +
  '<g class="pvn nd4"><circle cx="416" cy="120" r="11" fill="#0c1326" stroke="#3b82f6" stroke-width="1.6"/><text x="416" y="144" text-anchor="middle" font-family="monospace" font-size="8.5" fill="#808db2">s3://billing</text></g>' +
  '<g class="pvn nd5"><circle cx="292" cy="118" r="9" fill="#26121a" stroke="#fb7185" stroke-width="1.5"/><text x="292" y="140" text-anchor="middle" font-family="monospace" font-size="8.5" fill="#fb7185">CVE</text></g>' +
  "</svg></div></div>";

const PV_TRENDS =
  '<div class="lx-pv"><div class="lx-pv-bar"><i></i><i></i><i></i><span>posture · last 90 days</span></div><div class="lx-pv-body lx-pv-spark"><div class="cap-score"><b>82</b><span>▲ +6 this month</span></div><svg viewBox="0 0 300 64" preserveAspectRatio="none">' +
  GDEF +
  '<path class="pva" d="M0 50 L30 46 L60 48 L90 40 L120 42 L150 34 L180 30 L210 32 L240 22 L270 20 L300 14 L300 64 L0 64 Z" fill="url(#pvg)"/><polyline class="pvl" points="0,50 30,46 60,48 90,40 120,42 150,34 180,30 210,32 240,22 270,20 300,14" fill="none" stroke="url(#pvg)" stroke-width="2"/></svg></div></div>';

const PV_FIX =
  '<div class="lx-pv"><div class="lx-pv-bar"><i></i><i></i><i></i><span>kyverno-policy.yaml · generated</span></div><pre class="lx-pv-code"><span class="c"># reviewed suggestion — scoped to the finding</span>\napiVersion: kyverno.io/v1\nkind: <span class="b">ClusterPolicy</span>\nmetadata:\n  name: disallow-privileged\nspec:\n  rules:\n    - name: privileged-containers\n      validate:\n        message: <span class="g">"privileged not allowed"</span>\n        pattern: { spec: { containers: [ { securityContext: { privileged: <span class="g">false</span> } } ] } }</pre></div>';

type Cap = { code: string; label: string; t: string; icon: string; title: string; blurb: string; points: string[]; pv: string; g?: string };
const CAPS: Cap[] = [
  { code: "COLLECT", g: "See & prioritize", label: "Agentless collection", t: "#22d3ee", icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>', title: "Agentless collection, in minutes", blurb: "Twenty-two collectors per region connect via a customer-owned IAM role with temporary STS credentials — full asset coverage with no agents on your workloads and no access keys stored, ever.", points: ["22 collectors per region via STS", "No agents · no stored keys", "Normalized into one CMDB"], pv: PV_INVENTORY },
  { code: "GRAPH", label: "Security graph", t: "#3b82f6", icon: '<circle cx="5" cy="12" r="2.2"/><circle cx="14" cy="6" r="2.2"/><circle cx="14" cy="18" r="2.2"/><circle cx="21" cy="12" r="2.2"/><path d="M7 11 12 7M7 13 12 17M16 7l3 4M16 17l3-4"/>', title: "Evidence-backed security graph", blurb: "Every cloud, Kubernetes, identity and network relationship on one canvas — every edge a cited observation, not a guess.", points: ["Cloud + cluster + identity in one model", "Confirmed vs. theoretical reachability", "Click any edge to see the evidence"], pv: PV_GRAPH },
  { code: "ISSUES", label: "Runtime-informed issues", t: "#fb7185", icon: '<path d="M12 3 22 20H2z"/><path d="M12 10v5M12 18h.01"/>', title: "Runtime-informed issues", blurb: "Not thousands of CVEs — the handful that are internet-reachable, running and exploitable, proven with observed evidence.", points: ["Toxic-combination detection", "Reachability from real network flows", "Prioritized by exposure, not just CVSS"], pv: pvRows("issues · prioritized", [
    { dot: "#fb7185", k: "Internet-reachable workload", em: "running CVE-2024-3094", v: "Critical", tone: "red" },
    { dot: "#fbbf24", k: "Privileged pod reachable from ingress", em: "hostPID", v: "High", tone: "amber" },
    { dot: "#fbbf24", k: "ServiceAccount can delete a prod S3 bucket", em: "no MFA", v: "High", tone: "amber" },
    { dot: "#93c5fd", k: "Drifted workload gained a new CVE", em: "batch-runner · since last scan", v: "Medium", tone: "blue" },
    { k: "12,988 CVEs suppressed", em: "not reachable · not running", v: "deprioritized", tone: "green" }]) },
  { code: "CIEM", label: "Effective permissions", t: "#8b5cf6", icon: '<circle cx="8" cy="13" r="4"/><path d="m11 10 9-9M17 4l3 3"/>', title: "Effective permissions", blurb: "Resolve a workload's effective RBAC and follow its IRSA or EKS Pod Identity link into AWS — can this pod delete an S3 bucket?", points: ["In-cluster RBAC solver", "IRSA + Pod Identity → AWS reach", "Flags: secrets, exec, unused SA"], pv: pvRows("effective-permissions", [
    { k: "api-gateway", em: "mounts payments-sa token", v: "IRSA", tone: "blue" },
    { k: "payments-sa → PaymentsRole", em: "assume-role", v: "aws-reach", tone: "violet" },
    { k: "s3:DeleteObject on billing/*", em: "allowed", v: "aws-write", tone: "red" },
    { k: "batch-runner-sa", em: "no workload uses it", v: "unused", tone: "amber" }]) },
  { code: "EXPOSE", label: "Network exposure", t: "#22d3ee", icon: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5a14 14 0 0 1 0 17 14 14 0 0 1 0-17Z"/>', title: "Network exposure & port filtering", blurb: "A proven internet path — gateway route, NACL port filter, load-balancer target, DNS entry point — with open vs filtered ports per interface.", points: ["Hop-by-hop reachability, each hop cited", "Open vs NACL-filtered ports", "Missing evidence → honest unknown"], pv: pvRows("network-exposure", [
    { dot: "#fb7185", k: "eni-api-gw", em: "443 open · 8080 filtered by acl-1", v: "Internet-exposed", tone: "red" },
    { dot: "#34d399", k: "eni-batch", em: "22 filtered by acl-2", v: "Not exposed", tone: "green" },
    { dot: "#fbbf24", k: "eni-worker", em: "no route evidence", v: "Unknown", tone: "amber" },
    { dot: "#8b5cf6", k: "api.northstar.io", em: "DNS entry point → eni-api-gw", v: "DNS", tone: "violet" },
    { dot: "#93c5fd", k: "alb/public-web", em: "2 healthy targets · listener :443", v: "LB target", tone: "blue" }]) },
  { code: "PATCH", label: "Patch plans", t: "#f0842e", icon: '<rect x="4" y="4" width="7" height="7" rx="1.4"/><rect x="13" y="13" width="7" height="7" rx="1.4"/><path d="M11 7.5h5.5v5.5"/>', title: "Patch plans, not CVE lists", blurb: "Hundreds of CVEs collapse into the handful of version bumps that actually fix them — ranked by KEV, EPSS and reachability.", points: ["One upgrade per package + image", "KEV & EPSS-aware priority", "SLA due dates per severity"], pv: pvRows("patch-plan · ranked", [
    { k: "openssl 3.0.11 → 3.0.14", em: "fixes 4 CVEs", v: "KEV", tone: "red" },
    { k: "libxml2 2.9.1 → 2.12.0", em: "fixes 2 CVEs", v: "EPSS 0.62", tone: "amber" },
    { k: "base image node:18 → node:20", em: "fixes 12 CVEs", v: "12 CVEs", tone: "blue" },
    { k: "golang.org/x/net v0.17 → v0.23", em: "fixes 3 CVEs", v: "EPSS 0.31", tone: "blue" },
    { k: "SLA", em: "critical 7d · high 30d", v: "2 due this week", tone: "amber" }]) },
  { code: "GATE", g: "Ship & operate", label: "CI security gate", t: "#06b6c4", icon: '<path d="M12 3 20 6v6c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V6z"/><path d="m9 12 2 2 4-4"/>', title: "CI security gate", blurb: "The same scanners gate every build — Jenkins, GitHub Actions or an in-cluster Job — with severity thresholds and a JUnit report the pipeline renders.", points: ["Jenkins + Kubernetes + Actions", "Severity fail-on thresholds", "Skips reported, never silent passes"], pv: pvRows("ci-gate · fail-on high", [
    { k: "secret-scan", em: "no committed secrets", v: "pass", tone: "green" },
    { k: "iac-scan", em: "clean at fail-on high", v: "pass", tone: "green" },
    { k: "image-vulns", em: "1 critical · CVE-2024-3094", v: "fail", tone: "red" },
    { k: "sbom-attest", em: "no artifact provided", v: "skip", tone: "amber" }]) },
  { code: "TRENDS", label: "Posture trends", t: "#34d399", icon: '<path d="M4 19V5M4 19h16"/><path d="m7 14 3-3 3 2 4-5"/>', title: "Posture trends & scorecard", blurb: "A per-customer security score over time with regression detection and a resell-ready export — the report an MSP hands over.", points: ["Score per customer over time", "Automatic regression detection", "Exportable MSP scorecard"], pv: PV_TRENDS },
  { code: "DRIFT", label: "Drift & new CVEs", t: "#f0842e", icon: '<path d="M8 3H4v4M4 3l6 6M16 21h4v-4M20 21l-6-6"/>', title: "Drift & new-CVE detection", blurb: "Catch a workload that drifted from its admitted spec, or an image that gained a vulnerability since the last scan.", points: ["Live spec vs. admitted spec diff", "New-CVE delta between scans", "Severity-ranked, cited to the change"], pv: pvRows("drift · since last scan", [
    { dot: "#fbbf24", k: "replicas", em: "3 → 5", v: "drift", tone: "amber" },
    { dot: "#fbbf24", k: "image tag", em: ":1.4.2 → :latest", v: "drift", tone: "amber" },
    { dot: "#fb7185", k: "batch-runner", em: "gained CVE-2024-3094", v: "new CVE", tone: "red" },
    { dot: "#34d399", k: "api-gateway", em: "matches admitted spec · digest pinned", v: "in sync", tone: "green" }]) },
  { code: "FIX", label: "Guided remediation", t: "#06b6c4", icon: '<path d="M14.5 6.5a3.5 3.5 0 0 1-4.6 4.6L4 17l3 3 5.9-5.9a3.5 3.5 0 0 1 4.6-4.6l-2.2 2.2-2-2z"/>', title: "Guided remediation", blurb: "Generate the exact Kyverno policy or kubectl patch that fixes an issue — a reviewed suggestion, never an automatic change.", points: ["Kyverno policy or kubectl patch", "Scoped to the specific finding", "You review and apply — never auto"], pv: PV_FIX },
  { code: "RUNTIME", label: "Runtime detection", t: "#fb7185", icon: '<path d="M3 12h4l2 6 4-14 2 8h6"/>', title: "Runtime detection", blurb: "Signed, replay-resistant Falco events with Kubernetes context, human-confirmed cases and durable notification delivery.", points: ["Signed, replay-resistant events", "Full pod and workload context", "Human-confirmed cases + alerting"], pv: pvRows("runtime · falco events", [
    { dot: "#fb7185", k: "Shell spawned in container", em: "api-gateway · pod-7f9", v: "signed", tone: "red" },
    { dot: "#fbbf24", k: "Unexpected outbound connection", em: "batch-runner → 185.x", v: "case open", tone: "amber" },
    { dot: "#fb7185", k: "Sensitive file read", em: "/etc/shadow", v: "signed", tone: "red" }]) },
  { code: "COMPLY", label: "Readiness mappings", t: "#34d399", icon: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8 9 2 2 4-4M8 15h6"/>', title: "Readiness mappings", blurb: "CIS Kubernetes, NSA/CISA and SOC 2 readiness mapped to cited evidence — a readiness view, never a certification claim.", points: ["CIS, NSA/CISA, SOC 2 mappings", "Every control cited to evidence", "Honest readiness, not a pass stamp"], pv: '<div class="lx-pv"><div class="lx-pv-bar"><i></i><i></i><i></i><span>readiness · cited to evidence</span></div><div class="lx-pv-body"><div class="lx-pv-bars"><div class="lx-pv-barrow"><span>CIS Kubernetes</span><span class="lx-pv-track"><span class="lx-pv-fill" style="width:78%"></span></span><em>78%</em></div><div class="lx-pv-barrow"><span>NSA / CISA</span><span class="lx-pv-track"><span class="lx-pv-fill" style="width:84%"></span></span><em>84%</em></div><div class="lx-pv-barrow"><span>SOC 2 (CC)</span><span class="lx-pv-track"><span class="lx-pv-fill" style="width:71%"></span></span><em>71%</em></div></div></div></div>' },
  { code: "VULN", g: "Manage & prove", label: "Vulnerability management", t: "#fb7185", icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5h.01"/><path d="M5.5 5.5 3 3M18.5 5.5 21 3M5.5 18.5 3 21M18.5 18.5 21 21"/>', title: "Vulnerability management, unified", blurb: "One queue for cluster, cloud and container-registry CVEs — Trivy scans registry images, AWS Inspector findings arrive in the same view, all enriched from a local EPSS + KEV mirror (~349k CVEs), with SLA tracking and a waiver workflow.", points: ["EPSS + KEV mirror, refreshed locally", "Registry image scanning (Trivy) + AWS Inspector, one queue", "Waivers with owner, reason & expiry"], pv: pvRows("vuln-queue · unified", [
    { dot: "#fb7185", k: "CVE-2024-3094 · xz-utils", em: "KEV · reachable · running", v: "act now", tone: "red" },
    { dot: "#fbbf24", k: "registry.acme/app@sha256:… · openssl", em: "Trivy image scan", v: "registry", tone: "amber" },
    { dot: "#fbbf24", k: "CVE-2023-44487 · http/2", em: "EPSS 0.71 · Inspector", v: "high", tone: "amber" },
    { k: "CVE-2022-40897 · setuptools", em: "waived · expires 2026-09-01", v: "waived", tone: "blue" },
    { k: "349,204 CVEs mirrored", em: "EPSS + KEV · nightly", v: "local DB", tone: "green" }]) },
  { code: "SUPPLY", label: "Supply-chain trust", t: "#8b5cf6", icon: '<path d="M7 8a4 4 0 1 1 4 4H8a4 4 0 0 1-1-8z"/><path d="M17 16a4 4 0 1 1-4-4h3a4 4 0 0 1 1 8z"/>', title: "Supply-chain verification", blurb: "Cosign signatures, SLSA provenance and VEX statements verified per image — plus SBOM diffing between builds so a new dependency never slips in silently.", points: ["Cosign signature verification", "SLSA provenance & VEX statements", "SBOM diff between releases"], pv: pvRows("supply-chain · per image", [
    { dot: "#34d399", k: "api-gateway:1.4.2", em: "cosign verified · SLSA L2", v: "trusted", tone: "green" },
    { dot: "#fb7185", k: "batch-runner:latest", em: "unsigned image", v: "untrusted", tone: "red" },
    { k: "SBOM diff 1.4.1 → 1.4.2", em: "+2 deps · 1 flagged", v: "review", tone: "amber" },
    { k: "CVE-2024-3094", em: "VEX: not_affected (vendor)", v: "VEX", tone: "violet" }]) },
  { code: "IAC", label: "IaC & admission", t: "#f0842e", icon: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/><path d="m10 9-2 3 2 3M14 9l2 3-2 3"/>', title: "IaC & admission misconfiguration", blurb: "The same policy set scans Terraform and Kubernetes manifests in CI and enforces at admission with Kyverno — one source of truth from commit to cluster.", points: ["Terraform + manifest scanning", "Kyverno admission enforcement", "Same policies in CI and cluster"], pv: pvRows("iac-scan · fail-on high", [
    { dot: "#fb7185", k: "aws_s3_bucket.exports", em: "public-read ACL", v: "fail", tone: "red" },
    { dot: "#fbbf24", k: "Deployment/batch-runner", em: "privileged: true", v: "warn", tone: "amber" },
    { dot: "#34d399", k: "admission · disallow-privileged", em: "blocked at deploy", v: "enforced", tone: "green" }]) },
  { code: "NETPOL", label: "NetworkPolicy generator", t: "#22d3ee", icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18M12 3v18"/>', title: "Least-privilege NetworkPolicies", blurb: "Generate NetworkPolicies from observed Hubble flows — allow exactly what the workload actually talks to, deny the rest, and review before applying.", points: ["Built from observed flows", "Default-deny with explicit allows", "Reviewed before apply — never auto"], pv: pvRows("networkpolicy · generated", [
    { dot: "#34d399", k: "allow api-gateway → payments :8443", em: "12,405 flows observed", v: "allow", tone: "green" },
    { dot: "#34d399", k: "allow api-gateway → dns :53", em: "kube-dns", v: "allow", tone: "green" },
    { dot: "#fb7185", k: "everything else", em: "default", v: "deny", tone: "red" },
    { k: "policy.yaml", em: "ready for review", v: "generated", tone: "blue" }]) },
  { code: "TENANCY", label: "MSP multi-tenancy", t: "#34d399", icon: '<circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 6.4a3.2 3.2 0 0 1 0 6.1M20.5 20a5.6 5.6 0 0 0-4.2-5.4"/>', title: "MSP multi-tenancy", blurb: "Portfolio roll-up for your team; every customer user sees only their explicitly granted workspaces, accounts, resources and findings — enforced at every layer.", points: ["Cross-customer portfolio view", "Per-customer scoped workspaces", "Isolation enforced at every query"], pv: pvRows("tenancy · scoped access", [
    { dot: "#22d3ee", k: "MSP operator", em: "sees all customers", v: "portfolio", tone: "blue" },
    { dot: "#8b5cf6", k: "northstar-admin", em: "Northstar workspace only", v: "scoped", tone: "violet" },
    { dot: "#8b5cf6", k: "bluepeak-viewer", em: "read-only · Bluepeak", v: "scoped", tone: "violet" },
    { k: "cross-tenant access attempts", em: "denied + audited", v: "0 allowed", tone: "green" }]) },
  { code: "ALERTS", label: "Ticketing & alerting", t: "#06b6c4", icon: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>', title: "Ticketing & alerting", blurb: "Findings route to the tools you already run — generic webhooks for Jira or ServiceNow, Slack notifications, with durable delivery and human-confirmed cases.", points: ["Generic webhook (Jira / ServiceNow)", "Durable, retried delivery", "Human-confirmed case workflow"], pv: pvRows("notifications · delivery", [
    { dot: "#34d399", k: "Critical issue → Jira SEC-142", em: "webhook · 201 created", v: "delivered", tone: "green" },
    { dot: "#34d399", k: "Runtime case → Slack #sec-ops", em: "signed event", v: "delivered", tone: "green" },
    { dot: "#fbbf24", k: "ServiceNow INC0091", em: "retry 2/5 · backoff", v: "retrying", tone: "amber" }]) },
  { code: "FINOPS", label: "Cloud cost (FinOps)", t: "#34d399", icon: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.2a3 2.4 0 0 0-2.5-1.2c-1.8 0-2.8.9-2.8 1.9 0 1 .9 1.5 2.8 1.9 1.9.4 2.8 1 2.8 2s-1 1.9-2.8 1.9a3 2.4 0 0 1-2.5-1.2"/><path d="M12 6v12"/>', title: "FinOps cost allocation & savings", blurb: "Ingest AWS CUR 2.0 and FOCUS 1.0 billing, allocate spend by tag, account or service, track budgets, flag statistical spend anomalies, and surface commitment and rightsizing candidates — with an explicitly disclosed assumed discount rate, never a guaranteed-savings claim.", points: ["CUR 2.0 / FOCUS 1.0 ingestion + allocation", "Budgets + statistical anomaly signals", "Commitment & rightsizing, disclosed not promised"], pv: pvRows("finops · this period", [
    { dot: "#fbbf24", k: "Untagged spend", em: "$4,210 unallocated · disclosed", v: "allocate", tone: "amber" },
    { dot: "#fb7185", k: "EC2 spend spike", em: "3.1x trailing median", v: "anomaly", tone: "red" },
    { dot: "#34d399", k: "Compute Savings Plan candidate", em: "~20% assumed rate · not a quote", v: "commitment", tone: "green" },
    { dot: "#93c5fd", k: "Rightsizing candidate", em: "utilization not collected", v: "investigate", tone: "blue" }]) },
  { code: "API", label: "Public API & SDKs", t: "#3b82f6", icon: '<path d="M8 3H7a2 2 0 0 0-2 2v3.5a2 2 0 0 1-2 2 2 2 0 0 1 2 2V16a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v3.5a2 2 0 0 0 2 2 2 2 0 0 0-2 2V16a2 2 0 0 1-2 2h-1"/>', title: "Public API & typed SDKs", blurb: "A versioned, tenant-scoped REST API at /api/public/v1 with scoped service-account tokens, opaque cursor pagination and idempotent writes — plus a typed OpenAPI spec and hand-written TypeScript and Python client SDKs, so your automation reads resources, findings, cases, vulnerabilities and compliance exactly as the UI does.", points: ["Versioned REST API · scoped tokens", "Typed TS + Python SDKs from OpenAPI", "Cursor pagination · idempotent writes · quotas"], pv: pvRows("public-api · /v1", [
    { dot: "#34d399", k: "GET /v1/vulnerabilities", em: "scoped token · 200 OK", v: "read", tone: "green" },
    { dot: "#93c5fd", k: "PATCH /v1/cases/{id}", em: "Idempotency-Key honored", v: "write", tone: "blue" },
    { dot: "#8b5cf6", k: "@sutra/sdk · sutra (PyPI)", em: "generated from OpenAPI", v: "SDK", tone: "violet" },
    { dot: "#fbbf24", k: "120 requests / minute / token", em: "quota enforced", v: "limit", tone: "amber" }]) },
];

const MARQUEE = ["Amazon EKS", "AWS IAM & IRSA", "EKS Pod Identity", "Trivy Operator", "Falco runtime", "Kyverno admission", "Cilium · Hubble", "Amazon GuardDuty", "Security Hub", "Amazon Inspector", "SBOM & signing", "Kubernetes RBAC", "CIS Benchmarks", "KEV · EPSS", "Jenkins & GitOps gates", "Route tables & NACLs"];

type Panel = { name: string; icon: string; h3: string; lead: string; points: string[]; mini: string; chips: string[] };
const PLATFORM: Panel[] = [
  { name: "cloud", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5a14 14 0 0 1 0 17 14 14 0 0 1 0-17Z"/></svg>', h3: "Cloud CMDB & reachability", lead: "Twenty-two collectors per region build a normalized asset graph, then trace which resources are provably internet-reachable — gateway route, NACL port filter, load-balancer target, DNS entry point.", points: ["Open vs NACL-filtered ports, per resource", "Every hop cited; unknowns disclosed, never guessed"], chips: ["CSPM & CMDB", "Route tables · IGW · NACLs", "ELB target membership", "DNS entry points", "Universal CMDB · blast-radius", "Cloud cost · FinOps allocation", "Report builder · CSV / PDF", "Public API v1 & typed SDKs"], mini: '<svg viewBox="0 0 400 232"><path class="gl" d="M42 176 C 110 176 122 118 192 116 M192 116 C 262 114 282 64 352 62" stroke="#3b82f6"/><g class="gn" style="opacity:1"><circle cx="42" cy="176" r="12"/><text x="42" y="200" text-anchor="middle">igw</text></g><g class="gn" style="opacity:1"><circle cx="192" cy="116" r="13"/><text x="192" y="140" text-anchor="middle" fill="#f4f7ff">subnet</text></g><g class="gn acc" style="opacity:1"><circle cx="352" cy="62" r="12"/><text x="352" y="86" text-anchor="middle">sg :443</text></g></svg>' },
  { name: "k8s", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.2"/></svg>', h3: "Kubernetes posture & runtime", lead: "KSPM over admitted specs, workload & image drift, SBOM findings and signed Falco runtime events — correlated onto the same workloads, not a separate console.", points: ["Live spec vs admitted-spec drift", "Runtime-informed prioritization (KEV · EPSS · reachable)"], chips: ["KSPM over admitted specs", "Workload & image drift", "SBOM & new-CVE delta", "Signed Falco runtime", "Unified vuln mgmt · EPSS · KEV", "Patch plans · read-only", "Metric alerting · Jira / ServiceNow"], mini: '<svg viewBox="0 0 400 232"><g class="gn" style="opacity:1"><rect x="150" y="84" width="100" height="60" rx="11" stroke="#3b82f6" stroke-width="1.7"/><text x="200" y="118" text-anchor="middle" fill="#f4f7ff">workload</text></g><g class="gn crit" style="opacity:1"><circle cx="304" cy="66" r="10"/><text x="304" y="50" text-anchor="middle" fill="#fb7185">drift</text></g></svg>' },
  { name: "id", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="13" r="4"/><path d="m11 10 9-9M17 4l3 3"/></svg>', h3: "Cross-plane effective permissions", lead: "Kubernetes RBAC unioned with IRSA and EKS Pod Identity into one answer: what can this pod actually do — in the cluster and in the AWS account?", points: ["RBAC ∪ IRSA ∪ Pod Identity → AWS reach", "Unused & default-ServiceAccount flags"], chips: ["In-cluster RBAC solver", "IRSA & EKS Pod Identity", "AWS-reach verdicts", "Unused-SA flags"], mini: '<svg viewBox="0 0 400 232"><path class="gl" d="M68 116 H 184 M216 116 H 332" stroke="#3b82f6"/><g class="gn" style="opacity:1"><circle cx="55" cy="116" r="13"/><text x="55" y="140" text-anchor="middle">pod</text></g><g class="gn acc" style="opacity:1"><circle cx="200" cy="116" r="13"/><text x="200" y="140" text-anchor="middle">SA</text></g><g class="gn" style="opacity:1"><circle cx="345" cy="116" r="13"/><text x="345" y="140" text-anchor="middle">IAM</text></g></svg>' },
];

const COMPARISON = [
  { dim: "Finding confidence", them: "A severity score you have to trust", sutra: "Tri-state verdicts — unknown is disclosed, never hidden" },
  { dim: "Missing data", them: "Silently reported as passing", sutra: "Surfaced as missing evidence on the finding itself" },
  { dim: "Identity risk", them: "Cloud IAM and cluster RBAC in separate views", sutra: "One answer: RBAC + IRSA + Pod Identity → AWS reach" },
  { dim: "Internet exposure", them: "A security-group rule check", sutra: "Full path: route, NACL filter, LB target membership, DNS" },
  { dim: "Remediation", them: "Auto-applied changes or a ticket dump", sutra: "Reviewed Kyverno / kubectl fixes, patch plans, CI gate" },
  { dim: "Tenancy", them: "A single-tenant console", sutra: "MSP portfolio roll-up plus per-customer scoped workspaces" },
  { dim: "EKS depth", them: "Kubernetes bolted onto a cloud scanner", sutra: "EKS-native — RBAC, IRSA, Pod Identity, admission, Falco and Hubble in one model" },
  { dim: "Platform scope", them: "Point tools for posture, cost, CMDB, vuln and patch", sutra: "CNAPP, universal CMDB, FinOps, vulnerability, patch and compliance on one graph" },
  { dim: "MSP economics", them: "A separate FinOps product, priced per seat", sutra: "Per-customer showback, chargeback and unit economics beside every risk" },
];

const DIFFERENTIATORS = [
  { c: "01", h: "Evidence-honest by design", p: "Every verdict is tri-state — pass, fail, or unknown. When the evidence to decide is missing, Sutra says so on the finding. It never fabricates a “safe”.", proof: "Tri-state verdicts · missing evidence disclosed · every edge cited" },
  { c: "02", h: "One identity answer, cross-plane", p: "Kubernetes RBAC, IRSA annotations and EKS Pod Identity associations resolve into a single effective-permission verdict: what can this pod actually do?", proof: "RBAC ∪ IRSA ∪ Pod Identity → AWS reach · unused & default-SA flags" },
  { c: "03", h: "Reachability, hop by hop", p: "Internet exposure is a proven path, not a security-group guess: gateway route, NACL port filter, load-balancer target, DNS entry point — each hop present, or the verdict is unknown.", proof: "IGW route · open vs filtered ports · LB targets · DNS entry points" },
  { c: "04", h: "One platform, not seven point tools", p: "CNAPP posture, universal CMDB, FinOps, vulnerability management, patch posture and compliance readiness all resolve against a single evidence graph — not six consoles you reconcile by hand.", proof: "CNAPP · CMDB · FinOps · vuln · patch · compliance — one graph" },
  { c: "05", h: "A CMDB that reaches beyond the cloud", p: "The normalized asset graph ingests AWS and EKS, plus imported SaaS, network devices and on-prem assets — with a relationship and dependency graph that shows the blast radius before you change anything.", proof: "Cloud + SaaS + network + on-prem · dependency & blast-radius graph" },
  { c: "06", h: "Read-only in, generate-only out", p: "Access is strictly read-only STS with no keys stored, and every fix is a reviewed Kyverno policy, kubectl patch or patch plan — Sutra never mutates your environment on its own.", proof: "Read-only STS · no keys stored · reviewed fixes, never auto-applied" },
];

const LAYERS = [
  { n: "01", h: "Customer cloud", p: "A customer-owned IAM role grants only the metadata APIs in the selected collector pack." },
  { n: "02", h: "Collector plane", p: "An AWS workload identity obtains short-lived STS credentials and performs bounded regional discovery." },
  { n: "03", h: "Normalized CMDB", p: "Assets, relationships and evidence are validated, scoped and promoted only after a complete run." },
  { n: "04", h: "MSP control plane", p: "Role-aware dashboards, findings, audit history and customer access operate without exposing AWS credentials." },
];

/* ------------------------------------------------------------------ *
 * Pricing. `monthly` is the list price in USD per month, per connected
 * workspace/account scope. Annual billing bills 10 months for 12 (two
 * months free ≈ 17% off), computed in the renderer. A tier with no
 * `monthly` is custom/enterprise ("Contact us"). Feature bullets are
 * drawn only from capabilities that already ship on this page (see CAPS
 * / PLATFORM above); any numeric limit is explicitly marked "example".
 * ------------------------------------------------------------------ */
type Tier = { name: string; tagline: string; monthly?: number; cta: string; ctaHref: string; feat?: boolean; lead: string; points: string[]; eg: string };
const TIERS: Tier[] = [
  {
    name: "Starter",
    tagline: "Single-account posture, proven from day one",
    monthly: 15,
    cta: "Book a walkthrough",
    ctaHref: "/contact",
    lead: "Agentless collection and the evidence graph for a small AWS + EKS footprint.",
    points: [
      "Agentless collection · customer-owned IAM role, STS only",
      "Cloud + Kubernetes CMDB and security graph",
      "Runtime-informed, reachability-confirmed issues",
      "Readiness mappings — CIS, NSA/CISA, SOC 2 (CC)",
      "Email & webhook alerting",
    ],
    eg: "Example scope: up to 3 connected AWS accounts",
  },
  {
    name: "Growth",
    tagline: "The full CNAPP + FinOps operations suite",
    monthly: 30,
    cta: "Book a walkthrough",
    ctaHref: "/contact",
    feat: true,
    lead: "Everything in Starter, plus unified vulnerability management and cost.",
    points: [
      "Everything in Starter",
      "Vulnerability management — EPSS + KEV mirror, Trivy + AWS Inspector",
      "Patch plans, drift and new-CVE detection",
      "Cloud cost (FinOps) — CUR/FOCUS allocation & anomalies",
      "Supply-chain trust, IaC scanning & CI security gate",
      "Ticketing — Jira / ServiceNow webhooks & Slack",
    ],
    eg: "Example scope: up to 15 connected AWS accounts",
  },
  {
    name: "Portfolio",
    tagline: "Multi-tenant operations for the whole book",
    cta: "Contact us",
    ctaHref: "/contact",
    lead: "Everything in Growth, built for running many customers at once.",
    points: [
      "Everything in Growth",
      "MSP multi-tenancy — portfolio roll-up + per-customer scoped workspaces",
      "Public REST API & typed TypeScript / Python SDKs",
      "Per-customer posture trends & resell-ready scorecards",
      "Isolation enforced at every query, cross-tenant access audited",
    ],
    eg: "Example scope: unlimited customers, priced per workspace",
  },
];

/* Annual billing = 10 months billed for 12 (two months free). */
function annualTotal(monthly: number): number {
  return monthly * 10;
}

/* Trust content. NO customer claims — no logos, quotes or testimonials, because
 * Sutra has no customers to cite yet and will not invent social proof. The badge
 * row and FAQ state only what is truthfully accurate about the product today. */
const TRUST_BADGES = [
  "SOC 2 readiness mapping — not a certification",
  "Read-only, customer-owned access",
  "Every finding cited to collected evidence",
  "No customer access keys stored",
  "Data-minimizing by design",
];
const FAQ: Array<{ q: string; a: string }> = [
  { q: "How does onboarding work?", a: "You deploy a customer-owned IAM role from the CloudFormation template we provide. A separate collector workload assumes that role with temporary STS credentials and performs read-only, metadata-only discovery — no agents on your workloads, no access keys stored. Book a walkthrough to see the full product before connecting any account." },
  { q: "Is the access really read-only?", a: "Yes. The role grants metadata-only permission packs, is owned by you, and is scoped with a unique platform-generated ExternalId. There are no write permissions and no customer access keys ever leave your account or enter the browser or web control plane." },
  { q: "Which clouds and platforms are supported?", a: "AWS and Amazon EKS. Sutra is not multi-cloud — there is no Azure or GCP support. Within that scope it correlates cloud, Kubernetes, identity, network, runtime and supply-chain evidence into one graph." },
  { q: "How is my data handled?", a: "Data-minimizing by design: only normalized, scoped metadata evidence is validated and promoted after a complete collection run. Customer credentials never reach the browser or the web control plane, and each customer sees only the workspaces explicitly granted to them." },
  { q: "Is there an API?", a: "Yes — a versioned, tenant-scoped REST API at /api/public/v1 with scoped service-account tokens, cursor pagination and idempotent writes, plus typed TypeScript and Python SDKs generated from the OpenAPI spec. Automation reads resources, findings, cases, vulnerabilities and compliance exactly as the UI does." },
  { q: "Are you SOC 2 or ISO certified?", a: "We do not claim certifications the product does not hold. Sutra maps collected evidence to CIS Kubernetes, NSA/CISA and SOC 2 (CC) controls as an honest readiness view — a readiness mapping, never a pass stamp or a certification badge." },
];

function Arrow() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
function Check({ s = 15 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6}>
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}
function Plus() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/* Scroll-pinned suite wheel (Prisma-style): the donut stays fixed while the
 * right column scrolls; each story block lights its segment. */
function SuiteWheel() {
  const [on, setOn] = useState(0);
  const blocksRef = useRef<Array<HTMLDivElement | null>>([]);
  useEffect(() => {
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => { if (e.isIntersecting) setOn(Number((e.target as HTMLElement).dataset.i)); }),
      { rootMargin: "-40% 0px -40% 0px" }
    );
    blocksRef.current.forEach((b) => b && io.observe(b));
    return () => io.disconnect();
  }, []);
  const segs = [
    { d: "M220.5 60.4 A150 150 0 0 1 344.8 275.8", label: "CLOUD", lx: 370, ly: 118 },
    { d: "M334.3 293.9 A150 150 0 0 1 85.7 293.9", label: "KUBERNETES", lx: 210, ly: 412 },
    { d: "M75.2 275.8 A150 150 0 0 1 199.5 60.4", label: "IDENTITY", lx: 50, ly: 118 },
  ];
  const go = (i: number) => blocksRef.current[i]?.scrollIntoView({ behavior: "smooth", block: "center" });
  return (
    <div className="wheel-wrap">
      <div className="wheel-pin">
        <svg className="wheel" viewBox="0 0 420 440" aria-hidden="true">
          <defs><linearGradient id="wg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#22d3ee" /><stop offset=".5" stopColor="#3b82f6" /><stop offset="1" stopColor="#8b5cf6" /></linearGradient></defs>
          {segs.map((s, i) => <path key={s.label} className="wseg" d={s.d} data-on={i === on} onClick={() => go(i)} />)}
          {segs.map((s, i) => <text key={s.label} className="wlab" x={s.lx} y={s.ly} textAnchor="middle" data-on={i === on}>{s.label}</text>)}
          <circle className="wcore" cx={210} cy={210} r={86} />
          <text className="wcore-t" x={210} y={205} textAnchor="middle">Sutra</text>
          <text className="wcore-s" x={210} y={228} textAnchor="middle">ONE EVIDENCE GRAPH</text>
        </svg>
      </div>
      <div>
        {PLATFORM.map((p, i) => (
          <div key={p.name} className="wblock" data-on={i === on} data-i={i} ref={(el) => { blocksRef.current[i] = el; }}>
            <span className="sec-kicker">{p.name === "cloud" ? "Cloud" : p.name === "k8s" ? "Kubernetes" : "Identity"}</span>
            <h3>{p.h3}</h3>
            <p className="lead">{p.lead}</p>
            <div className="wchips">{p.chips.map((c) => <span key={c} className="wchip"><Check s={14} /> {c}</span>)}</div>
            <div className="mini" style={{ maxWidth: 560 }} dangerouslySetInnerHTML={{ __html: p.mini }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* Full-screen scroll-pinned statements (Prisma-style scrollytelling). */
const STMTS: Array<{ pre: string; em: string; post?: string; sub: string }> = [
  { pre: "Every tool floods you with ", em: "thousands of CVEs.", sub: "and calls it visibility" },
  { pre: "Sutra shows the ", em: "few that are provably reachable.", sub: "exposure · running · identity · blast radius" },
  { pre: "With ", em: "cited evidence", post: " behind every verdict.", sub: "tri-state verdicts · every edge cited" },
];
function Statements() {
  const ref = useRef<HTMLElement | null>(null);
  const [on, setOn] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const r = el.getBoundingClientRect();
      const total = Math.max(1, r.height - window.innerHeight);
      const prog = Math.min(0.999, Math.max(0, -r.top / total));
      setOn(Math.floor(prog * STMTS.length));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <section className="stmts" ref={ref} aria-label="Why Sutra exists">
      <div className="stmts-pin">
        {STMTS.map((s, i) => (
          <div key={s.em} className="stmt" data-on={i === on}>
            <div>
              <h2>{s.pre}<span className="em">{s.em}</span>{s.post ?? ""}</h2>
              <small>{s.sub}</small>
            </div>
          </div>
        ))}
        <div className="stmt-dots" aria-hidden="true">{STMTS.map((s, i) => <i key={s.em} data-on={i === on} />)}</div>
      </div>
    </section>
  );
}

/* Wiz-style typewriter: "Yes, Sutra works with <tool>|" */
const TOOLS = ["Trivy Operator", "Falco", "Kyverno", "GuardDuty", "Security Hub", "Inspector", "Jenkins", "GitHub Actions", "Cilium · Hubble"];
function TypeLine() {
  const [txt, setTxt] = useState("");
  useEffect(() => {
    let w = 0, i = 0, del = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const word = TOOLS[w];
      if (!del) {
        i++;
        setTxt(word.slice(0, i));
        if (i === word.length) { del = true; t = setTimeout(tick, 1500); return; }
      } else {
        i--;
        setTxt(word.slice(0, i));
        if (i === 0) { del = false; w = (w + 1) % TOOLS.length; }
      }
      t = setTimeout(tick, del ? 32 : 72);
    };
    t = setTimeout(tick, 500);
    return () => clearTimeout(t);
  }, []);
  return <p className="twr">Yes, Sutra works with <span className="twr-word">{txt}</span><span className="twr-caret" /></p>;
}

function FeatureExplorer() {
  const [sel, setSel] = useState(0);
  const c = CAPS[sel];
  return (
    <div className="explorer">
      <div className="ex-nav" role="tablist" aria-label="Capabilities">
        {CAPS.map((cap, i) => (
          <Fragment key={cap.code}>
          {cap.g ? <div className="exg">{cap.g}</div> : null}
          <button
            className="ex-item"
            role="tab"
            aria-selected={i === sel}
            style={{ "--t": cap.t } as React.CSSProperties}
            onClick={() => setSel(i)}
          >
            <span className="exi">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} dangerouslySetInnerHTML={{ __html: cap.icon }} />
            </span>
            <b>{cap.label}</b>
          </button>
          </Fragment>
        ))}
      </div>
      <div className="ex-panel" key={sel} style={{ "--t": c.t } as React.CSSProperties}>
        <div className="code">{c.code}</div>
        <h3>{c.title}</h3>
        <p className="blurb">{c.blurb}</p>
        <ul className="ex-points">
          {c.points.map((pt) => (
            <li key={pt}>
              <Check /> {pt}
            </li>
          ))}
        </ul>
        <div dangerouslySetInnerHTML={{ __html: c.pv }} />
      </div>
    </div>
  );
}

export default function LandingZone() {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /* ---- flowing bokeh dot field ---- */
    const cv = root.querySelector<HTMLCanvasElement>("#lz-bg");
    let raf = 0;
    let onResize: (() => void) | null = null;
    let onThemeChange: (() => void) | null = null;
    if (cv) {
      const ctx = cv.getContext("2d")!;
      let W = 0, H = 0, DPR = 1;
      let alphaMul = 1;
      let dots: Array<{ x: number; y: number; size: number; a: number; vx: number; vy: number; tw: number; tws: number; sway: number; sp: HTMLCanvasElement }> = [];
      const sprite = (rgb: string, peak: number) => {
        const s = document.createElement("canvas");
        s.width = s.height = 64;
        const c2 = s.getContext("2d")!;
        const g = c2.createRadialGradient(32, 32, 0, 32, 32, 32);
        g.addColorStop(0, "rgba(" + rgb + "," + peak + ")");
        g.addColorStop(0.35, "rgba(" + rgb + "," + peak * 0.42 + ")");
        g.addColorStop(1, "rgba(" + rgb + ",0)");
        c2.fillStyle = g;
        c2.fillRect(0, 0, 64, 64);
        return s;
      };
      let spCyan: HTMLCanvasElement, spViolet: HTMLCanvasElement, spBlue: HTMLCanvasElement;
      const resize = () => {
        DPR = Math.min(2, window.devicePixelRatio || 1);
        W = cv.width = window.innerWidth * DPR;
        H = cv.height = window.innerHeight * DPR;
        cv.style.width = window.innerWidth + "px";
        cv.style.height = window.innerHeight + "px";
        // Read the active theme so the field reads right on both grounds:
        // bright dots on the dark brand default, muted cool dots on light.
        const light = document.documentElement.dataset.theme === "light";
        alphaMul = light ? 0.5 : 1;
        if (light) {
          spCyan = sprite("36,150,178", 0.85);
          spViolet = sprite("120,96,214", 0.85);
          spBlue = sprite("64,110,214", 0.85);
        } else {
          spCyan = sprite("56,224,236", 0.95);
          spViolet = sprite("150,140,246", 0.95);
          spBlue = sprite("90,150,250", 0.95);
        }
        const n = Math.min(150, Math.round((window.innerWidth * window.innerHeight) / 12500));
        dots = Array.from({ length: n }, () => {
          const r = Math.random();
          return {
            x: Math.random() * W, y: Math.random() * H,
            size: (5 + Math.random() * 18) * DPR,
            a: 0.2 + Math.random() * 0.55,
            vx: (Math.random() - 0.5) * 0.14 * DPR, vy: (-0.08 - Math.random() * 0.26) * DPR,
            tw: Math.random() * 6.28, tws: 0.012 + Math.random() * 0.024,
            sway: (0.16 + Math.random() * 0.24) * DPR,
            sp: r < 0.16 ? spViolet : r < 0.42 ? spBlue : spCyan,
          };
        });
      };
      const draw = () => {
        ctx.clearRect(0, 0, W, H);
        for (let i = 0; i < dots.length; i++) {
          const d = dots[i];
          d.x += d.vx + Math.sin(d.tw * 0.7) * d.sway;
          d.y += d.vy;
          d.tw += d.tws;
          if (d.y < -d.size) { d.y = H + d.size; d.x = Math.random() * W; }
          if (d.x < -d.size) d.x = W + d.size; else if (d.x > W + d.size) d.x = -d.size;
          ctx.globalAlpha = d.a * (0.6 + 0.4 * Math.sin(d.tw)) * alphaMul;
          ctx.drawImage(d.sp, d.x - d.size / 2, d.y - d.size / 2, d.size, d.size);
        }
        ctx.globalAlpha = 1;
        raf = requestAnimationFrame(draw);
      };
      resize();
      onResize = resize;
      window.addEventListener("resize", resize);
      // Recolor the dot field the instant the theme flips.
      onThemeChange = () => {
        resize();
        if (reduce) { draw(); cancelAnimationFrame(raf); }
      };
      window.addEventListener(THEME_CHANGED_EVENT, onThemeChange);
      if (reduce) { draw(); cancelAnimationFrame(raf); } else { draw(); }
    }

    /* ---- scroll reveals ---- */
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }),
      { threshold: 0.12 }
    );
    root.querySelectorAll(".rise").forEach((el) => io.observe(el));

    /* ---- count-up stats ---- */
    const cio = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (!e.isIntersecting) return;
          cio.unobserve(e.target);
          const el = e.target as HTMLElement;
          const target = Number(el.getAttribute("data-n"));
          const suffix = el.getAttribute("data-suffix") || "";
          const node = el.firstChild;
          if (!node) return;
          if (reduce) { node.nodeValue = target + suffix; return; }
          let t0: number | null = null;
          const dur = 1100;
          const step = (ts: number) => {
            if (t0 === null) t0 = ts;
            const k = Math.min(1, (ts - t0) / dur);
            node.nodeValue = Math.round((1 - Math.pow(1 - k, 3)) * target) + suffix;
            if (k < 1) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
      { threshold: 0.5 }
    );
    root.querySelectorAll(".stats .n").forEach((el) => cio.observe(el));

    /* ---- header section spy (Prisma-style gradient underline) ---- */
    const navLinks = Array.from(root.querySelectorAll<HTMLAnchorElement>(".head nav a[href^='#']"));
    const spy = new IntersectionObserver(
      (es) => es.forEach((e) => {
        if (!e.isIntersecting) return;
        const id = "#" + (e.target as HTMLElement).id;
        navLinks.forEach((a) => a.setAttribute("data-active", String(a.getAttribute("href") === id)));
      }),
      { rootMargin: "-35% 0px -55% 0px" }
    );
    ["platform", "capabilities", "why", "pricing", "trust", "architecture", "proof"].forEach((id) => {
      const el = root.querySelector("#" + id);
      if (el) spy.observe(el);
    });

    return () => {
      spy.disconnect();
      if (raf) cancelAnimationFrame(raf);
      if (onResize) window.removeEventListener("resize", onResize);
      if (onThemeChange) window.removeEventListener(THEME_CHANGED_EVENT, onThemeChange);
      io.disconnect();
      cio.disconnect();
    };
  }, []);

  return (
    <div className="lz" ref={rootRef}>
      <div className="bg-glows" />
      <canvas className="bg-canvas" id="lz-bg" aria-hidden="true" />

      <header className="head">
        <Link className="lx-brand" href="/" aria-label="Sutra home">
          <span className="mark" aria-hidden="true"><i /><i /><i /></span>
          <span><b>Sutra</b><small>Cloud security, woven together</small></span>
        </Link>
        <nav aria-label="Page sections">
          <a href="#platform">Platform</a><a href="#capabilities">Capabilities</a><a href="#why">Why Sutra</a><a href="#pricing">Pricing</a><a href="#trust">Security model</a><a href="#architecture">Architecture</a><a href="#proof">Trust</a>
        </nav>
        <div className="head-actions">
          <ThemeToggle />
          <Link className="signin" href="/about">About</Link>
          <Link className="signin" href="/login">Sign in</Link>
          <Link className="btn btn-solid" href="/contact">Book a walkthrough <Arrow /></Link>
        </div>
      </header>

      <span id="top" />
      <section className="hero">
        <div className="lx-hero-copy">
          <span className="kicker"><i /> The cloud operations platform for AWS MSPs</span>
          <h1>See every risk.<br /><span className="accent">Prove every path.</span></h1>
          <p>One platform for AWS and Amazon EKS operations — a live CMDB and asset inventory, reachability-proven security, cloud cost (FinOps), compliance readiness, and a tenant-scoped API — woven into a single evidence graph. Sutra surfaces the few risks that are provably reachable and cites the exact observation behind every finding.</p>
          <div className="hero-cta">
            <Link className="btn btn-solid" href="/contact">Book a walkthrough <Arrow /></Link>
            <a className="btn" href="#trust">Review the trust model</a>
          </div>
          <div className="assur"><span><b>✓</b> Read-only access, customer-owned</span><span><b>✓</b> Every finding cited</span><span><b>✓</b> No customer access keys</span></div>
        </div>
        <div className="lx-hero-stage">
          <div className="card">
            <div className="card-bar"><i /><i /><i /><span>security-graph · live</span></div>
            <div
              className="graph"
              dangerouslySetInnerHTML={{
                __html:
                  '<svg viewBox="0 0 440 290" preserveAspectRatio="xMidYMid meet"><defs><linearGradient id="gg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset=".5" stop-color="#3b82f6"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>' +
                  '<path class="gl" d="M50 214 C 124 214 132 150 200 146"/><path class="gl d2" d="M200 146 C 264 142 268 66 344 62"/><path class="gl d3" d="M200 146 C 262 152 276 208 350 214"/><path class="gl rose" d="M200 146 C 226 110 268 100 314 112"/>' +
                  '<g class="gn" style="animation-delay:.15s"><circle cx="50" cy="214" r="13"/><text x="50" y="240" text-anchor="middle">internet</text></g>' +
                  '<g class="gn" style="animation-delay:.5s"><circle cx="200" cy="146" r="15"/><text x="200" y="174" text-anchor="middle" fill="#f4f7ff">api-gateway</text></g>' +
                  '<g class="gn acc" style="animation-delay:.85s"><circle cx="344" cy="62" r="13"/><text x="344" y="88" text-anchor="middle">payments-sa</text></g>' +
                  '<g class="gn" style="animation-delay:1.05s"><circle cx="350" cy="214" r="13"/><text x="350" y="240" text-anchor="middle">s3://billing</text></g>' +
                  '<g class="gn crit" style="animation-delay:1.25s"><circle cx="314" cy="112" r="11"/><text x="314" y="96" text-anchor="middle" fill="#fb7185">CVE</text></g></svg>' +
                  '<span class="gchip c1"><b></b> Internet → api-gateway <em>path confirmed</em></span>' +
                  '<span class="gchip c2"><b></b> payments-sa → s3:DeleteObject <em>via IRSA</em></span>' +
                  '<span class="gchip c3"><b></b> 443 open · 8080 filtered <em>by acl-1</em></span>',
              }}
            />
          </div>
        </div>
        <a className="scroll-cue" href="#platform" aria-label="Scroll to explore">
          <span className="mouse" />
          <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="m6 9 6 6 6-6" /></svg>
          <small>Scroll</small>
        </a>
      </section>

      <Statements />

      <div className="stats">
        <div className="wrap stats-in">
          <div><div className="n" data-n="22">0<em>per region</em></div><div className="l">AWS evidence collectors</div></div>
          <div><div className="n" data-n="5">0<em>frameworks</em></div><div className="l">Compliance readiness mappings</div></div>
          <div><div className="n" data-n="100" data-suffix="%">0<em>of findings</em></div><div className="l">Cited to collected evidence</div></div>
          <div><div className="n" data-n="0">0<em>stored</em></div><div className="l">Customer access keys</div></div>
        </div>
      </div>

      <div className="strip">
        <div className="wrap top">
          <TypeLine />
          <div className="lx-strip-cats"><span><strong>Cloud</strong> CMDB &amp; CSPM</span><span><strong>Kubernetes</strong> KSPM &amp; runtime</span><span><strong>Identity</strong> CIEM &amp; RBAC</span><span><strong>Supply chain</strong> SBOM &amp; signing</span></div>
        </div>
        <div className="marquee" aria-hidden="true">{[...MARQUEE, ...MARQUEE].map((t, i) => <span key={i}>{t}</span>)}</div>
      </div>

      <div className="wrap">
        <section className="block" id="platform">
          <div className="intro center rise"><span className="sec-kicker">Correlation is the product</span><h2>One graph connects the cloud, the cluster, and the identity.</h2><p className="lead">A privileged pod, reachable from the internet, running a critical CVE, with a ServiceAccount that can reach S3 — no single tool sees that whole chain. Sutra correlates it and cites every edge.</p></div>
          <SuiteWheel />
        </section>

        <section className="block" style={{ paddingTop: 0 }} id="capabilities">
          <div className="intro rise"><span className="sec-kicker">One correlated suite</span><h2>Every other tool floods you with CVEs. Sutra shows what&apos;s reachable.</h2><p className="lead">Cloud, Kubernetes, identity, network, runtime and supply-chain evidence in one graph — and only the risks proven to matter surface first. Every capability below is live in the product.</p></div>
          <div className="rise"><FeatureExplorer /></div>
        </section>

        <section className="block" style={{ paddingTop: 0 }} id="why">
          <div className="intro center rise"><span className="sec-kicker">Why teams choose Sutra</span><h2>Built on proof, where others ask for trust.</h2><p className="lead">Most platforms hand you a score. Sutra hands you the observation, the path, and the verdict — including the honest &ldquo;unknown&rdquo; when the evidence isn&apos;t there.</p></div>
          <div className="why rise">
            {DIFFERENTIATORS.map((d) => (
              <article key={d.c} className="lx-why-card"><span className="c">{d.c}</span><h3>{d.h}</h3><p>{d.p}</p><em>{d.proof}</em></article>
            ))}
          </div>
          <div className="compare rise">
            <div className="lx-compare-head">The difference in practice</div>
            <div className="crow crow-head"><span>&nbsp;</span><span>Typical CNAPP</span><span className="sutra">Sutra</span></div>
            {COMPARISON.map((r) => (
              <div key={r.dim} className="crow"><span className="dim">{r.dim}</span><span className="them">{r.them}</span><span className="sutra"><b>✓</b>{r.sutra}</span></div>
            ))}
          </div>
          <p className="lx-compare-note">&ldquo;Typical CNAPP&rdquo; describes common industry patterns, not any specific vendor. Every Sutra behavior above is live in the product.</p>
        </section>

        <section className="block" style={{ paddingTop: 0 }} id="pricing">
          <div className="intro center rise"><span className="sec-kicker">Plans</span><h2>Pricing that scales with your book of business.</h2><p className="lead">Three tiers built around what Sutra already does — collection, the evidence graph, vulnerability management, FinOps, compliance readiness, the API and MSP multi-tenancy.</p></div>
          <p className="lx-price-note">Simple per-month pricing, billed per connected workspace. Pay yearly and get <strong>two months free</strong> (about 17% off). Feature scopes marked <em>example</em> are illustrative, not fixed limits.</p>
          <div className="lx-tiers rise">
            {TIERS.map((t) => (
              <article key={t.name} className={"lx-tier" + (t.feat ? " feat" : "")}>
                {t.feat ? <span className="lx-tier-badge">Most popular</span> : null}
                <h3>{t.name}</h3>
                <p className="tagline">{t.tagline}</p>
                <div className="lx-price">
                  {t.monthly !== undefined
                    ? <><b>${t.monthly}<span className="lx-price-unit">/mo</span></b><small>or ${annualTotal(t.monthly)}/yr billed annually — two months free</small></>
                    : <><b>Custom</b><small>volume pricing for the whole book — let&rsquo;s talk</small></>}
                </div>
                <p className="lx-tier-lead">{t.lead}</p>
                <ul>
                  {t.points.map((pt) => (
                    <li key={pt}><Check s={14} /> {pt}</li>
                  ))}
                </ul>
                <span className="lx-tier-eg">{t.eg}</span>
                <Link className={"btn lx-tier-cta" + (t.feat ? " btn-solid" : "")} href={t.ctaHref}>{t.cta} <Arrow /></Link>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className="block trust" id="trust">
        <div className="wrap trust-in">
          <div className="rise">
            <span className="sec-kicker">Trust is a product feature</span>
            <h2>Customer credentials never enter the browser or web control plane.</h2>
            <p className="lead">A separate collector workload assumes the customer role with temporary STS credentials. The application receives normalized, scoped evidence — not access keys.</p>
            <ul><li><span>01</span> Exact vendor workload-role principal</li><li><span>02</span> Unique, platform-generated ExternalId</li><li><span>03</span> Positive and negative trust validation</li><li><span>04</span> Metadata-only permission packs</li></ul>
            <a className="btn btn-solid" href="#architecture">Review the security architecture <Arrow /></a>
          </div>
          <div className="lx-trust-panel rise">
            <div className="row"><b>role principal</b><span>arn:aws:iam::…:role/sutra-collector</span></div>
            <div className="row"><b>credential type</b><span className="ok">STS · temporary</span></div>
            <div className="row"><b>permission pack</b><span>read-only · metadata</span></div>
            <div className="row"><b>external id</b><span>platform-generated</span></div>
            <div className="row"><b>keys stored</b><span className="ok">none</span></div>
          </div>
        </div>
      </section>

      <div className="wrap">
        <section className="block" id="architecture">
          <div className="intro rise"><span className="sec-kicker">From account to action</span><h2>A production architecture, not a browser-side AWS script.</h2><p className="lead">Collection, normalization and user access live in deliberately separate trust zones.</p></div>
          <div className="layers-wrap">
            <svg className="ribbon" viewBox="0 0 1200 300" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#22d3ee" /><stop offset=".5" stopColor="#3b82f6" /><stop offset="1" stopColor="#8b5cf6" /></linearGradient></defs><path d="M0 200 C 140 120 260 110 400 165 S 640 250 800 180 S 1060 80 1200 140" /></svg>
            <div className="layers rise">
              {LAYERS.map((l) => (
                <div key={l.n} className="layer"><span>{l.n}</span><h4>{l.h}</h4><p>{l.p}</p></div>
              ))}
            </div>
          </div>
        </section>

        <section className="block" style={{ paddingTop: 0 }}>
          <div className="intro rise"><span className="sec-kicker">A suite with honest boundaries</span><h2>Superior correlation and evidence — not a black box that claims certainty it can&apos;t prove.</h2></div>
          <div className="claim rise">
            <div className="claim-col mine"><strong>Sutra provides</strong><ul>
              <li><Check s={16} /> Cloud + Kubernetes CMDB, KSPM and the evidence graph</li>
              <li><Check s={16} /> Runtime-informed, reachability-confirmed issue prioritization</li>
              <li><Check s={16} /> Kubernetes CIEM, drift, new-CVE detection and guided fixes</li>
              <li><Check s={16} /> Per-customer posture trends and resell-ready reporting</li>
            </ul></div>
            <div className="claim-col yours"><strong>Your scanners and cloud still provide</strong><ul>
              <li><Plus /> Trivy image, SBOM and configuration scanning in-cluster</li>
              <li><Plus /> Falco kernel-level runtime detection</li>
              <li><Plus /> GuardDuty, Security Hub and Inspector native findings</li>
              <li><Plus /> The vulnerability databases Sutra keeps you current against</li>
            </ul></div>
          </div>
        </section>
      </div>

      <section className="block proof" id="proof">
        <div className="wrap">
          <div className="intro center rise"><span className="sec-kicker">Security &amp; trust</span><h2>How Sutra works — and what it will never claim.</h2><p className="lead">No customer logos and no quotes: Sutra is early and we will not invent social proof. What we can state plainly is how the product behaves today, and answer the questions teams actually ask.</p></div>

          {/* Honest trust posture — no certification the product does not hold. */}
          <div className="lx-badges rise" aria-label="Trust posture">
            {TRUST_BADGES.map((b) => (
              <span key={b} className="lx-badge"><Check s={13} /> {b}</span>
            ))}
          </div>

          <div className="lx-faq rise">
            <h3 className="lx-faq-title">Frequently asked</h3>
            {FAQ.map((f) => (
              <details key={f.q} className="lx-faq-item">
                <summary>{f.q}<span className="lx-faq-mark" aria-hidden="true"><Plus /></span></summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="final">
        <div className="wrap"><div className="inner rise">
          <span className="sec-kicker">Start in minutes</span>
          <h2>See the MSP experience before connecting an account.</h2>
          <p className="lead">Book a walkthrough of the product, see the control library and the evidence graph, then review the customer-owned IAM role — read-only from the first minute.</p>
          <div className="hero-cta"><Link className="btn btn-solid" href="/contact">Book a walkthrough</Link><a className="btn" href="#platform">Explore the platform</a></div>
        </div></div>
      </section>

      <footer className="foot">
        <div className="wrap">
          <div className="ftcols">
            <div className="ftcol ftbrand">
              <Link className="lx-brand" href="/"><span className="mark" aria-hidden="true"><i /><i /><i /></span><span><b>Sutra</b><small>Cloud security, woven together</small></span></Link>
              <p>The evidence-backed cloud operations platform for AWS MSPs — inventory, security, cost and compliance, every finding traced to what was actually observed.</p>
              <div className="soc">
                <a href="#top" aria-label="X"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M17.7 3H21l-7.3 8.3L22.2 21h-6.8l-5.3-6.4L4 21H.8l7.8-8.9L.5 3h7l4.8 5.8L17.7 3Zm-1.2 16h1.9L6.6 4.9H4.6L16.5 19Z" /></svg></a>
                <a href="#top" aria-label="LinkedIn"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M4.98 3.5C4.98 4.88 3.87 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5ZM.24 8.25h4.52V23H.24V8.25ZM8.34 8.25h4.33v2h.06c.6-1.14 2.08-2.34 4.28-2.34 4.58 0 5.43 3.01 5.43 6.93V23h-4.52v-7.1c0-1.7-.03-3.88-2.37-3.88-2.37 0-2.73 1.85-2.73 3.76V23H8.34V8.25Z" /></svg></a>
                <a href="#top" aria-label="RSS"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4.44v2.83c7.03 0 12.73 5.7 12.73 12.73H19.5C19.5 11.4 12.6 4.44 4 4.44Zm0 5.66v2.83a7.9 7.9 0 0 1 7.9 7.9h2.83c0-5.93-4.8-10.73-10.73-10.73ZM6.18 15.64a2.18 2.18 0 1 0 0 4.36 2.18 2.18 0 0 0 0-4.36Z" /></svg></a>
              </div>
            </div>
            <div className="ftcol"><strong>Platform</strong>
              <a href="#platform">Platform overview</a>
              <a href="#capabilities">CMDB &amp; findings</a>
              <a href="#capabilities">Network exposure</a>
              <a href="#capabilities">Capabilities</a>
              <a href="#architecture">Control library</a>
            </div>
            <div className="ftcol"><strong>Trust</strong>
              <Link href="/security">Security</Link>
              <Link href="/contact">AWS onboarding</Link>
              <a href="#architecture">Security architecture</a>
              <a href="#trust">Trust model</a>
            </div>
            <div className="ftcol"><strong>Company</strong>
              <Link href="/about">About</Link>
              <Link href="/login">Sign in</Link>
              <Link href="/contact">Book a walkthrough</Link>
              <a href="#why">Why Sutra</a>
            </div>
          </div>
          <div className="ftbottom">
            <small>© 2026 Sutra, Inc. All rights reserved.</small>
            <nav aria-label="Legal">
              <Link href="/status">Status</Link>
              <Link href="/privacy">Privacy Policy</Link>
              <Link href="/terms">Terms of Use</Link>
              <button type="button" className="lx-cookie-link" onClick={openCookieSettings}>Cookie Preferences</button>
            </nav>
          </div>
        </div>
      </footer>

      <CookieConsent />
    </div>
  );
}
