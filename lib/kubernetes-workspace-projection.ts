import type {
  JsonValue,
  PilotConnection,
  PilotCoverageEntry,
  PilotFinding,
  PilotRelationship,
  PilotResource,
} from "./pilot-types";
import type {
  KubernetesCoverageInput,
  KubernetesStoredWorkspace,
} from "../db/kubernetes-repository";

export interface KubernetesPilotProjection {
  readonly resources: readonly PilotResource[];
  readonly relationships: readonly PilotRelationship[];
  readonly findings: readonly PilotFinding[];
  readonly coverage: readonly PilotCoverageEntry[];
}

function regionFromClusterUid(clusterUid: string, accountId: string): string {
  const prefix = `${accountId}:`;
  if (!clusterUid.startsWith(prefix)) return "global";
  const region = clusterUid.slice(prefix.length).split(":", 1)[0];
  return /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(region) ? region : "global";
}

function resourceKey(clusterId: string, kind: string, namespace: string | null, name: string): string {
  return `kubernetes:${clusterId}:${kind}:${namespace ?? "_cluster"}:${name}`;
}

function coverageStatus(state: KubernetesCoverageInput["state"]): PilotCoverageEntry["status"] {
  if (state === "COMPLETE") return "succeeded";
  if (state === "PARTIAL") return "partial";
  return "failed";
}

function remediation(controlId: string): string {
  if (controlId.includes("NETWORK-POLICY")) return "Add a namespace NetworkPolicy with an explicit default-deny baseline and reviewed allow rules.";
  if (controlId.includes("RBAC")) return "Remove wildcard or escalation-capable RBAC rules and grant only the exact verbs and resources required.";
  if (controlId.includes("PRIVILEG") || controlId.includes("HOST")) return "Harden the pod security context and remove privileged, host, or escalation access that is not explicitly required.";
  if (controlId.includes("IMAGE")) return "Pin the workload to an immutable image digest and validate the image through the approved registry pipeline.";
  if (controlId.includes("RESOURCE") || controlId.includes("PROBE")) return "Define reviewed resource requests, limits, and health probes in the workload specification.";
  if (controlId.includes("TLS")) return "Configure TLS for every reported ingress host and validate certificate lifecycle ownership.";
  return "Review the normalized evidence, apply the least-privilege Kubernetes configuration, and rescan to verify the result.";
}

