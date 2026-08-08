import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { WelcomeFlow } from "./welcome-flow";

export const metadata: Metadata = { title: "Welcome to Sutra" };

export default function WelcomePage() {
  return (
    <AppShell active="overview">
      <WelcomeFlow />
    </AppShell>
  );
}
