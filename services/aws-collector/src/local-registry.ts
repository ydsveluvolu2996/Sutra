import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";

import type {
  AwsRoleProvisioningMode,
  ConnectionScope,
  OnboardingTrustVerification,
  ScopedConnectionRegistry,
  StoredAwsConnection,
} from "./types.js";
import {
  CURRENT_PERMISSION_PACK_VERSION,
  FOUNDATIONAL_FINOPS_PERMISSION_PACK_VERSION,
  ORGANIZATION_FINOPS_PERMISSION_PACK_VERSION,
  ADVANCED_FINOPS_PERMISSION_PACK_VERSION,
  LEGACY_PERMISSION_PACK_VERSION,
  OLDER_PERMISSION_PACK_VERSION,
  PREVIOUS_PERMISSION_PACK_VERSION,
  PRIOR_PERMISSION_PACK_VERSION,
} from "./types.js";
import { parseFoundationalFinopsContracts } from "./finops-permission-contract.js";
import { parseFinopsSourceContracts } from "./finops-source-contract.js";
import {
  isValidAwsRegionSelection,
  type AwsRegionSelection,
  type LocalAwsPartition,
} from "./aws-region-selection.js";

const REGISTRY_AAD = Buffer.from("sutra-local-registry:v1", "utf8");
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const ACCOUNT_ID = /^\d{12}$/;
const EXTERNAL_ID = /^[A-Za-z0-9_+=,.@:/-]{20,128}$/;
const IAM_ROLE_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):iam::(\d{12}):role\/([A-Za-z0-9_+=,.@\/-]+)$/;
const PARTITIONS = new Set(["aws", "aws-us-gov", "aws-cn"]);
const ROLE_PATH = /^\/sutra\/(?:[A-Za-z0-9_+=,.@-]+\/)*$/;
const ROLE_NAME = /^[A-Za-z0-9_+=,.@-]{1,64}$/;
const UNSAFE_ROLE_NAME = /(admin|poweruser|root|shared|operation|break[-_.]?glass)/iu;
const MAX_CONNECTIONS = 10_000;

export type { LocalAwsPartition } from "./aws-region-selection.js";

export interface RegisteredAwsConnection extends StoredAwsConnection {
  readonly partition: LocalAwsPartition;
  readonly enabledRegions: AwsRegionSelection;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RegisterAwsConnectionInput {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly expectedAccountId: string;
  readonly partition: LocalAwsPartition;
  readonly roleArn: string;
  readonly externalId: string;
  readonly enabledRegions: AwsRegionSelection;
  readonly sessionNamePrefix?: string;
  readonly roleProvisioningMode?: AwsRoleProvisioningMode;
  readonly expectedRolePath?: string;
  readonly expectedRoleName?: string;
}

interface RegistryTombstone {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly offboardedAt: string;
}

interface RegistryDocument {
  readonly version: 3;
  readonly connections: Readonly<Record<string, RegisteredAwsConnection>>;
  readonly tombstones: Readonly<Record<string, RegistryTombstone>>;
}

interface EncryptedEnvelope {
  readonly version: 1;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export interface EncryptedFileConnectionRegistryOptions {
  readonly filePath: string;
  readonly encryptionKey: string;
  readonly now?: () => Date;
}

/**
 * Small local-only registry used by the pilot collector. The whole document is
 * authenticated and encrypted at rest; plaintext External IDs are never written
 * to disk. Mutations are serialized and published with an atomic rename.
 */
export class EncryptedFileConnectionRegistry implements ScopedConnectionRegistry {
  private readonly filePath: string;
  private readonly key: Buffer;
  private readonly now: () => Date;
  private writeTail: Promise<void> = Promise.resolve();

  public constructor(options: EncryptedFileConnectionRegistryOptions) {
    if (options.filePath.length === 0 || options.filePath.includes("\u0000")) {
      throw new RegistryConfigurationError("The local registry path is invalid");
    }
    this.filePath = options.filePath;
    this.key = decodeAes256Key(options.encryptionKey);
    this.now = options.now ?? (() => new Date());
  }

