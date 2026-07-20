import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { PatchPanel } from "./patch-panel";

export const metadata: Metadata = { title: "Patch management" };

export default function PatchManagementPage() {
  return (
    <AppShell active="patch">
      <PatchPanel />
    </AppShell>
  );
}
