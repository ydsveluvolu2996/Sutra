"use client";

import { ReactNode, useState } from "react";
import Link from "next/link";

/* ------------------------------------------------------------------ *
 * Shared feature glyphs (stroke icons, one per capability code)
 * ------------------------------------------------------------------ */
function Glyph({ name }: { name: string }): ReactNode {
  const paths: Record<string, ReactNode> = {
    GRAPH: (<><circle cx="5" cy="12" r="2.4" /><circle cx="14" cy="6" r="2.4" /><circle cx="14" cy="18" r="2.4" /><circle cx="21" cy="12" r="2.4" /><path d="M7 11 12 7M7 13 12 17M16 7l3 4M16 17l3-4" /></>),
    ISSUES: (<><path d="M12 3 22 20H2z" /><path d="M12 10v5M12 18h.01" /></>),
    CIEM: (<><circle cx="8" cy="13" r="4" /><path d="m11 10 9-9M17 4l3 3M15 6l2 2" /></>),
    TRENDS: (<><path d="M3 17 9 11l4 4 8-8" /><path d="M16 7h5v5" /></>),
    DRIFT: (<><path d="M6 3v6a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v6" /><circle cx="6" cy="3" r="1.6" /><circle cx="18" cy="21" r="1.6" /><path d="M14 8h8M18 4v8" /></>),
    FIX: (<><path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8 7.2 20l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.2-.4-.4-2.2z" /></>),
    RUNTIME: (<><path d="M3 12h4l2 6 4-14 2 8h6" /></>),
    COMPLY: (<><path d="M12 3 5 6v5c0 4 3 7 7 10 4-3 7-6 7-10V6z" /><path d="m9 12 2 2 4-4" /></>),
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name] ?? null}
    </svg>
  );
}

/* ================================================================== *
 * 1) Capability explorer — click a capability, a live view swaps in
 * ================================================================== */

function Chip({ tone, children }: { tone?: string; children: ReactNode }): ReactNode {
  return <span className={`pv-chip${tone ? ` pv-chip-${tone}` : ""}`}>{children}</span>;
}

function PreviewGraph(): ReactNode {
  const nodes = [
    { id: "net", label: "Internet", x: 6, y: 50, kind: "edge" },
    { id: "ing", label: "Ingress LB", x: 26, y: 50, kind: "net" },
    { id: "pod", label: "api-gateway", x: 48, y: 50, kind: "hot" },
    { id: "sa", label: "payments-sa", x: 70, y: 30, kind: "id" },
    { id: "role", label: "IAM: PaymentsRole", x: 70, y: 72, kind: "id" },
    { id: "s3", label: "s3://billing", x: 92, y: 72, kind: "data" },
  ] as const;
  const baseEdges = [["net", "ing"], ["ing", "pod"], ["pod", "sa"], ["pod", "role"], ["role", "s3"]] as const;
  const hops = [
    { from: "net", to: "ing", label: "Internet → Ingress", evidence: "12,405 inbound flows to :443 observed from the public internet (Hubble)." },
    { from: "ing", to: "pod", label: "Ingress → api-gateway", evidence: "Ingress routes api.northstar.io → api-gateway:8080, admission-confirmed." },
    { from: "pod", to: "role", label: "api-gateway → PaymentsRole", evidence: "Pod mounts the payments-sa token; the SA is IRSA-linked to PaymentsRole." },
    { from: "role", to: "s3", label: "PaymentsRole → s3://billing", evidence: "Role policy allows s3:GetObject and s3:DeleteObject on billing/*." },
  ] as const;
  const pos = (id: string) => nodes.find((n) => n.id === id)!;
  const [sel, setSel] = useState<number | null>(null);
  return (
    <div className="pv pv-graph">
      <div className="pv-head"><span>Security graph</span><b className="pv-tag pv-tag-red">attack path · confirmed</b></div>
      <div className="pv-graph-canvas">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pv-graph-edges" aria-hidden="true">
          {baseEdges.map(([a, b]) => { const pa = pos(a); const pb = pos(b); return <line key={`${a}-${b}`} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} className="pv-edge" />; })}
          {hops.map((h, i) => { const pa = pos(h.from); const pb = pos(h.to); return <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} className={`pv-edge pv-edge-hot${sel === i ? " is-sel" : ""}`} />; })}
        </svg>
        {nodes.map((n) => (
          <span key={n.id} className={`pv-node pv-node-${n.kind}`} style={{ left: `${n.x}%`, top: `${n.y}%` }}>{n.label}</span>
        ))}
        {hops.map((h, i) => { const pa = pos(h.from); const pb = pos(h.to); return <button type="button" key={`e${i}`} className={`pv-evi${sel === i ? " is-sel" : ""}`} style={{ left: `${(pa.x + pb.x) / 2}%`, top: `${(pa.y + pb.y) / 2}%` }} onClick={() => setSel(sel === i ? null : i)} aria-label={`Evidence for ${h.label}`}>{i + 1}</button>; })}
      </div>
      {sel === null ? (
        <div className="pv-foot"><b>Reachable:</b> Internet → api-gateway (CVE-2024-3094, running) → payments-sa → PaymentsRole → s3://billing <em>— click a numbered hop for its evidence.</em></div>
      ) : (
        <div className="pv-foot pv-foot-evi"><b>{hops[sel].label} —</b> {hops[sel].evidence} <button type="button" className="pv-evi-reset" onClick={() => setSel(null)}>full path</button></div>
      )}
    </div>
  );
}