  public async resolve(
    scope: ConnectionScope,
    connectionId: string,
  ): Promise<StoredAwsConnection | null> {
    const connection = await this.getRegistered(scope, connectionId);
    if (connection === null) return null;
    return {
      tenantId: connection.tenantId,
      connectionId: connection.connectionId,
      expectedAccountId: connection.expectedAccountId,
      roleArn: connection.roleArn,
      externalId: connection.externalId,
      status: connection.status,
      permissionPackVersion: connection.permissionPackVersion,
      ...(connection.roleProvisioningMode === undefined
        ? {}
        : { roleProvisioningMode: connection.roleProvisioningMode }),
      ...(connection.expectedRolePath === undefined
        ? {}
        : { expectedRolePath: connection.expectedRolePath }),
      ...(connection.expectedRoleName === undefined
        ? {}
        : { expectedRoleName: connection.expectedRoleName }),
      ...(connection.sessionNamePrefix === undefined
        ? {}
        : { sessionNamePrefix: connection.sessionNamePrefix }),
      ...(connection.foundationalFinopsContracts === undefined
        ? {}
        : { foundationalFinopsContracts: structuredClone(connection.foundationalFinopsContracts) }),
      ...(connection.finopsSourceContracts === undefined
        ? {}
        : { finopsSourceContracts: structuredClone(connection.finopsSourceContracts) }),
    };
  }

  public async getRegistered(
    scope: ConnectionScope,
    connectionId: string,
  ): Promise<RegisteredAwsConnection | null> {
    assertScope(scope, connectionId);
    await this.writeTail;
    const document = await this.readDocument();
    const connection = document.connections[connectionKey(scope.tenantId, connectionId)];
    if (
      connection === undefined ||
      connection.tenantId !== scope.tenantId ||
      connection.connectionId !== connectionId
    ) {
      return null;
    }
    return structuredClone(connection);
  }

  public async upsert(input: RegisterAwsConnectionInput): Promise<void> {
    const parsed = parseConnectionInput(input);
    await this.mutate((document) => {
      const key = connectionKey(parsed.tenantId, parsed.connectionId);
      if (document.tombstones[key] !== undefined) {
        throw new RegistryStateError();
      }
      const previous = document.connections[key];
      if (previous?.status === "DISABLED") {
        throw new RegistryStateError();
      }
      const timestamp = this.now().toISOString();
      const unchanged =
        previous !== undefined &&
        previous.expectedAccountId === parsed.expectedAccountId &&
        previous.partition === parsed.partition &&
        previous.roleArn === parsed.roleArn &&
        secretsEqual(previous.externalId, parsed.externalId) &&
        previous.sessionNamePrefix === parsed.sessionNamePrefix &&
        previous.roleProvisioningMode === parsed.roleProvisioningMode &&
        previous.expectedRolePath === parsed.expectedRolePath &&
        previous.expectedRoleName === parsed.expectedRoleName &&
        arraysEqual(previous.enabledRegions, parsed.enabledRegions);

      return {
        version: 3,
        connections: {
          ...document.connections,
          [key]: {
            ...parsed,
            ...(unchanged && previous.foundationalFinopsContracts !== undefined
              ? {
                  foundationalFinopsContracts: structuredClone(
                    previous.foundationalFinopsContracts,
                  ),
                }
              : {}),
            ...(unchanged && previous.finopsSourceContracts !== undefined
              ? {
                  finopsSourceContracts: structuredClone(
                    previous.finopsSourceContracts,
                  ),
                }
              : {}),
            status: unchanged ? previous.status : "PENDING",
            permissionPackVersion: unchanged
              ? previous.permissionPackVersion
              : LEGACY_PERMISSION_PACK_VERSION,
            createdAt: previous?.createdAt ?? timestamp,
            updatedAt: timestamp,
          },
        },
        tombstones: document.tombstones,
      };
    });
  }

