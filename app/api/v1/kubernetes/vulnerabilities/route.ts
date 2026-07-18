import { KubernetesRepository } from "../../../../../db/kubernetes-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { VulnerabilityMirrorRepository } from "../../../../../db/vulnerability-mirror-repository";
import { VulnerabilityWaiverRepository } from "../../../../../db/vulnerability-waiver-repository";
import { KEV_AS_OF, KEV_COUNT, isKnownExploited } from "../../../../../lib/kev-snapshot";
import { mergeVulnerabilityFindings } from "../../../../../lib/vulnerability-finding";
import { deriveVulnerabilityFindings, scanFindingKey } from "../../../../../lib/vulnerability-finding-evidence";
import { buildVulnerabilityQueue, type VulnWaiver } from "../../../../../lib/vulnerability-management";
import { toEngineWaiver } from "../../../../../lib/vulnerability-waiver-mapping";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;
const MS_PER_DAY = 86_400_000;

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
    const findings = merged.map((finding) => {
      const record = finding.cveId === null ? undefined : enrichment.get(finding.cveId.toUpperCase());
      return {
        ...finding,
        knownExploited: isKnownExploited(finding.cveId),
        epss: record?.epssScore ?? null,
        cvssScore: finding.cvssScore ?? record?.cvssScore ?? null,
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
    return jsonResponse({
      queue,
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
