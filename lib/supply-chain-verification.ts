// Supply-chain trust verification + VEX suppression engine (pure). It complements
// kubernetes-supply-chain.ts — which validates a submitted attestation envelope —
// by DERIVING a tri-state signature/provenance verdict from that envelope and by
// applying VEX statements to an already-collected vulnerability set. Two honesty
// rules shape every result:
//   * A signature or provenance block is "verified" ONLY when it is present, its
//     verified flag is exactly true, AND its supporting field (keyId / builderId)
//     is present. A verified claim missing that supporting field is downgraded to
//     "failed", never accepted. An absent block is "not_configured", never
//     "failed"; a present-but-unverified block is "failed", never silently passed.
//   * A VEX statement suppresses a matching vulnerability ONLY when its status is
//     not_affected or fixed AND it carries a non-empty justification. A suppressing
//     status without justification never suppresses: the vulnerability stays active
//     and the discarded statement is cited under rejectedVex. affected and
//     under_investigation never suppress under any circumstance.
// Nothing is synthesized: absent evidence yields an explicit not_configured /
// active / rejected state, and every verdict keeps the reasons it was built from.

export type SupplyChainVerificationState = "verified" | "failed" | "not_configured";
export type VexStatus = "not_affected" | "affected" | "fixed" | "under_investigation";

export interface SignatureEvidenceInput {
  readonly present: boolean;
  readonly verified?: boolean;
  readonly keyId?: string;
}

export interface ProvenanceEvidenceInput {
  readonly present: boolean;
  readonly slsaLevel?: number;
  readonly verified?: boolean;
  readonly builderId?: string;
}

export interface ArtifactInput {
  readonly imageDigest: string;
  readonly tenant?: string | null;
  readonly signature?: SignatureEvidenceInput;
  readonly provenance?: ProvenanceEvidenceInput;
}

export interface VexStatement {
  readonly vulnId: string;
  readonly productDigest: string;
  readonly status: VexStatus;
  readonly justification?: string;
}

export interface VexVulnerability {
  readonly cveId: string;
  readonly imageDigest: string;
}

export interface SuppressedVulnerability {
  readonly cveId: string;
  readonly imageDigest: string;
  readonly reason: "vex:not_affected" | "vex:fixed";
  readonly justification: string;
}

export interface RejectedVex {
  readonly cveId: string;
  readonly imageDigest: string;
  readonly status: "not_affected" | "fixed";
  readonly reason: "vex-without-justification";
}

export interface VexApplication {
  readonly active: readonly VexVulnerability[];
  readonly suppressed: readonly SuppressedVulnerability[];
  readonly rejectedVex: readonly RejectedVex[];
}

export interface ArtifactVerification {
  readonly imageDigest: string;
  readonly tenant: string | null;
  readonly signatureState: SupplyChainVerificationState;
  readonly provenanceState: SupplyChainVerificationState;
  readonly trustScore: number;
  readonly signature: {
    readonly present: boolean;
    // Tri-state: true / false as submitted, null when the verification result
    // was not provided (no block, or no verified flag).
    readonly verified: boolean | null;
    readonly keyId: string | null;
  };
  readonly provenance: {
    readonly present: boolean;
    readonly verified: boolean | null;
    readonly slsaLevel: number | null;
    readonly builderId: string | null;
  };
  readonly rationale: readonly string[];
}

export interface SupplyChainTrustInput {
  readonly artifacts: readonly ArtifactInput[];
  readonly vexStatements: readonly VexStatement[];
  readonly vulnerabilities: readonly VexVulnerability[];
}

export interface SupplyChainTrustReport {
  readonly schema: "sutra.supply-chain-verification.v1";
  readonly artifacts: readonly ArtifactVerification[];
  readonly vex: VexApplication;
  readonly totals: {
    readonly artifacts: number;
    readonly signatureVerified: number;
    readonly signatureFailed: number;
    readonly signatureNotConfigured: number;
    readonly provenanceVerified: number;
    readonly provenanceFailed: number;
    readonly provenanceNotConfigured: number;
    readonly vulnerabilitiesActive: number;
    readonly vulnerabilitiesSuppressed: number;
    readonly vexRejected: number;
  };
  readonly claimBoundary: "SUBMITTED_ATTESTATION_AND_VEX_METADATA_ONLY";
  readonly limitations: readonly [
    "VERIFICATION_STATE_REFLECTS_SUBMITTED_ATTESTATION_METADATA_NOT_LIVE_REVERIFICATION",
    "SIGNATURE_OR_PROVENANCE_VERIFIED_DOES_NOT_ESTABLISH_SOURCE_CODE_SAFETY",
    "VEX_SUPPRESSION_REFLECTS_SUBMITTED_JUSTIFICATION_NOT_INDEPENDENT_EXPLOITABILITY_ANALYSIS",
  ];
}