  /**
   * Stops future broker work while retaining the encrypted trust contract for
   * an operator-directed investigation. Missing registrations are treated as
   * an idempotent success because a draft may be disabled before role setup.
   */
  public async disable(scope: ConnectionScope, connectionId: string): Promise<void> {
    assertScope(scope, connectionId);
    await this.mutate((document) => {
      const key = connectionKey(scope.tenantId, connectionId);
      if (document.tombstones[key] !== undefined) return document;
      const connection = document.connections[key];
      if (connection === undefined) return document;
      if (connection.tenantId !== scope.tenantId || connection.connectionId !== connectionId) {
        throw new RegistryConnectionNotFoundError();
      }
      if (connection.status === "DISABLED") return document;
      return {
        version: 3,
        connections: {
          ...document.connections,
          [key]: {
            ...connection,
            status: "DISABLED",
            updatedAt: this.now().toISOString(),
          },
        },
        tombstones: document.tombstones,
      };
    });
  }

  /**
   * Permanently removes role and ExternalId material from the collector. The
   * non-secret tombstone prevents a delayed registration request from
   * recreating trust material under the same connection identifier.
   */
  public async offboard(scope: ConnectionScope, connectionId: string): Promise<void> {
    assertScope(scope, connectionId);
    await this.mutate((document) => {
      const key = connectionKey(scope.tenantId, connectionId);
      const existingTombstone = document.tombstones[key];
      if (existingTombstone !== undefined) return document;
      const connection = document.connections[key];
      if (
        connection !== undefined &&
        (connection.tenantId !== scope.tenantId || connection.connectionId !== connectionId)
      ) {
        throw new RegistryConnectionNotFoundError();
      }
      const connections = { ...document.connections };
      delete connections[key];
      return {
        version: 3,
        connections,
        tombstones: {
          ...document.tombstones,
          [key]: {
            tenantId: scope.tenantId,
            connectionId,
            offboardedAt: this.now().toISOString(),
          },
        },
      };
    });
  }

  public async markOnboardingVerified(
    scope: ConnectionScope,
    connectionId: string,
    verification: OnboardingTrustVerification,
  ): Promise<void> {
    assertScope(scope, connectionId);
    await this.mutate((document) => {
      const key = connectionKey(scope.tenantId, connectionId);
      const connection = document.connections[key];
      if (connection === undefined) throw new RegistryConnectionNotFoundError();
      if (connection.tenantId !== scope.tenantId || connection.connectionId !== connectionId) {
        throw new RegistryConnectionNotFoundError();
      }
      if (
        connection.status !== "PENDING" &&
        connection.status !== "VERIFIED" &&
        connection.status !== "DEGRADED" &&
        connection.status !== "ACTIVE"
      ) {
        throw new RegistryStateError();
      }
      if (
        verification.connectionId !== connection.connectionId ||
        verification.accountId !== connection.expectedAccountId ||
        verification.partition !== connection.partition ||
        verification.roleArn !== connection.roleArn ||
        verification.missingExternalIdDenied !== true ||
        verification.wrongExternalIdDenied !== true ||
        verification.trustPolicyAttested !== true ||
        verification.permissionPolicyAttested !== true ||
        verification.sessionPolicyApplied !== true ||
        verification.permissionPackVersion !== CURRENT_PERMISSION_PACK_VERSION
      ) {
        throw new RegistryIntegrityError();
      }
      return {
        version: 3,
        connections: {
          ...document.connections,
          [key]: {
            ...connection,
            // An already-active, unchanged role can remain runnable. Every new
            // or changed candidate remains fail-closed until the control plane
            // commits and calls activateOnboarding with the exact role ARN.
            status: connection.status === "ACTIVE" ? "ACTIVE" : "VERIFIED",
            permissionPackVersion: CURRENT_PERMISSION_PACK_VERSION,
            updatedAt: this.now().toISOString(),
          },
        },
        tombstones: document.tombstones,
      };
    });
  }

