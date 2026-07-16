import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { ComplianceBrowser } from "./compliance-browser";

export const metadata: Metadata = { title: "Compliance posture" };

export default function CompliancePage() {
  return (
    <AppShell active="compliance">
      <ComplianceBrowser />
    </AppShell>
  );
}
