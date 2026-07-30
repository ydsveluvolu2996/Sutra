import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
  type SecretsManagerClientConfig,
} from "@aws-sdk/client-secrets-manager";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTOR_ID = /^itc_[a-f0-9]{32}$/u;
const SECRET_REFERENCE =
  /^secret:\/\/itsm\/(itc_[a-f0-9]{32})(?:\/versions\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}))?$/u;
const SECRET_PREFIX = /^[A-Za-z0-9/_+=.@-]{1,160}$/u;
const KMS_KEY_ARN =
  /^arn:aws(?:-[a-z]+)*:kms:[a-z0-9-]+:[0-9]{12}:key\/[0-9a-f-]{36}$/u;
const MAXIMUM_SECRET_BYTES = 16 * 1024;
const AWS_OPERATION_TIMEOUT_MS = 5_000;

export interface ItsmManagedSecretScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface ItsmManagedSecretStore {
  readonly storageKind: "managed";
  write(
    scope: ItsmManagedSecretScope,
    connectorId: string,
    sharedSecret: string,
  ): Promise<string>;
  read(
    scope: ItsmManagedSecretScope,
    connectorId: string,
    reference: string,
  ): Promise<string | null>;
  delete(
    scope: ItsmManagedSecretScope,
    connectorId: string,
    reference: string,
  ): Promise<void>;
}

interface ItsmSecretDocument {
  readonly version: 1;
  readonly purpose: "sutra-itsm-hmac";
  readonly orgId: string;
  readonly customerId: string;
  readonly connectorId: string;
  readonly sharedSecret: string;
}

interface SecretsManagerLike {
  send(command: unknown, options?: { readonly abortSignal?: AbortSignal }): Promise<unknown>;
  destroy?(): void;
}

export class ItsmManagedSecretError extends Error {
  public readonly code:
    | "INVALID_CONFIGURATION"
    | "INVALID_REFERENCE"
    | "INVALID_SECRET"
    | "SCOPE_MISMATCH"
    | "SECRET_UNAVAILABLE";

  public constructor(code: ItsmManagedSecretError["code"]) {
    super("ITSM managed secret operation rejected");
    this.name = "ItsmManagedSecretError";
    this.code = code;
  }
}

function reject(code: ItsmManagedSecretError["code"]): never {
  throw new ItsmManagedSecretError(code);
}

function assertScope(scope: ItsmManagedSecretScope, connectorId: string): void {
  if (
    !IDENTIFIER.test(scope.orgId) ||
    !IDENTIFIER.test(scope.customerId) ||
    !CONNECTOR_ID.test(connectorId)
  ) reject("INVALID_REFERENCE");
}

function referenceFor(connectorId: string, versionId: string): string {
  return `secret://itsm/${connectorId}/versions/${versionId}`;
}

function secretName(prefix: string, connectorId: string, versionId?: string): string {
  return versionId === undefined
    ? `${prefix}${connectorId}`
    : `${prefix}${connectorId}/versions/${versionId}`;
}

function isNamedError(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}

function documentFor(
  scope: ItsmManagedSecretScope,
  connectorId: string,
  sharedSecret: string,
): string {
  if (
    sharedSecret.length < 16 ||
    sharedSecret.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(sharedSecret)
  ) reject("INVALID_SECRET");
  return JSON.stringify({
    version: 1,
    purpose: "sutra-itsm-hmac",
    orgId: scope.orgId,
    customerId: scope.customerId,
    connectorId,
    sharedSecret,
  } satisfies ItsmSecretDocument);
}

