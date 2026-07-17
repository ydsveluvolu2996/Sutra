import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { VulnerabilityExposureBrowser } from "./vulnerability-exposure-browser";

export const metadata: Metadata = { title: "Vulnerability & exposure" };

export default function VulnerabilitiesPage() {
  return <AppShell active="vulnerabilities"><VulnerabilityExposureBrowser /></AppShell>;
}
