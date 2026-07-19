"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

/* ================================================================== *
 * Sutra landing zone — cinematic dark page with a flowing bokeh
 * background, a scroll cue, and a Wiz-style feature explorer.
 * All styles are scoped under `.lz` in globals.css (lz-* keyframes),
 * so nothing here can collide with the authenticated app shell.
 * ================================================================== */

type Row = { dot?: string; k: string; em?: string; v: string; tone?: string };
function pvRows(bar: string, rows: Row[]): string {
  return (
    '<div class="pv"><div class="pv-bar"><i></i><i></i><i></i><span>' + bar + "</span></div><div class=\"pv-body\">" +
    rows
      .map(
        (r) =>
          '<div class="pv-row"><span class="k">' +
          (r.dot ? '<span class="dot" style="background:' + r.dot + '"></span>' : "") +
          r.k +
          (r.em ? " <em>" + r.em + "</em>" : "") +
          '</span><span class="pv-badge ' + (r.tone || "") + '">' + r.v + "</span></div>"
      )
      .join("") +
    "</div></div>"
  );
}

const GDEF =
  '<defs><linearGradient id="pvg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset=".5" stop-color="#3b82f6"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>';

const PV_GRAPH =
  '<div class="pv"><div class="pv-bar"><i></i><i></i><i></i><span>security-graph · live</span></div><div class="pv-graph"><svg viewBox="0 0 460 190" preserveAspectRatio="xMidYMid meet">' +
  GDEF +
  '<path d="M44 132 C 110 132 118 96 168 92" fill="none" stroke="url(#pvg)" stroke-width="1.6"/><path d="M168 92 C 236 88 250 50 316 46" fill="none" stroke="url(#pvg)" stroke-width="1.6"/><path d="M168 92 C 240 96 300 118 416 120" fill="none" stroke="url(#pvg)" stroke-width="1.6"/><path d="M168 92 C 200 66 250 62 292 118" fill="none" stroke="#fb7185" stroke-width="1.4" opacity=".7"/>' +
  '<g><circle cx="44" cy="132" r="11" fill="#0c1326" stroke="#3b82f6" stroke-width="1.6"/><text x="44" y="156" text-anchor="middle" font-family="monospace" font-size="8.5" fill="#808db2">internet</text></g>' +
  '<g><circle cx="168" cy="92" r="13" fill="#0c1326" stroke="#3b82f6" stroke-width="1.6"/><text x="168" y="118" text-anchor="middle" font-family="monospace" font-size="8.5" fill="#f4f7ff">api-gateway</text></g>' +
  '<g><circle cx="316" cy="46" r="11" fill="#0c1326" stroke="#22d3ee" stroke-width="1.6"/><text x="316" y="30" text-anchor="middle" font-family="monospace" font-size="8.5" fill="#808db2">payments-sa</text></g>' +
  '<g><circle cx="416" cy="120" r="11" fill="#0c1326" stroke="#3b82f6" stroke-width="1.6"/><text x="416" y="144" text-anchor="middle" font-family="monospace" font-size="8.5" fill="#808db2">s3://billing</text></g>' +
  '<g><circle cx="292" cy="118" r="9" fill="#26121a" stroke="#fb7185" stroke-width="1.5"/><text x="292" y="140" text-anchor="middle" font-family="monospace" font-size="8.5" fill="#fb7185">CVE</text></g>' +
  "</svg></div></div>";

const PV_TRENDS =
  '<div class="pv"><div class="pv-bar"><i></i><i></i><i></i><span>posture · last 90 days</span></div><div class="pv-body pv-spark"><div class="cap-score"><b>82</b><span>▲ +6 this month</span></div><svg viewBox="0 0 300 64" preserveAspectRatio="none">' +
  GDEF +
  '<path d="M0 50 L30 46 L60 48 L90 40 L120 42 L150 34 L180 30 L210 32 L240 22 L270 20 L300 14 L300 64 L0 64 Z" fill="url(#pvg)" opacity=".18"/><polyline points="0,50 30,46 60,48 90,40 120,42 150,34 180,30 210,32 240,22 270,20 300,14" fill="none" stroke="url(#pvg)" stroke-width="2"/></svg></div></div>';

