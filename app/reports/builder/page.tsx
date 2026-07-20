import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { ReportBuilder } from "../report-builder";

export const metadata: Metadata = { title: "Custom report builder" };

export default function ReportBuilderPage() {
  return <AppShell active="report_builder"><ReportBuilder /></AppShell>;
}