function PreviewIssues(): ReactNode {
  const rows = [
    { sev: "Critical", title: "Internet-reachable workload with a running critical CVE", chips: ["Internet-reachable", "Running now", "CVE-2024-3094", "Can reach S3"], who: "Northstar · api-gateway" },
    { sev: "High", title: "Privileged pod reachable from the ingress path", chips: ["Reachable", "privileged: true", "hostPID"], who: "Northstar · batch-runner" },
    { sev: "High", title: "ServiceAccount can delete a production S3 bucket", chips: ["s3:DeleteObject", "IRSA", "no MFA"], who: "Bluepeak · payments-sa" },
  ];
  return (
    <div className="pv pv-issues">
      <div className="pv-head"><span>Priority issues</span><b className="pv-tag">runtime-informed</b></div>
      <ul className="pv-issue-list">
        {rows.map((r) => (
          <li key={r.title}>
            <span className={`pv-sev pv-sev-${r.sev.toLowerCase()}`}>{r.sev}</span>
            <div>
              <strong>{r.title}</strong>
              <div className="pv-chips">{r.chips.map((c) => <Chip key={c}>{c}</Chip>)}</div>
              <em>{r.who}</em>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreviewCiem(): ReactNode {
  return (
    <div className="pv pv-ciem">
      <div className="pv-head"><span>Effective permissions</span><b className="pv-tag pv-tag-violet">payments-sa</b></div>
      <div className="pv-flow">
        <span className="pv-flow-node">Pod: payments</span>
        <i>→</i>
        <span className="pv-flow-node">SA: payments-sa</span>
        <i>→</i>
        <span className="pv-flow-node pv-flow-aws">IRSA · IAM: PaymentsRole</span>
      </div>
      <div className="pv-ciem-cols">
        <div>
          <small>In-cluster RBAC</small>
          <ul><li>get, list <b>secrets</b></li><li>create <b>pods/exec</b></li><li>get, watch pods</li></ul>
        </div>
        <div>
          <small>Reaches in AWS</small>
          <ul><li>s3:GetObject, <b>s3:DeleteObject</b></li><li>secretsmanager:GetSecretValue</li></ul>
        </div>
      </div>
      <div className="pv-flags">
        <Chip tone="red">reads Secrets</Chip><Chip tone="red">exec into pods</Chip><Chip tone="red">aws-write</Chip><Chip tone="ok">not cluster-admin</Chip>
      </div>
    </div>
  );
}

function PreviewTrends(): ReactNode {
  const pts = [58, 62, 61, 66, 70, 64, 72, 76, 74, 79, 82];
  const w = 300; const h = 96; const max = 100;
  const step = w / (pts.length - 1);
  const line = pts.map((p, i) => `${i * step},${h - (p / max) * h}`).join(" ");
  const area = `0,${h} ${line} ${w},${h}`;
  return (
    <div className="pv pv-trends">
      <div className="pv-head"><span>Posture trend · Northstar</span><b className="pv-tag pv-tag-green">+18 / 90d</b></div>
      <div className="pv-trends-body">
        <div className="pv-score"><strong>82</strong><small>/100</small><em>▲ 3 this week</em></div>
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="pv-spark" aria-hidden="true">
          <polygon points={area} className="pv-spark-fill" />
          <polyline points={line} className="pv-spark-line" />
          <circle cx={5 * step} cy={h - (64 / max) * h} r="3" className="pv-spark-dip" />
        </svg>
      </div>
      <div className="pv-foot"><b>Regression caught</b> wk of Jul 7 — new privileged workload dropped Northstar −6, auto-flagged.</div>
    </div>
  );
}

function PreviewDrift(): ReactNode {
  return (
    <div className="pv pv-drift">
      <div className="pv-head"><span>Workload drift · payments-api</span><b className="pv-tag pv-tag-orange">drifted 3h ago</b></div>
      <div className="pv-diff">
        <div className="pv-diff-row pv-del"><span>- securityContext.privileged: false</span></div>
        <div className="pv-diff-row pv-add"><span>+ securityContext.privileged: true</span><Chip tone="red">critical</Chip></div>
        <div className="pv-diff-row pv-del"><span>- runAsNonRoot: true</span></div>
        <div className="pv-diff-row pv-add"><span>+ image: payments-api:1.5.0</span><Chip tone="orange">+1 new CVE</Chip></div>
      </div>
      <div className="pv-foot"><b>Admitted spec</b> vs live — Sutra diffs every workload against what admission actually allowed.</div>
    </div>
  );
}

function PreviewFix(): ReactNode {
  const policy = [
    "apiVersion: kyverno.io/v1",
    "kind: ClusterPolicy",
    "metadata:",
    "  name: disallow-privileged",
    "spec:",
    "  validationFailureAction: Enforce",
    "  rules:",
    "    - name: privileged-containers",
    "      match: { any: [{ resources: { kinds: [Pod] } }] }",
    "      validate:",
    "        message: Privileged containers are not allowed",
    "        pattern:",
    "          spec:",
    "            containers:",
    "              - securityContext:",
    "                  privileged: \"false\"",
  ].join("\n");
  return (
    <div className="pv pv-fix">
      <div className="pv-head"><span>Guided remediation</span><b className="pv-tag pv-tag-teal">reviewed suggestion</b></div>
      <pre className="pv-code"><code>{policy}</code></pre>
      <div className="pv-foot"><b>Never auto-applied.</b> Copy into your GitOps pipeline, or export the equivalent kubectl patch.</div>
    </div>
  );
}

function PreviewRuntime(): ReactNode {
  const events = [
    { t: "10:04:12", rule: "Terminal shell spawned in container", pod: "payments-api", sev: "Warning" },
    { t: "10:03:58", rule: "Read of sensitive file /etc/shadow", pod: "api-gateway", sev: "Critical" },
    { t: "10:02:31", rule: "Outbound connection to unexpected IP", pod: "worker-3", sev: "Notice" },
    { t: "10:01:07", rule: "Package manager launched in container", pod: "batch-runner", sev: "Warning" },
  ];
  return (
    <div className="pv pv-runtime">
      <div className="pv-head"><span><i className="pv-live" />Runtime events · Falco</span><b className="pv-tag pv-tag-green">signed · replay-resistant</b></div>
      <ul className="pv-stream">
        {events.map((e) => (
          <li key={e.t}>
            <code>{e.t}</code>
            <span>{e.rule}</span>
            <em>{e.pod}</em>
            <b className={`pv-sev pv-sev-${e.sev.toLowerCase()}`}>{e.sev}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreviewComply(): ReactNode {
  const frameworks = [{ name: "CIS Kubernetes", pct: 78, tone: "blue" }, { name: "NSA / CISA", pct: 84, tone: "green" }, { name: "SOC 2 (CC)", pct: 71, tone: "violet" }];
  return (
    <div className="pv pv-comply">
      <div className="pv-head"><span>Readiness mappings</span><b className="pv-tag">evidence-backed</b></div>
      <div className="pv-frameworks">
        {frameworks.map((f) => (
          <div key={f.name} className="pv-fw">
            <span>{f.name}</span>
            <i><b className={`pv-fw-${f.tone}`} style={{ width: `${f.pct}%` }} /></i>
            <strong>{f.pct}%</strong>
          </div>
        ))}
      </div>
      <div className="pv-foot"><b>CIS 5.2.1</b> — Minimize privileged workloads: 3 fail, each cited to the exact workload spec. A readiness view, never a certification claim.</div>
    </div>
  );
}

interface Capability {
  readonly code: string;
  readonly tone: string;
  readonly title: string;
  readonly blurb: string;
  readonly points: readonly string[];
  readonly preview: ReactNode;
}

const CAPABILITIES: readonly Capability[] = [
  { code: "GRAPH", tone: "blue", title: "Evidence-backed security graph", blurb: "Every cloud, Kubernetes, identity and network relationship on one canvas — and every edge is a cited observation, not a guess.", points: ["Cloud + cluster + identity in one model", "Confirmed vs. theoretical reachability", "Click any edge to see the evidence"], preview: <PreviewGraph /> },
  { code: "ISSUES", tone: "red", title: "Runtime-informed issues", blurb: "Not thousands of CVEs — the handful that are internet-reachable, running and exploitable, proven with observed network and runtime evidence.", points: ["Toxic-combination detection", "Reachability from real network flows", "Prioritized by exposure, not just CVSS"], preview: <PreviewIssues /> },
  { code: "CIEM", tone: "violet", title: "Effective permissions", blurb: "Resolve a workload's effective RBAC and follow its IRSA role into AWS — can this pod read Secrets, or delete an S3 bucket?", points: ["In-cluster RBAC solver", "IRSA → IAM reach into AWS", "Flags: secrets, exec, escalate, aws-write"], preview: <PreviewCiem /> },
  { code: "TRENDS", tone: "green", title: "Posture trends & scorecard", blurb: "A per-customer security score over time with regression detection and a resell-ready export — the report an MSP hands over.", points: ["Score per customer over time", "Automatic regression detection", "Exportable MSP scorecard"], preview: <PreviewTrends /> },
  { code: "DRIFT", tone: "orange", title: "Drift & new-CVE detection", blurb: "Catch a workload that drifted from its admitted spec, or an image that gained a vulnerability since the last scan.", points: ["Live spec vs. admitted spec diff", "New-CVE delta between scans", "Severity-ranked, cited to the change"], preview: <PreviewDrift /> },
  { code: "FIX", tone: "teal", title: "Guided remediation", blurb: "Generate the exact Kyverno policy or kubectl patch that fixes an issue — a reviewed suggestion, never an automatic change.", points: ["Kyverno policy or kubectl patch", "Scoped to the specific finding", "You review and apply — never auto"], preview: <PreviewFix /> },
  { code: "RUNTIME", tone: "red", title: "Runtime detection", blurb: "Signed, replay-resistant Falco events with Kubernetes context, human-confirmed cases and durable notification delivery.", points: ["Signed, replay-resistant events", "Full pod and workload context", "Human-confirmed cases + alerting"], preview: <PreviewRuntime /> },
  { code: "COMPLY", tone: "green", title: "Readiness mappings", blurb: "CIS Kubernetes, NSA/CISA and SOC 2 readiness mapped to cited evidence — a readiness view, never a certification claim.", points: ["CIS, NSA/CISA, SOC 2 mappings", "Every control cited to evidence", "Honest readiness, not a pass stamp"], preview: <PreviewComply /> },
];

export function CapabilityExplorer(): ReactNode {
  const [active, setActive] = useState(0);
  return (
    <div className="cap-ex">
      <div className="cap-ex-rail" role="tablist" aria-label="Sutra capabilities">
        {CAPABILITIES.map((c, i) => (
          <div key={c.code} className={`cap-ex-item cap-tone-${c.tone}${i === active ? " is-active" : ""}`}>
            <button type="button" role="tab" id={`capex-tab-${i}`} aria-selected={i === active} aria-controls={`capex-panel-${i}`} className="cap-ex-head" onClick={() => setActive(i)}>
              <span className="cap-ex-ic"><Glyph name={c.code} /></span>
              <span className="cap-ex-ti"><strong>{c.title}</strong><em>{c.code}</em></span>
              <span className="cap-ex-chev" aria-hidden="true" />
            </button>
            {i === active ? (
              <div className="cap-ex-body">
                <p>{c.blurb}</p>
                <ul>{c.points.map((p) => <li key={p}>{p}</li>)}</ul>
                <Link href="/dashboard">Explore in the live demo →</Link>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="cap-ex-stage">
        {CAPABILITIES.map((c, i) => (
          <div key={c.code} id={`capex-panel-${i}`} role="tabpanel" aria-labelledby={`capex-tab-${i}`} aria-hidden={i !== active} className={`cap-ex-preview${i === active ? " is-active" : ""}`}>
            {c.preview}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================================================================== *
 * 2) Interactive correlation graph (replaces the static orbit)
 * ================================================================== */

interface OrbitNode { readonly id: string; readonly label: string; readonly sub: string; readonly detail: string; readonly cls: string; readonly line: string; }

const ORBIT_NODES: readonly OrbitNode[] = [
  { id: "cspm", label: "CSPM", sub: "Configuration posture", detail: "Misconfigurations across every AWS account and EKS cluster — each mapped to the exact assets it exposes, not a floating checklist.", cls: "orbit-north", line: "orbit-line-1" },
  { id: "iam", label: "IAM", sub: "Identity hygiene", detail: "Over-permissioned roles, unused access and the IRSA links that let a pod assume an AWS role — resolved to what each identity can actually reach.", cls: "orbit-east", line: "orbit-line-2" },
  { id: "evidence", label: "EVIDENCE", sub: "Audit & compliance", detail: "Every finding is traced to the observation that proves it — the flow, the scan, the spec — so a customer report is defensible, not a claim.", cls: "orbit-south", line: "orbit-line-3" },
  { id: "finops", label: "FINOPS", sub: "Cost signals · planned", detail: "Spend attributed to the same normalized asset graph, so cost sits beside risk on one object. Planned for a later release.", cls: "orbit-west", line: "orbit-line-4" },
];

const CMDB_DETAIL = "The normalized asset graph at the center: every AWS and Kubernetes resource, deduplicated, linked, and owned by a customer. Every other layer hangs off it — hover a node to see how.";

export function CorrelationGraph(): ReactNode {
  const [active, setActive] = useState("cmdb");
  const current = ORBIT_NODES.find((n) => n.id === active);
  return (
    <div className="platform-orbit is-interactive" data-active={active}>
      <button type="button" className={`orbit-node orbit-cmdb${active === "cmdb" ? " is-active" : ""}`} onMouseEnter={() => setActive("cmdb")} onFocus={() => setActive("cmdb")} onClick={() => setActive("cmdb")} aria-label="CMDB — normalized asset graph">
        <b>CMDB</b><span>Normalized asset graph</span>
      </button>
      {ORBIT_NODES.map((n) => (
        <span key={`${n.line}-wrap`} className={`orbit-line ${n.line}${active === n.id ? " is-active" : ""}`} aria-hidden="true" />
      ))}
      {ORBIT_NODES.map((n) => (
        <button type="button" key={n.id} className={`orbit-node ${n.cls}${active === n.id ? " is-active" : ""}`} onMouseEnter={() => setActive(n.id)} onFocus={() => setActive(n.id)} onClick={() => setActive(n.id)} aria-label={`${n.label} — ${n.sub}`}>
          <b>{n.label}</b><span>{n.sub}</span>
        </button>
      ))}
      <span className="orbit-customer orbit-customer-1">Customer 01</span>
      <span className="orbit-customer orbit-customer-2">Customer 02</span>
      <span className="orbit-customer orbit-customer-3">Customer 03</span>
      <div className="orbit-detail" role="status" aria-live="polite">
        <strong>{current ? current.label : "CMDB"}</strong>
        <p>{current ? current.detail : CMDB_DETAIL}</p>
      </div>
    </div>
  );
}

/* ================================================================== *
 * 3) Interactive trust panel (tabs over the assume-role model)
 * ================================================================== */

const TRUST_POLICY = [
  "Principal:",
  "  AWS: arn:aws:iam::VENDOR:role/SutraCollector",
  "Action: sts:AssumeRole",
  "Condition:",
  "  StringEquals:",
  "    sts:ExternalId: psd_<unique-128-bit-value>",
  "  StringLike:",
  "    sts:RoleSessionName: sutra-*",
  "",
  "# No resource mutation",
  "# No object, secret, or database payload reads",
  "# Maximum one-hour temporary session",
].join("\n");

const TRUST_READS = [
  "ec2:Describe* — networking, security groups, ENIs",
  "eks:Describe*, eks:List* — clusters and node groups",
  "iam:Get*, iam:List* — roles, policies, attachments",
  "s3:GetBucketPolicy, s3:GetBucketAcl — config only",
  "guardduty / securityhub / inspector — native findings",
];

const TRUST_NEVER = [
  "s3:GetObject — never reads object payloads",
  "secretsmanager:GetSecretValue — never reads secrets",
  "rds / dynamodb data APIs — never reads database rows",
  "any Create / Update / Delete — never mutates a resource",
  "long-lived keys — sessions expire in one hour",
];

export function TrustPanel(): ReactNode {
  const [tab, setTab] = useState<"policy" | "reads" | "never">("policy");
  return (
    <div className="trust-panel">
      <div className="trust-tabs" role="tablist" aria-label="Trust model">
        <button type="button" role="tab" aria-selected={tab === "policy"} className={tab === "policy" ? "is-active" : ""} onClick={() => setTab("policy")}>Assume-role policy</button>
        <button type="button" role="tab" aria-selected={tab === "reads"} className={tab === "reads" ? "is-active" : ""} onClick={() => setTab("reads")}>What Sutra reads</button>
        <button type="button" role="tab" aria-selected={tab === "never"} className={tab === "never" ? "is-active" : ""} onClick={() => setTab("never")}>Never touched</button>
      </div>
      {tab === "policy" ? (
        <div className="trust-policy-card" role="tabpanel">
          <div><span>customer-role.yaml</span><b>READ ONLY</b></div>
          <pre><code>{TRUST_POLICY}</code></pre>
          <p><span>✓</span> Customer can revoke access by deleting the role.</p>
        </div>
      ) : (
        <div className="trust-list-card" role="tabpanel">
          <div><span>{tab === "reads" ? "metadata-only.txt" : "never-touched.txt"}</span><b className={tab === "reads" ? "" : "is-deny"}>{tab === "reads" ? "READ ONLY" : "DENIED"}</b></div>
          <ul className={tab === "never" ? "is-deny" : undefined}>
            {(tab === "reads" ? TRUST_READS : TRUST_NEVER).map((item) => (
              <li key={item}><i aria-hidden="true">{tab === "reads" ? "✓" : "✗"}</i><span>{item}</span></li>
            ))}
          </ul>
          <p><span>{tab === "reads" ? "✓" : "✗"}</span>{tab === "reads" ? "Metadata and configuration only — scoped per collector pack." : "Enforced by the permission pack — not policy, capability."}</p>
        </div>
      )}
    </div>
  );
}

/* ================================================================== *
 * 4) Live hero dashboard — switch views, drill into an issue
 * ================================================================== */

const HERO_NAV = [
  { id: "overview", label: "Overview", glyph: (<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>) },
  { id: "issues", label: "Issues", glyph: (<><path d="M12 3 22 20H2z" /><path d="M12 10v5M12 18h.01" /></>) },
  { id: "customers", label: "Customers", glyph: (<><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 6.4a3.2 3.2 0 0 1 0 6.1M20.5 20a5.6 5.6 0 0 0-4.2-5.4" /></>) },
] as const;

type HeroView = "overview" | "issues" | "customers";

function HeroOverview(): ReactNode {
  return (
    <>
      <div className="product-topline"><div><small>MSP portfolio</small><strong>Good morning, Alex.</strong></div><span>All customers⌄</span></div>
      <div className="product-metrics"><article><small>Portfolio posture</small><strong>82<em>/100</em></strong><i><b style={{ width: "82%" }} /></i></article><article><small>Managed assets</small><strong>2,427</strong><span>+96 this week</span></article><article><small>Open findings</small><strong>46</strong><span className="risk-text">3 critical</span></article></div>
      <div className="product-middle">
        <article className="mini-chart"><div><small>Risk trend</small><strong>45 fewer findings</strong></div><div className="mini-bars">{[88, 82, 76, 70, 64, 60, 53, 47, 40, 34, 29, 23].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div></article>
        <article className="mini-coverage"><small>Customer posture</small>{([["Northstar", 62], ["Bluepeak", 78], ["Harbor", 86], ["Evergreen", 91]] as const).map(([name, value]) => <div key={name}><span>{name}</span><i><b style={{ width: `${value}%` }} /></i><strong>{value}</strong></div>)}</article>
      </div>
      <div className="product-queue"><div><small>Priority issues</small><span>Customer</span><span>Severity</span></div>{([["Internet-reachable critical CVE", "Northstar", "Critical"], ["Privileged workload reachable", "Northstar", "High"], ["ServiceAccount can delete S3", "Bluepeak", "High"]] as const).map((row) => <div key={row[0]}><strong>{row[0]}</strong><span>{row[1]}</span><b className={`queue-${row[2].toLowerCase()}`}>{row[2]}</b></div>)}</div>
    </>
  );
}

const HERO_ISSUES = [
  { t: "Internet-reachable critical CVE", c: "Northstar", s: "Critical", chain: "Internet → api-gateway (CVE-2024-3094) → payments-sa → s3://billing" },
  { t: "Privileged workload reachable", c: "Northstar", s: "High", chain: "ingress → batch-runner (privileged: true, hostPID)" },
  { t: "ServiceAccount can delete S3", c: "Bluepeak", s: "High", chain: "payments-sa → PaymentsRole → s3:DeleteObject on billing/*" },
  { t: "Public RDS snapshot exposure", c: "Harbor", s: "Medium", chain: "rds:DescribeDBSnapshots → snapshot shared to all accounts" },
] as const;

function HeroIssues(): ReactNode {
  const [sel, setSel] = useState(0);
  return (
    <>
      <div className="product-topline"><div><small>Priority issues</small><strong>46 open · 3 critical</strong></div><span>Severity⌄</span></div>
      <div className="hero-issues">
        {HERO_ISSUES.map((r, i) => (
          <button type="button" key={r.t} className={`hero-issue${sel === i ? " is-sel" : ""}`} onClick={() => setSel(i)} aria-pressed={sel === i}>
            <b className={`queue-${r.s.toLowerCase()}`}>{r.s}</b>
            <span className="hero-issue-t">{r.t}</span>
            <span className="hero-issue-c">{r.c}</span>
          </button>
        ))}
      </div>
      <div className="hero-evidence"><small>Evidence · reachable path</small><p>{HERO_ISSUES[sel].chain}</p></div>
    </>
  );
}

function HeroCustomers(): ReactNode {
  const rows = [["Northstar", 62, "At risk"], ["Bluepeak", 78, "Watch"], ["Harbor", 86, "Healthy"], ["Evergreen", 91, "Healthy"]] as const;
  return (
    <>
      <div className="product-topline"><div><small>Customer posture</small><strong>4 managed customers</strong></div><span>This quarter⌄</span></div>
      <div className="hero-custs">
        {rows.map(([name, value, status]) => (
          <div key={name} className="hero-cust">
            <span className="hero-cust-n">{name}</span>
            <i><b style={{ width: `${value}%` }} className={value < 70 ? "is-risk" : value < 85 ? "is-watch" : "is-ok"} /></i>
            <b className={`msp-${status.replace(" ", "-").toLowerCase()}`}>{status}</b>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="hero-evidence"><small>Scope</small><p>Each customer user sees only their own workspace; the MSP sees the roll-up.</p></div>
    </>
  );
}

export function HeroDashboard(): ReactNode {
  const [view, setView] = useState<HeroView>("overview");
  return (
    <div className="hero-product hero-live" aria-label="Sutra portfolio dashboard — interactive preview">
      <div className="product-window-bar"><div><i /><i /><i /></div><span>portfolio.sutra.cloud</span><b>LIVE DEMO</b></div>
      <div className="product-window-body">
        <aside className="product-rail">
          <span className="product-logo">P</span>
          {HERO_NAV.map((n) => (
            <button type="button" key={n.id} className={`product-nav${view === n.id ? " active" : ""}`} onClick={() => setView(n.id as HeroView)} aria-pressed={view === n.id} aria-label={n.label}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{n.glyph}</svg>
            </button>
          ))}
          <span className="product-user">AM</span>
        </aside>
        <div className="product-canvas">
          {view === "overview" ? <HeroOverview /> : view === "issues" ? <HeroIssues /> : <HeroCustomers />}
        </div>
      </div>
    </div>
  );
}

/* ================================================================== *
 * 5) MSP showcase — real, switchable tab views
 * ================================================================== */

function MspPortfolio(): ReactNode {
  return (
    <div className="msp-view">
      <aside><small>Portfolio posture</small><strong>82</strong><span>↑ 8 points this quarter</span><div className="msp-ring"><i /></div></aside>
      <div className="msp-customer-list">{([["Northstar Retail", "At risk", 62], ["Bluepeak Health", "Watch", 78], ["Harbor Analytics", "Healthy", 86], ["Evergreen Finance", "Healthy", 91]] as const).map(([name, status, score]) => <article key={name}><span>{name.slice(0, 2).toUpperCase()}</span><div><strong>{name}</strong><small>Customer workspace · {score > 80 ? "fresh" : "review"}</small></div><b className={`msp-${status.replace(" ", "-").toLowerCase()}`}>{status}</b><em>{score}/100</em></article>)}</div>
      <div className="msp-insight"><span>Today’s focus</span><strong>3 customer-impacting risks</strong><p>Prioritized using severity, exposure and asset context—never hidden behind an unexplained score.</p><Link href="/findings">Open analyst queue →</Link></div>
    </div>
  );
}

function MspCustomer(): ReactNode {
  return (
    <div className="msp-view">
      <aside><small>Northstar Retail</small><strong>62</strong><span className="is-risk">At risk · review</span><div className="msp-ring"><i /></div></aside>
      <div className="msp-customer-list msp-issue-list">{([["Critical", "Internet-reachable critical CVE", "api-gateway"], ["High", "Privileged workload reachable", "batch-runner"], ["High", "SA can delete production S3", "payments-sa"], ["Medium", "Drifted from admitted spec", "payments-api"]] as const).map(([sev, title, asset]) => <article key={title}><b className={`queue-${sev.toLowerCase()}`}>{sev}</b><div><strong>{title}</strong><small>{asset}</small></div></article>)}</div>
      <div className="msp-insight"><span>Top fix</span><strong>Patch api-gateway</strong><p>Removes the internet-reachable critical CVE and breaks the path to s3://billing.</p><Link href="/dashboard">Open remediation →</Link></div>
    </div>
  );
}

function MspAnalyst(): ReactNode {
  const rows = [
    ["Critical", "Internet-reachable critical CVE", "Northstar", "Triage", "AM"],
    ["High", "Privileged workload reachable", "Northstar", "In review", "RK"],
    ["High", "ServiceAccount can delete S3", "Bluepeak", "Assigned", "JT"],
    ["Medium", "Public RDS snapshot exposure", "Harbor", "Open", "—"],
  ] as const;
  return (
    <div className="msp-panel msp-queue">
      <div className="msp-queue-row msp-queue-head"><span>Severity</span><span>Issue</span><span>Customer</span><span>Status</span><span>Owner</span></div>
      {rows.map(([sev, issue, cust, status, owner]) => (
        <div key={issue} className="msp-queue-row"><b className={`queue-${sev.toLowerCase()}`}>{sev}</b><span className="msp-queue-issue">{issue}</span><span>{cust}</span><em className="msp-status">{status}</em><span className="msp-owner">{owner}</span></div>
      ))}
    </div>
  );
}

function MspAudit(): ReactNode {
  const log = [
    ["09:58", "collector", "assumed customer role via STS (1h session)", "Northstar"],
    ["09:59", "collector", "completed bounded discovery — 812 assets", "Northstar"],
    ["10:02", "system", "promoted scan — 3 new issues, 1 resolved", "Northstar"],
    ["10:04", "alex@msp", "confirmed runtime case: shell in container", "payments-api"],
    ["10:05", "system", "delivered signed alert to Slack + PagerDuty", "Northstar"],
  ] as const;
  return (
    <div className="msp-panel msp-audit">
      {log.map(([time, actor, action, target]) => (
        <div key={time + action} className="msp-audit-row"><code>{time}</code><span><b>{actor}</b> {action}</span><em>{target}</em></div>
      ))}
    </div>
  );
}

const MSP_TABS = [["portfolio", "MSP portfolio"], ["customer", "Customer workspace"], ["analyst", "Analyst queue"], ["audit", "Audit view"]] as const;
type MspTab = "portfolio" | "customer" | "analyst" | "audit";

export function MspShowcase(): ReactNode {
  const [tab, setTab] = useState<MspTab>("portfolio");
  return (
    <div className="msp-showcase">
      <div className="msp-tabs" role="tablist" aria-label="MSP views">
        {MSP_TABS.map(([id, label]) => (
          <button type="button" key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id as MspTab)}>{label}</button>
        ))}
      </div>
      {tab === "portfolio" ? <MspPortfolio /> : tab === "customer" ? <MspCustomer /> : tab === "analyst" ? <MspAnalyst /> : <MspAudit />}
    </div>
  );
}
