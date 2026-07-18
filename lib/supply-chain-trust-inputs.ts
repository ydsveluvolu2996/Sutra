// Adapter from stored Kubernetes supply-chain evidence to the supply-chain
// verification engine's ArtifactInput. The stored evidence and the engine share
// the same SupplyChainVerificationState vocabulary, so this is a faithful
// projection — nothing is inferred. A verified signature/provenance carries its
// key/builder identity (issuer / builderId) so the engine can enforce its rule
// that a "verified" state without key evidence is downgraded to "failed".
import type { KubernetesSupplyChainEvidence } from "./kubernetes-supply-chain.ts";
import type { ArtifactInput } from "./supply-chain-verification.ts";

export function evidenceToArtifact(
  evidence: KubernetesSupplyChainEvidence,
  tenant: string | null = null,
): ArtifactInput {
  return {
    imageDigest: evidence.image.digest,
    tenant,
    signature: {
      present: evidence.signature.state !== "not_configured",
      verified: evidence.signature.state === "verified",
      keyId: evidence.signature.issuer ?? undefined,
    },
    provenance: {
      present: evidence.provenance.state !== "not_configured",
      verified: evidence.provenance.state === "verified",
      builderId: evidence.provenance.builderId ?? undefined,
    },
  };
}
