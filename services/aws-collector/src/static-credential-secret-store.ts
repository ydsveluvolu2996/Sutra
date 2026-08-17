import { createHash } from "node:crypto";

import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
  UpdateSecretVersionStageCommand,
} from "@aws-sdk/client-secrets-manager";

import type { AwsPartition, AwsStaticCredentialMaterial } from "./types.js";

const SECRET_PREFIX = "sutra/customer-aws-credentials";
const PENDING_STAGE = "SUTRAPENDING";
const CURRENT_STAGE = "AWSCURRENT";
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const VERSION_ID = /^[A-Za-z0-9-]{32,64}$/u;
const STATIC_ACCESS_KEY_ID = /^AKIA[A-Z0-9]{16}$/u;
const STATIC_SECRET_ACCESS_KEY = /^[A-Za-z0-9/+]{40}$/u;
const SECRETS_MANAGER_DEADLINE_MS = 5_000;

export interface StaticCredentialSecretScope {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly expectedAccountId: string;
  readonly partition: AwsPartition;
}

/**
 * Non-secret pointer persisted by the collector and control plane. The full
 * ARN (including Secrets Manager's random suffix) and exact immutable version
 * prevent a name or staging-label swap from selecting another credential.
 */
export interface StaticCredentialSecretReference {
  readonly secretArn: string;
  readonly versionId: string;
  readonly accessKeyLast4: string;
}

export interface StaticCredentialSecretState {
  readonly active?: StaticCredentialSecretReference;
  readonly staged?: StaticCredentialSecretReference;
  readonly stagedVerified?: true;
}

interface SecretDescription {
  readonly arn: string;
  readonly versionStages: Readonly<Record<string, readonly string[]>>;
  readonly deleted: boolean;
}

export interface StaticCredentialSecretApi {
  create(input: {
    readonly name: string;
    readonly description: string;
    readonly clientRequestToken: string;
    readonly secretString: string;
  }): Promise<{ readonly arn: string; readonly versionId: string }>;
  put(input: {
    readonly secretId: string;
    readonly clientRequestToken: string;
    readonly secretString: string;
    readonly versionStages: readonly string[];
  }): Promise<{ readonly arn: string; readonly versionId: string }>;
  describe(secretId: string): Promise<SecretDescription>;
  get(input: {
    readonly secretId: string;
    readonly versionId: string;
    readonly versionStage?: string;
  }): Promise<{
    readonly arn: string;
    readonly versionId: string;
    readonly versionStages: readonly string[];
    readonly secretString: string;
  }>;
  moveStage(input: {
    readonly secretId: string;
    readonly stage: string;
    readonly moveToVersionId?: string;
    readonly removeFromVersionId?: string;
  }): Promise<void>;
  scheduleDeletion(secretId: string, recoveryWindowInDays: number): Promise<void>;
}

export class StaticCredentialSecretStoreError extends Error {
  public constructor(message = "The AWS static credential secret failed validation") {
    super(message);
    this.name = "StaticCredentialSecretStoreError";
  }
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error
    && typeof error.name === "string" ? error.name : "UnknownError";
}

class AwsSdkStaticCredentialSecretApi implements StaticCredentialSecretApi {
  private readonly client: SecretsManagerClient;

  public constructor(region: string) {
    this.client = new SecretsManagerClient({ region, maxAttempts: 4 });
  }

  public async create(input: {
    readonly name: string;
    readonly description: string;
    readonly clientRequestToken: string;
    readonly secretString: string;
  }): Promise<{ readonly arn: string; readonly versionId: string }> {
    const output = await this.withDeadline((signal) => this.client.send(
      new CreateSecretCommand({
        Name: input.name,
        Description: input.description,
        ClientRequestToken: input.clientRequestToken,
        SecretString: input.secretString,
      }),
      { abortSignal: signal },
    ));
    return requiredWriteResult(output.ARN, output.VersionId);
  }

