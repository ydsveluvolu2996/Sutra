import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { InventoryBrowser } from "./inventory-browser";

export const metadata: Metadata = { title: "CMDB inventory" };

export default function CmdbPage() {
  return <AppShell active="cmdb"><InventoryBrowser /></AppShell>;
}
