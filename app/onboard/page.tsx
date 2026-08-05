import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { FinopsOnboardingSources } from "./finops-onboarding-sources";
import { OnboardAccount } from "./onboard-account";

export const metadata: Metadata = { title: "Onboard AWS account" };

export default function OnboardPage() {
  return (
    <AppShell active="onboard">
      <OnboardAccount />
      {/*
        Additive, server-rendered coverage contract. It is deliberately kept out
        of OnboardAccount so the interactive trust flow is unchanged and the
        server-owned FinOps runtime registry never reaches the browser bundle.
      */}
      <FinopsOnboardingSources />
    </AppShell>
  );
}
