import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { ClientOnboardingGuide } from "./client-onboarding-guide";

export const metadata: Metadata = { title: "Onboard a client" };

export default function OnboardClientPage() {
  return <AppShell active="onboard_client"><ClientOnboardingGuide /></AppShell>;
}
