import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { ConnectionHealth } from "./connection-health";

export const metadata: Metadata = { title: "Connection health" };

export default function ConnectionHealthPage() {
  return (
    <AppShell active="connection_health">
      <ConnectionHealth />
    </AppShell>
  );
}
