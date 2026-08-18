import { getConnectionForOrg, getPilotStateForOrg, listConnectionsForOrg } from "../../../../db/pilot-repository";
import { AgentlessScanRepository } from "../../../../db/agentless-scan-repository";
import { buildAgentlessScanPlan, type AgentlessVolume } from "../../../../lib/aws-agentless-scan-plan";
import type { PilotResource } from "../../../../lib/pilot-types";
import { assertSessionCapability, requireApiSession } from "../../../../lib/api-auth";
import { authorize } from "../../../../lib/auth-policy";
import { assertSameOrigin, readBoundedJson } from "../../../../lib/aws-pilot-security";
import {
  errorResponse,
  getAgentlessExecutionReadiness,
  getAgentlessPlanProfile,
  jsonResponse,
} from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const RUN_ID = /^ags_[a-f0-9]{32}$/u;
const TAG_KEY = /^[A-Za-z0-9 +=._:/@-]{1,128}$/u;
const MAX_BODY_BYTES = 64 * 1024;

// Matches the vocabulary finops-waste already uses, so a volume is identified
// the same way everywhere rather than by a second private guess.
const VOLUME_TYPES = new Set(["aws.ec2.volume", "ec2.volume"]);

function badRequest(): never {
  throw Object.assign(new Error("The agentless scan request is invalid"), { code: "INVALID_INPUT" });
}

async function runtimeReadiness() {
  try {
    return await getAgentlessExecutionReadiness();
  } catch {
    return {
      schema: "sutra.aws-agentless-readiness.v1" as const,
      canPlan: true,
      canExecute: false,
      gaps: [{
        id: "broker-readiness",
        summary: "The authenticated hosted broker readiness could not be verified.",
        owner: "operator" as const,
      }],
      summary:
        "Agentless plans remain reviewable, but execution is fail-closed while "
        + "the signed broker readiness response is unavailable.",
    };
  }
}

/**
 * Collected EBS volumes for one connection, projected onto the planner's input.
 * Reads the CMDB snapshot the collector already produced — planning never calls
 * AWS itself, which is what makes a plan free and reviewable.
 */
function volumesFromSnapshot(resources: readonly PilotResource[]): AgentlessVolume[] {
  const volumes: AgentlessVolume[] = [];
  for (const resource of resources) {
    if (!VOLUME_TYPES.has(resource.resourceType)) continue;
    const configuration = resource.configuration;
    const sizeRaw = configuration["size"] ?? configuration["Size"];
    const encryptedRaw = configuration["encrypted"] ?? configuration["Encrypted"];
    const attachmentsRaw = configuration["attachments"] ?? configuration["Attachments"];
    const attached = Array.isArray(attachmentsRaw)
      ? attachmentsRaw.length > 0
      // An absent attachments field is NOT evidence of detachment. Treating
      // unknown as attached keeps an unattached-only policy from silently
      // pulling in volumes whose state was never collected.
      : resource.state === "in-use";
    volumes.push({
      volumeId: resource.nativeId,
      region: resource.region,
      sizeGiB: typeof sizeRaw === "number" && Number.isFinite(sizeRaw) ? sizeRaw : 0,
      encrypted: encryptedRaw === true,
      attached,
      tags: resource.tags,
    });
  }
  return volumes.sort((left, right) => left.volumeId.localeCompare(right.volumeId, "en-US"));
}

