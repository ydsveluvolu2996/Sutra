"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";

import CookieConsent, { openCookieSettings } from "./cookie-consent";
import LandingHeroCinematic from "./landing-hero-cinematic";
import ThemeToggle, { THEME_CHANGED_EVENT } from "./theme-toggle";

/* ================================================================== *
 * Sutra landing zone — cinematic dark page with a flowing bokeh
 * background, a scroll cue, and a Wiz-style feature explorer.
 * All styles are scoped under `.lz` in globals.css (lz-* keyframes),
 * so nothing here can collide with the authenticated app shell.
 * ================================================================== */

type Row = { dot?: string; k: string; em?: string; v: string; tone?: string };
function pvRows(bar: string, _rows: Row[]): string {
  void _rows;
  return (
    '<div class="lx-pv"><div class="lx-pv-bar"><i></i><i></i><i></i><span>' + bar + " · evidence boundary</span></div>" +
    '<div class="lx-pv-body">' +
    '<div class="lx-pv-row"><span class="k">Required source <em>configured for the customer workspace</em></span><span class="lx-pv-badge blue">Connect</span></div>' +
    '<div class="lx-pv-row"><span class="k">Evidence <em>persisted from a successful collection or import</em></span><span class="lx-pv-badge violet">Source-backed</span></div>' +
    '<div class="lx-pv-row"><span class="k">Before evidence exists <em>the workspace remains empty or unavailable</em></span><span class="lx-pv-badge green">No sample records</span></div>' +
    "</div></div>"
  );
}

/* Wiz-style inventory table: icon + name/sub + resource count per row */
type InvRow = { ico: string; t: string; nm: string; sub: string; count: string };
function pvInventory(bar: string, _rows: InvRow[]): string {
  void _rows;
  return (
    '<div class="lx-pv"><div class="lx-pv-bar"><i></i><i></i><i></i><span>' + bar + '</span></div><div class="lx-pv-body">' +
    '<div class="lx-pv-hdr"><span>Evidence categories</span><span>Readiness</span></div>' +
    '<div class="lx-pv-row"><span class="k"><span class="nm"><b>Compute and containers</b><em>Populates from the connected AWS role</em></span></span><span class="lx-pv-badge blue">Connect</span></div>' +
    '<div class="lx-pv-row"><span class="k"><span class="nm"><b>Identity and data</b><em>Shown only after a complete collection</em></span></span><span class="lx-pv-badge violet">Source-backed</span></div>' +
    '<div class="lx-pv-row"><span class="k"><span class="nm"><b>Network relationships</b><em>Missing coverage remains explicit</em></span></span><span class="lx-pv-badge green">No sample counts</span></div>' +
    '</div></div>'
  );
}
const PV_INVENTORY = pvInventory("cmdb · customer workspace", []);

const GDEF =
  '<defs><linearGradient id="pvg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset=".5" stop-color="#3b82f6"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>';

const PV_GRAPH =
  '<div class="lx-pv"><div class="lx-pv-bar"><i></i><i></i><i></i><span>security graph · evidence model</span></div><div class="lx-pv-graph"><svg viewBox="0 0 460 190" preserveAspectRatio="xMidYMid meet">' +
  GDEF +
  '<path class="pvl" d="M44 132 C 110 132 118 96 168 92" fill="none" stroke="url(#pvg)" stroke-width="1.6"/><path class="pvl pd2" d="M168 92 C 236 88 250 50 316 46" fill="none" stroke="url(#pvg)" stroke-width="1.6"/><path class="pvl pd3" d="M168 92 C 240 96 300 118 416 120" fill="none" stroke="url(#pvg)" stroke-width="1.6"/><path class="pvl pd4" d="M168 92 C 200 66 250 62 292 118" fill="none" stroke="#fb7185" stroke-width="1.4" opacity=".7"/>' +
  '<g class="pvn nd1"><circle cx="44" cy="132" r="11" fill="#0c1326" stroke="#3b82f6" stroke-width="1.6"/><text x="44" y="156" text-anchor="middle" font-family="monospace" font-size="8.5" fill="#808db2">entry point</text></g>' +
  '<g class="pvn nd2"><circle cx="168" cy="92" r="13" fill="#0c1326" stroke="#3b82f6" stroke-width="1.6"/><text x="168" y="118" text-anchor="middle" font-family="monospace" font-size="8.5" fill="#f4f7ff">workload</text></g>' +
  '<g class="pvn nd3"><circle cx="316" cy="46" r="11" fill="#0c1326" stroke="#22d3ee" stroke-width="1.6"/><text x="316" y="30" text-anchor="middle" font-family="monospace" font-size="8.5" fill="#808db2">identity</text></g>' +
  '<g class="pvn nd4"><circle cx="416" cy="120" r="11" fill="#0c1326" stroke="#3b82f6" stroke-width="1.6"/><text x="416" y="144" text-anchor="middle" font-family="monospace" font-size="8.5" fill="#808db2">data</text></g>' +
  '<g class="pvn nd5"><circle cx="292" cy="118" r="9" fill="#26121a" stroke="#fb7185" stroke-width="1.5"/><text x="292" y="140" text-anchor="middle" font-family="monospace" font-size="8.5" fill="#fb7185">risk</text></g>' +
  "</svg></div></div>";

const PV_TRENDS = pvRows("posture history", []);

const PV_FIX = pvRows("guided remediation", []);

