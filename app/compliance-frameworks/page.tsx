import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { ComplianceFrameworksBrowser } from "./compliance-frameworks-browser";

export const metadata: Metadata = { title: "Compliance frameworks" };

export default function ComplianceFrameworksPage() {
  return (
    <AppShell active="compliance_frameworks">
      <ComplianceFrameworksBrowser />
    </AppShell>
  );
}
