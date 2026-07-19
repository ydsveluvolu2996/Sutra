import type { Metadata } from "next";
import { AppShell } from "../../../components/app-shell";
import { Workload360 } from "../workload-360";

export const metadata: Metadata = { title: "Kubernetes Workload 360" };

export default async function KubernetesWorkloadPage({
  params,
}: {
  readonly params: Promise<{ readonly resourceKey: string }>;
}) {
  return <AppShell active="kubernetes_workloads"><Workload360 resourceKey={(await params).resourceKey} /></AppShell>;
}
