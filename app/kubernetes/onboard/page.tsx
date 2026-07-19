import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { KubernetesOnboarding } from "../kubernetes-onboarding";

export const metadata: Metadata = { title: "Onboard Kubernetes" };

export default function KubernetesOnboardPage() {
  return <AppShell active="kubernetes_onboard"><KubernetesOnboarding /></AppShell>;
}
