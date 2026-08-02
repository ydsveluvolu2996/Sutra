/** Server-owned Ed25519 signer for immutable ADV-05 runtime receipts. */
import type { GravitonEvidenceSigner } from "./finops-graviton-production-composition.ts";
const ID=/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u,SHA=/^[a-f0-9]{64}$/u;
function bytes(value:string):ArrayBuffer{if(!/^[A-Za-z0-9_-]+$/u.test(value))throw new Error("GRAVITON_SIGNER_INVALID");
  const source=Buffer.from(value,"base64url"),copy=new Uint8Array(source.byteLength);copy.set(source);return copy.buffer;}
export function createGravitonEvidenceSignerFromEnvironment(environment:Readonly<Record<string,string|undefined>>):GravitonEvidenceSigner{
  const keyId=environment.SUTRA_GRAVITON_EVIDENCE_KEY_ID?.trim(),privateValue=environment.SUTRA_GRAVITON_EVIDENCE_PRIVATE_KEY_PKCS8_BASE64URL?.trim(),
    publicValue=environment.SUTRA_GRAVITON_EVIDENCE_PUBLIC_KEY_SPKI_BASE64URL?.trim();
  if(keyId===undefined||!ID.test(keyId)||privateValue===undefined||publicValue===undefined)throw new Error("GRAVITON_SIGNER_NOT_CONFIGURED");
  const privateKey=crypto.subtle.importKey("pkcs8",bytes(privateValue),{name:"Ed25519"},false,["sign"]),
    publicKey=crypto.subtle.importKey("spki",bytes(publicValue),{name:"Ed25519"},false,["verify"]);
  const signer:GravitonEvidenceSigner={seal:async evidence=>{const digest=evidence.evidenceSha256;
    if(typeof digest!=="string"||!SHA.test(digest))throw new Error("GRAVITON_SIGNER_INVALID");
    const signature=await crypto.subtle.sign("Ed25519",await privateKey,new TextEncoder().encode(digest));
    return Object.freeze({keyId,algorithm:"ED25519" as const,value:Buffer.from(signature).toString("base64url")});},
    verify:async receipt=>receipt.signature.keyId===keyId&&receipt.signature.algorithm==="ED25519"&&SHA.test(receipt.evidenceSha256)
      &&crypto.subtle.verify("Ed25519",await publicKey,bytes(receipt.signature.value),new TextEncoder().encode(receipt.evidenceSha256)),
  };return Object.freeze(signer);
}