const PV_FIX =
  '<div class="pv"><div class="pv-bar"><i></i><i></i><i></i><span>kyverno-policy.yaml · generated</span></div><pre class="pv-code"><span class="c"># reviewed suggestion — scoped to the finding</span>\napiVersion: kyverno.io/v1\nkind: <span class="b">ClusterPolicy</span>\nmetadata:\n  name: disallow-privileged\nspec:\n  rules:\n    - name: privileged-containers\n      validate:\n        message: <span class="g">"privileged not allowed"</span>\n        pattern: { spec: { containers: [ { securityContext: { privileged: <span class="g">false</span> } } ] } }</pre></div>';

type Cap = { code: string; label: string; t: string; icon: string; title: string; blurb: string; points: string[]; pv: string };
const CAPS: Cap[] = [
  { code: "GRAPH", label: "Security graph", t: "#3b82f6", icon: '<circle cx="5" cy="12" r="2.2"/><circle cx="14" cy="6" r="2.2"/><circle cx="14" cy="18" r="2.2"/><circle cx="21" cy="12" r="2.2"/><path d="M7 11 12 7M7 13 12 17M16 7l3 4M16 17l3-4"/>', title: "Evidence-backed security graph", blurb: "Every cloud, Kubernetes, identity and network relationship on one canvas — every edge a cited observation, not a guess.", points: ["Cloud + cluster + identity in one model", "Confirmed vs. theoretical reachability", "Click any edge to see the evidence"], pv: PV_GRAPH },
  { code: "ISSUES", label: "Runtime-informed issues", t: "#fb7185", icon: '<path d="M12 3 22 20H2z"/><path d="M12 10v5M12 18h.01"/>', title: "Runtime-informed issues", blurb: "Not thousands of CVEs — the handful that are internet-reachable, running and exploitable, proven with observed evidence.", points: ["Toxic-combination detection", "Reachability from real network flows", "Prioritized by exposure, not just CVSS"], pv: pvRows("issues · prioritized", [
    { dot: "#fb7185", k: "Internet-reachable workload", em: "running CVE-2024-3094", v: "Critical", tone: "red" },
    { dot: "#fbbf24", k: "Privileged pod reachable from ingress", em: "hostPID", v: "High", tone: "amber" },
    { dot: "#fbbf24", k: "ServiceAccount can delete a prod S3 bucket", em: "no MFA", v: "High", tone: "amber" }]) },
  { code: "CIEM", label: "Effective permissions", t: "#8b5cf6", icon: '<circle cx="8" cy="13" r="4"/><path d="m11 10 9-9M17 4l3 3"/>', title: "Effective permissions", blurb: "Resolve a workload's effective RBAC and follow its IRSA or EKS Pod Identity link into AWS — can this pod delete an S3 bucket?", points: ["In-cluster RBAC solver", "IRSA + Pod Identity → AWS reach", "Flags: secrets, exec, unused SA"], pv: pvRows("effective-permissions", [
    { k: "api-gateway", em: "mounts payments-sa token", v: "IRSA", tone: "blue" },
    { k: "payments-sa → PaymentsRole", em: "assume-role", v: "aws-reach", tone: "violet" },
    { k: "s3:DeleteObject on billing/*", em: "allowed", v: "aws-write", tone: "red" },
    { k: "batch-runner-sa", em: "no workload uses it", v: "unused", tone: "amber" }]) },
  { code: "EXPOSE", label: "Network exposure", t: "#22d3ee", icon: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5a14 14 0 0 1 0 17 14 14 0 0 1 0-17Z"/>', title: "Network exposure & port filtering", blurb: "A proven internet path — gateway route, NACL port filter, load-balancer target, DNS entry point — with open vs filtered ports per interface.", points: ["Hop-by-hop reachability, each hop cited", "Open vs NACL-filtered ports", "Missing evidence → honest unknown"], pv: pvRows("network-exposure", [
    { dot: "#fb7185", k: "eni-api-gw", em: "443 open · 8080 filtered by acl-1", v: "Internet-exposed", tone: "red" },
    { dot: "#34d399", k: "eni-batch", em: "22 filtered by acl-2", v: "Not exposed", tone: "green" },
    { dot: "#fbbf24", k: "eni-worker", em: "no route evidence", v: "Unknown", tone: "amber" }]) },
  { code: "PATCH", label: "Patch plans", t: "#f0842e", icon: '<rect x="4" y="4" width="7" height="7" rx="1.4"/><rect x="13" y="13" width="7" height="7" rx="1.4"/><path d="M11 7.5h5.5v5.5"/>', title: "Patch plans, not CVE lists", blurb: "Hundreds of CVEs collapse into the handful of version bumps that actually fix them — ranked by KEV, EPSS and reachability.", points: ["One upgrade per package + image", "KEV & EPSS-aware priority", "SLA due dates per severity"], pv: pvRows("patch-plan · ranked", [
    { k: "openssl 3.0.11 → 3.0.14", em: "fixes 4 CVEs", v: "KEV", tone: "red" },
    { k: "libxml2 2.9.1 → 2.12.0", em: "fixes 2 CVEs", v: "EPSS 0.62", tone: "amber" },
    { k: "base image node:18 → node:20", em: "fixes 12 CVEs", v: "12 CVEs", tone: "blue" }]) },
  { code: "GATE", label: "CI security gate", t: "#06b6c4", icon: '<path d="M12 3 20 6v6c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V6z"/><path d="m9 12 2 2 4-4"/>', title: "CI security gate", blurb: "The same scanners gate every build — Jenkins, GitHub Actions or an in-cluster Job — with severity thresholds and a JUnit report the pipeline renders.", points: ["Jenkins + Kubernetes + Actions", "Severity fail-on thresholds", "Skips reported, never silent passes"], pv: pvRows("ci-gate · fail-on high", [
    { k: "secret-scan", em: "no committed secrets", v: "pass", tone: "green" },
    { k: "iac-scan", em: "clean at fail-on high", v: "pass", tone: "green" },
    { k: "image-vulns", em: "1 critical · CVE-2024-3094", v: "fail", tone: "red" },
    { k: "sbom-attest", em: "no artifact provided", v: "skip", tone: "amber" }]) },
  { code: "TRENDS", label: "Posture trends", t: "#34d399", icon: '<path d="M4 19V5M4 19h16"/><path d="m7 14 3-3 3 2 4-5"/>', title: "Posture trends & scorecard", blurb: "A per-customer security score over time with regression detection and a resell-ready export — the report an MSP hands over.", points: ["Score per customer over time", "Automatic regression detection", "Exportable MSP scorecard"], pv: PV_TRENDS },
  { code: "DRIFT", label: "Drift & new CVEs", t: "#f0842e", icon: '<path d="M8 3H4v4M4 3l6 6M16 21h4v-4M20 21l-6-6"/>', title: "Drift & new-CVE detection", blurb: "Catch a workload that drifted from its admitted spec, or an image that gained a vulnerability since the last scan.", points: ["Live spec vs. admitted spec diff", "New-CVE delta between scans", "Severity-ranked, cited to the change"], pv: pvRows("drift · since last scan", [
    { dot: "#fbbf24", k: "replicas", em: "3 → 5", v: "drift", tone: "amber" },
    { dot: "#fbbf24", k: "image tag", em: ":1.4.2 → :latest", v: "drift", tone: "amber" },
    { dot: "#fb7185", k: "batch-runner", em: "gained CVE-2024-3094", v: "new CVE", tone: "red" }]) },
  { code: "FIX", label: "Guided remediation", t: "#06b6c4", icon: '<path d="M14.5 6.5a3.5 3.5 0 0 1-4.6 4.6L4 17l3 3 5.9-5.9a3.5 3.5 0 0 1 4.6-4.6l-2.2 2.2-2-2z"/>', title: "Guided remediation", blurb: "Generate the exact Kyverno policy or kubectl patch that fixes an issue — a reviewed suggestion, never an automatic change.", points: ["Kyverno policy or kubectl patch", "Scoped to the specific finding", "You review and apply — never auto"], pv: PV_FIX },
  { code: "RUNTIME", label: "Runtime detection", t: "#fb7185", icon: '<path d="M3 12h4l2 6 4-14 2 8h6"/>', title: "Runtime detection", blurb: "Signed, replay-resistant Falco events with Kubernetes context, human-confirmed cases and durable notification delivery.", points: ["Signed, replay-resistant events", "Full pod and workload context", "Human-confirmed cases + alerting"], pv: pvRows("runtime · falco events", [
    { dot: "#fb7185", k: "Shell spawned in container", em: "api-gateway · pod-7f9", v: "signed", tone: "red" },
    { dot: "#fbbf24", k: "Unexpected outbound connection", em: "batch-runner → 185.x", v: "case open", tone: "amber" },
    { dot: "#fb7185", k: "Sensitive file read", em: "/etc/shadow", v: "signed", tone: "red" }]) },
  { code: "COMPLY", label: "Readiness mappings", t: "#34d399", icon: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8 9 2 2 4-4M8 15h6"/>', title: "Readiness mappings", blurb: "CIS Kubernetes, NSA/CISA and SOC 2 readiness mapped to cited evidence — a readiness view, never a certification claim.", points: ["CIS, NSA/CISA, SOC 2 mappings", "Every control cited to evidence", "Honest readiness, not a pass stamp"], pv: '<div class="pv"><div class="pv-bar"><i></i><i></i><i></i><span>readiness · cited to evidence</span></div><div class="pv-body"><div class="pv-bars"><div class="pv-barrow"><span>CIS Kubernetes</span><span class="pv-track"><span class="pv-fill" style="width:78%"></span></span><em>78%</em></div><div class="pv-barrow"><span>NSA / CISA</span><span class="pv-track"><span class="pv-fill" style="width:84%"></span></span><em>84%</em></div><div class="pv-barrow"><span>SOC 2 (CC)</span><span class="pv-track"><span class="pv-fill" style="width:71%"></span></span><em>71%</em></div></div></div></div>' },
];

