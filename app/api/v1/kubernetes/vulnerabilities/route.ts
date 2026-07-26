import { FalcoRuntimeRepository } from "../../../../../db/falco-runtime-repository";
import { HubbleFlowRepository } from "../../../../../db/hubble-flow-repository";
import { KubernetesRepository } from "../../../../../db/kubernetes-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { VulnerabilityMirrorRepository } from "../../../../../db/vulnerability-mirror-repository";
import { VulnerabilityWaiverRepository } from "../../../../../db/vulnerability-waiver-repository";
import type { NormalizedFalcoRuntimeEvent } from "../../../../../lib/falco-runtime-types";
import type { NormalizedHubbleFlow } from "../../../../../lib/hubble-flow-evidence";
import { KEV_AS_OF, KEV_COUNT, isKnownExploited } from "../../../../../lib/kev-snapshot";
import {
  buildReachabilityEvidence,
  type FlowCoverage,
  type RuntimeCoverage,
} from "../../../../../lib/kubernetes-reachable-vulnerability-inputs";
import {
  buildReachableVulnerabilities,
  classifyReachability,
  type ReachableFindingInput,
  type VulnSeverity as ReachableSeverity,
} from "../../../../../lib/kubernetes-reachable-vulnerability";
import { mergeVulnerabilityFindings } from "../../../../../lib/vulnerability-finding";
import { deriveVulnerabilityFindings, scanFindingKey } from "../../../../../lib/vulnerability-finding-evidence";
import { buildVulnerabilityQueue, type VulnWaiver } from "../../../../../lib/vulnerability-management";
import { buildPatchPlan } from "../../../../../lib/vulnerability-patch-plan";
import { toEngineWaiver } from "../../../../../lib/vulnerability-waiver-mapping";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;
const MS_PER_DAY = 86_400_000;
const SIGNAL_LIMIT = 500;
const RANKABLE: readonly ReachableSeverity[] = ["critical", "high", "medium", "low"];

function isRankable(severity: string): severity is ReachableSeverity {
  return (RANKABLE as readonly string[]).includes(severity);
}

/** Stable join key between the queue items and the reachability verdicts. */
function verdictKey(finding: {
  readonly resourceKey: string;
  readonly cveId: string | null;
  readonly packageName: string | null;
}): string {
  return `${finding.resourceKey}|${finding.cveId ?? ""}|${finding.packageName ?? ""}`;
}

function invalid(): never {
  throw Object.assign(new Error("Vulnerability query rejected"), { code: "INVALID_INPUT" });
}

function toMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => !["connectionId", "clusterId"].includes(key))) invalid();
    const connectionId = url.searchParams.get("connectionId");
    const clusterId = url.searchParams.get("clusterId");
    if (
      connectionId === null || !CONNECTION_ID.test(connectionId) ||
      clusterId === null || !CLUSTER_ID.test(clusterId)
    ) invalid();
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    }
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
    const tenant = { orgId: scope.orgId, customerId: connection.customerId, clusterId };
    const scans = await new KubernetesRepository().listVulnerabilityScans(scope, clusterId);

    const latest = scans.latest?.findings ?? [];
    const previous = scans.previous?.findings ?? [];
    const latestMs = toMs(scans.latest?.collectedAt);
    const previousMs = toMs(scans.previous?.collectedAt);
    const previousKeys = new Set(previous.map(scanFindingKey));

    // A finding also present in the previous scan has persisted at least since then,
    // so it gets the older (conservative) first-seen; a finding only in the latest
    // scan is dated to the latest scan. We never date a finding earlier than evidence.
    const persisting = latest.filter((finding) => previousKeys.has(scanFindingKey(finding)));
    const fresh = latest.filter((finding) => !previousKeys.has(scanFindingKey(finding)));
    const merged = mergeVulnerabilityFindings([
      ...deriveVulnerabilityFindings(persisting, tenant, previousMs ?? latestMs),
      ...deriveVulnerabilityFindings(fresh, tenant, latestMs),
    ]);
    // Enrich with live feeds: the bundled CISA KEV snapshot (a known-exploited CVE
    // dominates the ranking and is badged) and the Postgres EPSS/CVSS mirror
    // (exploit probability + disclosure severity). Absence from either feed is a
    // real fact ("not on the list" / "no score"), never an assumption of safety.
    const enrichment = await new VulnerabilityMirrorRepository().enrichmentFor(merged.map((finding) => finding.cveId));

    // Reachability evidence: observed inbound Hubble flows from outside the
    // cluster (network axis) and Falco runtime events (runtime axis), both already
    // persisted per cluster and read under the same tenant scope. A collector that
    // is absent or errors yields no evidence — never a fabricated verdict — so the
    // engine reports "unknown" and the response says why.
    const signalScope = { orgId: scope.orgId, customerId: connection.customerId, clusterId };
    const signalErrors: string[] = [];
    let flows: readonly NormalizedHubbleFlow[] = [];
    let flowCoverage: FlowCoverage = "not_configured";
    let runtimeEvents: readonly NormalizedFalcoRuntimeEvent[] = [];
    let runtimeCoverage: RuntimeCoverage = "not_configured";
    try {
      const hubble = await new HubbleFlowRepository().workspace(signalScope, SIGNAL_LIMIT);
      flows = hubble.flows;
      flowCoverage = hubble.coverage;
    } catch {
      signalErrors.push("The Hubble network-flow evidence could not be read; no network reachability was determined.");
    }
    try {
      const falco = await new FalcoRuntimeRepository().workspace(signalScope, SIGNAL_LIMIT);
      runtimeEvents = falco.events;
      runtimeCoverage = falco.coverage.status;
    } catch {
      signalErrors.push("The Falco runtime evidence could not be read; no runtime activity was determined.");
    }
    const reachabilityEvidence = buildReachabilityEvidence({ flows, flowCoverage, runtimeEvents, runtimeCoverage });

    const findings = merged.map((finding) => {
      const record = finding.cveId === null ? undefined : enrichment.get(finding.cveId.toUpperCase());
      const exposure = reachabilityEvidence.exposure.get(finding.resourceKey);
      return {
        ...finding,
        knownExploited: isKnownExploited(finding.cveId),
        epss: record?.epssScore ?? null,
        cvssScore: finding.cvssScore ?? record?.cvssScore ?? null,
        // Tri-state, straight from the observation: true/false only when a flow
        // actually proved reach or refusal, otherwise null (undetermined).
        internetReachable: exposure?.internetReachable ?? null,
      };
    });
    const epssCovered = findings.filter((finding) => finding.epss !== null).length;

    // Accepted-risk waivers that apply to this cluster (org-wide or cluster-scoped).
    // The engine treats each as an accepted-risk record — it suppresses a matching
    // OPEN finding only while unexpired, and reports empty/expired waivers in
    // invalidWaivers rather than silently hiding anything.
    const storedWaivers = await new VulnerabilityWaiverRepository().applicable(scope, clusterId);
    const waivers: VulnWaiver[] = storedWaivers.map(toEngineWaiver);

    const now = Date.now();
    const queue = buildVulnerabilityQueue(findings, {
      nowMs: now,
      nowDays: Math.floor(now / MS_PER_DAY),
      waivers,
    });
    // Patch-management view over the same enriched findings: what to upgrade
    // (grouped per image+package into one from->to bump), prioritized like the queue.
    const patchPlan = buildPatchPlan(findings, {
      now: { nowMs: now },
      waivers: waivers.map((waiver) => ({
        cveId: waiver.scope.cveId ?? null,
        resourceKey: waiver.scope.resourceKey ?? null,
        packageName: waiver.scope.packageName ?? null,
      })),
    });
    // Reachability engine over the same findings. loadedPackages is deliberately
    // NOT supplied — nothing in this product collects per-workload loaded packages
    // — so the engine reports inUse "unknown" instead of a fabricated
    // "not-observed". Only the four rankable severities can carry a contextPriority;
    // an 'unknown'-severity finding still gets its reachability verdict from the
    // engine's own classifier, without inventing a severity for it.
    const rankable: ReachableFindingInput[] = queue.items
      .filter((finding) => isRankable(finding.severity))
      .map((finding) => ({
        cveId: finding.cveId,
        packageName: finding.packageName,
        workloadRef: finding.resourceKey,
        severity: finding.severity as ReachableSeverity,
        tenant: finding.tenant?.customerId ?? null,
      }));
    const reachableReport = buildReachableVulnerabilities(rankable, {
      exposure: reachabilityEvidence.exposure,
    });
    const verdicts = new Map(reachableReport.findings.map((finding) => [verdictKey({
      resourceKey: finding.workloadRef, cveId: finding.cveId, packageName: finding.packageName,
    }), finding]));
    const items = queue.items.map((item) => {
      const verdict = verdicts.get(verdictKey(item));
      const exposure = reachabilityEvidence.exposure.get(item.resourceKey);
      return {
        ...item,
        reachable: verdict?.reachable ?? classifyReachability(exposure),
        inUse: verdict?.inUse ?? "unknown",
        contextPriority: verdict?.contextPriority ?? null,
        observedRuntimeActive: exposure?.observedRuntimeActive === true,
        // The cited observations the verdict was built from, plus the engine's own
        // rationale. Never a bare label.
        reachabilityRationale: verdict?.rationale ?? [],
        reachabilityEvidence: reachabilityEvidence.citations.get(item.resourceKey) ?? [],
      };
    });

    return jsonResponse({
      queue: { ...queue, items },
      patchPlan,
      reachability: {
        available: reachabilityEvidence.availability.available,
        totals: reachableReport.totals,
        inputs: reachabilityEvidence.availability,
        signalErrors,
        disclaimer: reachableReport.disclaimer,
      },
      scannedAt: scans.latest?.collectedAt ?? null,
      hasPrevious: scans.previous !== null,
      totalFindings: findings.length,
      kev: { asOf: KEV_AS_OF, count: KEV_COUNT },
      epss: { covered: epssCovered },
      waivers: { active: storedWaivers.length },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
