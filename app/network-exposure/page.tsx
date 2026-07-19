import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { NetworkExposureBrowser } from "./network-exposure-browser";

export const metadata: Metadata = { title: "Network exposure" };

export default function NetworkExposurePage() {
  return (
    <AppShell active="network_exposure">
      <NetworkExposureBrowser />
    </AppShell>
  );
}
