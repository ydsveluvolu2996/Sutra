import { requireRecentMfa } from "../../../../../db/auth-repository";
import {
  createComplianceException,
  listComplianceExceptionOwners,
  listComplianceExceptionReviewers,
  listComplianceExceptions,
  reviewComplianceException,
} from "../../../../../db/compliance-exception-repository";
import { getConnectionForOrg, getPilotStateForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { SUTRA_AWS_BASELINE } from "../../../../../lib/compliance-catalog";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";
import { authorize } from "../../../../../lib/auth-policy";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const EXCEPTION_ID = /^cex_[a-f0-9]{32}$/u;
const FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._:@/#+=-]{0,127}$/u;
const USER_ID = /^usr_[a-f0-9]{32}$/u;

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_INPUT", status: 400 });
}

function text(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string") invalid(`${label} is required`);
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (
    normalized.length < minimum || normalized.length > maximum ||
    /[\u0000-\u001f\u007f<>]/u.test(normalized)
  ) invalid(`${label} must be between ${minimum} and ${maximum} safe characters`);
  return normalized;
}

function connectionIdFrom(value: unknown): string {
  if (typeof value !== "string" || !CONNECTION_ID.test(value)) invalid("The connection identifier is invalid");
  return value;
}

async function scopedConnection(request: Request, connectionId: string, capability: "connection:read" | "finding:manage") {
  const authenticated = await requireApiSession(request);
  const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
  if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
  assertSessionCapability(authenticated, capability, connection.customerId);
  return { authenticated, connection };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId")) invalid("The exception query is invalid");
    const connectionId = connectionIdFrom(url.searchParams.get("connectionId"));
    const { authenticated, connection } = await scopedConnection(request, connectionId, "connection:read");
    const [exceptions, owners, reviewers] = await Promise.all([
      listComplianceExceptions({
        orgId: authenticated.subject.orgId,
        customerId: connection.customerId,
        connectionId,
      }),
      listComplianceExceptionOwners(authenticated.subject.orgId, connection.customerId),
      listComplianceExceptionReviewers(authenticated.subject.orgId, connection.customerId),
    ]);
    return jsonResponse({
      exceptions,
      owners,
      permissions: {
        canRequest: authorize(authenticated.subject, {
          orgId: authenticated.subject.orgId,
          capability: "finding:manage",
          customerId: connection.customerId,
        }).allowed,
        canReview: reviewers.some((reviewer) => reviewer.userId === authenticated.subject.userId),
        reviewRequiresRecentMfa: true,
        localSingleAdminReview:
          reviewers.length === 1 && reviewers[0]?.userId === authenticated.subject.userId,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readBoundedJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) invalid("The exception request is invalid");
    const record = body as Record<string, unknown>;
    const operation = record.operation;
    if (operation !== "request" && operation !== "approve" && operation !== "reject" && operation !== "revoke") {
      invalid("The exception operation is invalid");
    }
    const allowed = operation === "request"
      ? new Set(["operation", "connectionId", "controlKey", "findingFingerprint", "ownerUserId", "rationale", "compensatingControl", "expiresAt"])
      : new Set(["operation", "connectionId", "exceptionId", "reviewNote"]);
    if (Object.keys(record).some((key) => !allowed.has(key))) invalid("The exception request contains unsupported fields");
    const connectionId = connectionIdFrom(record.connectionId);
    const { authenticated, connection } = await scopedConnection(request, connectionId, "finding:manage");

    if (operation === "request") {
      const controlKey = text(record.controlKey, "Control key", 3, 96);
      if (!SUTRA_AWS_BASELINE.controls.some((control) => control.key === controlKey)) invalid("The control key is not in the active baseline");
      if (typeof record.findingFingerprint !== "string" || !FINGERPRINT.test(record.findingFingerprint)) invalid("The finding fingerprint is invalid");
      if (typeof record.ownerUserId !== "string" || !USER_ID.test(record.ownerUserId)) invalid("The exception owner is invalid");
      const rationale = text(record.rationale, "Business rationale", 20, 1_000);
      const compensatingControl = text(record.compensatingControl, "Compensating control", 20, 1_000);
      if (typeof record.expiresAt !== "string") invalid("The exception expiry is invalid");
      const expiresAt = Date.parse(record.expiresAt);
      const now = Date.now();
      if (!Number.isFinite(expiresAt) || expiresAt < now + 60 * 60 * 1_000 || expiresAt > now + 180 * 24 * 60 * 60 * 1_000) {
        invalid("The exception expiry must be between one hour and 180 days from now");
      }
      const state = await getPilotStateForOrg(authenticated.subject.orgId, connectionId);
      const finding = state.findings.find((candidate) => candidate.fingerprint === record.findingFingerprint && candidate.controlKey === controlKey);
      if (finding === undefined || finding.status === "resolved") invalid("The active snapshot does not contain the scoped control finding");
      const created = await createComplianceException({
        orgId: authenticated.subject.orgId,
        customerId: connection.customerId,
        connectionId,
        controlKey,
        findingFingerprint: record.findingFingerprint,
        ownerUserId: record.ownerUserId,
        requestedBy: authenticated.subject.userId,
        rationale,
        compensatingControl,
        expiresAt,
      });
      return jsonResponse({ exception: created }, { status: 201 });
    }

    const reviewers = await listComplianceExceptionReviewers(
      authenticated.subject.orgId,
      connection.customerId,
    );
    if (!reviewers.some((reviewer) => reviewer.userId === authenticated.subject.userId)) {
      throw Object.assign(new Error("Only an organization or customer administrator can review exceptions"), { code: "AUTHORIZATION_DENIED", status: 403 });
    }
    requireRecentMfa(authenticated);
    if (typeof record.exceptionId !== "string" || !EXCEPTION_ID.test(record.exceptionId)) invalid("The exception identifier is invalid");
    const reviewNote = text(record.reviewNote, "Review note", 5, 500);
    const action = operation === "approve" ? "approved" : operation === "reject" ? "rejected" : "revoked";
    const current = (await listComplianceExceptions({
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId,
    })).find((candidate) => candidate.id === record.exceptionId);
    if (current === undefined) throw Object.assign(new Error("Compliance exception not found"), { code: "NOT_FOUND" });
    const otherEligibleReviewerExists = reviewers.some(
      (reviewer) => reviewer.userId !== authenticated.subject.userId,
    );
    if (current.requestedBy === authenticated.subject.userId && otherEligibleReviewerExists) {
      throw Object.assign(
        new Error("A different eligible administrator must review this exception"),
        { code: "AUTHORIZATION_DENIED", status: 403 },
      );
    }
    const updated = await reviewComplianceException({
      orgId: authenticated.subject.orgId,
      customerId: connection.customerId,
      connectionId,
      exceptionId: record.exceptionId,
      actorId: authenticated.subject.userId,
      action,
      reviewNote,
      selfReviewed: current.requestedBy === authenticated.subject.userId,
    });
    return jsonResponse({ exception: updated });
  } catch (error) {
    return errorResponse(error);
  }
}
