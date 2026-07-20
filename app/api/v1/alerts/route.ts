import { AlertRuleRepository } from "../../../../db/alert-rule-repository";
import { appendAuditEvent } from "../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { assertSameOrigin, readBoundedJson } from "../../../../lib/aws-pilot-security";
import {
  ALERT_METRIC_DESCRIPTORS,
  isAlertComparator,
  isAlertSeverity,
  isSupportedAlertMetric,
} from "../../../../lib/alert-rules";
import { errorResponse, jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CUSTOMER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,191}$/u;
const RULE_ID = /^arule_[a-f0-9]{32}$/u;
const DESTINATION_ID = /^ndest_[a-f0-9]{32}$/u;
const MAX_THRESHOLD_MAGNITUDE = 1e12;

function invalid(message = "The alert request is invalid"): never {
  throw Object.assign(new Error(message), { code: "INVALID_INPUT", status: 400 });
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in record))
  ) invalid();
  return record;
}

function customerId(value: unknown): string {
  if (typeof value !== "string" || !CUSTOMER_ID.test(value)) invalid();
  return value;
}

function parseRuleInput(value: unknown): {
  readonly name: string;
  readonly metric: string;
  readonly comparator: string;
  readonly threshold: number;
  readonly severity: string;
  readonly enabled: boolean;
  readonly destinationRef: string | null;
} {
  const record = exact(value, ["name", "metric", "comparator", "threshold", "severity", "enabled", "destinationRef"]);
  if (
    typeof record.name !== "string" ||
    !isSupportedAlertMetric(record.metric) ||
    !isAlertComparator(record.comparator) ||
    !isAlertSeverity(record.severity) ||
    typeof record.threshold !== "number" ||
    !Number.isFinite(record.threshold) ||
    Math.abs(record.threshold) > MAX_THRESHOLD_MAGNITUDE ||
    typeof record.enabled !== "boolean" ||
    (record.destinationRef !== null &&
      (typeof record.destinationRef !== "string" || !DESTINATION_ID.test(record.destinationRef)))
  ) invalid();
  return {
    name: record.name,
    metric: record.metric,
    comparator: record.comparator,
    threshold: record.threshold,
    severity: record.severity,
    enabled: record.enabled,
    destinationRef: record.destinationRef as string | null,
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "customerId")) invalid();
    const scopedCustomerId = customerId(url.searchParams.get("customerId"));
    const authenticated = await requireApiSession(request);
    assertSessionCapability(authenticated, "connection:read", scopedCustomerId);
    const scope = { orgId: authenticated.subject.orgId, customerId: scopedCustomerId };
    const repository = new AlertRuleRepository();
    const [rules, events] = await Promise.all([
      repository.list(scope),
      repository.listEvents(scope),
    ]);
    return jsonResponse({
      rules,
      events,
      metrics: ALERT_METRIC_DESCRIPTORS,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const authenticated = await requireApiSession(request);
    const body = await readBoundedJson(request, 16 * 1024);
    if (typeof body !== "object" || body === null || Array.isArray(body)) invalid();
    const record = body as Record<string, unknown>;
    const repository = new AlertRuleRepository();

    if (record.operation === "save") {
      const input = exact(record, ["operation", "customerId", "rule"]);
      const scopedCustomerId = customerId(input.customerId);
      assertSessionCapability(authenticated, "connection:manage", scopedCustomerId);
      const rule = parseRuleInput(input.rule);
      const saved = await repository.save(
        { orgId: authenticated.subject.orgId, customerId: scopedCustomerId },
        rule,
        authenticated.subject.userId,
      );
      await appendAuditEvent({
        orgId: authenticated.subject.orgId,
        actorId: authenticated.subject.userId,
        action: "alerts.rule.saved",
        targetType: "alert_rule",
        targetId: saved.id,
        customerId: scopedCustomerId,
        outcome: "allowed",
        requestId: `alerts.rule.saved:${saved.id}`,
        metadata: { metric: saved.metric, comparator: saved.comparator, severity: saved.severity, enabled: saved.enabled },
      });
      return jsonResponse({ rule: saved }, { status: 201 });
    }

    if (record.operation === "setEnabled") {
      const input = exact(record, ["operation", "customerId", "id", "enabled"]);
      const scopedCustomerId = customerId(input.customerId);
      assertSessionCapability(authenticated, "connection:manage", scopedCustomerId);
      if (typeof input.id !== "string" || !RULE_ID.test(input.id) || typeof input.enabled !== "boolean") invalid();
      const updated = await repository.setEnabled(
        { orgId: authenticated.subject.orgId, customerId: scopedCustomerId },
        input.id,
        input.enabled,
      );
      if (!updated) throw Object.assign(new Error("Alert rule not found"), { code: "NOT_FOUND" });
      await appendAuditEvent({
        orgId: authenticated.subject.orgId,
        actorId: authenticated.subject.userId,
        action: "alerts.rule.enabled_changed",
        targetType: "alert_rule",
        targetId: input.id,
        customerId: scopedCustomerId,
        outcome: "allowed",
        requestId: `alerts.rule.enabled:${input.id}:${input.enabled}`,
        metadata: { enabled: input.enabled },
      });
      return jsonResponse({ updated: true });
    }

    return invalid();
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "customerId" && key !== "id")) invalid();
    const scopedCustomerId = customerId(url.searchParams.get("customerId"));
    const id = url.searchParams.get("id") ?? "";
    if (!RULE_ID.test(id)) invalid();
    const authenticated = await requireApiSession(request);
    assertSessionCapability(authenticated, "connection:manage", scopedCustomerId);
    const deleted = await new AlertRuleRepository().delete(
      { orgId: authenticated.subject.orgId, customerId: scopedCustomerId },
      id,
    );
    if (deleted) {
      await appendAuditEvent({
        orgId: authenticated.subject.orgId,
        actorId: authenticated.subject.userId,
        action: "alerts.rule.deleted",
        targetType: "alert_rule",
        targetId: id,
        customerId: scopedCustomerId,
        outcome: "allowed",
        requestId: `alerts.rule.deleted:${id}`,
        metadata: {},
      });
    }
    return jsonResponse({ deleted });
  } catch (error) {
    return errorResponse(error);
  }
}
