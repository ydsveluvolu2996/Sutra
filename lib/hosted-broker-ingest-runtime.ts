import { env } from "cloudflare:workers";
import { isHostedOidcRuntime } from "./api-auth";
import type { HostedBrokerPublicKeyResolver } from "./hosted-broker-request-security";

interface HostedBrokerIngestEnvironment {
  readonly SUTRA_BROKER_PUSH_INGEST_ENABLED?: string;
  readonly SUTRA_BROKER_PUBLIC_KEYS?: string;
}

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const MAX_KEYS_BYTES = 64 * 1024;

function runtime(): HostedBrokerIngestEnvironment {
  return env as unknown as HostedBrokerIngestEnvironment;
}

/**
 * The hosted broker ingestion endpoint is INERT unless the deployment is a
 * hosted OIDC runtime AND the legacy push-ingest switch is the exact string
 * "true". The production hosted broker uses authenticated app-to-broker
 * request/response calls and does not enable this superseded callback surface.
 */
export function isHostedBrokerIngestEnabled(): boolean {
  return isHostedOidcRuntime() &&
    runtime().SUTRA_BROKER_PUSH_INGEST_ENABLED === "true";
}

/**
 * Resolve broker signing keys from managed configuration.
 *
 * SUTRA_BROKER_PUBLIC_KEYS is a JSON object mapping each tenant to its set of
 * key ids and ed25519 public keys (SPKI PEM):
 *   { "<tenantId>": { "<keyId>": "-----BEGIN PUBLIC KEY-----\n..." } }
 *
 * The lookup is strictly by the (tenantId, keyId) the verifier derived from
 * trusted server state and the signed headers. An unknown tenant or key returns
 * null, which the verifier treats as AUTHENTICATION_FAILED (fail closed). The
 * key material itself is validated as ed25519 by the verifier.
 */
export function hostedBrokerPublicKeyResolver(): HostedBrokerPublicKeyResolver {
  return {
    async resolve({ tenantId, keyId }) {
      if (!TENANT_ID.test(tenantId) || !KEY_ID.test(keyId)) return null;
      const raw = runtime().SUTRA_BROKER_PUBLIC_KEYS?.trim();
      if (!raw || new TextEncoder().encode(raw).length > MAX_KEYS_BYTES) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const tenantKeys = (parsed as Record<string, unknown>)[tenantId];
      if (tenantKeys === null || typeof tenantKeys !== "object" || Array.isArray(tenantKeys)) return null;
      const pem = (tenantKeys as Record<string, unknown>)[keyId];
      if (typeof pem !== "string" || pem.length < 32 || pem.length > 4096) return null;
      return pem;
    },
  };
}
