import { env } from "cloudflare:workers";
import { EvidenceRepository } from "../../../../../db/evidence-repository";
import { PricingChangeMaterializationRepository } from "../../../../../db/finops-pricing-change-repository";
import { FinopsSourceJobLedgerRepository } from "../../../../../db/finops-source-job-ledger-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import {
  buildPricingChangeAnalysis,
  type PricingChangeCapture,
  type PricingChangeSnapshot,
  type PricingChangeTenantBoundary,
} from "../../../../../lib/finops-pricing-change-analysis";
import { FinopsEvidenceReferenceSealer } from "../../../../../lib/finops-source-evidence-reference";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ALLOWED_QUERY_PARAMETERS = new Set(["connectionId"]);
const SOURCE_ID = "aws_pricing_catalog" as const;
const EVIDENCE_SCHEMA = "sutra.pricing-change.capture-evidence.v1";

function invalidRequest(): never {
  throw Object.assign(new Error("The Pricing Change Analysis request is invalid"), {
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

function parseConnectionId(request: Request): string {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) {
    if (!ALLOWED_QUERY_PARAMETERS.has(key)) invalidRequest();
  }
  if (parameters.getAll("connectionId").length !== 1) invalidRequest();
  const connectionId = parameters.get("connectionId") ?? "";
  if (!CONNECTION_ID.test(connectionId)) invalidRequest();
  return connectionId;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evidencePayload(value: unknown): {
  readonly boundary: PricingChangeTenantBoundary;
  readonly capture: PricingChangeCapture;
} {
  if (
    !isRecord(value)
    || Object.keys(value).sort().join("\0") !== [
      "boundary", "capture", "schemaVersion",
    ].sort().join("\0")
    || value.schemaVersion !== EVIDENCE_SCHEMA
    || !isRecord(value.boundary)
    || !isRecord(value.capture)
  ) throw new Error("PRICING_CHANGE_EVIDENCE_INVALID");
  return {
    boundary: value.boundary as unknown as PricingChangeTenantBoundary,
    capture: value.capture as unknown as PricingChangeCapture,
  };
}

function sourceStateFor(
  snapshot: PricingChangeSnapshot,
): "configuration_required" | "partial" | "stale" | "empty" | "complete" {
  switch (snapshot.state) {
    case "READY": return "complete";
    case "PARTIAL": return "partial";
    case "CONFIGURATION_REQUIRED": return "configuration_required";
    case "STALE": return "stale";
    case "NO_USAGE": return "empty";
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const connectionId = parseConnectionId(request);
    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(
      authenticated.subject.orgId,
      connectionId,
    );
    if (
      connection === null
      || connection.sourceKind !== "aws_trust_role"
      || connection.status !== "active"
    ) notFound();
    assertSessionCapability(
      authenticated,
      "connection:read",
      connection.customerId,
    );

    const scope = {
      organizationId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId: connection.id,
    };
    const repository = new PricingChangeMaterializationRepository();
    const ledger = new FinopsSourceJobLedgerRepository();
    const [active, latest, summary] = await Promise.all([
      repository.getActive(scope),
      repository.getLatest(scope),
      ledger.summarize(scope, SOURCE_ID),
    ]);
    const latestAttempt = summary.sources[0]?.latestAttempt ?? null;
    const selected = latest ?? active;
    if (selected === null) {
      const sourceState = latestAttempt?.status === "queued"
        || latestAttempt?.status === "running"
        ? "waiting"
        : latestAttempt?.status === "failed"
          || latestAttempt?.status === "cancelled"
          ? "failed"
          : latestAttempt?.status === "partial"
            ? "partial"
            : "configuration_required";
      return jsonResponse({
        schema: "sutra.finops-pricing-change-dashboard.v1",
        connectionId,
        source: "VERSIONED_AWS_PRICE_LIST_BULK_FILES_AND_ACTIVE_CUR2_USAGE",
        sourceState,
        latestAttemptStatus: latestAttempt?.status ?? null,
        report: null,
        evidence: null,
        activation: {
          available: false,
          reason: "PRICING_CHANGE_CAPTURE_MATERIALIZER_NOT_IMPLEMENTED",
        },
        limitations: [
          "No browser-supplied catalog, price, usage, payer, account, or Region evidence is accepted.",
          "Public AWS catalog modeling is informational and is not an invoice, quote, discount, forecast, or savings claim.",
        ],
      });
    }

    try {
      const sealer = await FinopsEvidenceReferenceSealer.fromEnvironment(
        env as unknown as Readonly<Record<string, string | undefined>>,
      );
      const objectId = await sealer.open(selected.evidenceReference, {
        organizationId: scope.organizationId,
        customerId: scope.customerId,
        connectionId: scope.connectionId,
        sourceId: SOURCE_ID,
        generationId: selected.evidenceGenerationId,
      });
      const stored = await new EvidenceRepository().readFinopsSourceSnapshot({
        scope: {
          orgId: scope.organizationId,
          customerId: scope.customerId,
          connectionId: scope.connectionId,
        },
        objectId,
        snapshotId: selected.evidenceGenerationId,
        contentSha256: selected.contentSha256,
      });
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(stored.body);
      const payload = evidencePayload(JSON.parse(decoded) as unknown);
      const report = buildPricingChangeAnalysis(
        payload.boundary,
        payload.capture,
        new Date(),
      );
      if (
        report.scope.orgId !== scope.organizationId
        || report.scope.customerId !== scope.customerId
        || report.scope.connectionId !== scope.connectionId
        || report.collectionId !== selected.snapshotId
        || report.usagePeriodStartAt !== selected.usagePeriodStartAt
        || report.usagePeriodEndAt !== selected.usagePeriodEndAt
        || report.baselineEffectiveAt !== selected.baselineEffectiveAt
        || report.comparisonEffectiveAt !== selected.comparisonEffectiveAt
        || report.activeCur2GenerationId !== selected.activeCur2GenerationId
      ) throw new Error("PRICING_CHANGE_EVIDENCE_MISMATCH");

      const attemptState = latestAttempt?.status === "failed"
        || latestAttempt?.status === "cancelled"
        ? "failed"
        : latestAttempt?.status === "queued" || latestAttempt?.status === "running"
          ? "waiting"
          : latestAttempt?.status === "partial"
            ? "partial"
            : null;
      return jsonResponse({
        schema: "sutra.finops-pricing-change-dashboard.v1",
        connectionId,
        source: "VERSIONED_AWS_PRICE_LIST_BULK_FILES_AND_ACTIVE_CUR2_USAGE",
        sourceState: attemptState ?? sourceStateFor(report),
        latestAttemptStatus: latestAttempt?.status ?? null,
        report,
        evidence: {
          snapshotId: selected.snapshotId,
          evidenceGenerationId: selected.evidenceGenerationId,
          contentSha256: selected.contentSha256,
          capturedAt: selected.capturedAt,
          active: active?.snapshotId === selected.snapshotId,
        },
        activation: {
          available: false,
          reason: "PRICING_CHANGE_CAPTURE_MATERIALIZER_NOT_IMPLEMENTED",
        },
        limitations: [
          "Actual usage is held constant while public catalog rates at two effective dates are compared.",
          "Private pricing, credits, taxes, support, refunds, commitment-benefit allocation, and currency conversion are excluded.",
          "AWS Price List files are informational; this dashboard is not an invoice, quote, forecast, discount calculation, or savings claim.",
          "Collection activation remains disabled until the server-owned CUR2-to-catalog capture materializer is implemented and provider-accepted.",
        ],
      });
    } catch {
      return jsonResponse({
        schema: "sutra.finops-pricing-change-dashboard.v1",
        connectionId,
        source: "VERSIONED_AWS_PRICE_LIST_BULK_FILES_AND_ACTIVE_CUR2_USAGE",
        sourceState: "failed",
        latestAttemptStatus: latestAttempt?.status ?? null,
        report: null,
        evidence: {
          snapshotId: selected.snapshotId,
          evidenceGenerationId: selected.evidenceGenerationId,
          contentSha256: selected.contentSha256,
          capturedAt: selected.capturedAt,
          active: active?.snapshotId === selected.snapshotId,
        },
        activation: {
          available: false,
          reason: "PRICING_CHANGE_CAPTURE_MATERIALIZER_NOT_IMPLEMENTED",
        },
        limitations: [
          "The retained evidence object could not be independently rebound and validated; no modeled values are returned.",
        ],
      });
    }
  } catch (error) {
    return errorResponse(error);
  }
}
