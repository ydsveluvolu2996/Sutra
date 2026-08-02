import assert from "node:assert/strict";
import test from "node:test";

import type { VerifyCommand, VerifyCommandOutput } from "@aws-sdk/client-kms";

import {
  TrustedAdvisorTaxonomyKmsConfigurationError,
  createTrustedAdvisorTaxonomySignatureVerifier,
  type TrustedAdvisorTaxonomyKmsClient,
} from "../lib/finops-trusted-advisor-taxonomy-kms.ts";

const KEY_ARN =
  "arn:aws:kms:ap-south-1:999999999999:key/11111111-2222-3333-4444-555555555555";
const CONTENT = new TextEncoder().encode("canonical taxonomy bytes");
const SIGNATURE = Buffer.from(new Uint8Array(384).fill(11)).toString("base64url");

class Client implements TrustedAdvisorTaxonomyKmsClient {
  public readonly commands: VerifyCommand[] = [];
  private readonly valid: boolean;
  private readonly failure: boolean;

  public constructor(valid = true, failure = false) {
    this.valid = valid;
    this.failure = failure;
  }

  public async send(command: VerifyCommand): Promise<VerifyCommandOutput> {
    this.commands.push(command);
    if (this.failure) throw new Error("provider detail must not escape");
    return { $metadata: {}, SignatureValid: this.valid };
  }
}

test("verifies the exact SHA-256 digest with the pinned key and RSA-PSS", async () => {
  const client = new Client();
  const verifier = createTrustedAdvisorTaxonomySignatureVerifier({
    SUTRA_TA_TAXONOMY_SIGNING_KEY_ARN: KEY_ARN,
  }, client);
  assert.equal(await verifier.verify({
    algorithm: "AWS_KMS_RSASSA_PSS_SHA_256",
    signerKeyId: KEY_ARN,
    signature: SIGNATURE,
    content: CONTENT,
  }), true);
  assert.equal(client.commands.length, 1);
  const input = client.commands[0]?.input;
  assert.equal(input?.KeyId, KEY_ARN);
  assert.equal(input?.MessageType, "DIGEST");
  assert.equal(input?.SigningAlgorithm, "RSASSA_PSS_SHA_256");
  assert.deepEqual(
    input?.Message,
    new Uint8Array(await crypto.subtle.digest("SHA-256", CONTENT)),
  );
  assert.deepEqual(input?.Signature, Buffer.from(SIGNATURE, "base64url"));
});

test("rejects signer or envelope mismatch before KMS", async () => {
  for (const invalid of [
    { signerKeyId: KEY_ARN.replace("5555", "6666"), signature: SIGNATURE },
    { signerKeyId: KEY_ARN, signature: "not_base64url" },
    { signerKeyId: KEY_ARN, signature: Buffer.from(new Uint8Array(32)).toString("base64url") },
  ]) {
    const client = new Client();
    const verifier = createTrustedAdvisorTaxonomySignatureVerifier({
      SUTRA_TA_TAXONOMY_SIGNING_KEY_ARN: KEY_ARN,
    }, client);
    assert.equal(await verifier.verify({
      algorithm: "AWS_KMS_RSASSA_PSS_SHA_256",
      ...invalid,
      content: CONTENT,
    }), false);
    assert.equal(client.commands.length, 0);
  }
});

test("returns false for invalid signatures and provider failures", async () => {
  for (const client of [new Client(false), new Client(true, true)]) {
    const verifier = createTrustedAdvisorTaxonomySignatureVerifier({
      SUTRA_TA_TAXONOMY_SIGNING_KEY_ARN: KEY_ARN,
    }, client);
    assert.equal(await verifier.verify({
      algorithm: "AWS_KMS_RSASSA_PSS_SHA_256",
      signerKeyId: KEY_ARN,
      signature: SIGNATURE,
      content: CONTENT,
    }), false);
  }
});

test("fails closed for missing, malformed, non-commercial or non-key ARNs", () => {
  for (const value of [
    undefined,
    "alias/taxonomy",
    KEY_ARN.replace("arn:aws:", "arn:aws-us-gov:"),
    KEY_ARN.replace(":key/", ":alias/"),
  ]) {
    assert.throws(
      () => createTrustedAdvisorTaxonomySignatureVerifier({
        SUTRA_TA_TAXONOMY_SIGNING_KEY_ARN: value,
      }, new Client()),
      TrustedAdvisorTaxonomyKmsConfigurationError,
    );
  }
});
