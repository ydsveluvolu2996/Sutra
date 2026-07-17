import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { AccessBrowser } from "./access-browser";

export const metadata: Metadata = { title: "Access & Invitations" };

export default function AccessPage() {
  return <AppShell active="access"><AccessBrowser /></AppShell>;
}
