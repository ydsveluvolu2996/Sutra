import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { CasesBrowser } from "./cases-browser";

export const metadata: Metadata = { title: "Finding cases" };

export default function CasesPage() {
  return <AppShell active="cases"><CasesBrowser /></AppShell>;
}
