import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { OperationsBrowser } from "./operations-browser";

export const metadata: Metadata = { title: "Simulation runs" };

export default function OperationsPage() {
  return <AppShell active="operations"><OperationsBrowser /></AppShell>;
}
