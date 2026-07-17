import { canonicalJson } from "./canonical-json.ts";

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40,64}$/u;
const REPOSITORY = /^(?:[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u;

export type SupplyChainVerificationState = "verified" | "failed" | "not_configured";

export interface KubernetesSupplyChainEvidence {
  readonly schemaVersion: "sutra.kubernetes-supply-chain.v1";
  readonly clusterId: string;
  readonly collectedAt: string;
  readonly image: {
    readonly repository: string;
    readonly digest: string;
    readonly tag: string | null;
  };
  readonly vulnerabilityScan: {
    readonly scanner: "Trivy";
    readonly scannerVersion: string;
    readonly scannedAt: string;
    readonly critical: number;
    readonly high: number;
    readonly medium: number;
    readonly low: number;
    readonly unknown: number;
    readonly fixedAvailable: number;
  };
  readonly sbom: {
    readonly format: "CycloneDX" | "SPDX";
    readonly componentCount: number;
    readonly documentSha256: string;
  } | null;
  readonly signature: {
    readonly state: SupplyChainVerificationState;
    readonly issuer: string | null;
    readonly subject: string | null;
    readonly transparencyLogVerified: boolean | null;
  };
  readonly provenance: {
    readonly state: SupplyChainVerificationState;
    readonly builderId: string | null;
    readonly sourceRepository: string | null;
    readonly commitSha: string | null;
  };
  readonly priority: {
    readonly score: number;
    readonly rating: "critical" | "high" | "medium" | "low";
    readonly factors: readonly string[];
  };
  readonly evidenceSha256: string;
  readonly limitations: readonly [
    "EVIDENCE_DESCRIBES_ONE_IMMUTABLE_IMAGE_DIGEST",
    "VULNERABILITY_PRESENCE_DOES_NOT_PROVE_EXPLOITABILITY",
    "SIGNATURE_VERIFICATION_DOES_NOT_ESTABLISH_SOURCE_CODE_SAFETY",
  ];
}

export class KubernetesSupplyChainEvidenceError extends Error {
  public readonly code = "INVALID_SUPPLY_CHAIN_EVIDENCE";

  public constructor() {
    super("Kubernetes supply-chain evidence was rejected");
    this.name = "KubernetesSupplyChainEvidenceError";
  }
}

function invalid(): never {
  throw new KubernetesSupplyChainEvidenceError();
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > maximum ||
    value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)
  ) invalid();
  return value;
}

function nullableText(value: unknown, maximum: number): string | null {
  return value === null || value === undefined ? null : text(value, maximum);
}

function timestamp(value: unknown): string {
  const parsed = text(value, 40);
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds) || milliseconds > Date.now() + 300_000) invalid();
  return new Date(milliseconds).toISOString();
}

function count(value: unknown, maximum = 1_000_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) invalid();
  return value as number;
}

function verification(value: unknown): SupplyChainVerificationState {
  if (value === "verified" || value === "failed" || value === "not_configured") return value;
  return invalid();
}

