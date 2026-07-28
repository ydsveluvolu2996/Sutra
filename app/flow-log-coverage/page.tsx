import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { FlowLogCoveragePanel } from "./flow-log-coverage-panel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "VPC flow-log coverage" };

export default function FlowLogCoveragePage() {
  return (
    <AppShell active="flow_log_coverage">
      <FlowLogCoveragePanel />
    </AppShell>
  );
}
