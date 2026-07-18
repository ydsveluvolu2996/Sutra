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
  const edges = [["net", "ing"], ["ing", "pod"], ["pod", "sa"], ["pod", "role"], ["role", "s3"]] as const;
  const pos = (id: string) => nodes.find((n) => n.id === id)!;
  return (
    <div className="pv pv-graph">
      <div className="pv-head"><span>Security graph</span><b className="pv-tag pv-tag-red">attack path · confirmed</b></div>
      <div className="pv-graph-canvas">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pv-graph-edges" aria-hidden="true">
          {edges.map(([a, b]) => {
            const pa = pos(a); const pb = pos(b);
            return <line key={`${a}-${b}`} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} className="pv-edge" />;
          })}
          <line x1={pos("net").x} y1={pos("net").y} x2={pos("ing").x} y2={pos("ing").y} className="pv-edge pv-edge-hot" />
          <line x1={pos("ing").x} y1={pos("ing").y} x2={pos("pod").x} y2={pos("pod").y} className="pv-edge pv-edge-hot" />
          <line x1={pos("pod").x} y1={pos("pod").y} x2={pos("role").x} y2={pos("role").y} className="pv-edge pv-edge-hot" />
          <line x1={pos("role").x} y1={pos("role").y} x2={pos("s3").x} y2={pos("s3").y} className="pv-edge pv-edge-hot" />
        </svg>
        {nodes.map((n) => (
          <span key={n.id} className={`pv-node pv-node-${n.kind}`} style={{ left: `${n.x}%`, top: `${n.y}%` }}>{n.label}</span>
        ))}
      </div>
      <div className="pv-foot"><b>Reachable:</b> Internet → api-gateway (CVE-2024-3094, running) → payments-sa → PaymentsRole → s3://billing</div>
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
      <button type="button" className={`orbit-node orbit-cmdb${active === "cmdb" ? " is-active" : ""}`} onMouseEnter={() => setActive("cmdb")} onFocus={() => setActive("cmdb")} aria-label="CMDB — normalized asset graph">
        <b>CMDB</b><span>Normalized asset graph</span>
      </button>
      {ORBIT_NODES.map((n) => (
        <span key={`${n.line}-wrap`} className={`orbit-line ${n.line}${active === n.id ? " is-active" : ""}`} aria-hidden="true" />
      ))}
      {ORBIT_NODES.map((n) => (
        <button type="button" key={n.id} className={`orbit-node ${n.cls}${active === n.id ? " is-active" : ""}`} onMouseEnter={() => setActive(n.id)} onFocus={() => setActive(n.id)} aria-label={`${n.label} — ${n.sub}`}>
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
