import { getRawDb } from "./index.ts";
import { ensureRuntimeSchema } from "./runtime-migrations.ts";

/**
 * Atomically reserves a verified assertion ID. Storage failure and duplicate
 * assertion IDs both deny sign-in; assertions are never accepted unmetered.
 */
export async function consumeSamlAssertion(
  identityIssuer: string,
  assertionId: string,
  expiresAt: number,
  now = Date.now(),
): Promise<void> {
  if (
    !identityIssuer.startsWith("https://")
    || identityIssuer.length > 2048
    || !/^_[A-Za-z0-9._:-]{8,255}$/u.test(assertionId)
    || !Number.isSafeInteger(expiresAt)
    || expiresAt <= now
    || expiresAt > now + 11 * 60_000
  ) throw new Error("SAML assertion replay reservation is invalid");
  const database = getRawDb();
  await ensureRuntimeSchema(database);
  try {
    await database.prepare(
      `DELETE FROM saml_assertion_replays WHERE expires_at <= ?`,
    ).bind(now).run();
    const reserved = await database.prepare(
      `INSERT INTO saml_assertion_replays (identity_issuer, assertion_id, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(identity_issuer, assertion_id) DO NOTHING
       RETURNING assertion_id`,
    ).bind(identityIssuer, assertionId, expiresAt).first<{ assertion_id: string }>();
    if (reserved === null) throw new Error("SAML assertion was already used");
  } catch (error) {
    if (error instanceof Error && error.message === "SAML assertion was already used") throw error;
    throw new Error("SAML assertion replay protection is unavailable");
  }
}
