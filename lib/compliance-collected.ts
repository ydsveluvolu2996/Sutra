// Server-side helper that gathers the collected control results feeding every
// compliance-framework evaluation (built-in and custom): the AWS baseline
// assessment from the published pilot snapshot plus Kubernetes findings from
// every active cluster on the connection. Extracted from the frameworks route
// so custom frameworks evaluate against EXACTLY the same evidence.
import { getPilotStateForOrg } from "../db/pilot-repository";
import { KubernetesRepository } from "../db/kubernetes-repository";
import { assessCompliance, type ComplianceAssessment } from "./compliance-engine";
import {
  awsCollectedControlResults,
  kubernetesCollectedControlResults,
} from "./compliance-framework-inputs";
import type { CollectedControlResult, ReadinessScope } from "./compliance-frameworks";
import type { KubernetesReadinessEvidenceInput } from "./kubernetes-compliance-readiness";

export interface CollectedComplianceInputs {
  readonly collected: readonly CollectedControlResult[];
  readonly assessment: ComplianceAssessment;
  readonly awsResultCount: number;
  readonly kubernetesResultCount: number;
  readonly activeClusterCount: number;
  readonly k8sFindings: readonly (Parameters<typeof kubernetesCollectedControlResults>[0][number] & KubernetesReadinessEvidenceInput)[];
  readonly k8sCollectedAt: string | null;
  readonly k8sScanSha256: string | null;
  readonly readinessScope: ReadinessScope;
}

export async function collectComplianceInputs(input: {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
}): Promise<CollectedComplianceInputs> {
  // AWS baseline control results (raw assessment; exceptions are a separate
  // documented artifact and are intentionally NOT collapsed into readiness).
  const state = await getPilotStateForOrg(input.orgId, input.connectionId);
  const assessment = assessCompliance(state);
  const awsResults = awsCollectedControlResults(assessment);

  // Kubernetes control results across every active cluster on this connection.
  const scope = { orgId: input.orgId, customerId: input.customerId };
  const repository = new KubernetesRepository();
  const clusters = await repository.listClusters(scope);
  const activeClusters = clusters.filter((cluster) => cluster.status === "active");
  const workspaces = (
    await Promise.all(activeClusters.map((cluster) => repository.getLatestWorkspace(scope, cluster.id)))
  ).filter((workspace): workspace is NonNullable<typeof workspace> => workspace !== null);
  const k8sFindings = workspaces.flatMap((workspace) => workspace.findings);
  const k8sResults = kubernetesCollectedControlResults(k8sFindings);
  const k8sCollectedAt = workspaces
    .map((workspace) => workspace.scan?.collectedAt ?? null)
    .filter((value): value is string => value !== null)
    .sort((left, right) => right.localeCompare(left, "en-US"))[0] ?? null;
  const k8sScanSha256 = workspaces.find((workspace) => (workspace.scan?.collectedAt ?? null) === k8sCollectedAt)?.scan?.evidenceSha256 ?? null;

  return {
    collected: [...awsResults, ...k8sResults],
    assessment,
    awsResultCount: awsResults.length,
    kubernetesResultCount: k8sResults.length,
    activeClusterCount: activeClusters.length,
    k8sFindings,
    k8sCollectedAt,
    k8sScanSha256,
    readinessScope: {
      tenantId: input.customerId,
      collectionId: assessment.provenance.snapshotId,
      collectedAt: assessment.provenance.snapshotCollectedAt,
    },
  };
}
