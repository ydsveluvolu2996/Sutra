import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { ResourceBrowser } from "./resource-browser";

export const metadata: Metadata = { title: "Resource 360" };

export default function ResourcePage() {
  return <AppShell active="cmdb"><ResourceBrowser /></AppShell>;
}
