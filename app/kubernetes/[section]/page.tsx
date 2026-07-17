import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "../../components/app-shell";
import { KubernetesEnterpriseSection } from "../kubernetes-enterprise-section";
import { kubernetesSection } from "../kubernetes-sections";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ readonly section: string }>;
}): Promise<Metadata> {
  const definition = kubernetesSection((await params).section);
  return { title: definition?.title ?? "Kubernetes" };
}

export default async function KubernetesSectionPage({
  params,
}: {
  readonly params: Promise<{ readonly section: string }>;
}) {
  const definition = kubernetesSection((await params).section);
  if (definition === null) notFound();
  return (
    <AppShell active={`kubernetes_${definition.key}`}>
      <KubernetesEnterpriseSection section={definition} />
    </AppShell>
  );
}