const MARQUEE = ["Amazon EKS", "AWS IAM & IRSA", "EKS Pod Identity", "Trivy Operator", "Falco runtime", "Kyverno admission", "Cilium · Hubble", "Amazon GuardDuty", "Security Hub", "Amazon Inspector", "SBOM & signing", "Kubernetes RBAC", "CIS Benchmarks", "KEV · EPSS", "Jenkins & GitOps gates", "Route tables & NACLs"];

type Panel = { name: string; icon: string; h3: string; lead: string; points: string[]; mini: string };
const PLATFORM: Panel[] = [
  { name: "cloud", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5a14 14 0 0 1 0 17 14 14 0 0 1 0-17Z"/></svg>', h3: "Cloud CMDB & reachability", lead: "Twenty-two collectors per region build a normalized asset graph, then trace which resources are provably internet-reachable — gateway route, NACL port filter, load-balancer target, DNS entry point.", points: ["Open vs NACL-filtered ports, per resource", "Every hop cited; unknowns disclosed, never guessed"], mini: '<svg viewBox="0 0 400 232"><path class="gl" d="M42 176 C 110 176 122 118 192 116 M192 116 C 262 114 282 64 352 62" stroke="#3b82f6"/><g class="gn" style="opacity:1"><circle cx="42" cy="176" r="12"/><text x="42" y="200" text-anchor="middle">igw</text></g><g class="gn" style="opacity:1"><circle cx="192" cy="116" r="13"/><text x="192" y="140" text-anchor="middle" fill="#f4f7ff">subnet</text></g><g class="gn acc" style="opacity:1"><circle cx="352" cy="62" r="12"/><text x="352" y="86" text-anchor="middle">sg :443</text></g></svg>' },
  { name: "k8s", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.2"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.2"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.2"/></svg>', h3: "Kubernetes posture & runtime", lead: "KSPM over admitted specs, workload & image drift, SBOM findings and signed Falco runtime events — correlated onto the same workloads, not a separate console.", points: ["Live spec vs admitted-spec drift", "Runtime-informed prioritization (KEV · EPSS · reachable)"], mini: '<svg viewBox="0 0 400 232"><g class="gn" style="opacity:1"><rect x="150" y="84" width="100" height="60" rx="11" stroke="#3b82f6" stroke-width="1.7"/><text x="200" y="118" text-anchor="middle" fill="#f4f7ff">workload</text></g><g class="gn crit" style="opacity:1"><circle cx="304" cy="66" r="10"/><text x="304" y="50" text-anchor="middle" fill="#fb7185">drift</text></g></svg>' },
  { name: "id", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="13" r="4"/><path d="m11 10 9-9M17 4l3 3"/></svg>', h3: "Cross-plane effective permissions", lead: "Kubernetes RBAC unioned with IRSA and EKS Pod Identity into one answer: what can this pod actually do — in the cluster and in the AWS account?", points: ["RBAC ∪ IRSA ∪ Pod Identity → AWS reach", "Unused & default-ServiceAccount flags"], mini: '<svg viewBox="0 0 400 232"><path class="gl" d="M68 116 H 184 M216 116 H 332" stroke="#3b82f6"/><g class="gn" style="opacity:1"><circle cx="55" cy="116" r="13"/><text x="55" y="140" text-anchor="middle">pod</text></g><g class="gn acc" style="opacity:1"><circle cx="200" cy="116" r="13"/><text x="200" y="140" text-anchor="middle">SA</text></g><g class="gn" style="opacity:1"><circle cx="345" cy="116" r="13"/><text x="345" y="140" text-anchor="middle">IAM</text></g></svg>' },
];

const COMPARISON = [
  { dim: "Finding confidence", them: "A severity score you have to trust", sutra: "Tri-state verdicts — unknown is disclosed, never hidden" },
  { dim: "Missing data", them: "Silently reported as passing", sutra: "Surfaced as missing evidence on the finding itself" },
  { dim: "Identity risk", them: "Cloud IAM and cluster RBAC in separate views", sutra: "One answer: RBAC + IRSA + Pod Identity → AWS reach" },
  { dim: "Internet exposure", them: "A security-group rule check", sutra: "Full path: route, NACL filter, LB target membership, DNS" },
  { dim: "Remediation", them: "Auto-applied changes or a ticket dump", sutra: "Reviewed Kyverno / kubectl fixes, patch plans, CI gate" },
  { dim: "Tenancy", them: "A single-tenant console", sutra: "MSP portfolio roll-up plus per-customer scoped workspaces" },
];

const DIFFERENTIATORS = [
  { c: "01", h: "Evidence-honest by design", p: "Every verdict is tri-state — pass, fail, or unknown. When the evidence to decide is missing, Sutra says so on the finding. It never fabricates a “safe”.", proof: "Tri-state verdicts · missing evidence disclosed · every edge cited" },
  { c: "02", h: "One identity answer, cross-plane", p: "Kubernetes RBAC, IRSA annotations and EKS Pod Identity associations resolve into a single effective-permission verdict: what can this pod actually do?", proof: "RBAC ∪ IRSA ∪ Pod Identity → AWS reach · unused & default-SA flags" },
  { c: "03", h: "Reachability, hop by hop", p: "Internet exposure is a proven path, not a security-group guess: gateway route, NACL port filter, load-balancer target, DNS entry point — each hop present, or the verdict is unknown.", proof: "IGW route · open vs filtered ports · LB targets · DNS entry points" },
];

const LAYERS = [
  { n: "01", h: "Customer cloud", p: "A customer-owned IAM role grants only the metadata APIs in the selected collector pack." },
  { n: "02", h: "Collector plane", p: "An AWS workload identity obtains short-lived STS credentials and performs bounded regional discovery." },
  { n: "03", h: "Normalized CMDB", p: "Assets, relationships and evidence are validated, scoped and promoted only after a complete run." },
  { n: "04", h: "MSP control plane", p: "Role-aware dashboards, findings, audit history and customer access operate without exposing AWS credentials." },
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

function PlatformTabs() {
  const [tab, setTab] = useState("cloud");
  const active = PLATFORM.find((p) => p.name === tab) ?? PLATFORM[0];
  return (
    <>
      <div className="tabs" role="tablist">
        {PLATFORM.map((p) => (
          <button key={p.name} className="tab" role="tab" aria-selected={p.name === tab} onClick={() => setTab(p.name)}>
            <span dangerouslySetInnerHTML={{ __html: p.icon }} />{" "}
            {p.name === "cloud" ? "Cloud" : p.name === "k8s" ? "Kubernetes" : "Identity"}
          </button>
        ))}
      </div>
      <div className="prod">
        <div className="panel" data-active="true" key={tab}>
          <div>
            <h3>{active.h3}</h3>
            <p className="lead">{active.lead}</p>
            <ul>
              {active.points.map((pt) => (
                <li key={pt}>
                  <Check s={16} /> {pt}
                </li>
              ))}
            </ul>
          </div>
          <div className="mini" dangerouslySetInnerHTML={{ __html: active.mini }} />
        </div>
      </div>
    </>
  );
}

function FeatureExplorer() {
  const [sel, setSel] = useState(0);
  const c = CAPS[sel];
  return (
    <div className="explorer">
      <div className="ex-nav" role="tablist" aria-label="Capabilities">
        {CAPS.map((cap, i) => (
          <button
            key={cap.code}
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
    if (cv) {
      const ctx = cv.getContext("2d")!;
      let W = 0, H = 0, DPR = 1;
      let dots: Array<{ x: number; y: number; size: number; a: number; vx: number; vy: number; tw: number; tws: number; sway: number; sp: HTMLCanvasElement }> = [];
      const sprite = (rgb: string) => {
        const s = document.createElement("canvas");
        s.width = s.height = 64;
        const c2 = s.getContext("2d")!;
        const g = c2.createRadialGradient(32, 32, 0, 32, 32, 32);
        g.addColorStop(0, "rgba(" + rgb + ",.95)");
        g.addColorStop(0.35, "rgba(" + rgb + ",.4)");
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
        spCyan = sprite("56,224,236");
        spViolet = sprite("150,140,246");
        spBlue = sprite("90,150,250");
        const n = Math.min(150, Math.round((window.innerWidth * window.innerHeight) / 12500));
        dots = Array.from({ length: n }, () => {
          const r = Math.random();
          return {
            x: Math.random() * W, y: Math.random() * H,
            size: (5 + Math.random() * 18) * DPR,
            a: 0.16 + Math.random() * 0.5,
            vx: (Math.random() - 0.5) * 0.08 * DPR, vy: (-0.04 - Math.random() * 0.14) * DPR,
            tw: Math.random() * 6.28, tws: 0.008 + Math.random() * 0.02,
            sway: (0.1 + Math.random() * 0.16) * DPR,
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
          ctx.globalAlpha = d.a * (0.6 + 0.4 * Math.sin(d.tw));
          ctx.drawImage(d.sp, d.x - d.size / 2, d.y - d.size / 2, d.size, d.size);
        }
        ctx.globalAlpha = 1;
        raf = requestAnimationFrame(draw);
      };
      resize();
      onResize = resize;
      window.addEventListener("resize", resize);
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

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (onResize) window.removeEventListener("resize", onResize);
      io.disconnect();
      cio.disconnect();
    };
  }, []);

  return (
    <div className="lz" ref={rootRef}>
      <div className="bg-glows" />
      <canvas className="bg-canvas" id="lz-bg" aria-hidden="true" />

      <header className="head">
        <Link className="brand" href="/" aria-label="Sutra home">
          <span className="mark" aria-hidden="true"><i /><i /><i /></span>
          <span><b>Sutra</b><small>Cloud security, woven together</small></span>
        </Link>
        <nav>
          <a href="#platform">Platform</a><a href="#capabilities">Capabilities</a><a href="#why">Why Sutra</a><a href="#trust">Security model</a>
        </nav>
        <div className="head-actions">
          <Link className="signin" href="/login">Sign in</Link>
          <Link className="btn btn-solid" href="/dashboard">Open live demo <Arrow /></Link>
        </div>
      </header>

      <span id="top" />
      <section className="hero">
        <div className="hero-copy">
          <span className="kicker"><i /> EKS-first CNAPP for managed service providers</span>
          <h1>See every risk.<br /><span className="accent">Prove every path.</span></h1>
          <p>Sutra correlates every cloud and cluster risk across AWS and Kubernetes into one evidence graph — exposure, workload, identity, blast radius — and surfaces the few that are provably reachable. Every finding cites the exact observation behind it.</p>
          <div className="hero-cta">
            <Link className="btn btn-solid" href="/dashboard">Open live demo <Arrow /></Link>
            <a className="btn" href="#trust">Review the trust model</a>
          </div>
          <div className="assur"><span><b>✓</b> Read-only access, customer-owned</span><span><b>✓</b> Every finding cited</span><span><b>✓</b> No customer access keys</span></div>
        </div>
        <div className="hero-stage">
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
          <p><span>Correlated across your estate.</span> AWS + EKS · identity · network · runtime · supply chain — in one evidence graph</p>
          <div className="strip-cats"><span><strong>Cloud</strong> CMDB &amp; CSPM</span><span><strong>Kubernetes</strong> KSPM &amp; runtime</span><span><strong>Identity</strong> CIEM &amp; RBAC</span><span><strong>Supply chain</strong> SBOM &amp; signing</span></div>
        </div>
        <div className="marquee" aria-hidden="true">{[...MARQUEE, ...MARQUEE].map((t, i) => <span key={i}>{t}</span>)}</div>
      </div>

      <div className="wrap">
        <section className="block" id="platform">
          <div className="intro center rise"><span className="sec-kicker">Correlation is the product</span><h2>One graph connects the cloud, the cluster, and the identity.</h2><p className="lead">A privileged pod, reachable from the internet, running a critical CVE, with a ServiceAccount that can reach S3 — no single tool sees that whole chain. Sutra correlates it and cites every edge.</p></div>
          <div className="rise"><PlatformTabs /></div>
        </section>

        <section className="block" style={{ paddingTop: 0 }} id="capabilities">
          <div className="intro rise"><span className="sec-kicker">One correlated suite</span><h2>Every other tool floods you with CVEs. Sutra shows what&apos;s reachable.</h2><p className="lead">Cloud, Kubernetes, identity, network, runtime and supply-chain evidence in one graph — and only the risks proven to matter surface first. Every capability below is live in the product.</p></div>
          <div className="rise"><FeatureExplorer /></div>
        </section>

        <section className="block" style={{ paddingTop: 0 }} id="why">
          <div className="intro center rise"><span className="sec-kicker">Why teams choose Sutra</span><h2>Built on proof, where others ask for trust.</h2><p className="lead">Most platforms hand you a score. Sutra hands you the observation, the path, and the verdict — including the honest &ldquo;unknown&rdquo; when the evidence isn&apos;t there.</p></div>
          <div className="why rise">
            {DIFFERENTIATORS.map((d) => (
              <article key={d.c} className="why-card"><span className="c">{d.c}</span><h3>{d.h}</h3><p>{d.p}</p><em>{d.proof}</em></article>
            ))}
          </div>
          <div className="compare rise">
            <div className="compare-head">The difference in practice</div>
            <div className="crow crow-head"><span>&nbsp;</span><span>Typical CNAPP</span><span className="sutra">Sutra</span></div>
            {COMPARISON.map((r) => (
              <div key={r.dim} className="crow"><span className="dim">{r.dim}</span><span className="them">{r.them}</span><span className="sutra"><b>✓</b>{r.sutra}</span></div>
            ))}
          </div>
          <p className="compare-note">&ldquo;Typical CNAPP&rdquo; describes common industry patterns, not any specific vendor. Every Sutra behavior above is live in the demo workspace.</p>
        </section>
      </div>

      <section className="block trust" id="trust">
        <div className="wrap trust-in">
          <div className="rise">
            <span className="sec-kicker">Trust is a product feature</span>
            <h2>Customer credentials never enter the browser or web control plane.</h2>
            <p className="lead">A separate collector workload assumes the customer role with temporary STS credentials. The application receives normalized, scoped evidence — not access keys.</p>
            <ul><li><span>01</span> Exact vendor workload-role principal</li><li><span>02</span> Unique, platform-generated ExternalId</li><li><span>03</span> Positive and negative trust validation</li><li><span>04</span> Metadata-only permission packs</li></ul>
            <Link className="btn btn-solid" href="/controls#architecture">Review the security architecture <Arrow /></Link>
          </div>
          <div className="trust-panel rise">
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
          <div className="layers rise">
            {LAYERS.map((l) => (
              <div key={l.n} className="layer"><span>{l.n}</span><h4>{l.h}</h4><p>{l.p}</p></div>
            ))}
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

      <section className="final">
        <div className="wrap"><div className="inner rise">
          <span className="sec-kicker">Start in minutes</span>
          <h2>See the MSP experience before connecting an account.</h2>
          <p className="lead">Explore the live demo workspace, inspect the control library, then review the customer-owned IAM role — read-only from the first minute.</p>
          <div className="hero-cta"><Link className="btn btn-solid" href="/dashboard">Open live demo</Link><Link className="btn" href="/onboard">Review onboarding</Link></div>
        </div></div>
      </section>

      <footer className="foot">
        <div className="wrap foot-in">
          <Link className="brand" href="/"><span className="mark" aria-hidden="true"><i /><i /><i /></span><span><b>Sutra</b><small>Cloud security, woven together</small></span></Link>
          <small className="c">© 2026 Sutra · EKS-first CNAPP for MSPs · demo workspace uses fictional data</small>
        </div>
      </footer>
    </div>
  );
}
