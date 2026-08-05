import { JobQueueRepository } from "../../../../../../db/job-queue-repository";
import { FinopsDataExportObservationRepository } from "../../../../../../db/finops-data-export-observation-repository";
import { getConnectionForOrg } from "../../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../../lib/api-auth";
import { readBoundedJson } from "../../../../../../lib/aws-pilot-security";
import {
  enqueueFinopsDataExportIngestJob,
  FOUNDATIONAL_FINOPS_PERMISSION_PACK,
} from "../../../../../../lib/finops-data-export-ingest-job";
import { errorResponse, jsonResponse } from "../../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const BODY_BYTES = 2 * 1_024;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const OBSERVATION_ID = /^fdo_[a-f0-9]{32}$/u;

function invalid(): never {
  throw Object.assign(
    new Error("The FinOps Data Export ingestion request is invalid"),
    { code: "INVALID_INPUT", status: 400 },
  );
}

/**
 * Authorized production emitter for the durable canonical billing pipeline.
 *
 * Organization and customer scope are always resolved from the authenticated
 * session plus the persisted connection. The browser supplies only a connection
 * and immutable observation id. Manifest coordinates, independent totals and
 * producer attestation are loaded from the server-owned discovery outbox. AWS
 * object access is separately attested by the worker's broker session.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    // This also enforces same-origin before any mutation body is parsed.
    const authenticated = await requireApiSession(request);
    const body = await readBoundedJson(request, BODY_BYTES);
    if (
      typeof body !== "object"
      || body === null
      || Array.isArray(body)
      || Object.keys(body).length !== 2
      || !("connectionId" in body)
      || !("observationId" in body)
      || typeof body.connectionId !== "string"
      || !CONNECTION_ID.test(body.connectionId)
      || typeof body.observationId !== "string"
      || !OBSERVATION_ID.test(body.observationId)
    ) invalid();

    const connection = await getConnectionForOrg(
      authenticated.subject.orgId,
      body.connectionId,
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
    assertSessionCapability(
      authenticated,
      "sync:run",
      connection.customerId,
    );
    if (connection.permissionPackVersion !== FOUNDATIONAL_FINOPS_PERMISSION_PACK) {
      throw Object.assign(
        new Error("The Foundational FinOps permission contract is not active"),
        { code: "INVALID_STATE", status: 409 },
      );
    }

    const observation = await new FinopsDataExportObservationRepository()
      .getExact(
        {
          orgId: authenticated.subject.orgId,
          customerId: connection.customerId,
          connectionId: connection.id,
        },
        body.observationId,
      );
    if (observation === null) {
      throw Object.assign(
        new Error("Billing delivery observation not found"),
        { code: "NOT_FOUND", status: 404 },
      );
    }

    const queued = await enqueueFinopsDataExportIngestJob(
      new JobQueueRepository(),
      {
        orgId: authenticated.subject.orgId,
        customerId: connection.customerId,
        payload: observation.payload,
      },
    );
    return jsonResponse(
      { ok: true, jobId: queued.jobId },
      { status: 202 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