const SIGNATURE_TRUST_POINTS: Readonly<Record<SupplyChainVerificationState, number>> = {
  verified: 55,
  not_configured: 15,
  failed: 0,
};
const PROVENANCE_TRUST_POINTS: Readonly<Record<SupplyChainVerificationState, number>> = {
  verified: 45,
  not_configured: 12,
  failed: 0,
};

const CLAIM_BOUNDARY = "SUBMITTED_ATTESTATION_AND_VEX_METADATA_ONLY" as const;
const LIMITATIONS = [
  "VERIFICATION_STATE_REFLECTS_SUBMITTED_ATTESTATION_METADATA_NOT_LIVE_REVERIFICATION",
  "SIGNATURE_OR_PROVENANCE_VERIFIED_DOES_NOT_ESTABLISH_SOURCE_CODE_SAFETY",
  "VEX_SUPPRESSION_REFLECTS_SUBMITTED_JUSTIFICATION_NOT_INDEPENDENT_EXPLOITABILITY_ANALYSIS",
] as const;

interface StateVerdict {
  readonly state: SupplyChainVerificationState;
  readonly reason: string;
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function classifySignature(block: SignatureEvidenceInput | undefined): StateVerdict {
  if (block === undefined) {
    return { state: "not_configured", reason: "signature: no signature evidence block was submitted" };
  }
  if (block.present !== true) {
    return { state: "not_configured", reason: "signature: evidence reports present=false; no signature to verify" };
  }
  if (block.verified !== true) {
    return block.verified === false
      ? { state: "failed", reason: "signature: present but verification returned false" }
      : { state: "failed", reason: "signature: present but no verification result was provided" };
  }
  if (!nonEmpty(block.keyId)) {
    return {
      state: "failed",
      reason: "signature: reported verified but keyId is absent; a verified signature is not accepted without its key evidence",
    };
  }
  return { state: "verified", reason: `signature: verified with keyId=${block.keyId}` };
}

function classifyProvenance(block: ProvenanceEvidenceInput | undefined): StateVerdict {
  if (block === undefined) {
    return { state: "not_configured", reason: "provenance: no provenance evidence block was submitted" };
  }
  if (block.present !== true) {
    return { state: "not_configured", reason: "provenance: evidence reports present=false; no provenance to verify" };
  }
  if (block.verified !== true) {
    return block.verified === false
      ? { state: "failed", reason: "provenance: present but verification returned false" }
      : { state: "failed", reason: "provenance: present but no verification result was provided" };
  }
  if (!nonEmpty(block.builderId)) {
    return {
      state: "failed",
      reason: "provenance: reported verified but builderId is absent; a verified provenance is not accepted without its builder evidence",
    };
  }
  return { state: "verified", reason: `provenance: verified with builderId=${block.builderId}` };
}

function verifyArtifact(artifact: ArtifactInput): ArtifactVerification {
  const signatureBlock = artifact.signature;
  const provenanceBlock = artifact.provenance;
  const signature = classifySignature(signatureBlock);
  const provenance = classifyProvenance(provenanceBlock);
  const rawKeyId = signatureBlock?.keyId;
  const rawBuilderId = provenanceBlock?.builderId;
  const rawSlsaLevel = provenanceBlock?.slsaLevel;
  return {
    imageDigest: artifact.imageDigest,
    tenant: artifact.tenant ?? null,
    signatureState: signature.state,
    provenanceState: provenance.state,
    trustScore: SIGNATURE_TRUST_POINTS[signature.state] + PROVENANCE_TRUST_POINTS[provenance.state],
    signature: {
      present: signatureBlock?.present === true,
      verified: signatureBlock === undefined ? null : signatureBlock.verified ?? null,
      keyId: nonEmpty(rawKeyId) ? rawKeyId : null,
    },
    provenance: {
      present: provenanceBlock?.present === true,
      verified: provenanceBlock === undefined ? null : provenanceBlock.verified ?? null,
      slsaLevel: typeof rawSlsaLevel === "number" && Number.isFinite(rawSlsaLevel) ? rawSlsaLevel : null,
      builderId: nonEmpty(rawBuilderId) ? rawBuilderId : null,
    },
    rationale: [signature.reason, provenance.reason],
  };
}

function isSuppressingStatus(status: VexStatus): status is "not_affected" | "fixed" {
  return status === "not_affected" || status === "fixed";
}

/**
 * Applies VEX statements to a collected vulnerability set. A statement is matched
 * to a vulnerability only when both its vulnId equals the CVE id AND its
 * productDigest equals the image digest. A not_affected / fixed match suppresses
 * the vulnerability only when it carries a non-empty justification; otherwise the
 * vulnerability stays active and the unjustified statement is cited under
 * rejectedVex. affected and under_investigation never suppress. A valid justified
 * suppressor takes precedence over an unjustified one for the same vulnerability.
 * Input order is preserved so the result is deterministic for identical input.
 */
export function applyVex(
  vulnerabilities: readonly VexVulnerability[],
  vexStatements: readonly VexStatement[],
): VexApplication {
  const active: VexVulnerability[] = [];
  const suppressed: SuppressedVulnerability[] = [];
  const rejectedVex: RejectedVex[] = [];

  for (const vulnerability of vulnerabilities) {
    const matches = vexStatements.filter(
      (statement) =>
        statement.vulnId === vulnerability.cveId && statement.productDigest === vulnerability.imageDigest,
    );

    let suppressor: { readonly status: "not_affected" | "fixed"; readonly justification: string } | null = null;
    for (const statement of matches) {
      if (!isSuppressingStatus(statement.status)) continue;
      const justification = statement.justification;
      if (nonEmpty(justification)) {
        suppressor = { status: statement.status, justification };
        break;
      }
    }

    if (suppressor !== null) {
      suppressed.push({
        cveId: vulnerability.cveId,
        imageDigest: vulnerability.imageDigest,
        reason: suppressor.status === "not_affected" ? "vex:not_affected" : "vex:fixed",
        justification: suppressor.justification,
      });
      continue;
    }

    active.push({ cveId: vulnerability.cveId, imageDigest: vulnerability.imageDigest });
    const unjustified = matches.find((statement) => isSuppressingStatus(statement.status));
    if (unjustified !== undefined && isSuppressingStatus(unjustified.status)) {
      rejectedVex.push({
        cveId: vulnerability.cveId,
        imageDigest: vulnerability.imageDigest,
        status: unjustified.status,
        reason: "vex-without-justification",
      });
    }
  }

  return { active, suppressed, rejectedVex };
}

export function verifySupplyChainTrust(input: SupplyChainTrustInput): SupplyChainTrustReport {
  const artifacts = input.artifacts.map(verifyArtifact);
  const vex = applyVex(input.vulnerabilities, input.vexStatements);
  const signatureCount = (state: SupplyChainVerificationState): number =>
    artifacts.filter((artifact) => artifact.signatureState === state).length;
  const provenanceCount = (state: SupplyChainVerificationState): number =>
    artifacts.filter((artifact) => artifact.provenanceState === state).length;
  return {
    schema: "sutra.supply-chain-verification.v1",
    artifacts,
    vex,
    totals: {
      artifacts: artifacts.length,
      signatureVerified: signatureCount("verified"),
      signatureFailed: signatureCount("failed"),
      signatureNotConfigured: signatureCount("not_configured"),
      provenanceVerified: provenanceCount("verified"),
      provenanceFailed: provenanceCount("failed"),
      provenanceNotConfigured: provenanceCount("not_configured"),
      vulnerabilitiesActive: vex.active.length,
      vulnerabilitiesSuppressed: vex.suppressed.length,
      vexRejected: vex.rejectedVex.length,
    },
    claimBoundary: CLAIM_BOUNDARY,
    limitations: LIMITATIONS,
  };
}
