import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { RegistryInventoryBrowser } from "./registry-inventory-browser";

export const metadata: Metadata = { title: "Registry inventory" };

export default function RegistryInventoryPage() {
  return (
    <AppShell active="registry_inventory">
      <RegistryInventoryBrowser />
    </AppShell>
  );
}
