/**
 * Shared outbound ITSM ticket delivery.
 *
 * Extracted so the synchronous dispatch route and the durable background-job
 * handler deliver identically: same ticket shape, same HMAC signature, same
 * timeout. Pure except for the injected fetch — it imports only from the pure
 * `./itsm-sync.ts` mapping module (no db/ or cloudflare:workers imports) so it
 * runs unchanged inside the worker runtime and under a plain node test that
 * supplies a stub fetch.
 *
 * Honesty rule: the result is exactly what the transport observed — `delivered`
 * is the response's own `ok`, `statusCode` is the received status, and a network
 * failure is reported by its error name. Nothing about delivery is inferred.
 */
import {
  buildOutboundTicket,
  signOutboundBody,
  type ItsmCaseLike,
  type ItsmConnectorType,
} from "./itsm-sync.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const PAYLOAD_PREVIEW_LIMIT = 500;

export interface ItsmDeliveryConnector {
  readonly baseUrl: string;
  readonly sharedSecret: string;
  readonly connectorType: ItsmConnectorType;
  readonly projectKey: string | null;
}

export interface ItsmDeliveryResult {
  readonly delivered: boolean;
  readonly statusCode?: number;
  readonly error?: string;
  readonly payloadPreview: string;
}

export async function deliverItsmTicket(input: {
  readonly connector: ItsmDeliveryConnector;
  readonly itsmCase: ItsmCaseLike;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<ItsmDeliveryResult> {
  const { connector, itsmCase } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const ticket = buildOutboundTicket(itsmCase, connector.connectorType, connector.projectKey);
  const outboundBody = JSON.stringify(ticket.payload);
  const payloadPreview = outboundBody.slice(0, PAYLOAD_PREVIEW_LIMIT);
  const signature = await signOutboundBody(connector.sharedSecret, outboundBody);
  try {
    const response = await fetchImpl(connector.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sutra-signature": signature,
      },
      body: outboundBody,
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    return { delivered: response.ok, statusCode: response.status, payloadPreview };
  } catch (caught) {
    return { delivered: false, error: caught instanceof Error ? caught.name : "dispatch-error", payloadPreview };
  }
}
