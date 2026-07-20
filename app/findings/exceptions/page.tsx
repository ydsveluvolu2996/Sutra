import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { FindingExceptionsWorkspace } from "./exceptions-workspace";

export const metadata: Metadata = { title: "Finding exceptions" };

export default function FindingExceptionsPage() {
  return (
    <AppShell active="findings_exceptions">
      <FindingExceptionsWorkspace />
    </AppShell>
  );
}
