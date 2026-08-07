import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { OnboardAccount } from "./onboard-account";

export const metadata: Metadata = { title: "Onboard AWS account" };

export default function OnboardPage() {
  return (
    <AppShell active="onboard">
      <OnboardAccount />
    </AppShell>
  );
}
