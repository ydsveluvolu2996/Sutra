import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { KubernetesWorkspace } from "../kubernetes-workspace";

export const metadata: Metadata = { title: "Kubernetes Security" };

export default function KubernetesSecurityPage() {
  return <AppShell active="kubernetes_security"><KubernetesWorkspace view="security" /></AppShell>;
}
