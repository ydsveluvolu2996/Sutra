import type { Metadata } from "next";

import LegalShell from "../components/legal-shell";

export const metadata: Metadata = {
  title: "Status",
  description: "Sutra system status — a lightweight operational view of the app, API, collector and database components.",
};

const COMPONENTS: Array<{ name: string; detail: string }> = [
  { name: "Application", detail: "Web control plane and dashboards" },
  { name: "API", detail: "Public REST API — /api/public/v1" },
  { name: "Collector", detail: "Agentless AWS + EKS collection plane" },
  { name: "Database", detail: "Evidence store and query layer" },
];

export default function StatusPage() {
  return (
    <LegalShell
      kicker="System Status"
      title={<>All systems <span className="accent">operational.</span></>}
      lead="A lightweight view of Sutra's core components. This is not a full observability dashboard — it is a simple, honest status summary."
    >
      <div className="lx-status-banner ok" role="status">
        <span className="lx-status-dot" aria-hidden="true" />
        <div>
          <b>All systems operational</b>
          <em>No active incidents across monitored components.</em>
        </div>
      </div>

      <section className="lx-legal-section">
        <h2>Components</h2>
        <div className="lx-status-list">
          {COMPONENTS.map((component) => (
            <div key={component.name} className="lx-status-row">
              <div className="lx-status-name">
                <b>{component.name}</b>
                <em>{component.detail}</em>
              </div>
              <span className="lx-status-pill ok">
                <span className="lx-status-dot" aria-hidden="true" /> Operational
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="lx-legal-section">
        <h2>Incident history</h2>
        <div className="lx-status-empty">No incidents reported.</div>
      </section>

      <p className="lx-legal-note">
        <em>
          This status page is a lightweight summary, not a measured service-level agreement. Any availability
          figure shown elsewhere is illustrative unless explicitly presented as a contractual SLA. For
          incident-specific questions, reach us through the <a href="/contact">contact page</a>.
        </em>
      </p>
    </LegalShell>
  );
}
