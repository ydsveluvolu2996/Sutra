import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { SettingsBrowser } from "./settings-browser";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return <AppShell active="settings"><SettingsBrowser /></AppShell>;
}
