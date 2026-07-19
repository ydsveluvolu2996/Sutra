import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { TrendsWorkspace } from "./trends-workspace";

export const metadata: Metadata = { title: "Kubernetes Posture Trends" };

export default function KubernetesTrendsPage() {
  return <AppShell active="kubernetes_trends"><TrendsWorkspace /></AppShell>;
}
