import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { KubernetesWorkspace } from "../kubernetes-workspace";

export const metadata: Metadata = { title: "Kubernetes Inventory" };

export default function KubernetesInventoryPage() {
  return <AppShell active="kubernetes_inventory"><KubernetesWorkspace view="inventory" /></AppShell>;
}
