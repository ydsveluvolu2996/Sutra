import {
  FinopsFoundationalConfigRepository,
  type FinopsFoundationalTenantScope,
} from "../../../../../db/finops-foundational-config-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { readBoundedJson } from "../../../../../lib/aws-pilot-security";
import type {
  FinopsOrganizationTaxonomy,
  FinopsTaxonomyAssignment,
} from "../../../../../lib/finops-cost-intelligence";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const BODY_BYTES = 512 * 1_024;
const BODY_KEYS = new Set([
  "connectionId",
  "version",
  "source",
  "sourceEvidenceId",
  "observedAtIso",
  "auditReference",
  "allowLists",
  "assignments",
]);
const ALLOW_LIST_KEYS = new Set([
  "company",
  "business_unit",
  "environment",
  "cost_center",
  "account",
]);
const ASSIGNMENT_KEYS = new Set([
  "accountId",
  "company",
  "businessUnit",
  "environment",
  "costCenter",
  "owner",
]);

function invalid(): never {
  throw Object.assign(
    new Error("The taxonomy request is invalid"),
    { code: "INVALID_INPUT", status: 400 },
  );
}

function exactRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.has(key))
  ) invalid();
  return value as Readonly<Record<string, unknown>>;
}

type ApiSession = Awaited<ReturnType<typeof requireApiSession>>;

async function authorizedScope(
  authenticated: ApiSession,
  connectionId: string,
  capability: "connection:read" | "connection:manage",
): Promise<FinopsFoundationalTenantScope> {
  if (!CONNECTION_ID.test(connectionId)) invalid();
  const connection = await getConnectionForOrg(
    authenticated.subject.orgId,
    connectionId,
  );
  if (
    connection === null
    || connection.sourceKind !== "aws_trust_role"
    || connection.status !== "active"
  ) {
    throw Object.assign(
      new Error("Cloud connection not found"),
      { code: "NOT_FOUND", status: 404 },
    );
  }
  assertSessionCapability(authenticated, capability, connection.customerId);
  return {
    organizationId: authenticated.subject.orgId,
    customerId: connection.customerId,
    connectionId: connection.id,
  };
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 500) invalid();
  for (const entry of value) {
    if (
      typeof entry !== "string"
      || entry.length === 0
      || entry.length > 256
      || entry.includes("\0")
    ) invalid();
  }
  return value as readonly string[];
}

function optionalText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || value.includes("\0")
  ) invalid();
  return value;
}

function assignments(value: unknown): readonly FinopsTaxonomyAssignment[] {
  if (!Array.isArray(value) || value.length > 10_000) invalid();
  return value.map((candidate) => {
    const record = exactRecord(candidate, ASSIGNMENT_KEYS);
    if (
      typeof record.accountId !== "string"
      || !/^\d{12}$/u.test(record.accountId)
    ) invalid();
    return {
      accountId: record.accountId,
      company: optionalText(record.company),
      businessUnit: optionalText(record.businessUnit),
      environment: optionalText(record.environment),
      costCenter: optionalText(record.costCenter),
      owner: optionalText(record.owner),
    };
  });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId")) {
      invalid();
    }
    const connectionId = url.searchParams.get("connectionId") ?? "";
    const authenticated = await requireApiSession(request);
    const scope = await authorizedScope(
      authenticated,
      connectionId,
      "connection:read",
    );
    const active = await new FinopsFoundationalConfigRepository()
      .activeTaxonomy(scope);
    return jsonResponse({ connectionId, active });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    // Authentication performs the mutation same-origin check before body work.
    const authenticated = await requireApiSession(request);
    const body = exactRecord(
      await readBoundedJson(request, BODY_BYTES),
      BODY_KEYS,
    );
    const allowLists = exactRecord(body.allowLists, ALLOW_LIST_KEYS);
    if (
      typeof body.connectionId !== "string"
      || !Number.isSafeInteger(body.version)
      || Number(body.version) < 1
      || !new Set(["aws_organizations", "operator_map", "cmdb"]).has(
        String(body.source),
      )
      || typeof body.sourceEvidenceId !== "string"
      || body.sourceEvidenceId.length === 0
      || body.sourceEvidenceId.length > 1_024
      || typeof body.observedAtIso !== "string"
      || typeof body.auditReference !== "string"
      || body.auditReference.length === 0
      || body.auditReference.length > 1_024
    ) invalid();
    const scope = await authorizedScope(
      authenticated,
      body.connectionId,
      "connection:manage",
    );
    const taxonomy: FinopsOrganizationTaxonomy = {
      scope,
      evidence: {
        source: body.source as FinopsOrganizationTaxonomy["evidence"]["source"],
        sourceEvidenceId: body.sourceEvidenceId,
        observedAtIso: body.observedAtIso,
      },
      allowLists: {
        company: stringArray(allowLists.company),
        business_unit: stringArray(allowLists.business_unit),
        environment: stringArray(allowLists.environment),
        cost_center: stringArray(allowLists.cost_center),
        account: stringArray(allowLists.account),
      },
      assignments: assignments(body.assignments),
    };
    const actorId = authenticated.subject.userId;
    const repository = new FinopsFoundationalConfigRepository();
    const published = await repository.publishTaxonomy(scope, {
      version: Number(body.version),
      taxonomy,
      actorId,
      auditReference: body.auditReference,
    });
    return jsonResponse({ published }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
