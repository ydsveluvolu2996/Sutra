import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { CustomersBrowser } from "./customers-browser";

export const metadata: Metadata = { title: "MSP Command Center" };

export default function CustomersPage() {
  return <AppShell active="customers"><CustomersBrowser /></AppShell>;
}
