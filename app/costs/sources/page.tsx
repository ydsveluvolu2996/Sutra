import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { FinopsSourceCoverage } from "./finops-source-coverage";

export const metadata: Metadata = { title: "FinOps data sources" };

/**
 * The FinOps source contract lives in the FinOps section, not on the onboarding
 * screen it used to be appended to.
 *
 * It was mounted under `app/onboard/page.tsx`, so the page an operator reached
 * to register one AWS role also rendered the entire 29-dashboard catalog with
 * every source's exact reads and permission pack. Worse, "Connection health"
 * links into that same page by anchor, so a reader looking for one connection's
 * state was handed the onboarding form and the FinOps catalog as well.
 *
 * Nothing about the contract itself changed: it is still server-rendered, still
 * derived from the pinned catalog, and still refuses to read as health -- a
 * granted permission is not an observed delivery.
 */
export default function FinopsSourcesPage() {
  return (
    <AppShell active="finops_sources">
      <FinopsSourceCoverage />
    </AppShell>
  );
}
