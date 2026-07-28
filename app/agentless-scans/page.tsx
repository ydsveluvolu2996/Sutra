import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { AgentlessScansPanel } from "./agentless-scans-panel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Agentless snapshot scanning" };

export default function AgentlessScansPage() {
  return (
    <AppShell active="agentless_scans">
      <AgentlessScansPanel />
    </AppShell>
  );
}
