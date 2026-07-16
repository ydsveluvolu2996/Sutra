import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { ChangesBrowser } from "./changes-browser";

export const metadata: Metadata = { title: "CMDB changes" };

export default function ChangesPage() {
  return <AppShell active="changes"><ChangesBrowser /></AppShell>;
}
