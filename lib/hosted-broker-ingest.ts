import { Buffer } from "node:buffer";
import {
  HostedBrokerRequestSecurityError,
  type HostedBrokerRequestVerifier,
} from "./hosted-broker-request-security";
import type { HostedBrokerConnectionScope } from "../db/hosted-broker-repository";

/** The collector job kind an ingested broker payload is enqueued under. */
export const HOSTED_BROKER_INGEST_JOB_KIND = "hosted.broker.ingest";

/** Body cap: bounded so the base64 payload stays under the durable queue limit. */
export const MAX_HOSTED_BROKER_INGEST_BODY_BYTES = 96 * 1024;

export interface HostedBrokerEnqueueInput {
  readonly orgId: string;
  readonly customerId: string | null;
  readonly kind: string;
  readonly payload: unknown;
}

export interface HostedBrokerIngestDependencies {
  readonly verifier: HostedBrokerRequestVerifier;
  readonly resolveScope: (connectionId: string) => Promise<HostedBrokerConnectionScope | null>;
  readonly enqueue: (input: HostedBrokerEnqueueInput) => Promise<{ readonly id: string }>;
  readonly maximumBodyBytes?: number;
}

export interface HostedBrokerIngestOutcome {
  readonly status: number;
  readonly body: { readonly ok: true; readonly jobId: string } | { readonly error: { readonly code: string } };
}

function reject(code: string, status: number): HostedBrokerIngestOutcome {
  return { status, body: { error: { code } } };
}

function singleHeaderValue(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  return value === null || value.includes(",") ? null : value;
}

const SECURITY_STATUS: Readonly<Record<HostedBrokerRequestSecurityError["code"], number>> = {
  INVALID_REQUEST: 400,
  BODY_TOO_LARGE: 413,
  AUTHENTICATION_FAILED: 401,
  SCOPE_MISMATCH: 403,
  REQUEST_REPLAYED: 409,
};

/**
 * Authenticate and ingest ONE hosted broker → app request, then enqueue a
 * collector job carrying its SERVER-DERIVED org scope.
 *
 * Security properties:
 *  - The org (tenant) and customer are resolved from the persisted connection
 *    row (`resolveScope`), keyed only by the connection id. No tenant identity
 *    is ever taken from the request body or trusted from the caller.
 *  - Every request is verified via {@link HostedBrokerRequestVerifier}: ed25519
 *    signature over a canonical string, mandatory atomic replay protection, and
 *    a fail-closed scope check where the expected tenant/connection come from
 *    the resolved server state (SCOPE_MISMATCH otherwise). The broker job id is
 *    the caller's signed idempotency reference — it is bound by the signature
 *    but is never a tenancy boundary.
 *  - The body is bounded before and during verification.
 *  - The enqueue uses the resolved org/customer; the queue re-checks the org and
 *    customer are active, so the scope is validated a second time server-side.
 */
export async function ingestHostedBrokerRequest(
  request: Request,
  deps: HostedBrokerIngestDependencies,
): Promise<HostedBrokerIngestOutcome> {
  try {
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;

    const connectionId = singleHeaderValue(request.headers, "x-sutra-connection-id");
    if (connectionId === null) return reject("AUTHENTICATION_FAILED", 401);

    // Server-state scope resolution. This is the authoritative org/customer and
    // never derives from the request beyond using the connection id as a key.
    const scope = await deps.resolveScope(connectionId);
    if (scope === null) return reject("NOT_FOUND", 404);

    const maximumBodyBytes = deps.maximumBodyBytes ?? MAX_HOSTED_BROKER_INGEST_BODY_BYTES;
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maximumBodyBytes) return reject("BODY_TOO_LARGE", 413);
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > maximumBodyBytes) return reject("BODY_TOO_LARGE", 413);

    const brokerJobId = singleHeaderValue(request.headers, "x-sutra-job-id");
    const verified = await deps.verifier.verify({
      method: request.method,
      path,
      headers: request.headers,
      body,
      // Expected tenant + connection are the DB's, not the caller's declared
      // values; a mismatch fails closed inside the verifier as SCOPE_MISMATCH.
      expectedScope: {
        tenantId: scope.tenantId,
        connectionId: scope.connectionId,
        jobId: brokerJobId ?? "",
      },
    });

    const job = await deps.enqueue({
      orgId: scope.tenantId,
      customerId: scope.customerId,
      kind: HOSTED_BROKER_INGEST_JOB_KIND,
      payload: {
        connectionId: scope.connectionId,
        brokerJobId: verified.jobId,
        keyId: verified.keyId,
        bodySha256: verified.bodySha256,
        byteLength: body.byteLength,
        bodyBase64: Buffer.from(body).toString("base64"),
      },
    });
    return { status: 202, body: { ok: true, jobId: job.id } };
  } catch (error) {
    if (error instanceof HostedBrokerRequestSecurityError) {
      return reject(error.code, SECURITY_STATUS[error.code]);
    }
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "SCOPE_NOT_FOUND") return reject("NOT_FOUND", 404);
    if (code === "INVALID_INPUT") return reject("INVALID_INPUT", 400);
    return reject("REQUEST_FAILED", 500);
  }
}
