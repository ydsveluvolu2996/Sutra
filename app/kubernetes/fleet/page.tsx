import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { FleetHealthWorkspace } from "./fleet-health-workspace";

export const metadata: Metadata = { title: "Kubernetes Fleet Health" };

export default function KubernetesFleetPage() {
  return <AppShell active="kubernetes_fleet"><FleetHealthWorkspace /></AppShell>;
}
