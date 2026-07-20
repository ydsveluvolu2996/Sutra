import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { DependenciesPanel } from "../dependencies-panel";

export const metadata: Metadata = { title: "CMDB dependency graph" };
export const dynamic = "force-dynamic";

export default function CmdbDependenciesPage() {
  return (
    <AppShell active="cmdb_dependencies">
      <DependenciesPanel />
    </AppShell>
  );
}
