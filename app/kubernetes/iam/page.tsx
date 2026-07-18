import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";
import { IamCiemWorkspace } from "./iam-ciem-workspace";

export const metadata: Metadata = { title: "AWS IAM CIEM" };

export default function KubernetesIamCiemPage() {
  return <AppShell active="kubernetes_iam"><IamCiemWorkspace /></AppShell>;
}
