import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { DriftWorkspace } from "./drift-workspace";

export const metadata: Metadata = { title: "Kubernetes Drift" };

export default function KubernetesDriftPage() {
  return <AppShell active="kubernetes_drift"><DriftWorkspace /></AppShell>;
}
