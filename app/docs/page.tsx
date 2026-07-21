import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { DocsBrowser } from "./docs-browser";

export const metadata: Metadata = { title: "Documentation" };

// The help center is fully static, in-repo content — no data fetch, so the page
// renders statically. AppShell handles the client-side session/MFA gate. The
// `active` NavKey is a placeholder ("settings") until the parent adds a real
// "docs" nav entry; swap to active="docs" once the NavKey exists.
export default function DocsPage() {
  return (
    <AppShell active="docs">
      <DocsBrowser />
    </AppShell>
  );
}
