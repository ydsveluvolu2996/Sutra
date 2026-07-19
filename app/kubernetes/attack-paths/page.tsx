import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { AttackPathsWorkspace } from "./attack-paths-workspace";

export const metadata: Metadata = { title: "Kubernetes Attack Paths" };

export default function KubernetesAttackPathsPage() {
  return <AppShell active="kubernetes_attack_paths"><AttackPathsWorkspace /></AppShell>;
}
