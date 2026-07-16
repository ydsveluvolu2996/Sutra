import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { ExecutiveReportBrowser } from "./executive-report-browser";

export const metadata: Metadata = { title: "Executive report" };

export default function ReportsPage() {
  return <AppShell active="reports"><ExecutiveReportBrowser /></AppShell>;
}
