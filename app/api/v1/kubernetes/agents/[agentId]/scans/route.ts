import { canonicalJson } from "../../../../../../../lib/canonical-json";
import {
  evaluateKubernetesPosture,
  normalizeKubernetesEvidence,
  type KubernetesEvidenceKind,
  type KubernetesEvidenceSnapshot,
} from "../../../../../../../lib/kubernetes-posture";
import {
  KubernetesAgentRepository,
} from "../../../../../../../db/kubernetes-agent-repository";
import {
  KubernetesRepository,
  type KubernetesCoverageInput,
} from "../../../../../../../db/kubernetes-repository";
import {
  agentAuthorization,
  agentErrorResponse,
  exactAgentRecord,
  readAgentJson,
} from "../../../../../../../lib/kubernetes-agent-request";
import type {
  KubernetesCollectorCoverage,
  TrivyOperatorFinding,
  TrivySbomEvidence,
} from "../../../../../../../services/kubernetes-collector/src/types";

export const dynamic = "force-dynamic";

const AGENT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{7,127}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u;
const CAPABILITY = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MODULE_STATE = new Set(["AVAILABLE", "DEGRADED", "NOT_CONFIGURED", "UNKNOWN"]);
const COLLECTOR_STATUS = new Set(["succeeded", "failed", "not_configured"]);
const MAXIMUM_BODY_BYTES = 10 * 1024 * 1024;

const collectors: Readonly<Record<KubernetesEvidenceKind, readonly string[]>> = {
  Workload: [
    "kubernetes.deployments", "kubernetes.statefulsets",
    "kubernetes.daemonsets", "kubernetes.pods",
  ],
  Service: ["kubernetes.services"],
  Ingress: ["kubernetes.ingresses"],
  RbacRole: ["kubernetes.roles", "kubernetes.clusterroles"],
  Namespace: ["kubernetes.namespaces"],
  NetworkPolicy: ["kubernetes.networkpolicies"],
};

