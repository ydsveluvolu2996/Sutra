import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { IssuesWorkspace } from "./issues-workspace";

export const metadata: Metadata = { title: "Kubernetes Issues" };

export default function KubernetesIssuesPage() {
  return <AppShell active="kubernetes_issues"><IssuesWorkspace /></AppShell>;
}
