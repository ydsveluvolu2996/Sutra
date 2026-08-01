import { TrustedAdvisorOrganizationRepository } from "../../../../../db/finops-trusted-advisor-organization-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const REGION = /^[a-z0-9-]{1,128}$/u;
const STALE_AFTER_HOURS = 24;
const ALLOWED_PARAMETERS = new Set([
  "connectionId", "accountId", "checkId", "status", "region",
]);

interface Query {
  readonly connectionId: string;
  readonly accountId: string | null;
  readonly checkId: string | null;
  readonly status: "ok" | "warning" | "error" | null;
  readonly region: string | null;
}

function invalidRequest(): never {
  throw Object.assign(new Error("The Trusted Advisor dashboard request is invalid"), {
    code: "INVALID_INPUT",
    status: 400,
  });
}

function notFound(): never {
  throw Object.assign(new Error("Cloud connection not found"), {
    code: "NOT_FOUND",
    status: 404,
  });
}

function parseQuery(request: Request): Query {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) {
    if (!ALLOWED_PARAMETERS.has(key)) invalidRequest();
  }
  for (const key of ALLOWED_PARAMETERS) {
    if (parameters.getAll(key).length > 1) invalidRequest();
  }
  const connectionId = parameters.get("connectionId") ?? "";
  const accountId = parameters.get("accountId");
  const checkId = parameters.get("checkId");
  const status = parameters.get("status");
  const region = parameters.get("region");
  if (
    !CONNECTION_ID.test(connectionId)
    || (accountId !== null && !ACCOUNT_ID.test(accountId))
    || (checkId !== null && !CHECK_ID.test(checkId))
    || (status !== null && status !== "ok" && status !== "warning" && status !== "error")
    || (region !== null && !REGION.test(region))
  ) invalidRequest();
  return { connectionId, accountId, checkId, status, region };
}

function safeMetadata(value: string): readonly { readonly name: string; readonly value: string }[] {
  try {
    const decoded = JSON.parse(value) as unknown;
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return [];
    return Object.entries(decoded as Readonly<Record<string, unknown>>)
      .filter((entry): entry is [string, string] =>
        entry[0].length > 0 && entry[0].length <= 128
        && typeof entry[1] === "string" && entry[1].length <= 2_048)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 30)
      .map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function ageHours(value: string | null, nowMs = Date.now()): number | null {
  if (value === null) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || epoch > nowMs + 5 * 60_000) return null;
  return Math.max(0, Math.round(((nowMs - epoch) / 3_600_000) * 100) / 100);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const query = parseQuery(request);
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(
      authenticated.subject.orgId,
      query.connectionId,
    );
    if (
      connection === null
      || connection.sourceKind !== "aws_trust_role"
      || connection.status !== "active"
    ) notFound();
    assertSessionCapability(authenticated, "connection:read", connection.customerId);
    const scope = {
      organizationId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: connection.id,
    };
    const repository = new TrustedAdvisorOrganizationRepository();
    const [latestManifest, dashboard] = await Promise.all([
      repository.getLatestManifest(scope),
      repository.getActiveDashboard(scope, {
        accountId: query.accountId,
        checkId: query.checkId,
        status: query.status,
        region: query.region,
      }),
    ]);
    if (dashboard === null) {
      const sourceState = latestManifest === null
        ? "configuration_required"
        : new Set(["pending", "collecting", "finalizing"]).has(latestManifest.status)
          ? "waiting"
          : latestManifest.status === "failed" ? "failed" : "partial";
      return jsonResponse({
        schema: "sutra.finops-trusted-advisor-organizational-dashboard.v1",
        connectionId: connection.id,
        source: "AWS_SUPPORT_TRUSTED_ADVISOR_STANDARD_CHECKS",
        sourceState,
        dashboard: null,
        latestManifest: latestManifest === null ? null : {
          manifestId: latestManifest.manifestId,
          status: latestManifest.status,
          expectedAccountCount: latestManifest.expectedAccountCount,
          finalizedAt: latestManifest.finalizedAtIso,
        },
        activation: {
          available: false,
          reason: "AWS_ORGANIZATIONS_SIGNED_TAXONOMY_ADAPTER_NOT_REGISTERED",
        },
      });
    }

    const freshnessAgeHours = ageHours(dashboard.snapshot.dataThroughAtIso);
    const aFilterIsActive = query.accountId !== null || query.checkId !== null
      || query.status !== null || query.region !== null;
    const newerManifestIncomplete = latestManifest !== null
      && latestManifest.manifestId !== dashboard.snapshot.manifestId
      && latestManifest.status !== "complete";
    const sourceState = newerManifestIncomplete
      ? latestManifest.status === "failed" ? "failed" : "partial"
      : freshnessAgeHours === null ? "partial"
        : freshnessAgeHours > STALE_AFTER_HOURS ? "stale"
          : aFilterIsActive && dashboard.resources.length === 0 ? "empty" : "complete";
    const rejectedRecordCount = dashboard.accounts.reduce(
      (total, account) => total + account.rejectedRecordCount,
      0,
    );
    return jsonResponse({
      schema: "sutra.finops-trusted-advisor-organizational-dashboard.v1",
      connectionId: connection.id,
      source: "AWS_SUPPORT_TRUSTED_ADVISOR_STANDARD_CHECKS",
      sourceState,
      freshness: {
        dataThroughAt: dashboard.snapshot.dataThroughAtIso,
        collectedAt: dashboard.snapshot.collectedAtIso,
        ageHours: freshnessAgeHours,
        staleAfterHours: STALE_AFTER_HOURS,
      },
      coverage: {
        expectedAccounts: dashboard.snapshot.expectedAccountCount,
        acceptedAccounts: dashboard.snapshot.acceptedAccountCount,
        rejectedAccounts: dashboard.snapshot.rejectedAccountCount,
        acceptedChecks: dashboard.snapshot.checkCount,
        acceptedResources: dashboard.snapshot.resourceCount,
        rejectedRecords: rejectedRecordCount,
      },
      filters: dashboard.filters,
      accounts: dashboard.accounts,
      accountsTruncated: dashboard.accountsTruncated,
      checks: dashboard.checks,
      checksTruncated: dashboard.checksTruncated,
      resources: dashboard.resources.map(({ metadataJson, ...resource }) => ({
        ...resource,
        metadata: safeMetadata(metadataJson),
      })),
      resourcesTruncated: dashboard.resourcesTruncated,
      history: dashboard.history,
      evidence: {
        generationId: dashboard.snapshot.generationId,
        manifestId: dashboard.snapshot.manifestId,
        contentSha256: dashboard.snapshot.contentSha256,
      },
      latestManifest: latestManifest === null ? null : {
        manifestId: latestManifest.manifestId,
        status: latestManifest.status,
        expectedAccountCount: latestManifest.expectedAccountCount,
        finalizedAt: latestManifest.finalizedAtIso,
      },
      activation: {
        available: false,
        reason: "AWS_ORGANIZATIONS_SIGNED_TAXONOMY_ADAPTER_NOT_REGISTERED",
      },
      limitations: [
        "Standard checks are collected independently for each configured account.",
        "Trusted Advisor Priority recommendations are supplemental and are never substituted for standard checks.",
        "Only the immutable accepted complete generation is rendered; incomplete generations never advance the active head.",
        "Account discovery activation remains unavailable until the signed server-owned AWS Organizations taxonomy adapter and durable orchestration handlers are registered.",
      ],
    });
  } catch (error) {
    return errorResponse(error);
  }
}