function invalid(): never {
  throw Object.assign(new Error("Invalid Kubernetes agent scan"), { code: "INVALID_INPUT", status: 400 });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

function validateCoverage(value: unknown): readonly KubernetesCollectorCoverage[] {
  if (!Array.isArray(value) || value.length > 64) invalid();
  return value.map((item) => {
    const entry = exactAgentRecord(item, [
      "collectorKey", "apiPath", "status", "itemsObserved", "pagesObserved",
      ...(typeof (item as Record<string, unknown>)?.errorCode === "string" ? ["errorCode"] : []),
      ...(typeof (item as Record<string, unknown>)?.message === "string" ? ["message"] : []),
    ]);
    if (
      typeof entry.collectorKey !== "string" || !CAPABILITY.test(entry.collectorKey) ||
      typeof entry.apiPath !== "string" || entry.apiPath.length < 1 || entry.apiPath.length > 512 ||
      !COLLECTOR_STATUS.has(entry.status as string) ||
      !Number.isSafeInteger(entry.itemsObserved) || Number(entry.itemsObserved) < 0 ||
      !Number.isSafeInteger(entry.pagesObserved) || Number(entry.pagesObserved) < 0 ||
      (entry.errorCode !== undefined &&
        (typeof entry.errorCode !== "string" || !ERROR_CODE.test(entry.errorCode))) ||
      (entry.message !== undefined &&
        (typeof entry.message !== "string" || entry.message.length > 512 || /[\0\r\n]/u.test(entry.message)))
    ) invalid();
    return entry as unknown as KubernetesCollectorCoverage;
  });
}

function coverageFor(
  kind: KubernetesEvidenceKind,
  source: readonly KubernetesCollectorCoverage[],
  itemsObserved: number,
): KubernetesCoverageInput {
  const entries = collectors[kind].map((key) => source.find((item) => item.collectorKey === key));
  const successes = entries.filter((item) => item?.status === "succeeded").length;
  if (successes === entries.length) return { evidenceKind: kind, state: "COMPLETE", itemsObserved };
  const errorCode = entries.find((item) => item?.status === "failed")?.errorCode ?? "NOT_CONFIGURED";
  if (successes > 0) return { evidenceKind: kind, state: "PARTIAL", itemsObserved, errorCode };
  return {
    evidenceKind: kind,
    state: entries.some((item) => item?.status === "failed") ? "FAILED" : "UNKNOWN",
    itemsObserved,
    errorCode,
  };
}

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly agentId: string }> },
): Promise<Response> {
  try {
    const { agentId } = await context.params;
    const token = agentAuthorization(request, "Bearer");
    const idempotencyKey = request.headers.get("x-sutra-idempotency-key") ?? "";
    if (!AGENT_KEY.test(idempotencyKey)) invalid();
    const raw = await readAgentJson(request, MAXIMUM_BODY_BYTES);
    const body = exactAgentRecord(raw, [
      "schema", "agent", "evidence", "posture", "coverage",
      "trivyFindings", "trivySboms", "modules", "limitations",
    ]);
    if (body.schema !== "sutra.kubernetes-agent-scan.v1") invalid();
    const identity = exactAgentRecord(body.agent, [
      "clusterId", "clusterName", "agentVersion", "capabilities",
    ]);
    const limitations = exactAgentRecord(body.limitations, [
      "secretsCollected", "configMapValuesCollected", "falcoEventsCollected",
    ]);
    if (
      typeof identity.clusterId !== "string" || !ID.test(identity.clusterId) ||
      typeof identity.clusterName !== "string" || identity.clusterName.length < 1 ||
      identity.clusterName.length > 253 ||
      typeof identity.agentVersion !== "string" || !ID.test(identity.agentVersion) ||
      !Array.isArray(identity.capabilities) || identity.capabilities.length < 1 ||
      identity.capabilities.length > 64 ||
      identity.capabilities.some((item) => typeof item !== "string" || !CAPABILITY.test(item)) ||
      limitations.secretsCollected !== false ||
      limitations.configMapValuesCollected !== false ||
      limitations.falcoEventsCollected !== false ||
      !Array.isArray(body.trivyFindings) || body.trivyFindings.length > 2_000 ||
      !Array.isArray(body.trivySboms) || body.trivySboms.length > 200 ||
      typeof body.modules !== "object" || body.modules === null || Array.isArray(body.modules) ||
      Object.keys(body.modules as object).length > 32 ||
      Object.entries(body.modules as Record<string, unknown>).some(
        ([key, value]) => !CAPABILITY.test(key) || !MODULE_STATE.has(value as string),
      )
    ) invalid();
    let evidence: KubernetesEvidenceSnapshot;
    try {
      evidence = normalizeKubernetesEvidence(body.evidence as KubernetesEvidenceSnapshot);
    } catch {
      invalid();
    }
    if (
      evidence.clusterId !== identity.clusterId ||
      canonicalJson(evaluateKubernetesPosture(evidence)) !== canonicalJson(body.posture)
    ) invalid();
    const rawCoverage = validateCoverage(body.coverage);
    const coverage = (Object.keys(collectors) as KubernetesEvidenceKind[]).map((kind) =>
      coverageFor(
        kind,
        rawCoverage,
        evidence.resources.filter((resource) => resource.kind === kind).length,
      ));
    const repository = new KubernetesAgentRepository();
    const agent = await repository.authenticate(agentId, token, { allowPrevious: true });
    if (agent.clusterUid !== identity.clusterId || agent.clusterName !== identity.clusterName) {
      throw Object.assign(new Error("Agent binding mismatch"), {
        code: "AUTHENTICATION_REQUIRED", status: 401,
      });
    }
    const payloadSha256 = await sha256(canonicalJson(raw));
    const receipt = await repository.getScanReceipt(agent, idempotencyKey);
    if (receipt !== null) {
      if (receipt.payloadSha256 !== payloadSha256) {
        throw Object.assign(new Error("Idempotency collision"), { code: "CONFLICT", status: 409 });
      }
      return Response.json(
        {
          schema: "sutra.kubernetes-agent-scan-response.v1",
          scanId: receipt.scanRunId,
          status: "accepted",
          duplicate: true,
        },
        { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
      );
    }
    const publicationKey = `agent-${(await sha256(`${agentId}\0${idempotencyKey}`)).slice(0, 48)}`;
    const complete = coverage.every((entry) => entry.state === "COMPLETE");
    const scan = await new KubernetesRepository().publishScan({
      scope: { orgId: agent.orgId, customerId: agent.customerId },
      clusterId: agent.clusterId,
      idempotencyKey: publicationKey,
      status: complete ? "complete" : evidence.resources.length > 0 ? "partial" : "failed",
      evidence,
      coverage,
      scannerEvidence: {
        findings: body.trivyFindings as TrivyOperatorFinding[],
        sboms: body.trivySboms as TrivySbomEvidence[],
      },
    });
    await repository.recordScanReceipt({
      agent,
      idempotencyKey,
      payloadSha256,
      scanRunId: scan.id,
    });
    return Response.json(
      {
        schema: "sutra.kubernetes-agent-scan-response.v1",
        scanId: scan.id,
        status: "accepted",
        duplicate: false,
      },
      {
        status: 201,
        headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
      },
    );
  } catch (error) {
    return agentErrorResponse(error);
  }
}