  public async put(input: {
    readonly secretId: string;
    readonly clientRequestToken: string;
    readonly secretString: string;
    readonly versionStages: readonly string[];
  }): Promise<{ readonly arn: string; readonly versionId: string }> {
    const output = await this.withDeadline((signal) => this.client.send(
      new PutSecretValueCommand({
        SecretId: input.secretId,
        ClientRequestToken: input.clientRequestToken,
        SecretString: input.secretString,
        VersionStages: [...input.versionStages],
      }),
      { abortSignal: signal },
    ));
    return requiredWriteResult(output.ARN, output.VersionId);
  }

  public async describe(secretId: string): Promise<SecretDescription> {
    const output = await this.withDeadline((signal) => this.client.send(
      new DescribeSecretCommand({ SecretId: secretId }),
      { abortSignal: signal },
    ));
    if (typeof output.ARN !== "string" || output.ARN.length === 0) {
      throw new StaticCredentialSecretStoreError();
    }
    const versionStages: Record<string, readonly string[]> = {};
    for (const [versionId, stages] of Object.entries(output.VersionIdsToStages ?? {})) {
      if (!VERSION_ID.test(versionId) || !Array.isArray(stages)
        || stages.some((stage) => typeof stage !== "string")) {
        throw new StaticCredentialSecretStoreError();
      }
      versionStages[versionId] = [...stages];
    }
    return {
      arn: output.ARN,
      versionStages,
      deleted: output.DeletedDate !== undefined,
    };
  }

  public async get(input: {
    readonly secretId: string;
    readonly versionId: string;
    readonly versionStage?: string;
  }): Promise<{
    readonly arn: string;
    readonly versionId: string;
    readonly versionStages: readonly string[];
    readonly secretString: string;
  }> {
    const output = await this.withDeadline((signal) => this.client.send(
      new GetSecretValueCommand({
        SecretId: input.secretId,
        VersionId: input.versionId,
        ...(input.versionStage === undefined ? {} : { VersionStage: input.versionStage }),
      }),
      { abortSignal: signal },
    ));
    if (
      typeof output.ARN !== "string" || typeof output.VersionId !== "string"
      || !Array.isArray(output.VersionStages)
      || output.VersionStages.some((stage) => typeof stage !== "string")
      || typeof output.SecretString !== "string"
    ) {
      throw new StaticCredentialSecretStoreError();
    }
    return {
      arn: output.ARN,
      versionId: output.VersionId,
      versionStages: [...output.VersionStages],
      secretString: output.SecretString,
    };
  }

  public async moveStage(input: {
    readonly secretId: string;
    readonly stage: string;
    readonly moveToVersionId?: string;
    readonly removeFromVersionId?: string;
  }): Promise<void> {
    await this.withDeadline((signal) => this.client.send(
      new UpdateSecretVersionStageCommand({
        SecretId: input.secretId,
        VersionStage: input.stage,
        ...(input.moveToVersionId === undefined ? {} : { MoveToVersionId: input.moveToVersionId }),
        ...(input.removeFromVersionId === undefined
          ? {}
          : { RemoveFromVersionId: input.removeFromVersionId }),
      }),
      { abortSignal: signal },
    ));
  }

  public async scheduleDeletion(secretId: string, recoveryWindowInDays: number): Promise<void> {
    try {
      await this.withDeadline((signal) => this.client.send(
        new DeleteSecretCommand({
          SecretId: secretId,
          RecoveryWindowInDays: recoveryWindowInDays,
        }),
        { abortSignal: signal },
      ));
    } catch (error: unknown) {
      if (errorName(error) !== "ResourceNotFoundException") throw error;
    }
  }

  private async withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SECRETS_MANAGER_DEADLINE_MS);
    timer.unref?.();
    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}

