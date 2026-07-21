import {
  D1HostedBrokerReplayStore,
  resolveHostedBrokerConnectionScope,
} from "../../../../../db/hosted-broker-repository";
import { JobQueueRepository } from "../../../../../db/job-queue-repository";
import {
  hostedBrokerPublicKeyResolver,
  isHostedBrokerIngestEnabled,
} from "../../../../../lib/hosted-broker-ingest-runtime";
import {
  ingestHostedBrokerRequest,
  MAX_HOSTED_BROKER_INGEST_BODY_BYTES,
} from "../../../../../lib/hosted-broker-ingest";
import { HostedBrokerRequestVerifier } from "../../../../../lib/hosted-broker-request-security";

export const dynamic = "force-dynamic";

function json(outcome: { status: number; body: unknown }): Response {
  return new Response(JSON.stringify(outcome.body), {
    status: outcome.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

const notFound = () => json({ status: 404, body: { error: { code: "NOT_FOUND" } } });

/**
 * Hosted broker → app collector ingestion.
 *
 * INERT unless hosted mode is active AND the SUTRA_HOSTED_ENABLED master switch
 * is on: otherwise it answers a flat 404 as if it did not exist. When live,
 * every request is authenticated with an ed25519 signature, mandatory atomic
 * replay protection, and a fail-closed scope check whose expected tenant comes
 * from the persisted connection row — never from the request. The resulting
 * collector job is enqueued on the durable queue under that server-derived org
 * scope. See {@link ingestHostedBrokerRequest}.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isHostedBrokerIngestEnabled()) return notFound();
  const verifier = new HostedBrokerRequestVerifier({
    publicKeys: hostedBrokerPublicKeyResolver(),
    replayStore: new D1HostedBrokerReplayStore(),
    maximumBodyBytes: MAX_HOSTED_BROKER_INGEST_BODY_BYTES,
  });
  const queue = new JobQueueRepository();
  const outcome = await ingestHostedBrokerRequest(request, {
    verifier,
    resolveScope: (connectionId) => resolveHostedBrokerConnectionScope(connectionId),
    enqueue: (input) => queue.enqueue(input),
    maximumBodyBytes: MAX_HOSTED_BROKER_INGEST_BODY_BYTES,
  });
  return json(outcome);
}
