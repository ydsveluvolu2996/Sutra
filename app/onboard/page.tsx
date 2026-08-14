import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { OnboardAccount } from "./onboard-account";
import { isAwsStaticCredentialsOnboardingEnabled } from "../../lib/aws-static-credentials-feature";

export const metadata: Metadata = { title: "Onboard AWS account" };
export const dynamic = "force-dynamic";

export default function OnboardPage() {
  return (
    <AppShell active="onboard">
      <OnboardAccount staticCredentialsEnabled={isAwsStaticCredentialsOnboardingEnabled()} />
    </AppShell>
  );
}
