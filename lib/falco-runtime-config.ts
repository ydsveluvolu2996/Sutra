import { env } from "cloudflare:workers";
import type { FalcoCredentialResolver } from "./falco-request-security";

interface FalcoRuntimeEnv {
  readonly SUTRA_FALCO_INGESTION_KEYS_JSON?: string;
}

const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function decodeSecret(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43,172}$/u.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength >= 32 && decoded.byteLength <= 128
      ? new Uint8Array(decoded)
      : null;
  } catch {
    return null;
  }
}

/**
 * Server-only rotating sensor credentials. Shape:
 * `{"kcluster_...":{"current":"<base64url 32+ bytes>","previous":"..."}}`.
 * Key material is never written to the Sutra database.
 */
export class EnvironmentFalcoCredentialResolver implements FalcoCredentialResolver {
  public async resolve(input: {
    readonly clusterId: string;
    readonly keyId: string;
  }): Promise<Uint8Array | null> {
    if (!CLUSTER_ID.test(input.clusterId) || !KEY_ID.test(input.keyId)) return null;
    const source = (env as unknown as FalcoRuntimeEnv).SUTRA_FALCO_INGESTION_KEYS_JSON ??
      process.env.SUTRA_FALCO_INGESTION_KEYS_JSON;
    if (source === undefined || source.length < 2 || source.length > 64 * 1024) return null;
    try {
      const root = JSON.parse(source) as unknown;
      if (typeof root !== "object" || root === null || Array.isArray(root)) return null;
      const cluster = (root as Record<string, unknown>)[input.clusterId];
      if (typeof cluster !== "object" || cluster === null || Array.isArray(cluster)) return null;
      return decodeSecret((cluster as Record<string, unknown>)[input.keyId]);
    } catch {
      return null;
    }
  }
}
