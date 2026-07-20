import type { Metadata } from "next";
import { AppShell } from "../components/app-shell";
import { CloudDetectionsBrowser } from "./cloud-detections-browser";

export const metadata: Metadata = { title: "Cloud detections" };

export default function CloudDetectionsPage() {
  return (
    <AppShell active="cloud_detections">
      <CloudDetectionsBrowser />
    </AppShell>
  );
}
