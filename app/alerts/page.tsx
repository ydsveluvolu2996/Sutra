import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { AlertsPanel } from "./alerts-panel";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Metric alerts" };

export default function AlertsPage() {
  return (
    <AppShell active="alerts">
      <AlertsPanel />
    </AppShell>
  );
}