  /**
   * Make an attested candidate runnable only after the durable control plane
   * has committed the same exact role ARN. The role comparison is an optimistic
   * concurrency guard against delayed activation of a replaced candidate.
   */
  public async activateOnboarding(
    scope: ConnectionScope,
    connectionId: string,
    expectedRoleArn: string,
  ): Promise<void> {
    assertScope(scope, connectionId);
    await this.mutate((document) => {
      const key = connectionKey(scope.tenantId, connectionId);
      const connection = document.connections[key];
      if (connection === undefined) throw new RegistryConnectionNotFoundError();
      if (
        connection.tenantId !== scope.tenantId ||
        connection.connectionId !== connectionId ||
        connection.roleArn !== expectedRoleArn
      ) {
        throw new RegistryStateError();
      }
      if (
        connection.status === "ACTIVE" &&
        connection.permissionPackVersion === CURRENT_PERMISSION_PACK_VERSION
      ) return document;
      if (connection.status !== "VERIFIED") throw new RegistryStateError();
      if (connection.permissionPackVersion !== CURRENT_PERMISSION_PACK_VERSION) {
        throw new RegistryStateError();
      }
      return {
        version: 3,
        connections: {
          ...document.connections,
          [key]: {
            ...connection,
            status: "ACTIVE",
            updatedAt: this.now().toISOString(),
          },
        },
        tombstones: document.tombstones,
      };
    });
  }

  /**
   * Remove an uncommitted candidate without writing an offboarding tombstone.
   * Only fail-closed staging states can be discarded; an ACTIVE connection can
   * never be removed through this compensating path.
   */
  public async discardStagedOnboarding(
    scope: ConnectionScope,
    connectionId: string,
    expectedRoleArn: string,
  ): Promise<void> {
    assertScope(scope, connectionId);
    await this.mutate((document) => {
      const key = connectionKey(scope.tenantId, connectionId);
      if (document.tombstones[key] !== undefined) throw new RegistryStateError();
      const connection = document.connections[key];
      if (connection === undefined) return document;
      if (
        connection.tenantId !== scope.tenantId ||
        connection.connectionId !== connectionId ||
        connection.roleArn !== expectedRoleArn ||
        (connection.status !== "PENDING" && connection.status !== "VERIFIED")
      ) {
        throw new RegistryStateError();
      }
      const connections = { ...document.connections };
      delete connections[key];
      return { version: 3, connections, tombstones: document.tombstones };
    });
  }

  private async mutate(
    transform: (document: RegistryDocument) => RegistryDocument,
  ): Promise<void> {
    const operation = this.writeTail.then(async () => {
      const current = await this.readDocument();
      const next = transform(current);
      if (
        Object.keys(next.connections).length > MAX_CONNECTIONS ||
        Object.keys(next.tombstones).length > MAX_CONNECTIONS
      ) {
        throw new RegistryIntegrityError();
      }
      await this.writeDocument(next);
    });
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private async readDocument(): Promise<RegistryDocument> {
    let handle;
    try {
      // Open the object once without following a final symlink, then inspect
      // and read that same descriptor. A path swap cannot redirect this read.
      handle = await open(
        this.filePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) {
        throw new RegistryIntegrityError();
      }
      const raw = await handle.readFile({ encoding: "utf8" });
      if (Buffer.byteLength(raw, "utf8") > 8 * 1024 * 1024) {
        throw new RegistryIntegrityError();
      }
      const envelope = parseEnvelope(JSON.parse(raw) as unknown);
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(envelope.iv, "base64url"),
      );
      decipher.setAAD(REGISTRY_AAD);
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const cleartext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      return parseDocument(JSON.parse(cleartext) as unknown);
    } catch (error: unknown) {
      if (isMissingFile(error)) return emptyDocument();
      if (error instanceof RegistryError) throw error;
      throw new RegistryIntegrityError();
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
    }
  }

