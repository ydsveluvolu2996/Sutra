import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { FindingsBrowser } from "./findings-browser";

export const metadata: Metadata = { title: "Security findings" };

export default function FindingsPage() {
  return <AppShell active="findings"><FindingsBrowser /></AppShell>;
}
