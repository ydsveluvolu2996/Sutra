import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { CustomAssetsPanel } from "../custom-assets-panel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Custom assets" };

export default function CmdbCustomAssetsPage() {
  return (
    <AppShell active="cmdb_assets">
      <CustomAssetsPanel />
    </AppShell>
  );
}
