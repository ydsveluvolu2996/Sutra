import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { AdmissionWorkspace } from "./admission-workspace";

export const metadata: Metadata = { title: "Kubernetes Admission Governance" };

export default function KubernetesAdmissionPage() {
  return <AppShell active="kubernetes_admission"><AdmissionWorkspace /></AppShell>;
}
