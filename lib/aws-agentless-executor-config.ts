/**
 * Resolves the configuration an agentless scan needs before it may execute.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `AGENTLESS_SCAN_EXECUTION_READINESS` states the remaining gaps in prose, which is
 * right for a human reading a panel and useless for a code path deciding whether it
 * may act. This module turns the same gaps into named values that are either present
 * or absent, so the apply path can refuse with "these four settings are missing"
 * instead of "not ready", and so closing a gap is a config change rather than a code
 * change.
 *
 * The deliberate design point: there is NO default for any of these. A default
 * scan-account id or a default KMS key would let a misconfigured deployment start
 * snapshotting into the wrong account, which is precisely the failure this whole
 * subsystem is built to make impossible. Absent means refuse.
 */

export interface AgentlessExecutorSettings {
  /** The Sutra-operated account that receives shared snapshots. */
  readonly scanAccountId: string;
  /** AZ in the scan account where the copied volume is attached. */
  readonly scanAvailabilityZone: string;
  /** CMK used to re-encrypt the snapshot copy. Null is legal: unencrypted source. */
  readonly kmsKeyArn: string | null;
  /** The scanner container image, by digest. */
  readonly scannerImage: string;
  /**
   * Set only by an operator who has validated every EC2 call in
   * services/agentless-scanner against a live account. The executor refuses to act
   * without it, and this flag is the single place that claim is recorded.
   */
  readonly liveValidated: boolean;
}

export type AgentlessConfigResolution =
  | { readonly available: true; readonly settings: AgentlessExecutorSettings }
  | {
    readonly available: false;
    /** Env var names that are unset or malformed, in a stable order. */
    readonly missing: readonly string[];
    /** Values present but rejected, with why — distinct from simply absent. */
    readonly invalid: readonly { readonly name: string; readonly reason: string }[];
  };

const ACCOUNT_ID = /^\d{12}$/u;
const AVAILABILITY_ZONE = /^[a-z]{2}(-gov)?-[a-z]+-\d[a-z]$/u;
const KMS_KEY_ARN = /^arn:aws(-us-gov|-cn)?:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/u;
/** Digest-pinned only. A mutable tag would make a finding unattributable to a scanner build. */
const IMAGE_DIGEST = /^[a-z0-9.\-_/:]+@sha256:[0-9a-f]{64}$/u;

export interface AgentlessConfigSource {
  readonly SUTRA_AGENTLESS_SCAN_ACCOUNT_ID?: string | undefined;
  readonly SUTRA_AGENTLESS_SCAN_AZ?: string | undefined;
  readonly SUTRA_AGENTLESS_KMS_KEY_ARN?: string | undefined;
  readonly SUTRA_AGENTLESS_SCANNER_IMAGE?: string | undefined;
  readonly SUTRA_AGENTLESS_LIVE_VALIDATED?: string | undefined;
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

export function resolveAgentlessExecutorConfig(
  source: AgentlessConfigSource,
): AgentlessConfigResolution {
  const missing: string[] = [];
  const invalid: { name: string; reason: string }[] = [];

  const accountId = trimmed(source.SUTRA_AGENTLESS_SCAN_ACCOUNT_ID);
  if (accountId === undefined) missing.push("SUTRA_AGENTLESS_SCAN_ACCOUNT_ID");
  else if (!ACCOUNT_ID.test(accountId)) {
    invalid.push({ name: "SUTRA_AGENTLESS_SCAN_ACCOUNT_ID", reason: "must be a 12-digit AWS account id" });
  }

  const az = trimmed(source.SUTRA_AGENTLESS_SCAN_AZ);
  if (az === undefined) missing.push("SUTRA_AGENTLESS_SCAN_AZ");
  else if (!AVAILABILITY_ZONE.test(az)) {
    invalid.push({ name: "SUTRA_AGENTLESS_SCAN_AZ", reason: "must be an availability zone such as ap-south-1a" });
  }

  // Absent is legal and means "the source snapshot is not encrypted". Present but
  // malformed is not: a typo'd key ARN would fail mid-scan after a snapshot already
  // exists and is already billing.
  const kmsKeyArn = trimmed(source.SUTRA_AGENTLESS_KMS_KEY_ARN);
  if (kmsKeyArn !== undefined && !KMS_KEY_ARN.test(kmsKeyArn)) {
    invalid.push({ name: "SUTRA_AGENTLESS_KMS_KEY_ARN", reason: "must be a full KMS key ARN" });
  }

  const scannerImage = trimmed(source.SUTRA_AGENTLESS_SCANNER_IMAGE);
  if (scannerImage === undefined) missing.push("SUTRA_AGENTLESS_SCANNER_IMAGE");
  else if (!IMAGE_DIGEST.test(scannerImage)) {
    invalid.push({
      name: "SUTRA_AGENTLESS_SCANNER_IMAGE",
      reason: "must be pinned by digest (repo@sha256:...); a mutable tag makes a finding unattributable",
    });
  }

  // Only the exact string "true" counts. Anything else — "1", "yes", "TRUE" — is
  // treated as not validated, because this flag is an operator attesting that they
  // checked every AWS call by hand, and a near-miss must not be read as that claim.
  const liveValidatedRaw = trimmed(source.SUTRA_AGENTLESS_LIVE_VALIDATED);
  if (liveValidatedRaw === undefined) missing.push("SUTRA_AGENTLESS_LIVE_VALIDATED");
  else if (liveValidatedRaw !== "true" && liveValidatedRaw !== "false") {
    invalid.push({
      name: "SUTRA_AGENTLESS_LIVE_VALIDATED",
      reason: 'must be exactly "true" or "false"; this flag records an operator attestation, so an ambiguous value is refused',
    });
  }

  if (missing.length > 0 || invalid.length > 0) {
    return { available: false, missing, invalid };
  }
  if (liveValidatedRaw !== "true") {
    // Configured but explicitly not attested. Reported as missing the attestation
    // rather than as a config error, because that is what it is.
    return {
      available: false,
      missing: ["SUTRA_AGENTLESS_LIVE_VALIDATED=true"],
      invalid: [],
    };
  }

  return {
    available: true,
    settings: {
      scanAccountId: accountId as string,
      scanAvailabilityZone: az as string,
      kmsKeyArn: kmsKeyArn ?? null,
      scannerImage: scannerImage as string,
      liveValidated: true,
    },
  };
}

/** One-line summary for an API response or a log line. */
export function describeAgentlessConfigGap(resolution: AgentlessConfigResolution): string {
  if (resolution.available) return "Agentless execution configuration is complete.";
  const parts: string[] = [];
  if (resolution.missing.length > 0) parts.push(`unset: ${resolution.missing.join(", ")}`);
  for (const entry of resolution.invalid) parts.push(`${entry.name} (${entry.reason})`);
  return `Agentless execution is not configured — ${parts.join("; ")}.`;
}
