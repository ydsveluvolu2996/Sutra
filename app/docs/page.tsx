import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { DocsBrowser } from "./docs-browser";

export const metadata: Metadata = { title: "Documentation" };

// The help center is fully static, in-repo content — no data fetch, so the page
// renders statically. AppShell handles the client-side session/MFA gate and the
// account menu owns the real Documentation destination and icon.
export default function DocsPage() {
  return (
    <AppShell active="docs">
      <DocsBrowser />
    </AppShell>
  );
}