/**
 * List scan runs, or one run with its findings.
 *
 * Always reports execution readiness alongside the data. Agentless scanning has
 * a reviewed plan, persistence and a broker-pinned executor. A caller must be
 * able to tell "no findings because nothing is wrong" apart from "no findings
 * because no scan has ever run", so readiness and neverScanned are returned
 * rather than leaving an empty list to imply the flattering interpretation.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId");
    const runId = url.searchParams.get("runId");
    if (connectionId !== null && !CONNECTION_ID.test(connectionId)) badRequest();
    if (runId !== null && !RUN_ID.test(runId)) badRequest();

    const authenticated = await requireApiSession(request);
    assertSessionCapability(authenticated, "connection:read");
    const orgId = authenticated.subject.orgId;

    // Customer comes from the connection Sutra owns, never from the caller.
    const connections = await listConnectionsForOrg(orgId);
    const scoped = connections.find((entry) =>
      (connectionId === null || entry.id === connectionId) &&
      authorize(authenticated.subject, {
          orgId,
          capability: "connection:read",
          customerId: entry.customerId,
        }).allowed,
    ) ?? null;
    if (scoped === null) {
      return jsonResponse({
        connectionId: null,
        runs: [],
        readiness: await runtimeReadiness(),
        available: false,
        reason: "No AWS connection is readable for this organization.",
      });
    }
    assertSessionCapability(authenticated, "connection:read", scoped.customerId);
    const scope = { orgId, customerId: scoped.customerId };
    const repository = new AgentlessScanRepository();

    if (runId !== null) {
      const run = await repository.getRun(scope, runId);
      if (run === null) {
        throw Object.assign(new Error("Scan run not found"), { code: "NOT_FOUND", status: 404 });
      }
      return jsonResponse({
        run,
        findings: await repository.listFindings(scope, runId),
        outstanding: await repository.listOpenTeardownDebtForCustomer(scope),
        readiness: await runtimeReadiness(),
      });
    }

    const runs = await repository.listRuns(scope, scoped.id);
    return jsonResponse({
      connectionId: scoped.id,
      customerId: scoped.customerId,
      customerName: scoped.customerName,
      runs,
      // Snapshots Sutra created and cannot delete. Surfaced on the list view
      // because it is spend, and spend nobody looks at is spend that persists.
      outstanding: await repository.listOpenTeardownDebtForCustomer(scope),
      readiness: await runtimeReadiness(),
      neverScanned: runs.length === 0,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Build a reviewable scan plan and record it as a run in `planned`.
 *
 * This deliberately does NOT execute. Nothing is created in AWS, no snapshot is
 * taken and no cost is incurred: the row exists so that a later apply is
 * traceable to the exact plan a human approved. Applying is gated on the
 * broker's authenticated execution readiness — see `readiness` in the response,
 * which states the exact configuration or validation gap.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readBoundedJson(request, MAX_BODY_BYTES);
    if (typeof body !== "object" || body === null || Array.isArray(body)) badRequest();
    const allowedKeys = new Set([
      "connectionId", "requiredTagKey", "requiredTagValue", "includeUnattached",
      "maxConcurrentScans", "snapshotTtlHours", "scanners",
    ]);
    if (Object.keys(body as Record<string, unknown>).some((key) => !allowedKeys.has(key))) badRequest();
    const { connectionId, requiredTagKey, requiredTagValue, includeUnattached, maxConcurrentScans, snapshotTtlHours, scanners } = body as {
      connectionId?: unknown;
      requiredTagKey?: unknown; requiredTagValue?: unknown; includeUnattached?: unknown;
      maxConcurrentScans?: unknown; snapshotTtlHours?: unknown; scanners?: unknown;
    };
    if (typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId)) badRequest();
    if (includeUnattached !== undefined && typeof includeUnattached !== "boolean") badRequest();
    if (
      maxConcurrentScans !== undefined &&
      (
        typeof maxConcurrentScans !== "number" ||
        !Number.isInteger(maxConcurrentScans) ||
        maxConcurrentScans < 1 ||
        maxConcurrentScans > 64
      )
    ) badRequest();
    if (
      snapshotTtlHours !== undefined &&
      (
        typeof snapshotTtlHours !== "number" ||
        !Number.isInteger(snapshotTtlHours) ||
        snapshotTtlHours < 1 ||
        snapshotTtlHours > 168
      )
    ) badRequest();
    if (requiredTagKey !== undefined && (typeof requiredTagKey !== "string" || !TAG_KEY.test(requiredTagKey))) badRequest();
    if (requiredTagValue !== undefined && (typeof requiredTagValue !== "string" || !TAG_KEY.test(requiredTagValue))) badRequest();
    if (requiredTagValue !== undefined && requiredTagKey === undefined) badRequest();
    const scannerList = scanners === undefined
      ? undefined
      : Array.isArray(scanners) &&
          scanners.length >= 1 &&
          scanners.length <= 4 &&
          new Set(scanners).size === scanners.length &&
          scanners.every((entry) => entry === "vuln" || entry === "secret" || entry === "sbom" || entry === "malware")
        ? (scanners as readonly ("vuln" | "secret" | "sbom" | "malware")[])
        : badRequest();

    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 });
    }
    // Planning a scan commits the tenant to future snapshot cost, so it is a
    // manage-level action, not a read.
    assertSessionCapability(authenticated, "connection:manage", connection.customerId);
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };

    const state = await getPilotStateForOrg(authenticated.subject.orgId, connectionId);
    const volumes = volumesFromSnapshot(state?.resources ?? []);
    const profile = await getAgentlessPlanProfile();

    const plan = buildAgentlessScanPlan({
      volumes,
      scanAccountId: profile.scanAccountId,
      // The app receives only the non-secret planning property, never a KMS ARN.
      kmsKeyArn: profile.kmsReencrypt ? "broker-pinned" : null,
      policy: {
        ...(requiredTagKey !== undefined
          ? { requiredTags: { [requiredTagKey]: typeof requiredTagValue === "string" ? requiredTagValue : "true" } }
          : {}),
        ...(includeUnattached !== undefined ? { includeUnattached } : {}),
        ...(maxConcurrentScans !== undefined ? { maxConcurrentScans } : {}),
        ...(snapshotTtlHours !== undefined ? { snapshotTtlHours } : {}),
        ...(scannerList !== undefined ? { scanners: scannerList } : {}),
      },
    });

    const repository = new AgentlessScanRepository();
    const run = await repository.createRun(scope, {
      connectionId,
      plan,
      requestedBy: authenticated.subject.userId ?? null,
    });

    return jsonResponse({
      run,
      plan,
      // No snapshot exists yet; only an explicit apply can start execution.
      applied: false,
      readiness: await runtimeReadiness(),
      volumesConsidered: volumes.length,
      snapshotSourcedFrom: state === null ? "none" : "collected-cmdb-snapshot",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