export function projectStoredKubernetesWorkspace(
  workspace: KubernetesStoredWorkspace,
  connection: PilotConnection,
): KubernetesPilotProjection {
  const collectedAt = workspace.scan?.collectedAt ?? connection.updatedAt;
  const contentSha256 = workspace.scan?.evidenceSha256 ?? "0".repeat(64);
  const region = regionFromClusterUid(workspace.cluster.clusterUid, connection.awsAccountId);
  const clusterResourceKey = resourceKey(workspace.cluster.id, "Cluster", null, workspace.cluster.name);
  const clusterResource: PilotResource = {
    resourceKey: clusterResourceKey,
    service: "kubernetes",
    resourceType: "kubernetes.cluster",
    nativeId: workspace.cluster.clusterUid,
    arn: null,
    name: workspace.cluster.name,
    region,
    state: workspace.cluster.status,
    tags: {},
    configuration: {
      kind: "Cluster",
      clusterName: workspace.cluster.name,
      distribution: workspace.cluster.distribution,
      version: workspace.cluster.version,
    },
    source: {
      api: "sutra.kubernetes.scan.v1",
      accountId: connection.awsAccountId,
      collectedAt,
    },
    contentSha256,
  };
  const resources: PilotResource[] = [clusterResource];
  const subjectToResource = new Map<string, string>([
    [`Cluster/${workspace.cluster.clusterUid}`, clusterResourceKey],
  ]);
  const objectToResource = new Map<string, string>();
  for (const evidence of workspace.resources) {
    const key = resourceKey(workspace.cluster.id, evidence.kind, evidence.namespace, evidence.name);
    subjectToResource.set(
      `${evidence.kind}/${evidence.namespace === null ? "" : `${evidence.namespace}/`}${evidence.name}`,
      key,
    );
    objectToResource.set(`${evidence.namespace ?? ""}/${evidence.name}`, key);
    resources.push({
      resourceKey: key,
      service: "kubernetes",
      resourceType: `kubernetes.${evidence.kind.toLocaleLowerCase("en-US")}`,
      nativeId: `${evidence.kind}/${evidence.namespace ?? ""}/${evidence.name}`,
      arn: null,
      name: evidence.name,
      region,
      state: "observed",
      tags: {},
      configuration: {
        ...(evidence as unknown as Readonly<Record<string, JsonValue>>),
        kind: evidence.kind === "Workload" ? evidence.workloadKind : evidence.kind,
        clusterName: workspace.cluster.name,
        namespace: evidence.namespace,
      },
      source: {
        api: "sutra.kubernetes.scan.v1",
        accountId: connection.awsAccountId,
        collectedAt,
      },
      contentSha256,
    });
  }
  for (const sbom of workspace.scannerEvidence.sboms) {
    const key = resourceKey(workspace.cluster.id, "Sbom", sbom.namespace, sbom.reportName);
    const imageReference = sbom.artifact.repository === null
      ? null
      : `${sbom.artifact.repository}${sbom.artifact.digest ? `@${sbom.artifact.digest}` : sbom.artifact.tag ? `:${sbom.artifact.tag}` : ""}`;
    resources.push({
      resourceKey: key,
      service: "kubernetes",
      resourceType: "kubernetes.sbom",
      nativeId: sbom.fingerprint,
      arn: null,
      name: sbom.reportName,
      region,
      state: "observed",
      tags: {},
      configuration: {
        kind: "Sbom",
        clusterName: workspace.cluster.name,
        namespace: sbom.namespace,
        affectedKind: sbom.affectedResource.kind,
        affectedName: sbom.affectedResource.name,
        imageReference,
        bomFormat: sbom.bomFormat,
        specVersion: sbom.specVersion,
        componentCount: sbom.declaredComponentCount ?? sbom.components.length,
        components: sbom.components.map((component) => ({
          name: component.name,
          version: component.version,
          type: component.type,
          packageUrl: component.packageUrl,
        })),
        scannerName: sbom.scanner.name,
        scannerVersion: sbom.scanner.version,
      },
      source: {
        api: "trivy-operator.sbomreports",
        accountId: connection.awsAccountId,
        collectedAt,
      },
      contentSha256: sbom.fingerprint,
    });
  }
  const relationships: PilotRelationship[] = resources.slice(1).map((resource) => ({
    fromResourceKey: clusterResourceKey,
    toResourceKey: resource.resourceKey,
    relationType: "cluster_contains",
    evidence: { source: "sutra.kubernetes.scan.v1" },
  }));
  const findings: PilotFinding[] = workspace.findings.map((finding) => ({
    fingerprint: `k8s:${workspace.scan?.id ?? workspace.cluster.id}:${finding.controlId}:${finding.subject}`,
    resourceKey: subjectToResource.get(finding.subject) ?? clusterResourceKey,
    controlKey: finding.controlId,
    controlVersion: "1",
    severity: finding.severity.toLocaleLowerCase("en-US") as PilotFinding["severity"],
    status: finding.state === "PASS" ? "resolved" : "open",
    title: finding.controlId.replaceAll("-", " "),
    summary: finding.message,
    remediation: remediation(finding.controlId),
    evidence: {
      result: finding.state,
      subject: finding.subject,
      observations: [...finding.evidence],
    },
    evaluatedAt: collectedAt,
  }));
  findings.push(...workspace.scannerEvidence.findings.map((finding): PilotFinding => {
    const affectedKey = finding.affectedResource.name === null
      ? clusterResourceKey
      : objectToResource.get(
        `${finding.affectedResource.namespace ?? finding.namespace ?? ""}/${finding.affectedResource.name}`,
      ) ?? clusterResourceKey;
    const severity: PilotFinding["severity"] =
      finding.severity === "unknown" ? "informational" : finding.severity;
    return {
      fingerprint: finding.fingerprint,
      resourceKey: affectedKey,
      controlKey: finding.cveId ?? finding.checkId ?? `TRIVY-${finding.source.toLocaleUpperCase("en-US")}`,
      controlVersion: finding.scanner.version,
      severity,
      status: "open",
      title: finding.title,
      summary: finding.cveId === null
        ? `Trivy Operator reported ${finding.source.replaceAll("_", " ")} evidence for ${finding.reportName}.`
        : `${finding.cveId} affects ${finding.packageName ?? finding.target ?? finding.reportName}.`,
      remediation: finding.remediation ??
        (finding.fixedVersion === null
          ? "Review the scanner evidence and vendor advisory; no fixed version was reported."
          : `Upgrade ${finding.packageName ?? "the affected package"} to ${finding.fixedVersion} or later, then rescan.`),
      evidence: {
        source: finding.source,
        reportName: finding.reportName,
        cveId: finding.cveId,
        packageName: finding.packageName,
        packageType: finding.packageType,
        installedVersion: finding.installedVersion,
        fixedVersion: finding.fixedVersion,
        target: finding.target,
        score: finding.score,
        scanner: finding.scanner.name,
        scannerVersion: finding.scanner.version,
      },
      evaluatedAt: finding.scanner.reportUpdatedAt ?? collectedAt,
    };
  }));
  const coverage: PilotCoverageEntry[] = workspace.coverage.map((entry) => ({
    collectorKey: `kubernetes.posture.${entry.evidenceKind.toLocaleLowerCase("en-US")}`,
    region,
    status: coverageStatus(entry.state),
    itemsObserved: entry.itemsObserved,
    pagesObserved: entry.itemsObserved > 0 ? 1 : 0,
    ...(entry.errorCode === undefined ? {} : {
      errorCode: entry.errorCode,
      message: "Collector coverage was incomplete; review the cluster access contract.",
    }),
  }));
  if (workspace.scannerEvidence.findings.length > 0) {
    coverage.push({
      collectorKey: "kubernetes.trivy.findings",
      region,
      status: "succeeded",
      itemsObserved: workspace.scannerEvidence.findings.length,
      pagesObserved: 1,
    });
  }
  if (workspace.scannerEvidence.sboms.length > 0) {
    coverage.push({
      collectorKey: "kubernetes.trivy.sbomreports",
      region,
      status: "succeeded",
      itemsObserved: workspace.scannerEvidence.sboms.length,
      pagesObserved: 1,
    });
  }
  return { resources, relationships, findings, coverage };
}
