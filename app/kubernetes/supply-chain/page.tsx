import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { SupplyChainWorkspace } from "./supply-chain-workspace";

export const metadata: Metadata = { title: "Kubernetes Supply Chain" };

export default function KubernetesSupplyChainPage() {
  return <AppShell active="kubernetes_supply_chain"><SupplyChainWorkspace /></AppShell>;
}