function requiredWriteResult(
  arn: string | undefined,
  versionId: string | undefined,
): { readonly arn: string; readonly versionId: string } {
  if (typeof arn !== "string" || arn.length === 0
    || typeof versionId !== "string" || !VERSION_ID.test(versionId)) {
    throw new StaticCredentialSecretStoreError();
  }
  return { arn, versionId };
}

/**
 * Collector-owned Secrets Manager boundary. Credential values enter only the
 * SecretString member of AWS SDK calls and are resolved by exact ARN+version
 * immediately before identity proof or collection.
 */
export class AwsStaticCredentialSecretStore {
  private readonly accountId: string;
  private readonly region: string;
  private readonly api: StaticCredentialSecretApi;

  public constructor(options: {
    readonly accountId: string;
    readonly region: string;
    readonly api?: StaticCredentialSecretApi;
  }) {
    if (!ACCOUNT_ID.test(options.accountId) || !REGION.test(options.region)) {
      throw new StaticCredentialSecretStoreError(
        "The static credential Secrets Manager workload scope is invalid",
      );
    }
    this.accountId = options.accountId;
    this.region = options.region;
    this.api = options.api ?? new AwsSdkStaticCredentialSecretApi(options.region);
  }

  /**
   * Create or validate the deterministic secret container and return the exact
   * candidate reference without writing customer credential material. Callers
   * must durably persist this reference before calling stagePrepared().
   */
  public async prepare(
    scope: StaticCredentialSecretScope,
    credentials: AwsStaticCredentialMaterial,
    existingSecretArn?: string,
  ): Promise<StaticCredentialSecretReference> {
    validateScope(scope);
    validateCredentials(credentials);
    const name = this.secretName(scope);
    const secretString = JSON.stringify({
      schemaVersion: "sutra.aws-static-credentials.v1",
      tenantId: scope.tenantId,
      connectionId: scope.connectionId,
      expectedAccountId: scope.expectedAccountId,
      partition: scope.partition,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    });
    // A SHA-256 token gives Secrets Manager's immutable-version idempotency
    // without persisting another derivative of the secret material.
    const token = createHash("sha256").update(secretString, "utf8").digest("hex");
    let secretArn: string;
    if (existingSecretArn === undefined) {
      try {
        // Secrets Manager can attach AWSCURRENT automatically to the first
        // stored version. Seed that slot with a non-credential marker so the
        // submitted customer value is never current before verification.
        const placeholder = JSON.stringify({
          schemaVersion: "sutra.aws-static-credentials.placeholder.v1",
        });
        const created = await this.api.create({
          name,
          description: "Sutra collector-owned customer AWS credential",
          clientRequestToken: createHash("sha256")
            .update(`placeholder\u0000${name}`, "utf8")
            .digest("hex"),
          secretString: placeholder,
        });
        secretArn = created.arn;
      } catch (error: unknown) {
        if (errorName(error) !== "ResourceExistsException") throw error;
        const description = await this.api.describe(name);
        this.validateArn(description.arn, name);
        if (description.deleted) throw new StaticCredentialSecretStoreError();
        secretArn = description.arn;
      }
    } else {
      this.validateArn(existingSecretArn, name);
      secretArn = existingSecretArn;
    }
    this.validateArn(secretArn, name);
    if (existingSecretArn !== undefined) {
      const description = await this.api.describe(secretArn);
      if (description.arn !== secretArn || description.deleted) {
        throw new StaticCredentialSecretStoreError();
      }
    }
    return {
      secretArn,
      versionId: token,
      accessKeyLast4: credentials.accessKeyId.slice(-4),
    };
  }

