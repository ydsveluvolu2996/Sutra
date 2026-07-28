import { env } from "cloudflare:workers";

import { AgentlessScanRepository } from "../../../../../../db/agentless-scan-repository";
import { getConnectionForOrg } from "../../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../../lib/api-auth";
import {
  describeAgentlessConfigGap,
  resolveAgentlessExecutorConfig,
  type AgentlessConfigSource,
} from "../../../../../../lib/aws-agentless-executor-config";
import {
  AGENTLESS_SCAN_EXECUTION_READINESS,
  isAgentlessExecutionReady,
} from "../../../../../../lib/aws-agentless-readiness";
import { assertSameOrigin, readBoundedJson } from "../../../../../../lib/aws-pilot-security";
import { errorResponse, jsonResponse } from "../../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const MAX_BODY_BYTES = 2_048;

function badRequest(): never {
  throw Object.assign(new Error("Agentless execute request rejected"), { code: "INVALID_INPUT" });
}

/**
 * Applies a previously-computed agentless scan plan.
 *
 * ── WHY THIS ROUTE REFUSES TODAY, AND WHY THAT IS THE POINT ─────────────────
 * Every other piece of agentless scanning exists: the customer IAM grant with its
 * no-delete deny, the separate STS session ceiling, the EC2 executor, the scanner
 * container, the teardown sweeper, the findings normalizer, and the three tables.
 * What never existed is the call that starts a scan — `executeAgentlessScan` had no
 * caller at all, which meant the feature could not be used and, worse, could not be
 * honestly described as built.
 *
 * This route is that call, and it is deliberately written to REFUSE rather than to
 * pretend. While the readiness gaps are open or the executor configuration is
 * incomplete it returns 409 naming exactly what is missing, and it does NOT mark the
 * run as running, does NOT create a snapshot, and does NOT record findings.
 *
 * That distinction matters more here than almost anywhere else in the product. A
 * scan that silently did nothing would leave a run row with zero findings, and zero
 * findings is indistinguishable from "this disk is clean" once it reaches the
 * vulnerability queue. Refusing loudly keeps "nothing looked" and "nothing is wrong"
 * separate facts.
 *
 * When the gaps close this route works without a code change: the readiness gate and
 * the config resolver are the only things between it and a real scan.
 */
export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly runId: string }> },
): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { runId } = await context.params;
    if (typeof runId !== "string" || !RUN_ID.test(runId)) badRequest();

    // connectionId is required, and it is what establishes the tenant. The
    // repository scopes every read by org AND customer on purpose — "a run id is not
    // a capability" — so there is no cross-customer lookup by id, and this route
    // must not invent one. The connection record is the authority for customerId;
    // the caller never supplies it.
    const body = await readBoundedJson(request, MAX_BODY_BYTES);
    if (typeof body !== "object" || body === null || Array.isArray(body)) badRequest();
    const { connectionId } = body as { connectionId?: unknown };
    if (typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId)) badRequest();

    const authenticated = await requireApiSession(request);
    const orgId = authenticated.subject.orgId;
    const connection = await getConnectionForOrg(orgId, connectionId);
    if (connection === null) {
      throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND", status: 404 });
    }
    // Executing commits real AWS spend in the customer's account, so this is a
    // manage-level action — the same bar as planning, deliberately not lower.
    assertSessionCapability(authenticated, "connection:manage", connection.customerId);

    const scope = { orgId, customerId: connection.customerId };
    const repository = new AgentlessScanRepository();
    const run = await repository.getRun(scope, runId);
    // A run belonging to another customer is indistinguishable from one that does
    // not exist, which is the correct answer to give.
    if (run === null || run.connectionId !== connectionId) {
      throw Object.assign(new Error("Agentless scan run not found"), { code: "NOT_FOUND", status: 404 });
    }
    if (run.status !== "planned") {
      throw Object.assign(
        new Error(`This run is '${run.status}'. Only a planned run can be applied; terminal runs are never re-opened.`),
        { code: "CONFLICT", status: 409 },
      );
    }

    const configuration = resolveAgentlessExecutorConfig(env as unknown as AgentlessConfigSource);
    const ready = isAgentlessExecutionReady() && configuration.available;

    if (!ready) {
      // 409, not 200-with-a-flag and not 500. The request was well formed and
      // authorized; the system is not in a state where it may act. Nothing has been
      // mutated: the run stays 'planned' and remains applicable later.
      return jsonResponse({
        applied: false,
        runId,
        status: run.status,
        readiness: AGENTLESS_SCAN_EXECUTION_READINESS,
        configuration: configuration.available
          ? { available: true as const }
          : {
            available: false as const,
            missing: configuration.missing,
            invalid: configuration.invalid,
            summary: describeAgentlessConfigGap(configuration),
          },
        // Stated so no caller can read this response as a completed clean scan.
        interpretation:
          "No scan ran. No snapshot was created, nothing was billed, and no findings were "
          + "recorded. This run is unchanged and can be applied once the gaps above are "
          + "closed. Do NOT read an empty findings list for this run as evidence that any "
          + "volume is clean.",
      }, { status: 409 });
    }

    /* c8 ignore start — unreachable until the readiness gaps close. Not unit-tested
       on purpose: every statement past this point makes a real AWS call that creates
       billable resources, so it is validated by the live runbook instead. */
    throw Object.assign(
      new Error(
        "Agentless execution is configured and attested, but this deployment has no "
        + "orchestrator client factory. Constructing an Ec2AgentlessExecutor needs STS "
        + "clients for both the customer role (under agentlessSnapshotSessionPolicy) and "
        + "the Sutra scan account; see docs/agentless-snapshot-scanning-design.md.",
      ),
      { code: "NOT_CONFIGURED", status: 503 },
    );
    /* c8 ignore stop */
  } catch (error) {
    return errorResponse(error);
  }
}
