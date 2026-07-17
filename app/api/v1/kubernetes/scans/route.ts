import { appendAuditEvent, getConnectionForOrg } from "../../../../../db/pilot-repository";
import {
  KubernetesRepository,
  type KubernetesCoverageInput,
} from "../../../../../db/kubernetes-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";
import { canonicalJson } from "../../../../../lib/canonical-json";
import { evaluateKubernetesPosture } from "../../../../../lib/kubernetes-posture";
import {
  toKubernetesEvidenceSnapshot,
  type KubernetesCollectorCoverage,
  type KubernetesSnapshot,
} from "../../../../../services/kubernetes-collector/src/index";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{7,127}$/u;
const MAX_SCAN_BODY_BYTES = 3 * 1024 * 1024;

const collectors = {
  Workload: ["kubernetes.deployments", "kubernetes.statefulsets", "kubernetes.daemonsets", "kubernetes.pods"],
  Service: ["kubernetes.services"],
  Ingress: ["kubernetes.ingresses"],
  RbacRole: ["kubernetes.roles", "kubernetes.clusterroles"],
  Namespace: ["kubernetes.namespaces"],
  NetworkPolicy: ["kubernetes.networkpolicies"],
} as const;

function invalid(): never {
  throw Object.assign(new Error("The Kubernetes scan artifact is invalid"), { code: "INVALID_INPUT" });
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !keys.includes(key))
  ) invalid();
  return record;
}

function required(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  return value;
}

function validateSnapshot(value: unknown): KubernetesSnapshot {
  const artifact = exactRecord(value, [
    "schemaVersion", "clusterId", "clusterName", "collectedAt",
    "resources", "coverage", "trivyFindings", "trivySboms",
  ]);
  if (
    artifact.schemaVersion !== "sutra.kubernetes.inventory.v1" ||
    typeof artifact.clusterId !== "string" ||
    typeof artifact.clusterName !== "string" ||
    typeof artifact.collectedAt !== "string" ||
    !Array.isArray(artifact.resources) ||
    !Array.isArray(artifact.coverage) ||
    !Array.isArray(artifact.trivyFindings) ||
    !Array.isArray(artifact.trivySboms) ||
    artifact.resources.length > 900 ||
    artifact.coverage.length > 64 ||
    artifact.trivyFindings.length > 2_000 ||
    artifact.trivySboms.length > 200
  ) invalid();
  return artifact as unknown as KubernetesSnapshot;
}

function validateArtifact(value: unknown): {
  readonly snapshot: KubernetesSnapshot;
  readonly assertedPosture: unknown;
} {
  const artifact = exactRecord(value, [
    "schemaVersion", "generatedAt", "snapshot", "posture", "limitations",
  ]);
  if (artifact.schemaVersion !== "sutra.kubernetes.scan-artifact.v1") invalid();
  if (
    typeof artifact.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(artifact.generatedAt))
  ) invalid();
  const limitations = exactRecord(artifact.limitations, [
    "secretsCollected", "imageVulnerabilities", "runtimeDetection", "admissionControl",
  ]);
  if (
    limitations.secretsCollected !== false ||
    !new Set([
      "NOT_CONFIGURED",
      "TRIVY_REPORTS_IMPORTED",
      "TRIVY_REPORT_API_OBSERVED_EMPTY",
    ]).has(limitations.imageVulnerabilities as string) ||
    limitations.runtimeDetection !== "NOT_CONFIGURED" ||
    limitations.admissionControl !== "NOT_CONFIGURED"
  ) invalid();
  return {
    snapshot: validateSnapshot(artifact.snapshot),
    assertedPosture: artifact.posture,
  };
}

function coverageFor(
  kind: keyof typeof collectors,
  coverage: readonly KubernetesCollectorCoverage[],
  itemsObserved: number,
): KubernetesCoverageInput {
  const entries = collectors[kind].map((key) => coverage.find((item) => item.collectorKey === key));
  const successes = entries.filter((entry) => entry?.status === "succeeded").length;
  if (successes === entries.length) {
    return { evidenceKind: kind, state: "COMPLETE", itemsObserved };
  }
  const safeCode = entries.find((entry) => entry?.status === "failed")?.errorCode ?? "NOT_CONFIGURED";
  if (successes > 0) {
    return { evidenceKind: kind, state: "PARTIAL", itemsObserved, errorCode: safeCode };
  }
  return {
    evidenceKind: kind,
    state: entries.some((entry) => entry?.status === "failed") ? "FAILED" : "UNKNOWN",
    itemsObserved,
    errorCode: safeCode,
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const authenticated = await requireApiSession(request);
    const body = exactRecord(await readBoundedJson(request, MAX_SCAN_BODY_BYTES), [
      "connectionId", "clusterId", "idempotencyKey", "artifact",
    ]);
    const connectionId = required(body.connectionId, CONNECTION_ID);
    const clusterId = required(body.clusterId, CLUSTER_ID);
    const idempotencyKey = required(body.idempotencyKey, IDEMPOTENCY_KEY);
    const artifact = validateArtifact(body.artifact);
    const snapshot = artifact.snapshot;
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    }
    assertSessionCapability(authenticated, "sync:run", connection.customerId);
    const repository = new KubernetesRepository();
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
    const cluster = (await repository.listClusters(scope)).find((item) => item.id === clusterId);
    if (cluster === undefined || cluster.status !== "active" || snapshot.clusterId !== cluster.clusterUid) invalid();
    const evidence = toKubernetesEvidenceSnapshot(snapshot);
    if (canonicalJson(evaluateKubernetesPosture(evidence)) !== canonicalJson(artifact.assertedPosture)) invalid();
    const coverage = evidence.observedKinds.map((kind) => coverageFor(
      kind,
      snapshot.coverage,
      evidence.resources.filter((resource) => resource.kind === kind).length,
    ));
    const complete = evidence.observedKinds.length === Object.keys(collectors).length &&
      coverage.every((entry) => entry.state === "COMPLETE");
    const scan = await repository.publishScan({
      scope,
      clusterId,
      idempotencyKey,
      status: complete ? "complete" : evidence.resources.length > 0 ? "partial" : "failed",
      evidence,
      coverage,
      scannerEvidence: {
        findings: snapshot.trivyFindings,
        sboms: snapshot.trivySboms,
      },
    });
    await appendAuditEvent({
      orgId: authenticated.subject.orgId,
      actorId: authenticated.subject.userId,
      action: "kubernetes.scan.published",
      targetType: "kubernetes_cluster",
      targetId: clusterId,
      customerId: connection.customerId,
      outcome: "allowed",
      requestId: `kubernetes.scan.published:${scan.id}`,
      metadata: {
        scanId: scan.id,
        status: scan.status,
        evidenceSha256: scan.evidenceSha256,
        resourceCount: scan.resourceCount,
        findingCount: scan.findingCount,
      },
    });
    return jsonResponse({ scan }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
