import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { CloudVulnerabilityRepository } from "../../../../../db/cloud-vulnerability-repository";
import { VulnerabilityMirrorRepository } from "../../../../../db/vulnerability-mirror-repository";
import { VulnerabilityWaiverRepository } from "../../../../../db/vulnerability-waiver-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { KEV_AS_OF, KEV_COUNT, isKnownExploited } from "../../../../../lib/kev-snapshot";
import { deriveCloudVulnerabilityFindings } from "../../../../../lib/cloud-vulnerability-evidence";
import { buildVulnerabilityQueue, type VulnWaiver } from "../../../../../lib/vulnerability-management";
import { toEngineWaiver } from "../../../../../lib/vulnerability-waiver-mapping";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const MS_PER_DAY = 86_400_000;

function invalid(): never {
  throw Object.assign(new Error("Cloud vulnerability query rejected"), { code: "INVALID_INPUT" });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId")) invalid();
    const connectionId = url.searchParams.get("connectionId");
    if (connectionId === null || !CONNECTION_ID.test(connectionId)) invalid();
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
    const tenant = { orgId: scope.orgId, customerId: connection.customerId };

    const rows = await new CloudVulnerabilityRepository().listForConnection(scope, connectionId);
    const findingsBase = deriveCloudVulnerabilityFindings(rows, tenant);

    // Same enrichment as the Kubernetes queue: bundled CISA KEV snapshot + the
    // Postgres EPSS/CVSS mirror. Absence from a feed is a fact, never assumed safe.
    const enrichment = await new VulnerabilityMirrorRepository().enrichmentFor(findingsBase.map((finding) => finding.cveId));
    const findings = findingsBase.map((finding) => {
      const record = finding.cveId === null ? undefined : enrichment.get(finding.cveId.toUpperCase());
      return {
        ...finding,
        knownExploited: isKnownExploited(finding.cveId),
        epss: record?.epssScore ?? null,
        cvssScore: finding.cvssScore ?? record?.cvssScore ?? null,
      };
    });
    const epssCovered = findings.filter((finding) => finding.epss !== null).length;

    // Cloud findings are not cluster-scoped, so only org-wide waivers apply.
    const storedWaivers = await new VulnerabilityWaiverRepository().applicableToCloud(scope);
    const waivers: VulnWaiver[] = storedWaivers.map(toEngineWaiver);

    const now = Date.now();
    const queue = buildVulnerabilityQueue(findings, {
      nowMs: now,
      nowDays: Math.floor(now / MS_PER_DAY),
      waivers,
    });
    return jsonResponse({
      queue,
      source: "aws-inspector",
      accountId: connection.awsAccountId,
      totalFindings: findings.length,
      lastSeenAt: rows.length > 0 ? new Date(Math.max(...rows.map((row) => row.lastSeenMs))).toISOString() : null,
      kev: { asOf: KEV_AS_OF, count: KEV_COUNT },
      epss: { covered: epssCovered },
      waivers: { active: storedWaivers.length },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
