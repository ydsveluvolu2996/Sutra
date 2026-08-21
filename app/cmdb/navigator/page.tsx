import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { AwsNavigatorBrowser } from "./aws-navigator-browser";

export const metadata: Metadata = { title: "AWS Navigator" };

export default async function AwsNavigatorPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const query = await searchParams;
  return <AppShell active="cmdb_navigator"><AwsNavigatorBrowser
    segments={[]}
    initialConnectionId={typeof query.connectionId === "string" ? query.connectionId : null}
    initialRegion={typeof query.region === "string" ? query.region : "all"}
    initialQuery={typeof query.q === "string" ? query.q : ""}
  /></AppShell>;
}
