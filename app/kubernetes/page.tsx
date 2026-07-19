import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { KubernetesWorkspace } from "./kubernetes-workspace";

export const metadata: Metadata = { title: "Kubernetes Overview" };

export default function KubernetesPage() {
  return <AppShell active="kubernetes_overview"><KubernetesWorkspace view="overview" /></AppShell>;
}