function parseDocument(
  value: string,
  expected: ItsmManagedSecretScope & { readonly connectorId: string },
): string {
  if (new TextEncoder().encode(value).byteLength > MAXIMUM_SECRET_BYTES) {
    reject("SECRET_UNAVAILABLE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return reject("SECRET_UNAVAILABLE");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    reject("SECRET_UNAVAILABLE");
  }
  const record = parsed as Record<string, unknown>;
  const allowed = new Set([
    "version",
    "purpose",
    "orgId",
    "customerId",
    "connectorId",
    "sharedSecret",
  ]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    record.version !== 1 ||
    record.purpose !== "sutra-itsm-hmac" ||
    typeof record.orgId !== "string" ||
    typeof record.customerId !== "string" ||
    typeof record.connectorId !== "string" ||
    typeof record.sharedSecret !== "string" ||
    record.sharedSecret.length < 16 ||
    record.sharedSecret.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(record.sharedSecret)
  ) reject("SECRET_UNAVAILABLE");
  if (
    record.orgId !== expected.orgId ||
    record.customerId !== expected.customerId ||
    record.connectorId !== expected.connectorId
  ) reject("SCOPE_MISMATCH");
  return record.sharedSecret;
}

export class AwsItsmManagedSecretStore implements ItsmManagedSecretStore {
  public readonly storageKind = "managed" as const;
  private readonly client: SecretsManagerLike;
  private readonly prefix: string;
  private readonly kmsKeyArn: string;

  public constructor(input: {
    readonly prefix: string;
    readonly kmsKeyArn: string;
    readonly client?: SecretsManagerLike;
    readonly clientConfig?: SecretsManagerClientConfig;
  }) {
    if (
      !SECRET_PREFIX.test(input.prefix) ||
      !input.prefix.endsWith("/") ||
      input.prefix.includes("..") ||
      !KMS_KEY_ARN.test(input.kmsKeyArn)
    ) reject("INVALID_CONFIGURATION");
    this.prefix = input.prefix;
    this.kmsKeyArn = input.kmsKeyArn;
    this.client = input.client ?? new SecretsManagerClient(input.clientConfig ?? {});
  }

  private async send(command: unknown): Promise<unknown> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), AWS_OPERATION_TIMEOUT_MS);
    try {
      return await this.client.send(command, { abortSignal: abort.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseReference(
    connectorId: string,
    reference: string,
  ): { readonly versionId: string | null } {
    const match = SECRET_REFERENCE.exec(reference);
    if (match === null || match[1] !== connectorId) reject("INVALID_REFERENCE");
    return { versionId: match[2] ?? null };
  }

  private async getDocument(connectorId: string, reference: string): Promise<string | null> {
    const parsed = this.parseReference(connectorId, reference);
    try {
      const result = await this.send(new GetSecretValueCommand({
        SecretId: secretName(this.prefix, connectorId, parsed.versionId ?? undefined),
        ...(parsed.versionId === null
          ? { VersionStage: "AWSCURRENT" }
          : { VersionId: parsed.versionId }),
      })) as { readonly SecretString?: string };
      if (typeof result.SecretString !== "string") reject("SECRET_UNAVAILABLE");
      return result.SecretString;
    } catch (error) {
      if (isNamedError(error, "ResourceNotFoundException")) return null;
      if (
        isNamedError(error, "InvalidRequestException") &&
        /scheduled for deletion/iu.test(error instanceof Error ? error.message : "")
      ) return null;
      throw error;
    }
  }

  public async write(
    scope: ItsmManagedSecretScope,
    connectorId: string,
    sharedSecret: string,
  ): Promise<string> {
    assertScope(scope, connectorId);
    const value = documentFor(scope, connectorId, sharedSecret);
    const versionId = crypto.randomUUID();
    await this.send(new CreateSecretCommand({
      Name: secretName(this.prefix, connectorId, versionId),
      Description: "Sutra immutable tenant-scoped ITSM connector HMAC credential version",
      KmsKeyId: this.kmsKeyArn,
      SecretString: value,
      ClientRequestToken: versionId,
      Tags: [
        { Key: "sutra:purpose", Value: "itsm-hmac" },
        { Key: "sutra:org-id", Value: scope.orgId },
        { Key: "sutra:customer-id", Value: scope.customerId },
        { Key: "sutra:connector-id", Value: connectorId },
        { Key: "sutra:version-id", Value: versionId },
      ],
    }));
    return referenceFor(connectorId, versionId);
  }

  public async read(
    scope: ItsmManagedSecretScope,
    connectorId: string,
    reference: string,
  ): Promise<string | null> {
    assertScope(scope, connectorId);
    const value = await this.getDocument(connectorId, reference);
    return value === null ? null : parseDocument(value, { ...scope, connectorId });
  }

  public async delete(
    scope: ItsmManagedSecretScope,
    connectorId: string,
    reference: string,
  ): Promise<void> {
    assertScope(scope, connectorId);
    const parsed = this.parseReference(connectorId, reference);
    const current = await this.getDocument(connectorId, reference);
    if (current === null) return;
    parseDocument(current, { ...scope, connectorId });
    try {
      await this.send(new DeleteSecretCommand({
        SecretId: secretName(this.prefix, connectorId, parsed.versionId ?? undefined),
        RecoveryWindowInDays: 7,
      }));
    } catch (error) {
      if (
        isNamedError(error, "ResourceNotFoundException") ||
        (
          isNamedError(error, "InvalidRequestException") &&
          /scheduled for deletion/iu.test(error instanceof Error ? error.message : "")
        )
      ) return;
      throw error;
    }
  }

  public destroy(): void {
    this.client.destroy?.();
  }
}

export function createRuntimeItsmSecretStore(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ItsmManagedSecretStore | null {
  const deployment = environment.SUTRA_DEPLOYMENT_ENV?.trim() || "local";
  if (deployment === "local" || deployment === "development" || deployment === "test") {
    return null;
  }
  if (deployment !== "production") reject("INVALID_CONFIGURATION");
  if (environment.SUTRA_ITSM_SECRET_BACKEND !== "aws-secrets-manager") {
    reject("INVALID_CONFIGURATION");
  }
  return new AwsItsmManagedSecretStore({
    prefix: environment.SUTRA_ITSM_SECRET_PREFIX ?? "",
    kmsKeyArn: environment.SUTRA_ITSM_SECRET_KMS_KEY_ARN ?? "",
  });
}
