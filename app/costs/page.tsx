import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { CostsBrowser } from "./costs-browser";

export const metadata: Metadata = { title: "AWS Cost & FinOps" };

export default function CostsPage() {
  return (
    <AppShell active="costs">
      <CostsBrowser />
    </AppShell>
  );
}
