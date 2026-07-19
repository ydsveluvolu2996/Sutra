import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { IacScanWorkspace } from "./iac-scan-workspace";

export const metadata: Metadata = { title: "IaC misconfiguration scan" };

export default function IacScanPage() {
  return (
    <AppShell active="iac_scan">
      <IacScanWorkspace />
    </AppShell>
  );
}