  /**
   * Write a prepared candidate after its exact reference is durable. A timeout
   * may mean AWS accepted the write, so cleanup removes only the runnable label;
   * the durable reference remains sufficient for retry and exact offboarding.
   */
  public async stagePrepared(
    scope: StaticCredentialSecretScope,
    credentials: AwsStaticCredentialMaterial,
    prepared: StaticCredentialSecretReference,
  ): Promise<StaticCredentialSecretReference> {
    validateScope(scope);
    validateCredentials(credentials);
    this.validateReference(scope, prepared);
    const name = this.secretName(scope);
    const secretString = JSON.stringify({
      schemaVersion: "sutra.aws-static-credentials.v1",
      tenantId: scope.tenantId,
      connectionId: scope.connectionId,
      expectedAccountId: scope.expectedAccountId,
      partition: scope.partition,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    });
    const token = createHash("sha256").update(secretString, "utf8").digest("hex");
    if (prepared.versionId !== token
      || prepared.accessKeyLast4 !== credentials.accessKeyId.slice(-4)) {
      throw new StaticCredentialSecretStoreError();
    }
    try {
      const result = await this.api.put({
        secretId: prepared.secretArn,
        clientRequestToken: token,
        secretString,
        versionStages: [PENDING_STAGE],
      });
      this.validateArn(result.arn, name);
      if (result.arn !== prepared.secretArn || result.versionId !== token) {
        throw new StaticCredentialSecretStoreError();
      }
      const description = await this.api.describe(result.arn);
      if (description.arn !== result.arn || description.deleted) {
        throw new StaticCredentialSecretStoreError();
      }
      const pendingVersion = versionWithStage(description, PENDING_STAGE);
      if (pendingVersion !== result.versionId) {
        await this.api.moveStage({
          secretId: result.arn,
          stage: PENDING_STAGE,
          moveToVersionId: result.versionId,
          ...(pendingVersion === null ? {} : { removeFromVersionId: pendingVersion }),
        });
      }
      const stagedDescription = await this.api.describe(result.arn);
      if (stagedDescription.arn !== result.arn || stagedDescription.deleted
        || stagedDescription.versionStages[result.versionId]?.includes(PENDING_STAGE) !== true) {
        throw new StaticCredentialSecretStoreError();
      }
      return prepared;
    } catch (error: unknown) {
      try {
        const description = await this.api.describe(prepared.secretArn);
        if (description.arn === prepared.secretArn && !description.deleted
          && description.versionStages[token]?.includes(PENDING_STAGE) === true) {
          await this.api.moveStage({
            secretId: prepared.secretArn,
            stage: PENDING_STAGE,
            removeFromVersionId: token,
          });
        }
      } catch {
        // Preserve the staging failure. The exact durable reference still lets
        // retry or offboarding reconcile the same secret and immutable version.
      }
      throw error;
    }
  }

  public async read(
    scope: StaticCredentialSecretScope,
    reference: StaticCredentialSecretReference,
    mode: "active" | "candidate",
  ): Promise<AwsStaticCredentialMaterial> {
    validateScope(scope);
    this.validateReference(scope, reference);
    let expectedStage = mode === "active" ? CURRENT_STAGE : PENDING_STAGE;
    if (mode === "candidate") {
      // Secrets Manager promotion and the encrypted registry write are two
      // systems. If promotion succeeded but registry persistence failed, the
      // exact staged VersionId is already AWSCURRENT. Allow only that same
      // immutable version so a retry can re-attest and reconcile it.
      const description = await this.api.describe(reference.secretArn);
      if (description.arn !== reference.secretArn || description.deleted) {
        throw new StaticCredentialSecretStoreError();
      }
      const stages = description.versionStages[reference.versionId] ?? [];
      if (stages.includes(PENDING_STAGE)) {
        expectedStage = PENDING_STAGE;
      } else if (stages.includes(CURRENT_STAGE)) {
        expectedStage = CURRENT_STAGE;
      } else {
        throw new StaticCredentialSecretStoreError();
      }
    }
    const result = await this.api.get({
      secretId: reference.secretArn,
      versionId: reference.versionId,
      versionStage: expectedStage,
    });
    if (result.arn !== reference.secretArn || result.versionId !== reference.versionId
      || !result.versionStages.includes(expectedStage)) {
      throw new StaticCredentialSecretStoreError();
    }
    const material = parseSecretString(result.secretString, scope);
    if (material.accessKeyId.slice(-4) !== reference.accessKeyLast4) {
      throw new StaticCredentialSecretStoreError();
    }
    return material;
  }

