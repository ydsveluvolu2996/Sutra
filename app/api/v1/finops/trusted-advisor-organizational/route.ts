import { env } from "cloudflare:workers";
import { TrustedAdvisorOrganizationRepository } from "../../../../../db/finops-trusted-advisor-organization-repository";
import { JobQueueRepository } from "../../../../../db/job-queue-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { TRUSTED_ADVISOR_ORGANIZATIONAL_OFFICIAL_DEFINITION } from "../../../../../lib/finops-trusted-advisor-organizational-official-definition";
import {
  enqueueTrustedAdvisorOrganizationActivation,
} from "../../../../../lib/finops-trusted-advisor-standard-orchestration";
import { FinopsEvidenceReferenceSealer } from "../../../../../lib/finops-source-evidence-reference";
import {
  createTrustedAdvisorTaxonomySignatureVerifier,
} from "../../../../../lib/finops-trusted-advisor-taxonomy-kms";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const REGION = /^[a-z0-9-]{1,128}$/u;
const CATEGORY = new Set(["security", "cost_optimizing", "fault_tolerance", "performance", "service_limits"]);
const STALE_AFTER_HOURS = 24;
const BODY_BYTES = 2 * 1_024;
const REQUIRED_PERMISSION_PACK = "standard-2026-08.2";
const ALLOWED_PARAMETERS = new Set([
  "connectionId", "accountId", "checkId", "status", "region", "category", "suppressed",
]);

interface Query {
  readonly connectionId: string;
  readonly accountId: string | null;
  readonly checkId: string | null;
  readonly status: "ok" | "warning" | "error" | null;
  readonly region: string | null;
  readonly category: string | null;
  readonly suppressed: boolean | null;
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
  const category = parameters.get("category");
  const suppressedParameter = parameters.get("suppressed");
  if (
    !CONNECTION_ID.test(connectionId)
    || (accountId !== null && !ACCOUNT_ID.test(accountId))
    || (checkId !== null && !CHECK_ID.test(checkId))
    || (status !== null && status !== "ok" && status !== "warning" && status !== "error")
    || (region !== null && !REGION.test(region))
    || (category !== null && !CATEGORY.has(category))
    || (suppressedParameter !== null && suppressedParameter !== "true" && suppressedParameter !== "false")
  ) invalidRequest();
  return {
    connectionId, accountId, checkId, status, region, category,
    suppressed: suppressedParameter === null ? null : suppressedParameter === "true",
  };
}

function safeMetadata(value: string): readonly { readonly name: string; readonly value: string }[] {
  try {
    const decoded = JSON.parse(value) as unknown;
    if (Array.isArray(decoded)) {
      return decoded.filter((entry): entry is { readonly name: string; readonly value: string } =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry)
        && "name" in entry && typeof entry.name === "string"
        && entry.name.length > 0 && entry.name.length <= 256
        && "value" in entry && typeof entry.value === "string"
        && entry.value.length <= 4_096)
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 100);
    }
    if (typeof decoded !== "object" || decoded === null) return [];
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

async function activationState(permissionPackVersion: string): Promise<
  | { readonly available: true; readonly reason: null }
  | { readonly available: false; readonly reason: string }
> {
  if (permissionPackVersion !== REQUIRED_PERMISSION_PACK) {
    return { available: false, reason: "ADVANCED_FINOPS_PERMISSION_PACK_REQUIRED" };
  }
  const environment = env as unknown as Readonly<Record<string, string | undefined>>;
  try {
    createTrustedAdvisorTaxonomySignatureVerifier(environment);
  } catch {
    return { available: false, reason: "TAXONOMY_SIGNATURE_VERIFIER_NOT_CONFIGURED" };
  }
  try {
    await FinopsEvidenceReferenceSealer.fromEnvironment(environment);
  } catch {
    return { available: false, reason: "FINOPS_EVIDENCE_REFERENCE_KEY_NOT_CONFIGURED" };
  }
  return { available: true, reason: null };
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
    const [latestManifest, dashboard, activation] = await Promise.all([
      repository.getLatestManifest(scope),
      repository.getActiveDashboard(scope, {
        accountId: query.accountId,
        checkId: query.checkId,
        status: query.status,
        region: query.region,
        category: query.category,
        suppressed: query.suppressed,
      }),
      activationState(connection.permissionPackVersion),
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
        officialDefinition: TRUSTED_ADVISOR_ORGANIZATIONAL_OFFICIAL_DEFINITION,
        dashboard: null,
        latestManifest: latestManifest === null ? null : {
          manifestId: latestManifest.manifestId,
          status: latestManifest.status,
          expectedAccountCount: latestManifest.expectedAccountCount,
          finalizedAt: latestManifest.finalizedAtIso,
        },
        activation,
      });
    }

    const freshnessAgeHours = ageHours(dashboard.snapshot.dataThroughAtIso);
    const aFilterIsActive = query.accountId !== null || query.checkId !== null
      || query.status !== null || query.region !== null || query.category !== null
      || query.suppressed !== null;
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
      officialDefinition: TRUSTED_ADVISOR_ORGANIZATIONAL_OFFICIAL_DEFINITION,
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
      activation,
      limitations: [
        "Standard checks are collected independently for each configured account.",
        "Trusted Advisor Priority recommendations are supplemental and are never substituted for standard checks.",
        "The official TA Priority and Well-Architected sheets require separate authoritative provider datasets and remain visibly unavailable when those datasets are absent.",
        "Only the immutable accepted complete generation is rendered; incomplete generations never advance the active head.",
        "Account discovery is server-owned and requires the advanced permission pack, signed Organizations taxonomy verification, and encrypted evidence-reference configuration.",
      ],
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const authenticated = await requireApiSession(request);
    const body = await readBoundedJson(request, BODY_BYTES);
    if (
      typeof body !== "object"
      || body === null
      || Array.isArray(body)
      || Object.keys(body).length !== 1
      || !("connectionId" in body)
      || typeof body.connectionId !== "string"
      || !CONNECTION_ID.test(body.connectionId)
    ) invalidRequest();
    const connection = await getConnectionForOrg(
      authenticated.subject.orgId,
      body.connectionId,
    );
    if (
      connection === null
      || connection.sourceKind !== "aws_trust_role"
      || connection.status !== "active"
    ) notFound();
    assertSessionCapability(authenticated, "sync:run", connection.customerId);
    const activation = await activationState(connection.permissionPackVersion);
    if (!activation.available) {
      throw Object.assign(
        new Error("Trusted Advisor organization collection is not configured"),
        { code: "INVALID_STATE", status: 409 },
      );
    }
    const queued = await enqueueTrustedAdvisorOrganizationActivation(
      new JobQueueRepository(),
      {
        organizationId: authenticated.subject.orgId,
        customerId: connection.customerId,
        connectionId: connection.id,
      },
    );
    return jsonResponse({ ok: true, jobId: queued.jobId }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