type Cap = { code: string; label: string; t: string; icon: string; title: string; blurb: string; points: string[]; pv: string; g?: string };
const CAPS: Cap[] = [
  { code: "COLLECT", g: "See & prioritize", label: "Agentless collection", t: "#22d3ee", icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>', title: "Agentless AWS collection", blurb: "Regional metadata collectors use a customer-owned IAM role and temporary STS credentials by default. Supported assets populate after a complete run; uncovered or failed sources remain explicit.", points: ["Customer-owned role via STS", "No agents · role path stores no access key", "Complete snapshots normalized into one CMDB"], pv: PV_INVENTORY },
  { code: "GRAPH", label: "Security graph", t: "#3b82f6", icon: '<circle cx="5" cy="12" r="2.2"/><circle cx="14" cy="6" r="2.2"/><circle cx="14" cy="18" r="2.2"/><circle cx="21" cy="12" r="2.2"/><path d="M7 11 12 7M7 13 12 17M16 7l3 4M16 17l3-4"/>', title: "Evidence-backed security graph", blurb: "Collected cloud, Kubernetes, identity, and network relationships share one model, with observation-backed edges and explicit missing evidence.", points: ["Cloud + cluster + identity in one model", "Confirmed vs. theoretical reachability", "Click an observed edge to see its evidence"], pv: PV_GRAPH },
  { code: "ISSUES", label: "Runtime-informed issues", t: "#fb7185", icon: '<path d="M12 3 22 20H2z"/><path d="M12 10v5M12 18h.01"/>', title: "Runtime-informed issues", blurb: "Prioritize collected vulnerability and exposure evidence when the required network, workload, and scanner sources are available.", points: ["Toxic-combination detection", "Reachability from configured network sources", "Prioritized by exposure, not just CVSS"], pv: pvRows("issues · prioritized", []) },
  { code: "CIEM", label: "Effective permissions", t: "#8b5cf6", icon: '<circle cx="8" cy="13" r="4"/><path d="m11 10 9-9M17 4l3 3"/>', title: "Effective permissions", blurb: "Resolve collected Kubernetes RBAC and follow configured IRSA or EKS Pod Identity links into AWS.", points: ["In-cluster RBAC solver", "IRSA + Pod Identity → AWS reach", "Flags: secrets, exec, unused SA"], pv: pvRows("effective permissions", []) },
  { code: "EXPOSE", label: "Network exposure", t: "#22d3ee", icon: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5a14 14 0 0 1 0 17 14 14 0 0 1 0-17Z"/>', title: "Network exposure & port filtering", blurb: "Evaluate gateway routes, NACL port filters, load-balancer targets, and DNS entry points from collected AWS evidence.", points: ["Hop-by-hop reachability, each hop cited", "Open vs NACL-filtered ports", "Missing evidence → honest unknown"], pv: pvRows("network exposure", []) },
  { code: "PATCH", label: "Patch plans", t: "#f0842e", icon: '<rect x="4" y="4" width="7" height="7" rx="1.4"/><rect x="13" y="13" width="7" height="7" rx="1.4"/><path d="M11 7.5h5.5v5.5"/>', title: "Patch plans, not CVE lists", blurb: "Translate imported vulnerability evidence into reviewed package and image upgrade plans, ranked by the enrichment sources that are configured.", points: ["One upgrade per package + image", "KEV & EPSS-aware priority", "SLA due dates per severity"], pv: pvRows("patch plans", []) },
  { code: "GATE", g: "Ship & operate", label: "CI security gate", t: "#06b6c4", icon: '<path d="M12 3 20 6v6c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V6z"/><path d="m9 12 2 2 4-4"/>', title: "CI security gate", blurb: "Configured Jenkins, GitHub Actions, or in-cluster jobs can apply severity thresholds and publish machine-readable results.", points: ["Jenkins + Kubernetes + Actions", "Severity fail-on thresholds", "Skips reported, never silent passes"], pv: pvRows("CI gate", []) },
  { code: "TRENDS", label: "Posture trends", t: "#34d399", icon: '<path d="M4 19V5M4 19h16"/><path d="m7 14 3-3 3 2 4-5"/>', title: "Posture trends & scorecard", blurb: "A per-customer security score over time with regression detection and a resell-ready export — the report an MSP hands over.", points: ["Score per customer over time", "Automatic regression detection", "Exportable MSP scorecard"], pv: PV_TRENDS },
  { code: "DRIFT", label: "Drift & new CVEs", t: "#f0842e", icon: '<path d="M8 3H4v4M4 3l6 6M16 21h4v-4M20 21l-6-6"/>', title: "Drift & new-CVE detection", blurb: "Compare collected workload state with an admitted specification, or compare imported image evidence between scans.", points: ["Collected spec vs. admitted spec diff", "New-CVE delta between scans", "Severity-ranked, cited to the change"], pv: pvRows("drift and new CVEs", []) },
  { code: "FIX", label: "Guided remediation", t: "#06b6c4", icon: '<path d="M14.5 6.5a3.5 3.5 0 0 1-4.6 4.6L4 17l3 3 5.9-5.9a3.5 3.5 0 0 1 4.6-4.6l-2.2 2.2-2-2z"/>', title: "Guided remediation", blurb: "Generate the exact Kyverno policy or kubectl patch that fixes an issue — a reviewed suggestion, never an automatic change.", points: ["Kyverno policy or kubectl patch", "Scoped to the specific finding", "You review and apply — never auto"], pv: PV_FIX },
  { code: "RUNTIME", label: "Runtime detection", t: "#fb7185", icon: '<path d="M3 12h4l2 6 4-14 2 8h6"/>', title: "Runtime detection", blurb: "When a Falco source is configured, signed replay-resistant events can be correlated with collected Kubernetes context and cases.", points: ["Signed, replay-resistant events", "Full pod and workload context", "Human-confirmed cases + alerting"], pv: pvRows("runtime events", []) },
  { code: "COMPLY", label: "Readiness mappings", t: "#34d399", icon: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8 9 2 2 4-4M8 15h6"/>', title: "Readiness mappings", blurb: "CIS Kubernetes, NSA/CISA and SOC 2 readiness mapped to cited evidence — a readiness view, never a certification claim.", points: ["CIS, NSA/CISA, SOC 2 mappings", "Every evaluated control cites evidence", "Honest readiness, not a pass stamp"], pv: pvRows("readiness mappings", []) },
  { code: "VULN", g: "Manage & prove", label: "Vulnerability management", t: "#fb7185", icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5h.01"/><path d="M5.5 5.5 3 3M18.5 5.5 21 3M5.5 18.5 3 21M18.5 18.5 21 21"/>', title: "Vulnerability management, unified", blurb: "Unify imported Kubernetes, registry, and AWS Inspector evidence with configured EPSS and KEV enrichment, SLA tracking, and waiver workflows.", points: ["EPSS + KEV enrichment", "Registry and AWS Inspector inputs in one queue", "Waivers with owner, reason & expiry"], pv: pvRows("vulnerability management", []) },
  { code: "SUPPLY", label: "Supply-chain trust", t: "#8b5cf6", icon: '<path d="M7 8a4 4 0 1 1 4 4H8a4 4 0 0 1-1-8z"/><path d="M17 16a4 4 0 1 1-4-4h3a4 4 0 0 1 1 8z"/>', title: "Supply-chain verification", blurb: "Verify supplied Cosign signatures, SLSA provenance, VEX statements, and SBOMs for enrolled image sources.", points: ["Cosign signature verification", "SLSA provenance & VEX statements", "SBOM diff between releases"], pv: pvRows("supply-chain verification", []) },
  { code: "IAC", label: "IaC & admission", t: "#f0842e", icon: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/><path d="m10 9-2 3 2 3M14 9l2 3-2 3"/>', title: "IaC & admission misconfiguration", blurb: "Apply the policy set to supplied Terraform and Kubernetes manifests; Kyverno enforcement requires its own cluster configuration.", points: ["Terraform + manifest scanning", "Kyverno admission enforcement", "Same policies in CI and cluster"], pv: pvRows("IaC and admission", []) },
  { code: "NETPOL", label: "NetworkPolicy generator", t: "#22d3ee", icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18M12 3v18"/>', title: "Least-privilege NetworkPolicies", blurb: "Generate reviewed NetworkPolicy suggestions after a Hubble flow source has supplied observed communication evidence.", points: ["Built from observed flows", "Default-deny with explicit allows", "Reviewed before apply — never auto"], pv: pvRows("NetworkPolicy generation", []) },
  { code: "TENANCY", label: "MSP multi-tenancy", t: "#34d399", icon: '<circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 6.4a3.2 3.2 0 0 1 0 6.1M20.5 20a5.6 5.6 0 0 0-4.2-5.4"/>', title: "MSP multi-tenancy", blurb: "Portfolio access for MSP operators and explicitly granted customer workspaces, enforced by server-side tenant scope.", points: ["Cross-customer portfolio for authorized operators", "Per-customer scoped workspaces", "Isolation enforced at every query"], pv: pvRows("tenant-scoped access", []) },
  { code: "ALERTS", label: "Ticketing & alerting", t: "#06b6c4", icon: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>', title: "Ticketing & alerting", blurb: "Configured destinations can receive findings through durable delivery; missing or failing destinations never report success.", points: ["Email, chat, webhook and incident destinations", "Durable, retried delivery", "Human-confirmed case workflow"], pv: pvRows("notification delivery", []) },
  { code: "FINOPS", label: "Cloud cost (FinOps)", t: "#34d399", icon: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.2a3 2.4 0 0 0-2.5-1.2c-1.8 0-2.8.9-2.8 1.9 0 1 .9 1.5 2.8 1.9 1.9.4 2.8 1 2.8 2s-1 1.9-2.8 1.9a3 2.4 0 0 1-2.5-1.2"/><path d="M12 6v12"/>', title: "FinOps cost allocation & savings", blurb: "When billing evidence is enabled, allocate AWS spend, track budgets, evaluate anomalies, and review commitment or rightsizing candidates without guaranteed-savings claims.", points: ["Cost Explorer plus optional CUR allocation", "Budgets + statistical anomaly signals", "Commitment & rightsizing, disclosed not promised"], pv: pvRows("FinOps evidence", []) },
  { code: "API", label: "Public API & SDKs", t: "#3b82f6", icon: '<path d="M8 3H7a2 2 0 0 0-2 2v3.5a2 2 0 0 1-2 2 2 2 0 0 1 2 2V16a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v3.5a2 2 0 0 0 2 2 2 2 0 0 0-2 2V16a2 2 0 0 1-2 2h-1"/>', title: "Public API & typed SDKs", blurb: "A versioned, tenant-scoped REST API with scoped service-account tokens, cursor pagination, idempotent writes, and published client contracts.", points: ["Versioned REST API · scoped tokens", "Typed TypeScript and Python clients", "Cursor pagination · idempotent writes · quotas"], pv: pvRows("public API", []) },
];

const CAPABILITY_READINESS: Readonly<Record<string, string>> = {
  COLLECT: "Live after AWS connection",
  GRAPH: "Live after collection",
  ISSUES: "Live when evidence exists",
  CIEM: "Live after Kubernetes enrollment",
  EXPOSE: "Live after collection",
  PATCH: "Live when vulnerability sources are connected",
  GATE: "Operator configured",
  TRENDS: "Live after collection history exists",
  DRIFT: "Live after Kubernetes enrollment",
  FIX: "Live for supported evidence-backed findings",
  RUNTIME: "Operator configured",
  COMPLY: "Live when control evidence exists",
  VULN: "Live when sources are connected",
  SUPPLY: "Operator configured",
  IAC: "Live after an IaC source is supplied",
  NETPOL: "Operator configured",
  TENANCY: "Live",
  ALERTS: "Operator configured",
  FINOPS: "Live when billing evidence is enabled",
  API: "Live",
};

const MARQUEE = ["Amazon EKS", "AWS IAM & IRSA", "EKS Pod Identity", "Trivy Operator", "Falco runtime", "Kyverno admission", "Cilium · Hubble", "Amazon GuardDuty", "Security Hub", "Amazon Inspector", "SBOM & signing", "Kubernetes RBAC", "CIS Benchmarks", "KEV · EPSS", "Jenkins & GitOps gates", "Route tables & NACLs"];

type Panel = { name: string; icon: string; h3: string; lead: string; points: string[]; mini: string; chips: string[] };
const PLATFORM: Panel[] = [
  { name: "cloud", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5a14 14 0 0 1 0 17 14 14 0 0 1 0-17Z"/></svg>', h3: "Cloud CMDB & reachability", lead: "Connected regional collectors build a normalized asset graph and evaluate internet reachability from collected routes, NACLs, load-balancer targets, and DNS evidence.", points: ["Open vs NACL-filtered ports, per resource", "Every observed hop cited; missing inputs stay unknown"], chips: ["CSPM & CMDB", "Route tables · IGW · NACLs", "ELB target membership", "DNS entry points", "Universal CMDB · blast-radius", "Cloud cost · FinOps allocation", "Report builder · CSV / PDF", "Public API v1 & typed SDKs"], mini: '<svg viewBox="0 0 400 232"><path class="gl" d="M42 176 C 110 176 122 118 192 116 M192 116 C 262 114 282 64 352 62" stroke="#3b82f6"/><g class="gn" style="opacity:1"><circle cx="42" cy="176" r="12"/><text x="42" y="200" text-anchor="middle">gateway</text></g><g class="gn" style="opacity:1"><circle cx="192" cy="116" r="13"/><text x="192" y="140" text-anchor="middle" fill="#f4f7ff">network</text></g><g class="gn acc" style="opacity:1"><circle cx="352" cy="62" r="12"/><text x="352" y="86" text-anchor="middle">policy</text></g></svg>' },
  { name: "k8s", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.2"/></svg>', h3: "Kubernetes posture & runtime", lead: "After enrollment, admitted specs, workload and image drift, SBOM evidence, and configured Falco events can correlate onto collected workloads.", points: ["Collected spec vs admitted-spec drift", "Runtime-informed priority when the required sources exist"], chips: ["KSPM over admitted specs", "Workload & image drift", "SBOM & new-CVE delta", "Signed Falco runtime", "Unified vuln mgmt · EPSS · KEV", "Patch plans · generate-only", "Configured metric alerting"], mini: '<svg viewBox="0 0 400 232"><g class="gn" style="opacity:1"><rect x="150" y="84" width="100" height="60" rx="11" stroke="#3b82f6" stroke-width="1.7"/><text x="200" y="118" text-anchor="middle" fill="#f4f7ff">workload</text></g><g class="gn crit" style="opacity:1"><circle cx="304" cy="66" r="10"/><text x="304" y="50" text-anchor="middle" fill="#fb7185">evidence</text></g></svg>' },
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
  { c: "06", h: "Nothing of yours is ever deleted", p: "The recommended role uses read-only STS and stores no customer access key. Agentless disk scanning is the role's one opt-in that writes, and it can only create snapshots it tags itself — Sutra holds an explicit deny on every delete, so cleanup runs from your own lifecycle policy, in your account, pausable from your console.", proof: "Recommended role: read-only STS · no customer key stored · explicit deny on deletes" },
];

const LAYERS = [
  { n: "01", h: "Customer cloud", p: "A customer-owned IAM role grants only the metadata APIs in the selected collector pack." },
  { n: "02", h: "Collector plane", p: "An AWS workload identity obtains short-lived STS credentials and performs bounded regional discovery." },
  { n: "03", h: "Normalized CMDB", p: "Assets, relationships and evidence are validated, scoped and promoted only after a complete run." },
  { n: "04", h: "MSP control plane", p: "Role-aware dashboards, findings, audit history and customer access operate without exposing AWS credentials." },
];

/* Commercial packaging is scoped with each customer. Public cards describe
 * the product boundary, not a finalized rate card or contractual limit. */
type Tier = { name: string; tagline: string; cta: string; ctaHref: string; feat?: boolean; lead: string; points: string[]; eg: string };
const TIERS: Tier[] = [
  {
    name: "Starter",
    tagline: "Single-account posture, proven from day one",
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
    eg: "Workspace scope and commercial terms are confirmed during review",
  },
  {
    name: "Growth",
    tagline: "The full CNAPP + FinOps operations suite",
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
    eg: "Source readiness and commercial terms are confirmed during review",
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
    eg: "Portfolio scope and commercial terms are confirmed during review",
  },
];

/* Trust content. No unsupported customer claims, logos, quotes, or
 * testimonials. The badge row and FAQ describe product boundaries only. */
const TRUST_BADGES = [
  "SOC 2 readiness mapping — not a certification",
  "Read-only by default, customer-owned access",
  "Every finding cited to collected evidence",
  "IAM role recommended · optional keys encrypted",
  "Data-minimizing by design",
];
const FAQ: Array<{ q: string; a: string }> = [
  { q: "How does onboarding work?", a: "The recommended path deploys a customer-owned IAM role from our CloudFormation template. A collector assumes it with temporary STS credentials and performs read-only, metadata-only discovery, with no customer access key stored. If role creation is impossible, an optional dedicated-IAM-user path stores the submitted key encrypted in AWS Secrets Manager; the customer remains responsible for its IAM policy and rotation." },
  { q: "Is the access really read-only?", a: "With the recommended role, yes by default — it grants metadata-only permission packs, is owned by you, and is scoped with a unique platform-generated ExternalId. The optional access-key method cannot prove least privilege; GetCallerIdentity verifies the account, while the IAM policies you attach determine effective access. The role has one opt-in exception: agentless disk scanning needs to create a tagged EBS snapshot. That grant is deliberately narrow and carries explicit denies for destructive actions." },
  { q: "So Sutra can delete my snapshots?", a: "No — it has no delete permission at all, by explicit deny. That raises a fair question: who cleans up the scan snapshots so they stop costing you money? The same CloudFormation stack installs an AWS Data Lifecycle Manager policy in your account, running under your own service role, which deletes only sutra-agentless-tagged snapshots on a retention window you choose. You can inspect, pause, retune, or delete that policy from your console at any time. Sutra keeps scanning either way; it simply starts reporting uncleaned snapshots to you as cost." },
  { q: "Which clouds and platforms are supported?", a: "AWS and Amazon EKS. Sutra is not multi-cloud — there is no Azure or GCP support. Within that scope it correlates cloud, Kubernetes, identity, network, runtime and supply-chain evidence into one graph." },
  { q: "How is my data handled?", a: "Data-minimizing by design: only normalized, scoped metadata evidence is promoted after a complete collection run. The recommended role stores no customer access key. If you choose the optional access-key method, the submitted value is encrypted in AWS Secrets Manager and the web control plane retains only a non-secret reference. Each customer sees only the workspaces explicitly granted to them." },
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

/* ==================================================================== *
 * Suite wheel — the cross-cutting function ring.
 *
 * THE LOGIC (mirrored from the reference, not its words): the OUTER ring is
 * the three *planes* Sutra collects from — cloud, Kubernetes, identity — and
 * the INNER ring is the five *functions* that apply across all three. Every
 * Readiness still depends on the source boundary described in the capability
 * explorer and the platform coverage page.
 *
 * GEOMETRY — measured, not eyeballed. The wheel is a 420x440 viewBox with
 * centre (210,210). The segment band is `stroke-width: 44` on an r=150 arc,
 * so it occupies r=128..172 and the usable annulus is bounded by the brand
 * core below and r=128 above. The brand core was r=86, which left only 42px
 * of annulus — not enough for an 18px icon plus a two-line caption at any
 * legible size (solved numerically: the best all-single-line arrangement
 * overran the segment band by 4.6px). So the core is now r=58, which both
 * matches the reference's proportions (a small brand mark inside a much
 * larger function ring) and opens the annulus to 70px. Verified against real
 * rendered `getBBox()` metrics (not estimated advance widths): at r=101.5 with
 * a 16px icon and a 7.2px caption the ring clears the brand core by 5.5px and
 * the segment band by 4.7px, leaves 52px between adjacent blocks, and collides
 * with neither the three segment labels nor the core text.
 *
 * Captions sit on the CENTRE-FACING side of every icon — that one rule is
 * what keeps the lower two blocks from pushing their text out into the band.
 *
 * The whole ring is decorative relative to the interaction: `pointer-events:
 * none`, so the three segments remain the only clickable targets.
 * ==================================================================== */
const WHEEL_R = 100.5;
const WHEEL_ICON = 16;
const WHEEL_CAP_FS = 7.2;
const WHEEL_CAP_GAP = 4;

/** Five cross-cutting functions, hand-authored 24x24 thin-stroke line art to
 *  match the icon language already used by the capability grid. */
const WHEEL_FNS: Array<{ a: number; l1: string; l2: string; icon: string }> = [
  // Always-current AWS CMDB / asset graph — a three-layer stack.
  { a: -90, l1: "INVENTORY", l2: "AWS CMDB", icon: '<path d="M12 3 21 7.5 12 12 3 7.5z"/><path d="M3 12l9 4.5 9-4.5"/><path d="M3 16.5 12 21l9-4.5"/>' },
  // Risk proven reachable via attack paths — a rising node-and-edge chain.
  { a: -18, l1: "REACHABLE", l2: "PATHS", icon: '<circle cx="4.6" cy="18" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19.4" cy="5.6" r="2.2"/><path d="M6.3 16.5 10.3 13.4M13.7 10.4 17.7 7"/>' },
  // The unified queue ordered by EPSS / KEV / SLA — sorted, ranked bars.
  { a: 54, l1: "PRIORITISE", l2: "EPSS · KEV", icon: '<path d="M4 6h16M4 12h10.5M4 18h5.5"/>' },
  // FinOps spend, waste and per-customer margin — a price tag.
  { a: 126, l1: "COST", l2: "FINOPS", icon: '<path d="M13.4 3H4.8A1.8 1.8 0 0 0 3 4.8v8.6l7.7 7.7a1.7 1.7 0 0 0 2.4 0l6.9-6.9a1.7 1.7 0 0 0 0-2.4z"/><circle cx="8" cy="8" r="1.5"/>' },
  // Every finding cited to an observation, auditor-ready — a page + check.
  { a: 198, l1: "EVIDENCE", l2: "CITED", icon: '<path d="M14 3H6.2A1.8 1.8 0 0 0 4.4 4.8v14.4A1.8 1.8 0 0 0 6.2 21h11.6a1.8 1.8 0 0 0 1.8-1.8V8.8z"/><path d="M14 3v5.8h5.8"/><path d="m8.7 14.3 2.2 2.2 4.5-4.6"/>' },
];

/**
 * Resolve one function's placement. `inward` puts the caption on the side of
 * the icon that faces the centre, which is what keeps every block inside the
 * r=128 annulus regardless of which quadrant it lands in.
 */
function wheelFnGeometry(angleDeg: number, lines: number) {
  const t = (angleDeg * Math.PI) / 180;
  const px = 210 + WHEEL_R * Math.cos(t);
  const py = 210 + WHEEL_R * Math.sin(t);
  const capH = WHEEL_CAP_FS * 0.72;
  const lineH = WHEEL_CAP_FS * 1.32;
  const blockH = capH + (lines - 1) * lineH;
  const half = WHEEL_ICON / 2;
  // Above the centre -> caption below the icon; below the centre -> above it.
  const capTop =
    Math.sin(t) <= 0 ? py + half + WHEEL_CAP_GAP : py - half - WHEEL_CAP_GAP - blockH;
  return { px, py, half, lineH, baseline: capTop + capH };
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
  /* Accessible name for a segment, derived from the same `segs` label the SVG
   * paints ("CLOUD" -> "Cloud") so the two can never drift apart. */
  const pillar = (label: string) => label.charAt(0) + label.slice(1).toLowerCase();
  return (
    <div className="wheel-wrap">
      <div className="wheel-pin">
        {/* The wheel is interactive: the three segments scroll their story block
            into view, so they are real buttons. Everything else in the SVG —
            sphere, segment labels, the function ring, the core wordmark — is
            decoration and is individually aria-hidden, which keeps the tree to
            exactly the three operable controls. `role="presentation"` drops the
            <svg> element's own graphic semantics without hiding its children.
            Deliberately NOT a tablist: all three .wblock panels stay rendered
            and are read in normal document order (inactive ones are only dimmed,
            and prefers-reduced-motion shows them at full opacity), and the
            "selected" segment tracks scroll position rather than activation.
            Tabs would require hiding the other two panels — i.e. hiding real
            content from assistive tech — so this is scroll-spy navigation and
            `aria-current` is the honest state. */}
        <svg className="wheel" viewBox="0 0 420 440" role="presentation">
          <defs>
            <linearGradient id="wg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#22d3ee" /><stop offset=".5" stopColor="#3b82f6" /><stop offset="1" stopColor="#8b5cf6" /></linearGradient>
            {/* Soft inner sphere — the thing that makes the reference read as
                a lit object rather than a flat diagram. Stops are themed from
                CSS so both grounds work. */}
            <radialGradient id="wsphere" cx="50%" cy="40%" r="66%">
              <stop className="wsph-0" offset="0" />
              <stop className="wsph-1" offset=".58" />
              <stop className="wsph-2" offset="1" />
            </radialGradient>
            {/* One mask per segment, punching the 44px band out of that
                segment's focus halo so the halo survives only as two thin arcs
                either side of the band. Without it the halo would show through
                the segment's translucent stroke and read as a filled arc. */}
            {segs.map((s, i) => (
              <mask key={s.label} id={`wsegm${i}`} maskUnits="userSpaceOnUse" x="0" y="0" width="420" height="440">
                <rect x="0" y="0" width="420" height="440" fill="#fff" />
                <path d={s.d} fill="none" stroke="#000" strokeWidth={44} />
              </mask>
            ))}
          </defs>
          <circle className="wsphere" cx={210} cy={210} r={124} aria-hidden="true" />
          <g role="group" aria-label="Platform pillars">
            {segs.map((s, i) => (
              <g key={s.label}>
                {/* Focus halo: a little wider than the 44px band and masked
                    back to the band's two edges, so keyboard focus reads as an
                    outline hugging the arc on either ground. */}
                <path className="wseg-ring" d={s.d} mask={`url(#wsegm${i})`} aria-hidden="true" />
                <path
                  className="wseg"
                  d={s.d}
                  data-on={i === on}
                  role="button"
                  tabIndex={0}
                  aria-label={pillar(s.label)}
                  aria-current={i === on ? "true" : undefined}
                  onClick={() => go(i)}
                  onKeyDown={(e) => {
                    // role="button" on an SVG element gets no implicit key
                    // activation, so Enter and Space are wired by hand.
                    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
                      e.preventDefault();
                      go(i);
                    }
                  }}
                />
              </g>
            ))}
          </g>
          {segs.map((s, i) => <text key={s.label} className="wlab" x={s.lx} y={s.ly} textAnchor="middle" data-on={i === on} aria-hidden="true">{s.label}</text>)}

          {/* Cross-cutting function ring. Decorative: pointer-events are off,
              so the three segments stay the only clickable targets. */}
          <g className="wfns" aria-hidden="true">
            {WHEEL_FNS.map((f) => {
              const g = wheelFnGeometry(f.a, 2);
              return (
                <g key={f.l1}>
                  <g
                    className="wico"
                    transform={`translate(${(g.px - g.half).toFixed(2)} ${(g.py - g.half).toFixed(2)}) scale(${WHEEL_ICON / 24})`}
                    dangerouslySetInnerHTML={{ __html: f.icon }}
                  />
                  <text className="wcap" x={g.px.toFixed(2)} y={g.baseline.toFixed(2)} textAnchor="middle">{f.l1}</text>
                  <text className="wcap wcap-2" x={g.px.toFixed(2)} y={(g.baseline + g.lineH).toFixed(2)} textAnchor="middle">{f.l2}</text>
                </g>
              );
            })}
          </g>

          <circle className="wcore" cx={210} cy={210} r={58} aria-hidden="true" />
          <text className="wcore-t" x={210} y={207} textAnchor="middle" aria-hidden="true">Sutra</text>
          <text className="wcore-s" x={210} y={224} textAnchor="middle" aria-hidden="true">ONE EVIDENCE GRAPH</text>
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

function TypeLine() {
  return (
    <p className="twr">
      Optional engines and destinations show <span className="twr-word">configured readiness</span> before they process evidence.
    </p>
  );
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
        <div className="code">{c.code} · {CAPABILITY_READINESS[c.code] ?? "Configuration dependent"}</div>
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

/* Section nav: label + the id it must resolve to. Every id here is asserted
   against the DOM at mount (dev-only warning) so a renamed section can never
   silently leave a dead anchor in the header. */
const NAV_SECTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "platform", label: "Platform" },
  { id: "capabilities", label: "Capabilities" },
  { id: "why", label: "Why Sutra" },
  { id: "pricing", label: "Pricing" },
  { id: "trust", label: "Trust model" },
  { id: "architecture", label: "Architecture" },
  { id: "proof", label: "FAQ" },
];

export default function LandingZone() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const indRef = useRef<HTMLSpanElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stuck, setStuck] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  /* ---- section scroll-spy: one IntersectionObserver, resolved against a
     single switch line at 40% of the viewport. The callback only fires when a
     section crosses a threshold (never per scroll event); it then picks the
     last section whose top has passed the line, so the shortest trailing
     section still wins, and a hard bottom-of-document check guarantees the
     final section activates even if it can never reach the line. ---- */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const els = NAV_SECTIONS.map((s) => root.querySelector<HTMLElement>("#" + s.id));
    if (process.env.NODE_ENV !== "production") {
      NAV_SECTIONS.forEach((s, i) => {
        if (!els[i]) console.warn("[landing nav] dead anchor: no element with id #" + s.id);
      });
    }
    const resolve = () => {
      const doc = document.documentElement;
      const line = window.innerHeight * 0.4;
      let next: string | null = null;
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (el && el.getBoundingClientRect().top <= line) next = NAV_SECTIONS[i].id;
      }
      // Bottom of the document always belongs to the final section.
      if (window.scrollY + window.innerHeight >= doc.scrollHeight - 2) {
        for (let i = els.length - 1; i >= 0; i--) if (els[i]) { next = NAV_SECTIONS[i].id; break; }
      }
      setActiveId(next);
    };
    const spy = new IntersectionObserver(resolve, { threshold: [0, 0.02, 0.25, 0.5, 0.75, 0.98, 1] });
    els.forEach((el) => { if (el) spy.observe(el); });
    window.addEventListener("resize", resolve, { passive: true });
    return () => { spy.disconnect(); window.removeEventListener("resize", resolve); };
  }, []);

  /* ---- sliding underline: positioned by writing CSS custom properties on
     the decorative indicator, so no per-link layout thrash. ---- */
  useEffect(() => {
    const place = () => {
      const nav = navRef.current;
      const ind = indRef.current;
      if (!nav || !ind) return;
      const link = activeId ? nav.querySelector<HTMLAnchorElement>('a[data-sec="' + activeId + '"]') : null;
      if (!link) { ind.style.setProperty("--o", "0"); return; }
      ind.style.setProperty("--o", "1");
      ind.style.setProperty("--x", link.offsetLeft + "px");
      ind.style.setProperty("--w", link.offsetWidth + "px");
    };
    place();
    window.addEventListener("resize", place, { passive: true });
    return () => window.removeEventListener("resize", place);
  }, [activeId]);

  /* ---- mobile menu: Escape and outside-click dismiss, focus returned to the
     toggle so keyboard users never lose their place. ---- */
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => { setMenuOpen(false); toggleRef.current?.focus(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    const onDown = (e: MouseEvent) => {
      const head = rootRef.current?.querySelector(".head");
      if (head && !head.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [menuOpen]);

  /* ---- sticky chrome: the header is bare over the cinematic hero at rest and
     only earns its blur + hairline once the page has scrolled. Driven by a
     sentinel observer, not a scroll listener. ---- */
  useEffect(() => {
    const el = rootRef.current?.querySelector("#top");
    if (!el) return;
    // Make the skip-link target programmatically focusable so "Skip to content"
    // moves focus, not just the scroll position.
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    const io = new IntersectionObserver((es) => setStuck(!es[0].isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

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
        // Soft glow sprites only, so phones cap the backing store at 1.5x
        // (~44% less fill per frame) with no visible loss. Desktop keeps 2x.
        DPR = Math.min(window.innerWidth <= 560 ? 1.5 : 2, window.devicePixelRatio || 1);
        W = cv.width = Math.round(window.innerWidth * DPR);
        H = cv.height = Math.round(window.innerHeight * DPR);
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

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (onResize) window.removeEventListener("resize", onResize);
      if (onThemeChange) window.removeEventListener(THEME_CHANGED_EVENT, onThemeChange);
      io.disconnect();
    };
  }, []);

  return (
    <div className="lz" ref={rootRef}>
      <div className="bg-glows" />
      <canvas className="bg-canvas" id="lz-bg" aria-hidden="true" />

      <a className="lx-skip" href="#top">Skip to content</a>

      <header className={"head" + (stuck ? " is-stuck" : "") + (menuOpen ? " is-menu" : "")}>
        <Link className="lx-brand" href="/" aria-label="Sutra home">
          <span className="mark" aria-hidden="true"><i /><i /><i /></span>
          <span><b>Sutra</b><small>Cloud security, woven together</small></span>
        </Link>
        <div className="lx-navwrap" id="lz-nav-panel" data-open={menuOpen ? "true" : "false"}>
          <nav aria-label="Page sections" ref={navRef}>
            <span className="lx-nav-ind" ref={indRef} aria-hidden="true" />
            {NAV_SECTIONS.map((s) => (
              <a
                key={s.id}
                href={"#" + s.id}
                data-sec={s.id}
                data-active={activeId === s.id ? "true" : "false"}
                aria-current={activeId === s.id ? "true" : undefined}
                onClick={() => setMenuOpen(false)}
              >
                {s.label}
              </a>
            ))}
          </nav>
          <div className="lx-nav-extra">
            <Link className="signin" href="/about" onClick={() => setMenuOpen(false)}>About</Link>
            <Link className="signin" href="/login" onClick={() => setMenuOpen(false)}>Sign in</Link>
          </div>
        </div>
        <div className="head-actions">
          <ThemeToggle />
          <Link className="signin" href="/about">About</Link>
          <Link className="signin" href="/login">Sign in</Link>
          <Link className="btn btn-solid" href="/contact">Book a walkthrough <Arrow /></Link>
          <button
            type="button"
            className="lx-nav-toggle"
            ref={toggleRef}
            aria-expanded={menuOpen}
            aria-controls="lz-nav-panel"
            aria-label={menuOpen ? "Close section menu" : "Open section menu"}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span className="lx-burger" aria-hidden="true"><i /><i /><i /></span>
          </button>
        </div>
      </header>

      <span id="top" />
      {/* Cinematic opening band. The established hero (headline + live
          security-graph card) follows immediately below, unchanged. */}
      <LandingHeroCinematic />
      <section className="hero" id="lz-hero">
        <div className="lx-hero-copy">
          {/* One pill, two lengths: the full positioning line on desktop, a
              short one on phones so it never wraps to two lines. */}
          <span className="kicker">
            <i />
            <span className="lx-kicker-full">The cloud operations platform for AWS MSPs</span>
            <span className="lx-kicker-short">Cloud ops for AWS MSPs</span>
          </span>
          <h1>See every risk.<br /><span className="accent">Prove every path.</span></h1>
          <p>One platform for AWS and Amazon EKS operations — connected inventory, evidence-backed reachability, cloud cost, compliance readiness, and tenant-scoped APIs woven into a single graph. Each workspace populates only after its required AWS, Kubernetes, billing, scanner, or destination source is connected.</p>
          <div className="hero-cta">
            <Link className="btn btn-solid" href="/contact">Book a walkthrough <Arrow /></Link>
            <a className="btn" href="#trust">Review the trust model</a>
          </div>
          <div className="assur"><span><b>✓</b> IAM role recommended, customer-owned</span><span><b>✓</b> Every finding cited</span><span><b>✓</b> Optional keys encrypted in AWS Secrets Manager</span></div>
        </div>
        <div className="lx-hero-stage">
          <div className="card">
            <div className="card-bar"><i /><i /><i /><span>security graph · evidence model</span></div>
            <div
              className="graph"
              dangerouslySetInnerHTML={{
                __html:
                  '<svg viewBox="0 0 440 290" preserveAspectRatio="xMidYMid meet"><defs><linearGradient id="gg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset=".5" stop-color="#3b82f6"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>' +
                  '<path class="gl" d="M50 214 C 124 214 132 150 200 146"/><path class="gl d2" d="M200 146 C 264 142 268 66 344 62"/><path class="gl d3" d="M200 146 C 262 152 276 208 350 214"/><path class="gl rose" d="M200 146 C 226 110 268 100 314 112"/>' +
                  /* Travelling evidence packets — one per edge, staggered, each
                     pinned to its own edge via CSS offset-path. Decorative, so
                     aria-hidden, and stopped dead by prefers-reduced-motion. */
                  '<g aria-hidden="true">' +
                  '<circle class="gpk" r="3.1" style="offset-path:path(\'M50 214 C 124 214 132 150 200 146\')"/>' +
                  '<circle class="gpk k2" r="2.9" style="offset-path:path(\'M200 146 C 264 142 268 66 344 62\')"/>' +
                  '<circle class="gpk k3" r="2.9" style="offset-path:path(\'M200 146 C 262 152 276 208 350 214\')"/>' +
                  '<circle class="gpk alert" r="3.4" style="offset-path:path(\'M200 146 C 226 110 268 100 314 112\')"/>' +
                  "</g>" +
                  '<g class="gn" style="animation-delay:.15s"><circle cx="50" cy="214" r="13"/><text x="50" y="240" text-anchor="middle">entry point</text></g>' +
                  '<g class="gn" style="animation-delay:.5s"><circle cx="200" cy="146" r="15"/><text x="200" y="174" text-anchor="middle" fill="#f4f7ff">workload</text></g>' +
                  '<g class="gn acc" style="animation-delay:.85s"><circle cx="344" cy="62" r="13"/><text x="344" y="88" text-anchor="middle">identity</text></g>' +
                  '<g class="gn" style="animation-delay:1.05s"><circle cx="350" cy="214" r="13"/><text x="350" y="240" text-anchor="middle">data</text></g>' +
                  '<g class="gn crit" style="animation-delay:1.25s"><circle cx="314" cy="112" r="11"/><text x="314" y="96" text-anchor="middle" fill="#fb7185">risk</text></g></svg>' +
                  '<span class="gchip c1"><b></b> AWS collection <em>customer-owned role</em></span>' +
                  '<span class="gchip c2"><b></b> Kubernetes context <em>after enrollment</em></span>' +
                  '<span class="gchip c3"><b></b> Optional sources <em>explicitly configured</em></span>',
              }}
            />
          </div>
        </div>
        {/* The page carries exactly ONE scroll affordance, and it lives at the
            bottom of the cinematic band above — the first thing a visitor sees,
            pointing down at this section. A second cue here read as a
            duplicate. */}
      </section>

      <Statements />

      <div className="stats">
        <div className="wrap stats-in">
          <div><div className="n">AWS<em>live after connection</em></div><div className="l">Customer-owned role and persisted evidence</div></div>
          <div><div className="n">EKS<em>live after enrollment</em></div><div className="l">Cluster, identity and runtime context</div></div>
          <div><div className="n">Delivery<em>operator configured</em></div><div className="l">Destinations report their own readiness</div></div>
          <div><div className="n">Azure · GCP<em>planned</em></div><div className="l">No provider evidence shown before release</div></div>
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
          <div className="intro rise"><span className="sec-kicker">One correlated suite</span><h2>Prioritize what the available evidence proves.</h2><p className="lead">AWS collection and tenant controls are live; Kubernetes, billing, runtime, scanner, and delivery views activate when their required sources are enrolled or configured. Planned providers stay labelled planned, and unconfigured areas show no sample records.</p></div>
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
          <p className="lx-compare-note">&ldquo;Typical CNAPP&rdquo; describes common industry patterns, not any specific vendor. Sutra behaviors remain subject to the source and readiness boundary shown for each capability.</p>
        </section>

        <section className="block" style={{ paddingTop: 0 }} id="pricing">
          <div className="intro center rise"><span className="sec-kicker">Commercial plans</span><h2>Scope the platform to your operating model.</h2><p className="lead">Choose the capability boundary that fits your AWS and EKS portfolio. Final scope, source readiness, service terms, and pricing are confirmed through a commercial review.</p></div>
          <p className="lx-price-note">Public plan descriptions are capability guides, not a finalized rate card or contractual limit.</p>
          <div className="lx-tiers rise">
            {TIERS.map((t) => (
              <article key={t.name} className={"lx-tier" + (t.feat ? " feat" : "")}>
                {t.feat ? <span className="lx-tier-badge">Most popular</span> : null}
                <h3>{t.name}</h3>
                <p className="tagline">{t.tagline}</p>
                <div className="lx-price">
                  <b>Contact</b><small>commercial terms aligned to the approved scope</small>
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
            <h2>The recommended IAM role stores no customer access key.</h2>
            <p className="lead">A collector assumes the customer role with temporary STS credentials. If role creation is impossible, the optional access-key method stores the submitted credential encrypted in AWS Secrets Manager and keeps only a non-secret reference in the web control plane.</p>
            <ul><li><span>01</span> Exact vendor workload-role principal</li><li><span>02</span> Unique, platform-generated ExternalId</li><li><span>03</span> Positive and negative trust validation</li><li><span>04</span> Metadata-only permission packs</li></ul>
            <a className="btn btn-solid" href="#architecture">Review the security architecture <Arrow /></a>
          </div>
          <div className="lx-trust-panel rise">
            <div className="row"><b>recommended method</b><span className="ok">IAM role</span></div>
            <div className="row"><b>role principal</b><span>arn:aws:iam::…:role/sutra-collector</span></div>
            <div className="row"><b>credential type</b><span className="ok">STS · temporary</span></div>
            <div className="row"><b>permission pack</b><span>read-only · metadata · no deletes ever</span></div>
            <div className="row"><b>external id</b><span>platform-generated</span></div>
            <div className="row"><b>customer keys stored by role path</b><span className="ok">none</span></div>
          </div>
        </div>
      </section>

      <div className="wrap">
        <section className="block" id="architecture">
          <div className="intro rise"><span className="sec-kicker">From account to action</span><h2>A separated service architecture, not a browser-side AWS script.</h2><p className="lead">Collection, normalization, and user access follow deliberately separate trust boundaries.</p></div>
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
          <div className="intro center rise"><span className="sec-kicker">Security &amp; trust</span><h2>How Sutra works — and what it will never claim.</h2><p className="lead">Trust statements are grounded in the product&apos;s access, evidence, and isolation boundaries. Unconfigured integrations remain unavailable, and readiness mappings are never presented as certifications.</p></div>

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
          <p className="lead">Book a walkthrough of the product, see the control library and the evidence graph, then review the customer-owned IAM role — read-only from the first minute, and never able to delete anything.</p>
          <div className="hero-cta"><Link className="btn btn-solid" href="/contact">Book a walkthrough</Link><a className="btn" href="#platform">Explore the platform</a></div>
        </div></div>
      </section>

      <footer className="foot">
        <div className="wrap">
          <div className="ftcols">
            <div className="ftcol ftbrand">
              <Link className="lx-brand" href="/"><span className="mark" aria-hidden="true"><i /><i /><i /></span><span><b>Sutra</b><small>Cloud security, woven together</small></span></Link>
              <p>The evidence-backed cloud operations platform for AWS MSPs — inventory, security, cost and compliance, every finding traced to what was actually observed.</p>
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
