import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { ShowbackPanel } from "../showback-panel";

export const metadata: Metadata = { title: "Per-customer showback" };

export default function ShowbackPage() {
  return (
    <AppShell active="showback">
      <ShowbackPanel />
    </AppShell>
  );
}
