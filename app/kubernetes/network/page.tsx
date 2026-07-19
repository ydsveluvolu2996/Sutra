import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { NetworkVisibility } from "./network-visibility";

export const metadata: Metadata = { title: "Kubernetes Network Visibility" };
export default function KubernetesNetworkPage() {
  return <AppShell active="kubernetes_network"><NetworkVisibility /></AppShell>;
}
