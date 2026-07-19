import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { PermissionsWorkspace } from "./permissions-workspace";

export const metadata: Metadata = { title: "Kubernetes Effective Permissions" };

export default function KubernetesPermissionsPage() {
  return <AppShell active="kubernetes_permissions"><PermissionsWorkspace /></AppShell>;
}
