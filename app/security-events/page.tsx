import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { SecurityEventsBrowser } from "./security-events-browser";

export const metadata: Metadata = { title: "Security Events Lite" };

export default function SecurityEventsPage() {
  return (
    <AppShell active="security_events">
      <SecurityEventsBrowser />
    </AppShell>
  );
}
