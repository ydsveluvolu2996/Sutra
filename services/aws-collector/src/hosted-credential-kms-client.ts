import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";

import type { CredentialKmsClient } from "./hosted-credential-envelope.js";

// Same shape the envelope module enforces on the ARN it is handed. Repeated
// rather than exported across the boundary so a future relaxation on one side
// cannot silently widen the other.
const KMS_KEY_ARN = /^arn:aws:kms:[a-z0-9-]{1,32}:[0-9]{12}:key\/[a-f0-9-]{36}$/u;

export class HostedCredentialKmsConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HostedCredentialKmsConfigurationError";
  }
}

/**
 * Thin adapter from the envelope module's minimal client contract onto the AWS
 * SDK. It exists so `hosted-credential-envelope.ts` stays free of SDK types and
 * remains testable with a fake, and so the SDK client is not constructed at all
 * on a deployment that has no customer-credential CMK.
 */
export class HostedCredentialKmsClient implements CredentialKmsClient {
  private readonly region: string;
  private client: KMSClient | null = null;

  public constructor(region: string) {
    this.region = region;
  }

  private resolved(): KMSClient {
    // Lazy: a broker that never registers a static-credential connection never
    // builds a KMS client, opens a socket, or resolves credentials for one.
    this.client ??= new KMSClient({ region: this.region });
    return this.client;
  }

  public async generateDataKey(input: {
    readonly KeyId: string;
    readonly KeySpec: string;
    readonly EncryptionContext: Readonly<Record<string, string>>;
  }): Promise<{
    readonly Plaintext?: Uint8Array;
    readonly CiphertextBlob?: Uint8Array;
    readonly KeyId?: string;
  }> {
    const result = await this.resolved().send(new GenerateDataKeyCommand({
      KeyId: input.KeyId,
      KeySpec: input.KeySpec as "AES_256",
      EncryptionContext: { ...input.EncryptionContext },
    }));
    // `exactOptionalPropertyTypes` distinguishes an absent key from one holding
    // undefined, and the caller checks presence. Omit rather than carry
    // undefined through, so "KMS returned no plaintext" stays one condition.
    return {
      ...(result.Plaintext === undefined ? {} : { Plaintext: result.Plaintext }),
      ...(result.CiphertextBlob === undefined ? {} : { CiphertextBlob: result.CiphertextBlob }),
      ...(result.KeyId === undefined ? {} : { KeyId: result.KeyId }),
    };
  }

  public async decrypt(input: {
    readonly CiphertextBlob: Uint8Array;
    readonly EncryptionContext: Readonly<Record<string, string>>;
    readonly KeyId: string;
  }): Promise<{ readonly Plaintext?: Uint8Array; readonly KeyId?: string }> {
    const result = await this.resolved().send(new DecryptCommand({
      CiphertextBlob: input.CiphertextBlob,
      // Naming the key means a ciphertext that decrypts under some other key
      // this role can reach is still refused. The envelope module additionally
      // compares the returned KeyId.
      KeyId: input.KeyId,
      EncryptionContext: { ...input.EncryptionContext },
    }));
    return {
      ...(result.Plaintext === undefined ? {} : { Plaintext: result.Plaintext }),
      ...(result.KeyId === undefined ? {} : { KeyId: result.KeyId }),
    };
  }

  public destroy(): void {
    this.client?.destroy();
    this.client = null;
  }
}

/**
 * Resolves the customer-credential CMK for the hosted broker.
 *
 * Absent configuration is a valid state, not an error: the broker then refuses
 * static-credential connections outright rather than sealing customer key
 * material under the shared application registry key. Present-but-wrong is an
 * error, because a CMK in another account or region would look configured while
 * placing customer secrets outside the workload boundary.
 */
export function hostedCredentialKmsConfiguration(
  accountId: string,
  region: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): {
  readonly credentialKms?: HostedCredentialKmsClient;
  readonly credentialKeyArn?: string;
} {
  const configured = environment.SUTRA_HOSTED_CREDENTIAL_KMS_KEY_ARN?.trim();
  if (configured === undefined || configured.length === 0) return {};
  if (!KMS_KEY_ARN.test(configured)) {
    throw new HostedCredentialKmsConfigurationError(
      "SUTRA_HOSTED_CREDENTIAL_KMS_KEY_ARN must be an exact KMS key ARN",
    );
  }
  if (!configured.startsWith(`arn:aws:kms:${region}:${accountId}:key/`)) {
    throw new HostedCredentialKmsConfigurationError(
      "The hosted customer-credential CMK must remain in the broker workload account and region",
    );
  }
  // Deliberately not the Trusted Advisor taxonomy signing key. That key signs
  // Sutra's own attestations; reusing it for customer secrets would put two
  // unrelated blast radiuses behind one grant and one rotation schedule.
  if (configured === environment.SUTRA_TA_TAXONOMY_SIGNING_KEY_ARN?.trim()) {
    throw new HostedCredentialKmsConfigurationError(
      "The customer-credential CMK must not be the taxonomy signing key",
    );
  }
  return {
    credentialKms: new HostedCredentialKmsClient(region),
    credentialKeyArn: configured,
  };
}