  public async promote(
    scope: StaticCredentialSecretScope,
    staged: StaticCredentialSecretReference,
  ): Promise<void> {
    validateScope(scope);
    this.validateReference(scope, staged);
    const description = await this.api.describe(staged.secretArn);
    if (description.arn !== staged.secretArn || description.deleted) {
      throw new StaticCredentialSecretStoreError();
    }
    const current = currentVersion(description);
    if (current !== staged.versionId) {
      await this.api.moveStage({
        secretId: staged.secretArn,
        stage: CURRENT_STAGE,
        moveToVersionId: staged.versionId,
        ...(current === null ? {} : { removeFromVersionId: current }),
      });
    }
    const refreshed = await this.api.describe(staged.secretArn);
    if (refreshed.versionStages[staged.versionId]?.includes(PENDING_STAGE) === true) {
      await this.api.moveStage({
        secretId: staged.secretArn,
        stage: PENDING_STAGE,
        removeFromVersionId: staged.versionId,
      });
    }
  }

  public async discard(
    scope: StaticCredentialSecretScope,
    staged: StaticCredentialSecretReference,
    active?: StaticCredentialSecretReference,
  ): Promise<void> {
    validateScope(scope);
    this.validateReference(scope, staged);
    if (active === undefined) {
      const description = await this.api.describe(staged.secretArn);
      if (description.arn !== staged.secretArn || description.deleted) {
        throw new StaticCredentialSecretStoreError();
      }
      if (description.versionStages[staged.versionId]?.includes(PENDING_STAGE) === true) {
        await this.api.moveStage({
          secretId: staged.secretArn,
          stage: PENDING_STAGE,
          removeFromVersionId: staged.versionId,
        });
      }
      return;
    }
    this.validateReference(scope, active);
    if (active.secretArn !== staged.secretArn) throw new StaticCredentialSecretStoreError();
    const description = await this.api.describe(staged.secretArn);
    const current = currentVersion(description);
    if (current === staged.versionId && active.versionId !== staged.versionId) {
      await this.api.moveStage({
        secretId: staged.secretArn,
        stage: CURRENT_STAGE,
        moveToVersionId: active.versionId,
        removeFromVersionId: staged.versionId,
      });
    }
    const refreshed = await this.api.describe(staged.secretArn);
    if (refreshed.versionStages[staged.versionId]?.includes(PENDING_STAGE) === true) {
      await this.api.moveStage({
        secretId: staged.secretArn,
        stage: PENDING_STAGE,
        removeFromVersionId: staged.versionId,
      });
    }
  }

  public async destroy(
    scope: StaticCredentialSecretScope,
    reference: StaticCredentialSecretReference,
  ): Promise<void> {
    validateScope(scope);
    this.validateReference(scope, reference);
    let description: SecretDescription;
    try {
      description = await this.api.describe(reference.secretArn);
    } catch (error: unknown) {
      if (errorName(error) === "ResourceNotFoundException") return;
      throw error;
    }
    if (description.arn !== reference.secretArn) {
      throw new StaticCredentialSecretStoreError();
    }
    if (description.deleted) return;
    await this.api.scheduleDeletion(reference.secretArn, 7);
  }

  public async destroyOrphan(scope: Pick<StaticCredentialSecretScope,
    "tenantId" | "connectionId">): Promise<void> {
    if (!IDENTIFIER.test(scope.tenantId) || !IDENTIFIER.test(scope.connectionId)) {
      throw new StaticCredentialSecretStoreError();
    }
    const name = this.secretName({
      ...scope,
      expectedAccountId: "000000000000",
      partition: "aws",
    });
    let description: SecretDescription;
    try {
      description = await this.api.describe(name);
    } catch (error: unknown) {
      if (errorName(error) === "ResourceNotFoundException") return;
      throw error;
    }
    this.validateArn(description.arn, name);
    if (description.deleted) return;
    await this.api.scheduleDeletion(description.arn, 7);
  }