function priority(input: {
  readonly critical: number;
  readonly high: number;
  readonly fixedAvailable: number;
  readonly signature: SupplyChainVerificationState;
  readonly provenance: SupplyChainVerificationState;
  readonly sbomPresent: boolean;
}): KubernetesSupplyChainEvidence["priority"] {
  let score = 0;
  const factors: string[] = [];
  if (input.critical > 0) {
    score += Math.min(40, 20 + input.critical * 4);
    factors.push(`${input.critical} critical package vulnerabilit${input.critical === 1 ? "y" : "ies"}`);
  }
  if (input.high > 0) {
    score += Math.min(25, 10 + input.high * 2);
    factors.push(`${input.high} high package vulnerabilit${input.high === 1 ? "y" : "ies"}`);
  }
  if (input.fixedAvailable > 0) factors.push(`${input.fixedAvailable} finding${input.fixedAvailable === 1 ? "" : "s"} with a known fix`);
  if (input.signature !== "verified") {
    score += input.signature === "failed" ? 25 : 15;
    factors.push(input.signature === "failed" ? "image signature verification failed" : "image signature verification is not configured");
  }
  if (input.provenance !== "verified") {
    score += input.provenance === "failed" ? 20 : 10;
    factors.push(input.provenance === "failed" ? "build provenance verification failed" : "build provenance is not configured");
  }
  if (!input.sbomPresent) {
    score += 10;
    factors.push("no SBOM evidence");
  }
  score = Math.min(100, score);
  return {
    score,
    rating: score >= 80 ? "critical" : score >= 55 ? "high" : score >= 25 ? "medium" : "low",
    factors,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Accepts a deliberately small scanner/verifier envelope. Package lists,
 * registry credentials, certificate material, raw attestations and scanner
 * output are never accepted by this boundary.
 */
export async function normalizeKubernetesSupplyChainEvidence(input: {
  readonly clusterId: string;
  readonly collectedAt: string;
  readonly evidence: unknown;
}): Promise<KubernetesSupplyChainEvidence> {
  const raw = record(input.evidence);
  const image = record(raw.image);
  const scan = record(raw.vulnerabilityScan);
  const signature = record(raw.signature);
  const provenance = record(raw.provenance);
  const repository = text(image.repository, 512);
  const digest = text(image.digest, 71);
  if (!REPOSITORY.test(repository) || !SHA256.test(digest)) invalid();
  const tag = nullableText(image.tag, 128);
  const critical = count(scan.critical);
  const high = count(scan.high);
  const medium = count(scan.medium);
  const low = count(scan.low);
  const unknown = count(scan.unknown);
  const fixedAvailable = count(scan.fixedAvailable, critical + high + medium + low + unknown);
  const signatureState = verification(signature.state);
  const signatureIssuer = nullableText(signature.issuer, 1_024);
  const signatureSubject = nullableText(signature.subject, 1_024);
  const transparencyLogVerified = signature.transparencyLogVerified;
  if (transparencyLogVerified !== null && typeof transparencyLogVerified !== "boolean") invalid();
  if (signatureState === "verified" && (signatureIssuer === null || signatureSubject === null || transparencyLogVerified !== true)) invalid();
  const provenanceState = verification(provenance.state);
  const builderId = nullableText(provenance.builderId, 1_024);
  const sourceRepository = nullableText(provenance.sourceRepository, 1_024);
  const commitSha = nullableText(provenance.commitSha, 64);
  if (commitSha !== null && !COMMIT.test(commitSha)) invalid();
  if (provenanceState === "verified" && (builderId === null || sourceRepository === null || commitSha === null)) invalid();
  let sbom: KubernetesSupplyChainEvidence["sbom"] = null;
  if (raw.sbom !== null) {
    const source = record(raw.sbom);
    if (source.format !== "CycloneDX" && source.format !== "SPDX") invalid();
    const documentSha256 = text(source.documentSha256, 64);
    if (!HEX_SHA256.test(documentSha256)) invalid();
    sbom = {
      format: source.format,
      componentCount: count(source.componentCount, 1_000_000),
      documentSha256,
    };
  }
  const normalized = {
    schemaVersion: "sutra.kubernetes-supply-chain.v1" as const,
    clusterId: text(input.clusterId, 254),
    collectedAt: timestamp(input.collectedAt),
    image: { repository, digest, tag },
    vulnerabilityScan: {
      scanner: "Trivy" as const,
      scannerVersion: text(scan.scannerVersion, 64),
      scannedAt: timestamp(scan.scannedAt),
      critical,
      high,
      medium,
      low,
      unknown,
      fixedAvailable,
    },
    sbom,
    signature: {
      state: signatureState,
      issuer: signatureIssuer,
      subject: signatureSubject,
      transparencyLogVerified,
    },
    provenance: {
      state: provenanceState,
      builderId,
      sourceRepository,
      commitSha,
    },
    priority: priority({
      critical,
      high,
      fixedAvailable,
      signature: signatureState,
      provenance: provenanceState,
      sbomPresent: sbom !== null,
    }),
    limitations: [
      "EVIDENCE_DESCRIBES_ONE_IMMUTABLE_IMAGE_DIGEST",
      "VULNERABILITY_PRESENCE_DOES_NOT_PROVE_EXPLOITABILITY",
      "SIGNATURE_VERIFICATION_DOES_NOT_ESTABLISH_SOURCE_CODE_SAFETY",
    ] as const,
  };
  return { ...normalized, evidenceSha256: await sha256(canonicalJson(normalized)) };
}
