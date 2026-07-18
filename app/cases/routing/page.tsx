import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { CaseRoutingWorkspace } from "./routing-workspace";

export const metadata: Metadata = { title: "Case routing rules" };

export default function CaseRoutingPage() {
  return (
    <AppShell active="cases_routing">
      <CaseRoutingWorkspace />
    </AppShell>
  );
}