  private secretName(scope: StaticCredentialSecretScope): string {
    const tenant = createHash("sha256").update(scope.tenantId, "utf8").digest("hex");
    const connection = createHash("sha256").update(scope.connectionId, "utf8").digest("hex");
    return `${SECRET_PREFIX}/v1/${tenant}/${connection}`;
  }

  private validateReference(
    scope: StaticCredentialSecretScope,
    reference: StaticCredentialSecretReference,
  ): void {
    this.validateArn(reference.secretArn, this.secretName(scope));
    if (!VERSION_ID.test(reference.versionId) || !/^[A-Z0-9]{4}$/u.test(reference.accessKeyLast4)) {
      throw new StaticCredentialSecretStoreError();
    }
  }

  private validateArn(arn: string, expectedName: string): void {
    const prefix = `arn:aws:secretsmanager:${this.region}:${this.accountId}:secret:`;
    if (!arn.startsWith(prefix)) throw new StaticCredentialSecretStoreError();
    const resource = arn.slice(prefix.length);
    if (!new RegExp(`^${escapeRegExp(expectedName)}-[A-Za-z0-9]{6}$`, "u").test(resource)) {
      throw new StaticCredentialSecretStoreError();
    }
  }
}

function validateScope(scope: StaticCredentialSecretScope): void {
  if (!IDENTIFIER.test(scope.tenantId) || !IDENTIFIER.test(scope.connectionId)
    || !ACCOUNT_ID.test(scope.expectedAccountId)
    || !["aws", "aws-us-gov", "aws-cn"].includes(scope.partition)) {
    throw new StaticCredentialSecretStoreError();
  }
}

function validateCredentials(credentials: AwsStaticCredentialMaterial): void {
  if (!STATIC_ACCESS_KEY_ID.test(credentials.accessKeyId)
    || !STATIC_SECRET_ACCESS_KEY.test(credentials.secretAccessKey)
    || credentials.sessionToken !== undefined) {
    throw new StaticCredentialSecretStoreError();
  }
}

function parseSecretString(
  value: string,
  expected: StaticCredentialSecretScope,
): AwsStaticCredentialMaterial {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new StaticCredentialSecretStoreError();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StaticCredentialSecretStoreError();
  }
  const record = parsed as Record<string, unknown>;
  const keys = ["schemaVersion", "tenantId", "connectionId", "expectedAccountId", "partition",
    "accessKeyId", "secretAccessKey"];
  if (Object.keys(record).length !== keys.length
    || Object.keys(record).some((key) => !keys.includes(key))
    || record.schemaVersion !== "sutra.aws-static-credentials.v1"
    || record.tenantId !== expected.tenantId || record.connectionId !== expected.connectionId
    || record.expectedAccountId !== expected.expectedAccountId
    || record.partition !== expected.partition
    || typeof record.accessKeyId !== "string" || typeof record.secretAccessKey !== "string") {
    throw new StaticCredentialSecretStoreError();
  }
  const material: AwsStaticCredentialMaterial = {
    accessKeyId: record.accessKeyId,
    secretAccessKey: record.secretAccessKey,
  };
  validateCredentials(material);
  return material;
}

function currentVersion(description: SecretDescription): string | null {
  return versionWithStage(description, CURRENT_STAGE);
}

function versionWithStage(description: SecretDescription, stage: string): string | null {
  const current = Object.entries(description.versionStages)
    .filter(([, stages]) => stages.includes(stage))
    .map(([versionId]) => versionId);
  if (current.length > 1) throw new StaticCredentialSecretStoreError();
  return current[0] ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
