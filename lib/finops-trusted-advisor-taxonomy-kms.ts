/** App-side verifier for ADV-01 signed AWS Organizations taxonomy captures. */
import {
  KMSClient,
  VerifyCommand,
  type VerifyCommandOutput,
} from "@aws-sdk/client-kms";

const KEY_ARN = /^arn:aws:kms:([a-z0-9-]+):\d{12}:key\/[0-9a-f-]{36}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{43,8192}$/u;

export const TRUSTED_ADVISOR_TAXONOMY_SIGNING_ALGORITHM =
  "AWS_KMS_RSASSA_PSS_SHA_256" as const;

export interface TrustedAdvisorTaxonomyKmsClient {
  send(command: VerifyCommand): Promise<VerifyCommandOutput>;
}

export interface TrustedAdvisorTaxonomySignatureVerifier {
  readonly expectedSignerKeyId: string;
  verify(input: TrustedAdvisorTaxonomySignatureVerificationInput): Promise<boolean>;
}

export interface TrustedAdvisorTaxonomySignatureVerificationInput {
  readonly algorithm: typeof TRUSTED_ADVISOR_TAXONOMY_SIGNING_ALGORITHM;
  readonly signerKeyId: string;
  readonly signature: string;
  readonly content: Uint8Array;
}

export class TrustedAdvisorTaxonomyKmsConfigurationError extends Error {
  public constructor() {
    super("Trusted Advisor taxonomy KMS verification is not configured");
    this.name = "TrustedAdvisorTaxonomyKmsConfigurationError";
  }
}

export function createTrustedAdvisorTaxonomySignatureVerifier(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  injectedClient?: TrustedAdvisorTaxonomyKmsClient,
): TrustedAdvisorTaxonomySignatureVerifier {
  const expectedSignerKeyId = environment.SUTRA_TA_TAXONOMY_SIGNING_KEY_ARN?.trim();
  const region = expectedSignerKeyId === undefined
    ? undefined
    : KEY_ARN.exec(expectedSignerKeyId)?.[1];
  if (expectedSignerKeyId === undefined || region === undefined) {
    throw new TrustedAdvisorTaxonomyKmsConfigurationError();
  }
  const client = injectedClient ?? new KMSClient({
    region,
    retryMode: "standard",
    maxAttempts: 3,
    requestHandler: {
      connectionTimeout: 5_000,
      requestTimeout: 10_000,
    },
  });
  return Object.freeze({
    expectedSignerKeyId,
    verify: async (
      input: TrustedAdvisorTaxonomySignatureVerificationInput,
    ): Promise<boolean> => {
      if (
        input.algorithm !== TRUSTED_ADVISOR_TAXONOMY_SIGNING_ALGORITHM
        || input.signerKeyId !== expectedSignerKeyId
        || !SIGNATURE.test(input.signature)
        || !(input.content instanceof Uint8Array)
        || input.content.byteLength === 0
        || input.content.byteLength > 8 * 1_024 * 1_024
      ) return false;
      const decoded = Buffer.from(input.signature, "base64url");
      if (
        decoded.byteLength < 256
        || decoded.byteLength > 512
        || decoded.toString("base64url") !== input.signature
      ) return false;
      const digest = new Uint8Array(await crypto.subtle.digest(
        "SHA-256",
        input.content as BufferSource,
      ));
      try {
        const result = await client.send(new VerifyCommand({
          KeyId: expectedSignerKeyId,
          Message: digest,
          MessageType: "DIGEST",
          SigningAlgorithm: "RSASSA_PSS_SHA_256",
          Signature: decoded,
        }));
        return result.SignatureValid === true;
      } catch {
        return false;
      }
    },
  });
}
