import type { Metadata } from "next";

import LegalShell from "../components/legal-shell";
import StatusClient from "./status-client";

export const metadata: Metadata = {
  title: "Status",
  description: "Sutra system status — live, measured health of the app, database, background jobs and collector, with uptime history.",
};

export default function StatusPage() {
  return (
    <LegalShell
      kicker="System Status"
      title={<>Measured <span className="accent">system health.</span></>}
      lead="A live view of Sutra's core components, derived from recorded health probes. It is an honest operational summary, not a full observability dashboard — anything we have not observed recently is shown as unknown rather than assumed healthy."
    >
      <StatusClient />
    </LegalShell>
  );
}