  private async writeDocument(document: RegistryDocument): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(REGISTRY_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(document), "utf8"),
      cipher.final(),
    ]);
    const envelope: EncryptedEnvelope = {
      version: 1,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify(envelope), { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

export class RegistryError extends Error {}

export class RegistryConfigurationError extends RegistryError {
  public constructor(message: string) {
    super(message);
    this.name = "RegistryConfigurationError";
  }
}

export class RegistryIntegrityError extends RegistryError {
  public constructor() {
    super("The encrypted local connection registry failed validation");
    this.name = "RegistryIntegrityError";
  }
}

export class RegistryConnectionNotFoundError extends RegistryError {
  public constructor() {
    super("The scoped connection was not found");
    this.name = "RegistryConnectionNotFoundError";
  }
}

export class RegistryStateError extends RegistryError {
  public constructor() {
    super("The scoped connection is not in a valid state for this operation");
    this.name = "RegistryStateError";
  }
}

function decodeAes256Key(value: string): Buffer {
  if (value.length < 43 || value.length > 48 || /\s/u.test(value)) {
    throw new RegistryConfigurationError(
      "SUTRA_REGISTRY_ENCRYPTION_KEY must be a base64 value containing exactly 256 bits",
    );
  }
  const decoded = Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  if (decoded.byteLength !== 32) {
    throw new RegistryConfigurationError(
      "SUTRA_REGISTRY_ENCRYPTION_KEY must contain exactly 256 bits",
    );
  }
  return decoded;
}

export function parseConnectionInput(input: RegisterAwsConnectionInput): RegisteredAwsConnection {
  if (!IDENTIFIER.test(input.tenantId) || !IDENTIFIER.test(input.connectionId)) {
    throw new RegistryIntegrityError();
  }
  if (!ACCOUNT_ID.test(input.expectedAccountId) || !PARTITIONS.has(input.partition)) {
    throw new RegistryIntegrityError();
  }
  const role = IAM_ROLE_ARN.exec(input.roleArn);
  if (
    role === null ||
    role[1] !== input.partition ||
    role[2] !== input.expectedAccountId ||
    role[3] === undefined ||
    role[3].startsWith("/") ||
    role[3].endsWith("/") ||
    role[3].includes("//")
  ) {
    throw new RegistryIntegrityError();
  }
  if (!EXTERNAL_ID.test(input.externalId)) throw new RegistryIntegrityError();
  if (!isValidAwsRegionSelection(input.enabledRegions, input.partition)) {
    throw new RegistryIntegrityError();
  }
  const prefix = input.sessionNamePrefix ?? "sutra-";
  if (!/^[A-Za-z0-9_+=,.@-]{3,32}$/u.test(prefix)) throw new RegistryIntegrityError();
  const roleProvisioningMode = input.roleProvisioningMode ?? "sutra_template";
  const expectedRolePath = input.expectedRolePath ?? "/sutra/";
  // Derived from the supplied ARN, not from the current template's role name.
  // A registry document written before the SutraReadOnlyRole → SutraCollectorRole
  // rename carries no expectedRoleName, and defaulting it to the new name would
  // rewrite the record to describe a role the customer never created — after
  // which every attestation for that connection fails. `role[3]` is the ARN's
  // path-and-name, so the segment after the last slash is what actually exists in
  // the account. The allowlist below still constrains the result.
  const expectedRoleName = input.expectedRoleName ?? role[3].slice(role[3].lastIndexOf("/") + 1);
  if (
    (roleProvisioningMode !== "sutra_template" && roleProvisioningMode !== "customer_managed") ||
    !ROLE_PATH.test(expectedRolePath) ||
    expectedRolePath.length > 512 ||
    !ROLE_NAME.test(expectedRoleName) ||
    (roleProvisioningMode === "sutra_template" &&
      (expectedRolePath !== "/sutra/" ||
        (expectedRoleName !== "SutraCollectorRole" && expectedRoleName !== "SutraReadOnlyRole"))) ||
    (roleProvisioningMode === "customer_managed" &&
      (UNSAFE_ROLE_NAME.test(expectedRoleName) ||
        expectedRoleName.toLowerCase() === "organizationaccountaccessrole"))
  ) {
    throw new RegistryIntegrityError();
  }
  const timestamp = new Date(0).toISOString();
  return {
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    expectedAccountId: input.expectedAccountId,
    partition: input.partition,
    roleArn: input.roleArn,
    externalId: input.externalId,
    status: "PENDING",
    permissionPackVersion: LEGACY_PERMISSION_PACK_VERSION,
    sessionNamePrefix: prefix,
    roleProvisioningMode,
    expectedRolePath,
    expectedRoleName,
    enabledRegions: [...input.enabledRegions],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function parseEnvelope(value: unknown): EncryptedEnvelope {
  const record = exactRecord(value, ["version", "iv", "tag", "ciphertext"]);
  if (
    record.version !== 1 ||
    !isBase64Url(record.iv, 16, 16) ||
    !isBase64Url(record.tag, 22, 22) ||
    !isBase64Url(record.ciphertext, 1, 12 * 1024 * 1024)
  ) {
    throw new RegistryIntegrityError();
  }
  return {
    version: 1,
    iv: record.iv,
    tag: record.tag,
    ciphertext: record.ciphertext,
  };
}

function parseDocument(value: unknown): RegistryDocument {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3)) {
    throw new RegistryIntegrityError();
  }
  const expectedKeys = value.version === 1
    ? ["version", "connections"]
    : ["version", "connections", "tombstones"];
  const record = exactRecord(value, expectedKeys);
  if (!isRecord(record.connections)) throw new RegistryIntegrityError();
  const entries = Object.entries(record.connections);
  if (entries.length > MAX_CONNECTIONS) throw new RegistryIntegrityError();
  const connections: Record<string, RegisteredAwsConnection> = {};
  for (const [key, candidate] of entries) {
    if (!isRecord(candidate)) throw new RegistryIntegrityError();
    const parsed = parsePersistedConnection(candidate);
    if (key !== connectionKey(parsed.tenantId, parsed.connectionId)) {
      throw new RegistryIntegrityError();
    }
    connections[key] = parsed;
  }
  const tombstones: Record<string, RegistryTombstone> = {};
  if (record.version === 2 || record.version === 3) {
    if (!isRecord(record.tombstones)) throw new RegistryIntegrityError();
    const tombstoneEntries = Object.entries(record.tombstones);
    if (tombstoneEntries.length > MAX_CONNECTIONS) throw new RegistryIntegrityError();
    for (const [key, candidate] of tombstoneEntries) {
      const tombstone = parseTombstone(candidate);
      if (
        key !== connectionKey(tombstone.tenantId, tombstone.connectionId) ||
        connections[key] !== undefined
      ) {
        throw new RegistryIntegrityError();
      }
      tombstones[key] = tombstone;
    }
  }
  return { version: 3, connections, tombstones };
}

function parseTombstone(value: unknown): RegistryTombstone {
  const record = exactRecord(value, ["tenantId", "connectionId", "offboardedAt"]);
  if (
    typeof record.tenantId !== "string" ||
    typeof record.connectionId !== "string" ||
    !IDENTIFIER.test(record.tenantId) ||
    !IDENTIFIER.test(record.connectionId) ||
    !validIsoDate(record.offboardedAt)
  ) {
    throw new RegistryIntegrityError();
  }
  return {
    tenantId: record.tenantId,
    connectionId: record.connectionId,
    offboardedAt: record.offboardedAt,
  };
}

export function parsePersistedConnection(value: Record<string, unknown>): RegisteredAwsConnection {
  const legacyKeys = [
    "tenantId",
    "connectionId",
    "expectedAccountId",
    "partition",
    "roleArn",
    "externalId",
    "status",
    "sessionNamePrefix",
    "enabledRegions",
    "createdAt",
    "updatedAt",
  ];
  const currentKeys = [...legacyKeys, "permissionPackVersion"];
  const roleContractKeys = [
    ...currentKeys,
    "roleProvisioningMode",
    "expectedRolePath",
    "expectedRoleName",
  ];
  const selectedKeys = Object.hasOwn(value, "roleProvisioningMode")
      ? roleContractKeys
      : Object.hasOwn(value, "permissionPackVersion")
        ? currentKeys
        : legacyKeys;
  const optionalContractKeys = [
    ...(Object.hasOwn(value, "foundationalFinopsContracts")
      ? ["foundationalFinopsContracts"]
      : []),
    ...(Object.hasOwn(value, "finopsSourceContracts")
      ? ["finopsSourceContracts"]
      : []),
  ];
  const record = exactRecord(value, [...selectedKeys, ...optionalContractKeys]);
  if (
    typeof record.tenantId !== "string" ||
    typeof record.connectionId !== "string" ||
    typeof record.expectedAccountId !== "string" ||
    typeof record.partition !== "string" ||
    typeof record.roleArn !== "string" ||
    typeof record.externalId !== "string" ||
    typeof record.sessionNamePrefix !== "string" ||
    (Object.hasOwn(record, "roleProvisioningMode") &&
      (typeof record.roleProvisioningMode !== "string" ||
        typeof record.expectedRolePath !== "string" ||
        typeof record.expectedRoleName !== "string")) ||
    !Array.isArray(record.enabledRegions)
  ) {
    throw new RegistryIntegrityError();
  }
  const parsed = parseConnectionInput({
    tenantId: record.tenantId,
    connectionId: record.connectionId,
    expectedAccountId: record.expectedAccountId,
    partition: record.partition as LocalAwsPartition,
    roleArn: record.roleArn,
    externalId: record.externalId,
    enabledRegions: record.enabledRegions as string[],
    sessionNamePrefix: record.sessionNamePrefix,
    ...(record.roleProvisioningMode === undefined
      ? {}
      : {
          roleProvisioningMode: record.roleProvisioningMode as AwsRoleProvisioningMode,
          expectedRolePath: record.expectedRolePath as string,
          expectedRoleName: record.expectedRoleName as string,
        }),
  });
  if (
    record.status !== "PENDING" &&
    record.status !== "VERIFIED" &&
    record.status !== "ACTIVE" &&
    record.status !== "DEGRADED" &&
    record.status !== "DISABLED"
  ) {
    throw new RegistryIntegrityError();
  }
  if (!validIsoDate(record.createdAt) || !validIsoDate(record.updatedAt)) {
    throw new RegistryIntegrityError();
  }
  const permissionPackVersion = record.permissionPackVersion ?? LEGACY_PERMISSION_PACK_VERSION;
  if (
    permissionPackVersion !== LEGACY_PERMISSION_PACK_VERSION &&
    permissionPackVersion !== OLDER_PERMISSION_PACK_VERSION &&
    permissionPackVersion !== PREVIOUS_PERMISSION_PACK_VERSION &&
    permissionPackVersion !== PRIOR_PERMISSION_PACK_VERSION &&
    permissionPackVersion !== CURRENT_PERMISSION_PACK_VERSION &&
    permissionPackVersion !== FOUNDATIONAL_FINOPS_PERMISSION_PACK_VERSION &&
    permissionPackVersion !== ORGANIZATION_FINOPS_PERMISSION_PACK_VERSION &&
    permissionPackVersion !== ADVANCED_FINOPS_PERMISSION_PACK_VERSION
  ) {
    throw new RegistryIntegrityError();
  }
  let foundationalFinopsContracts;
  if (Object.hasOwn(record, "foundationalFinopsContracts")) {
    try {
      foundationalFinopsContracts = parseFoundationalFinopsContracts(
        record.foundationalFinopsContracts,
        {
          tenantId: parsed.tenantId,
          connectionId: parsed.connectionId,
          expectedAccountId: parsed.expectedAccountId,
          partition: parsed.partition,
        },
      );
    } catch {
      throw new RegistryIntegrityError();
    }
  }
  let finopsSourceContracts;
  if (Object.hasOwn(record, "finopsSourceContracts")) {
    try {
      finopsSourceContracts = parseFinopsSourceContracts(
        record.finopsSourceContracts,
        {
          tenantId: parsed.tenantId,
          connectionId: parsed.connectionId,
          expectedAccountId: parsed.expectedAccountId,
          partition: parsed.partition,
        },
      );
    } catch {
      throw new RegistryIntegrityError();
    }
  }
  return {
    ...parsed,
    status: record.status,
    permissionPackVersion,
    ...(foundationalFinopsContracts === undefined
      ? {}
      : { foundationalFinopsContracts }),
    ...(finopsSourceContracts === undefined
      ? {}
      : { finopsSourceContracts }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function emptyDocument(): RegistryDocument {
  return { version: 3, connections: {}, tombstones: {} };
}

function connectionKey(tenantId: string, connectionId: string): string {
  return `${tenantId}\u001f${connectionId}`;
}

function assertScope(scope: ConnectionScope, connectionId: string): void {
  if (!IDENTIFIER.test(scope.tenantId) || !IDENTIFIER.test(connectionId)) {
    throw new RegistryConnectionNotFoundError();
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new RegistryIntegrityError();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new RegistryIntegrityError();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBase64Url(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

function validIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function secretsEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
