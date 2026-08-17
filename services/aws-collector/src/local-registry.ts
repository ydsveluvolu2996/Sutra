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
  AwsConnectionCredentialKind,
  AwsRoleProvisioningMode,
  AwsStaticCredentialMaterial,
  ComputeOptimizerExportLaunchProvisioningVerification,
  ConnectionScope,
  OnboardingTrustVerification,
  ScopedConnectionRegistry,
  StaticCredentialVerification,
  StoredAwsConnection,
} from "./types.js";
import {
  CURRENT_PERMISSION_PACK_VERSION,
  FOUNDATIONAL_FINOPS_PERMISSION_PACK_VERSION,
  ORGANIZATION_FINOPS_PERMISSION_PACK_VERSION,
  ADVANCED_FINOPS_PERMISSION_PACK_VERSION,
  COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION,
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
  EXTENDED_SUPPORT_PERMISSION_PACK_VERSION,
  AWS_SUPPORT_CASES_PERMISSION_PACK_VERSION,
  AWS_HEALTH_PERMISSION_PACK_VERSION,
  RESILIENCE_VUE_PERMISSION_PACK_VERSION,
  DCF_STEP_FUNCTIONS_PERMISSION_PACK_VERSION,
  END_USER_COMPUTING_PERMISSION_PACK_VERSION,
  GRAVITON_SAVINGS_PERMISSION_PACK_VERSION,
  LEGACY_PERMISSION_PACK_VERSION,
  OLDER_PERMISSION_PACK_VERSION,
  PREVIOUS_PERMISSION_PACK_VERSION,
  PRIOR_PERMISSION_PACK_VERSION,
} from "./types.js";
import { parseFoundationalFinopsContracts } from "./finops-permission-contract.js";
import { parseFinopsSourceContracts } from "./finops-source-contract.js";
import {
  parseComputeOptimizerExportObjectContracts,
} from "./compute-optimizer-export-object-contract.js";
import {
  parseComputeOptimizerExportLaunchContracts,
} from "./compute-optimizer-export-launch-contract.js";
import {
  validateComputeOptimizerExportLaunchProvisioningContractSet,
  validateComputeOptimizerExportLaunchProvisioningVerification,
} from "./compute-optimizer-export-launch-provisioning.js";
import {
  isValidAwsRegionSelection,
  type AwsRegionSelection,
  type LocalAwsPartition,
} from "./aws-region-selection.js";
import {
  type AwsStaticCredentialSecretStore,
  type StaticCredentialSecretReference,
  type StaticCredentialSecretState,
} from "./static-credential-secret-store.js";

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
const STATIC_ACCESS_KEY_ID = /^AKIA[A-Z0-9]{16}$/;
const STATIC_SECRET_ACCESS_KEY = /^[A-Za-z0-9/+]{40}$/;
const MAX_CONNECTIONS = 10_000;

export type { LocalAwsPartition } from "./aws-region-selection.js";

export interface RegisteredAwsConnection extends StoredAwsConnection {
  readonly partition: LocalAwsPartition;
  readonly enabledRegions: AwsRegionSelection;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Persisted pointer only; runtime callers receive hydrated key material. */
  readonly staticCredentialSecretState?: StaticCredentialSecretState;
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
  /**
   * "static_credentials" registrations carry customer key material instead of
   * a role: roleArn and externalId must be empty strings, no role contract may
   * be supplied, and staticCredentials is required. Absent means trust_role.
   */
  readonly credentialKind?: AwsConnectionCredentialKind;
  readonly staticCredentials?: AwsStaticCredentialMaterial;
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
  readonly staticCredentialSecretStore?: AwsStaticCredentialSecretStore;
  /** Test-only fault seam for atomic registry publication. */
  readonly testOnlyWriteFaultInjector?: (point: "beforeRename" | "afterRename") => void;
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
  private readonly staticCredentialSecretStore: AwsStaticCredentialSecretStore | null;
  private readonly testOnlyWriteFaultInjector:
    ((point: "beforeRename" | "afterRename") => void) | null;
  private writeTail: Promise<void> = Promise.resolve();

  public constructor(options: EncryptedFileConnectionRegistryOptions) {
    if (options.filePath.length === 0 || options.filePath.includes("\u0000")) {
      throw new RegistryConfigurationError("The local registry path is invalid");
    }
    this.filePath = options.filePath;
    this.key = decodeAes256Key(options.encryptionKey);
    this.now = options.now ?? (() => new Date());
    this.staticCredentialSecretStore = options.staticCredentialSecretStore ?? null;
    this.testOnlyWriteFaultInjector = options.testOnlyWriteFaultInjector ?? null;
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
      ...(connection.credentialKind === undefined
        ? {}
        : { credentialKind: connection.credentialKind, partition: connection.partition }),
      ...(connection.staticCredentials === undefined
        ? {}
        : { staticCredentials: structuredClone(connection.staticCredentials) }),
      ...(connection.foundationalFinopsContracts === undefined
        ? {}
        : { foundationalFinopsContracts: structuredClone(connection.foundationalFinopsContracts) }),
      ...(connection.finopsSourceContracts === undefined
        ? {}
        : { finopsSourceContracts: structuredClone(connection.finopsSourceContracts) }),
      ...(connection.computeOptimizerExportObjectContracts === undefined
        ? {}
        : {
            computeOptimizerExportObjectContracts: structuredClone(
              connection.computeOptimizerExportObjectContracts,
            ),
          }),
      ...(connection.computeOptimizerExportLaunchContracts === undefined
        ? {}
        : {
            computeOptimizerExportLaunchContracts: structuredClone(
              connection.computeOptimizerExportLaunchContracts,
            ),
          }),
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
    return await this.hydrateStaticCredential(connection, "active");
  }

  /** Candidate-only resolver used by the verification endpoint during rotation. */
  public async getStaticCredentialCandidate(
    scope: ConnectionScope,
    connectionId: string,
  ): Promise<RegisteredAwsConnection | null> {
    assertScope(scope, connectionId);
    await this.writeTail;
    const document = await this.readDocument();
    const connection = document.connections[connectionKey(scope.tenantId, connectionId)];
    if (connection === undefined || connection.tenantId !== scope.tenantId
      || connection.connectionId !== connectionId) return null;
    return await this.hydrateStaticCredential(connection, "candidate");
  }

  public async getStaticCredentialSecretReference(
    scope: ConnectionScope,
    connectionId: string,
  ): Promise<StaticCredentialSecretReference | null> {
    assertScope(scope, connectionId);
    await this.writeTail;
    const connection = (await this.readDocument())
      .connections[connectionKey(scope.tenantId, connectionId)];
    if (connection === undefined || connection.tenantId !== scope.tenantId
      || connection.connectionId !== connectionId) return null;
    const reference = connection.staticCredentialSecretState?.staged
      ?? connection.staticCredentialSecretState?.active;
    return reference === undefined ? null : structuredClone(reference);
  }

  public async upsert(input: RegisterAwsConnectionInput): Promise<void> {
    const parsed = parseConnectionInput(input);
    let pendingMaterialization: {
      readonly scope: ReturnType<typeof staticSecretScope>;
      readonly credentials: AwsStaticCredentialMaterial;
      readonly prepared: StaticCredentialSecretReference;
    } | null = null;
    await this.mutateAsync(async (document) => {
      const key = connectionKey(parsed.tenantId, parsed.connectionId);
      if (document.tombstones[key] !== undefined) {
        throw new RegistryStateError();
      }
      const previous = document.connections[key];
      if (previous?.status === "DISABLED") {
        throw new RegistryStateError();
      }
      const timestamp = this.now().toISOString();
      const metadataUnchanged =
        previous !== undefined &&
        previous.expectedAccountId === parsed.expectedAccountId &&
        previous.partition === parsed.partition &&
        previous.roleArn === parsed.roleArn &&
        secretsEqual(previous.externalId, parsed.externalId) &&
        previous.sessionNamePrefix === parsed.sessionNamePrefix &&
        previous.roleProvisioningMode === parsed.roleProvisioningMode &&
        previous.expectedRolePath === parsed.expectedRolePath &&
        previous.expectedRoleName === parsed.expectedRoleName &&
        previous.credentialKind === parsed.credentialKind &&
        arraysEqual(previous.enabledRegions, parsed.enabledRegions);

      let nextConnection: RegisteredAwsConnection;
      if (parsed.credentialKind === "static_credentials"
        && this.staticCredentialSecretStore !== null) {
        if (parsed.staticCredentials === undefined) throw new RegistryIntegrityError();
        // A deployment that turns on the Secrets Manager backend must never
        // silently migrate a legacy file-stored key. The customer re-submits it
        // through the reviewed path instead.
        if (previous?.credentialKind === "static_credentials"
          && previous.staticCredentialSecretState === undefined) {
          throw new RegistryStateError();
        }
        const previousSecretState = previous?.staticCredentialSecretState;
        const existingArn = previousSecretState?.active?.secretArn
          ?? previousSecretState?.staged?.secretArn;
        const prepared = await this.staticCredentialSecretStore.prepare(
          staticSecretScope(parsed),
          parsed.staticCredentials,
          existingArn,
        );
        const { staticCredentials: _requestMaterial,
          staticCredentialSecretState: _requestState, ...metadata } = parsed;
        void _requestMaterial;
        void _requestState;
        const active = previousSecretState?.active;
        pendingMaterialization = {
          scope: staticSecretScope(parsed),
          credentials: parsed.staticCredentials,
          prepared,
        };
        const keepActive = active !== undefined
          && (previous?.status === "ACTIVE" || previous?.status === "DEGRADED");
        nextConnection = {
          ...metadata,
          ...(metadataUnchanged && previous?.foundationalFinopsContracts !== undefined
            ? { foundationalFinopsContracts: structuredClone(previous.foundationalFinopsContracts) }
            : {}),
          ...(metadataUnchanged && previous?.finopsSourceContracts !== undefined
            ? { finopsSourceContracts: structuredClone(previous.finopsSourceContracts) }
            : {}),
          ...(metadataUnchanged && previous?.computeOptimizerExportObjectContracts !== undefined
            ? { computeOptimizerExportObjectContracts:
                structuredClone(previous.computeOptimizerExportObjectContracts) }
            : {}),
          ...(metadataUnchanged && previous?.computeOptimizerExportLaunchContracts !== undefined
            ? { computeOptimizerExportLaunchContracts:
                structuredClone(previous.computeOptimizerExportLaunchContracts) }
            : {}),
          staticCredentialSecretState: {
            ...(active === undefined ? {} : { active }),
            staged: prepared,
          },
          status: keepActive ? previous.status : "PENDING",
          permissionPackVersion: keepActive
            ? previous.permissionPackVersion
            : LEGACY_PERMISSION_PACK_VERSION,
          createdAt: previous?.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
      } else {
        const unchanged = metadataUnchanged
          && staticCredentialsEqual(previous?.staticCredentials, parsed.staticCredentials);
        nextConnection = {
          ...parsed,
          ...(unchanged && previous?.foundationalFinopsContracts !== undefined
            ? { foundationalFinopsContracts: structuredClone(previous.foundationalFinopsContracts) }
            : {}),
          ...(unchanged && previous?.finopsSourceContracts !== undefined
            ? { finopsSourceContracts: structuredClone(previous.finopsSourceContracts) }
            : {}),
          ...(unchanged && previous?.computeOptimizerExportObjectContracts !== undefined
            ? { computeOptimizerExportObjectContracts:
                structuredClone(previous.computeOptimizerExportObjectContracts) }
            : {}),
          ...(unchanged && previous?.computeOptimizerExportLaunchContracts !== undefined
            ? { computeOptimizerExportLaunchContracts:
                structuredClone(previous.computeOptimizerExportLaunchContracts) }
            : {}),
          status: unchanged ? previous!.status : "PENDING",
          permissionPackVersion: unchanged
            ? previous!.permissionPackVersion
            : LEGACY_PERMISSION_PACK_VERSION,
          createdAt: previous?.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
      }

      return {
        version: 3,
        connections: {
          ...document.connections,
          [key]: nextConnection,
        },
        tombstones: document.tombstones,
      };
    }, async () => {
      const pending = pendingMaterialization as {
        readonly scope: ReturnType<typeof staticSecretScope>;
        readonly credentials: AwsStaticCredentialMaterial;
        readonly prepared: StaticCredentialSecretReference;
      } | null;
      if (pending === null) return;
      if (this.staticCredentialSecretStore === null) throw new RegistryIntegrityError();
      await this.staticCredentialSecretStore.stagePrepared(
        pending.scope,
        pending.credentials,
        pending.prepared,
      );
    });
  }

  /**
   * Stops future broker work while retaining the encrypted trust contract for
   * an operator-directed investigation. Missing registrations are treated as
   * an idempotent success because a draft may be disabled before role setup.
   */
  public async disable(scope: ConnectionScope, connectionId: string): Promise<void> {
    assertScope(scope, connectionId);
    await this.mutateAsync(async (document) => {
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
    await this.mutateAsync(async (document) => {
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
      const secretState = connection?.staticCredentialSecretState;
      const reference = secretState?.active ?? secretState?.staged;
      if (reference !== undefined) {
        if (this.staticCredentialSecretStore === null || connection === undefined) {
          throw new RegistryStateError();
        }
        await this.staticCredentialSecretStore.destroy(staticSecretScope(connection), reference);
      } else if (this.staticCredentialSecretStore !== null
        && (connection === undefined || connection.credentialKind === "static_credentials")) {
        await this.staticCredentialSecretStore.destroyOrphan({
          tenantId: scope.tenantId,
          connectionId,
        });
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
    await this.mutateAsync(async (document) => {
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
   * Record a proven static-credential identity. Mirrors
   * markOnboardingVerified's transitions: a new or changed candidate becomes
   * VERIFIED (still fail-closed) until the control plane commits and
   * activates it with the pinned empty role ARN.
   */
  public async markStaticCredentialVerified(
    scope: ConnectionScope,
    connectionId: string,
    verification: StaticCredentialVerification,
  ): Promise<void> {
    assertScope(scope, connectionId);
    await this.mutate((document) => {
      const key = connectionKey(scope.tenantId, connectionId);
      const connection = document.connections[key];
      if (connection === undefined) throw new RegistryConnectionNotFoundError();
      if (connection.tenantId !== scope.tenantId || connection.connectionId !== connectionId) {
        throw new RegistryConnectionNotFoundError();
      }
      if (connection.credentialKind !== "static_credentials") {
        throw new RegistryStateError();
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
        (connection.staticCredentialSecretState !== undefined
          && verification.secretVersionId !== (
            connection.staticCredentialSecretState.staged?.versionId
            ?? connection.staticCredentialSecretState.active?.versionId
          )) ||
        (connection.staticCredentialSecretState === undefined
          && verification.secretVersionId !== undefined) ||
        verification.accessKeyLast4 !== (
          connection.staticCredentialSecretState?.staged?.accessKeyLast4
          ?? connection.staticCredentialSecretState?.active?.accessKeyLast4
          ?? connection.staticCredentials?.accessKeyId.slice(-4)
        )
      ) {
        throw new RegistryIntegrityError();
      }
      const secretState = connection.staticCredentialSecretState;
      return {
        version: 3,
        connections: {
          ...document.connections,
          [key]: {
            ...connection,
            ...(secretState?.staged === undefined
              ? {}
              : { staticCredentialSecretState: { ...secretState, stagedVerified: true } }),
            status: connection.status === "ACTIVE" ? "ACTIVE" : "VERIFIED",
            permissionPackVersion: CURRENT_PERMISSION_PACK_VERSION,
            updatedAt: this.now().toISOString(),
          },
        },
        tombstones: document.tombstones,
      };
    });
  }

  /** Stage an explicitly attested .8.5 successor without auto-activation. */
  public async markComputeOptimizerExportLaunchProvisioningVerified(
    scope: ConnectionScope,
    connectionId: string,
    unsafeVerification: ComputeOptimizerExportLaunchProvisioningVerification,
  ): Promise<void> {
    assertScope(scope, connectionId);
    await this.mutate((document) => {
      const key = connectionKey(scope.tenantId, connectionId);
      const connection = document.connections[key];
      if (connection === undefined) throw new RegistryConnectionNotFoundError();
      if (connection.status !== "ACTIVE" || !new Set<StoredAwsConnection["permissionPackVersion"]>([
        CURRENT_PERMISSION_PACK_VERSION,
        FOUNDATIONAL_FINOPS_PERMISSION_PACK_VERSION,
        ORGANIZATION_FINOPS_PERMISSION_PACK_VERSION,
        ADVANCED_FINOPS_PERMISSION_PACK_VERSION,
        COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION,
        COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
      ]).has(connection.permissionPackVersion)) throw new RegistryStateError();
      let verification: ComputeOptimizerExportLaunchProvisioningVerification;
      try {
        verification = validateComputeOptimizerExportLaunchProvisioningVerification(
          unsafeVerification,
          connection,
        );
      } catch {
        throw new RegistryIntegrityError();
      }
      if (connection.permissionPackVersion ===
          COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION) {
        if (JSON.stringify(connection.finopsSourceContracts) !==
            JSON.stringify(verification.sourceContracts)
          || JSON.stringify(connection.computeOptimizerExportObjectContracts) !==
            JSON.stringify(verification.objectContracts)
          || JSON.stringify(connection.computeOptimizerExportLaunchContracts) !==
            JSON.stringify(verification.launchContracts)) {
          throw new RegistryIntegrityError();
        }
        return document;
      }
      return {
        version: 3,
        connections: {
          ...document.connections,
          [key]: {
            ...connection,
            status: "VERIFIED",
            permissionPackVersion:
              COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
            finopsSourceContracts: structuredClone(verification.sourceContracts),
            computeOptimizerExportObjectContracts:
              structuredClone(verification.objectContracts),
            computeOptimizerExportLaunchContracts:
              structuredClone(verification.launchContracts),
            updatedAt: this.now().toISOString(),
          },
        },
        tombstones: document.tombstones,
      };
    });
  }

  /** Explicit second phase for a staged, exact-role .8.5 promotion. */
  public async activateComputeOptimizerExportLaunchProvisioning(
    scope: ConnectionScope,
    connectionId: string,
    expectedRoleArn: string,
  ): Promise<void> {
    assertScope(scope, connectionId);
    await this.mutate((document) => {
      const key = connectionKey(scope.tenantId, connectionId);
      const connection = document.connections[key];
      if (connection === undefined || connection.roleArn !== expectedRoleArn) {
        throw new RegistryStateError();
      }
      if (connection.status === "ACTIVE" && connection.permissionPackVersion ===
          COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION) return document;
      if (connection.status !== "VERIFIED"
        || connection.permissionPackVersion !==
          COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION
        || connection.finopsSourceContracts === undefined
        || connection.computeOptimizerExportObjectContracts === undefined
        || connection.computeOptimizerExportLaunchContracts === undefined) {
        throw new RegistryStateError();
      }
      try {
        validateComputeOptimizerExportLaunchProvisioningContractSet(
          connection,
          connection.enabledRegions,
          connection.finopsSourceContracts,
          connection.computeOptimizerExportObjectContracts,
          connection.computeOptimizerExportLaunchContracts,
        );
      } catch {
        throw new RegistryIntegrityError();
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
   * Make an attested candidate runnable only after the durable control plane
   * has committed the same exact role ARN. The role comparison is an optimistic
   * concurrency guard against delayed activation of a replaced candidate.
   */
  public async activateOnboarding(
    scope: ConnectionScope,
    connectionId: string,
    expectedRoleArn: string,
    expectedSecretVersionId?: string,
  ): Promise<void> {
    assertScope(scope, connectionId);
    await this.mutateAsync(async (document) => {
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
      const secretState = connection.staticCredentialSecretState;
      if (connection.credentialKind === "static_credentials" && secretState !== undefined) {
        if (expectedRoleArn !== "" || this.staticCredentialSecretStore === null) {
          throw new RegistryStateError();
        }
        if (expectedSecretVersionId === undefined
          || !/^[A-Za-z0-9-]{32,64}$/u.test(expectedSecretVersionId)) {
          throw new RegistryStateError();
        }
        if (secretState.staged === undefined) {
          if (secretState.active !== undefined && connection.status === "ACTIVE"
            && connection.permissionPackVersion === CURRENT_PERMISSION_PACK_VERSION
            && secretState.active.versionId === expectedSecretVersionId) {
            return document;
          }
          throw new RegistryStateError();
        }
        if (secretState.staged.versionId !== expectedSecretVersionId) {
          throw new RegistryStateError();
        }
        if (secretState.stagedVerified !== true) throw new RegistryStateError();
        await this.staticCredentialSecretStore.promote(
          staticSecretScope(connection),
          secretState.staged,
        );
        return {
          version: 3,
          connections: {
            ...document.connections,
            [key]: {
              ...connection,
              staticCredentialSecretState: { active: secretState.staged },
              status: "ACTIVE",
              permissionPackVersion: CURRENT_PERMISSION_PACK_VERSION,
              updatedAt: this.now().toISOString(),
            },
          },
          tombstones: document.tombstones,
        };
      }
      if (expectedSecretVersionId !== undefined) throw new RegistryStateError();
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
    expectedSecretVersionId?: string,
  ): Promise<void> {
    assertScope(scope, connectionId);
    await this.mutateAsync(async (document) => {
      const key = connectionKey(scope.tenantId, connectionId);
      if (document.tombstones[key] !== undefined) throw new RegistryStateError();
      const connection = document.connections[key];
      if (connection === undefined) return document;
      const secretState = connection.staticCredentialSecretState;
      if (connection.credentialKind === "static_credentials" && secretState !== undefined) {
        if (expectedRoleArn !== "" || this.staticCredentialSecretStore === null) {
          throw new RegistryStateError();
        }
        if (expectedSecretVersionId === undefined
          || !/^[A-Za-z0-9-]{32,64}$/u.test(expectedSecretVersionId)) {
          throw new RegistryStateError();
        }
        if (secretState.staged === undefined) return document;
        if (secretState.staged.versionId !== expectedSecretVersionId) {
          throw new RegistryStateError();
        }
        await this.staticCredentialSecretStore.discard(
          staticSecretScope(connection),
          secretState.staged,
          secretState.active,
        );
        if (secretState.active !== undefined) {
          return {
            version: 3,
            connections: {
              ...document.connections,
              [key]: {
                ...connection,
                staticCredentialSecretState: { active: secretState.active },
                status: "ACTIVE",
                updatedAt: this.now().toISOString(),
              },
            },
            tombstones: document.tombstones,
          };
        }
        // Retain the opaque reference after a failed initial handoff. No key
        // material is present and the version has no runnable stage, but the
        // pointer lets a same-key retry reattach SUTRAPENDING and lets explicit
        // offboarding schedule recoverable deletion of the exact secret.
        return {
          version: 3,
          connections: {
            ...document.connections,
            [key]: {
              ...connection,
              staticCredentialSecretState: { staged: secretState.staged },
              status: "PENDING",
              permissionPackVersion: LEGACY_PERMISSION_PACK_VERSION,
              updatedAt: this.now().toISOString(),
            },
          },
          tombstones: document.tombstones,
        };
      }
      if (expectedSecretVersionId !== undefined) throw new RegistryStateError();
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
    return this.mutateAsync(async (document) => transform(document));
  }

  private async mutateAsync(
    transform: (document: RegistryDocument) => Promise<RegistryDocument>,
    afterWrite?: () => Promise<void>,
  ): Promise<void> {
    const operation = this.writeTail.then(async () => {
      const current = await this.readDocument();
      const next = await transform(current);
      if (
        Object.keys(next.connections).length > MAX_CONNECTIONS ||
        Object.keys(next.tombstones).length > MAX_CONNECTIONS
      ) {
        throw new RegistryIntegrityError();
      }
      await this.writeDocument(next);
      await afterWrite?.();
    });
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private async hydrateStaticCredential(
    persisted: RegisteredAwsConnection,
    selection: "active" | "candidate",
  ): Promise<RegisteredAwsConnection> {
    const state = persisted.staticCredentialSecretState;
    if (state === undefined) {
      if (persisted.credentialKind === "static_credentials"
        && this.staticCredentialSecretStore !== null) {
        // A live Secrets Manager deployment never consumes a legacy key from
        // the encrypted registry file. The customer must re-register through
        // the reviewed secret-reference path.
        throw new RegistryIntegrityError();
      }
      return structuredClone(persisted);
    }
    if (persisted.credentialKind !== "static_credentials"
      || persisted.staticCredentials !== undefined
      || this.staticCredentialSecretStore === null) {
      throw new RegistryIntegrityError();
    }
    const activeSelected = state.active !== undefined
      && (selection === "active" || state.staged === undefined
        || state.staged.versionId === state.active.versionId);
    const reference = selection === "candidate"
      ? state.staged ?? state.active
      : state.active ?? state.staged;
    if (reference === undefined) throw new RegistryIntegrityError();
    const material = await this.staticCredentialSecretStore.read(
      staticSecretScope(persisted),
      reference,
      activeSelected ? "active" : "candidate",
    );
    const { staticCredentialSecretState: _reference, ...connection } = persisted;
    void _reference;
    return {
      ...structuredClone(connection),
      staticCredentials: material,
    };
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
      this.testOnlyWriteFaultInjector?.("beforeRename");
      await rename(temporaryPath, this.filePath);
      this.testOnlyWriteFaultInjector?.("afterRename");
      await chmod(this.filePath, 0o600);
      const directoryHandle = await open(directory, fsConstants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
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
  if (input.credentialKind !== undefined && input.credentialKind !== "trust_role" && input.credentialKind !== "static_credentials") {
    throw new RegistryIntegrityError();
  }
  if (input.credentialKind === "static_credentials") {
    return parseStaticCredentialConnectionInput(input);
  }
  if (input.staticCredentials !== undefined) throw new RegistryIntegrityError();
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

/**
 * Static-credential records carry no role trust material: roleArn and
 * externalId are pinned to empty strings so no AssumeRole path can ever
 * resolve them, and no role contract may be attached. Only a dedicated IAM
 * user's long-lived AKIA credential is accepted.
 */
function parseStaticCredentialConnectionInput(
  input: RegisterAwsConnectionInput,
): RegisteredAwsConnection {
  const metadata = parseStaticCredentialConnectionMetadata(input);
  const credentials = input.staticCredentials;
  if (
    credentials === undefined ||
    !STATIC_ACCESS_KEY_ID.test(credentials.accessKeyId) ||
    !STATIC_SECRET_ACCESS_KEY.test(credentials.secretAccessKey) ||
    credentials.sessionToken !== undefined
  ) {
    throw new RegistryIntegrityError();
  }
  return {
    ...metadata,
    staticCredentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  };
}

function parseStaticCredentialConnectionMetadata(
  input: Omit<RegisterAwsConnectionInput, "staticCredentials">,
): RegisteredAwsConnection {
  if (
    input.roleArn !== "" ||
    input.externalId !== "" ||
    input.roleProvisioningMode !== undefined ||
    input.expectedRolePath !== undefined ||
    input.expectedRoleName !== undefined
  ) {
    throw new RegistryIntegrityError();
  }
  if (!IDENTIFIER.test(input.tenantId) || !IDENTIFIER.test(input.connectionId)
    || !ACCOUNT_ID.test(input.expectedAccountId) || !PARTITIONS.has(input.partition)) {
    throw new RegistryIntegrityError();
  }
  if (!isValidAwsRegionSelection(input.enabledRegions, input.partition)) {
    throw new RegistryIntegrityError();
  }
  const prefix = input.sessionNamePrefix ?? "sutra-";
  if (!/^[A-Za-z0-9_+=,.@-]{3,32}$/u.test(prefix)) throw new RegistryIntegrityError();
  const timestamp = new Date(0).toISOString();
  return {
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    expectedAccountId: input.expectedAccountId,
    partition: input.partition,
    roleArn: "",
    externalId: "",
    status: "PENDING",
    permissionPackVersion: LEGACY_PERMISSION_PACK_VERSION,
    sessionNamePrefix: prefix,
    credentialKind: "static_credentials",
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
    ...(Object.hasOwn(value, "credentialKind")
      ? [
          "credentialKind",
          Object.hasOwn(value, "staticCredentialSecretState")
            ? "staticCredentialSecretState"
            : "staticCredentials",
        ]
      : []),
    ...(Object.hasOwn(value, "foundationalFinopsContracts")
      ? ["foundationalFinopsContracts"]
      : []),
    ...(Object.hasOwn(value, "finopsSourceContracts")
      ? ["finopsSourceContracts"]
      : []),
    ...(Object.hasOwn(value, "computeOptimizerExportObjectContracts")
      ? ["computeOptimizerExportObjectContracts"]
      : []),
    ...(Object.hasOwn(value, "computeOptimizerExportLaunchContracts")
      ? ["computeOptimizerExportLaunchContracts"]
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
  const persistedInput = {
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
    ...(record.credentialKind === undefined ? {} : {
      credentialKind: record.credentialKind as AwsConnectionCredentialKind,
    }),
  };
  const parsed = record.credentialKind === "static_credentials"
      && Object.hasOwn(record, "staticCredentialSecretState")
    ? {
        ...parseStaticCredentialConnectionMetadata(persistedInput),
        staticCredentialSecretState: parseStaticCredentialSecretState(
          record.staticCredentialSecretState,
        ),
      }
    : parseConnectionInput({
        ...persistedInput,
        ...(record.credentialKind === undefined
          ? {}
          : { staticCredentials: parsePersistedStaticCredentials(record.staticCredentials) }),
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
  if (parsed.staticCredentialSecretState !== undefined) {
    const requiresActiveReference = record.status === "ACTIVE"
      || record.status === "DEGRADED"
      || record.status === "DISABLED";
    if (requiresActiveReference && parsed.staticCredentialSecretState.active === undefined) {
      throw new RegistryIntegrityError();
    }
    if (!requiresActiveReference
      && parsed.staticCredentialSecretState.active !== undefined) {
      throw new RegistryIntegrityError();
    }
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
    permissionPackVersion !== ADVANCED_FINOPS_PERMISSION_PACK_VERSION &&
    permissionPackVersion !== COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION &&
    permissionPackVersion !== COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION &&
    permissionPackVersion !== EXTENDED_SUPPORT_PERMISSION_PACK_VERSION &&
    permissionPackVersion !== AWS_SUPPORT_CASES_PERMISSION_PACK_VERSION &&
    permissionPackVersion !== AWS_HEALTH_PERMISSION_PACK_VERSION &&
    permissionPackVersion !== RESILIENCE_VUE_PERMISSION_PACK_VERSION
    && permissionPackVersion !== DCF_STEP_FUNCTIONS_PERMISSION_PACK_VERSION
    && permissionPackVersion !== END_USER_COMPUTING_PERMISSION_PACK_VERSION
    && permissionPackVersion !== GRAVITON_SAVINGS_PERMISSION_PACK_VERSION
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
  let computeOptimizerExportObjectContracts;
  if (Object.hasOwn(record, "computeOptimizerExportObjectContracts")) {
    if (
      permissionPackVersion !==
        COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION
      && permissionPackVersion !==
        COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION
      && permissionPackVersion !== EXTENDED_SUPPORT_PERMISSION_PACK_VERSION
      && permissionPackVersion !== AWS_SUPPORT_CASES_PERMISSION_PACK_VERSION
      && permissionPackVersion !== AWS_HEALTH_PERMISSION_PACK_VERSION
      && permissionPackVersion !== RESILIENCE_VUE_PERMISSION_PACK_VERSION
      && permissionPackVersion !== DCF_STEP_FUNCTIONS_PERMISSION_PACK_VERSION
      && permissionPackVersion !== END_USER_COMPUTING_PERMISSION_PACK_VERSION
      && permissionPackVersion !== GRAVITON_SAVINGS_PERMISSION_PACK_VERSION
    ) throw new RegistryIntegrityError();
    try {
      computeOptimizerExportObjectContracts = parseComputeOptimizerExportObjectContracts(
        record.computeOptimizerExportObjectContracts,
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
  let computeOptimizerExportLaunchContracts;
  if (Object.hasOwn(record, "computeOptimizerExportLaunchContracts")) {
    if (
      permissionPackVersion !==
        COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION
      && permissionPackVersion !== EXTENDED_SUPPORT_PERMISSION_PACK_VERSION
      && permissionPackVersion !== AWS_SUPPORT_CASES_PERMISSION_PACK_VERSION
      && permissionPackVersion !== AWS_HEALTH_PERMISSION_PACK_VERSION
      && permissionPackVersion !== RESILIENCE_VUE_PERMISSION_PACK_VERSION
      && permissionPackVersion !== DCF_STEP_FUNCTIONS_PERMISSION_PACK_VERSION
      && permissionPackVersion !== END_USER_COMPUTING_PERMISSION_PACK_VERSION
      && permissionPackVersion !== GRAVITON_SAVINGS_PERMISSION_PACK_VERSION
    ) throw new RegistryIntegrityError();
    try {
      computeOptimizerExportLaunchContracts = parseComputeOptimizerExportLaunchContracts(
        record.computeOptimizerExportLaunchContracts,
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
    ...(computeOptimizerExportObjectContracts === undefined
      ? {}
      : { computeOptimizerExportObjectContracts }),
    ...(computeOptimizerExportLaunchContracts === undefined
      ? {}
      : { computeOptimizerExportLaunchContracts }),
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

/**
 * Persisted static credentials are re-validated on every document read so a
 * corrupted or hand-edited registry fails closed instead of yielding a
 * partially formed credential to a session.
 */
function parsePersistedStaticCredentials(value: unknown): AwsStaticCredentialMaterial {
  if (!isRecord(value)) throw new RegistryIntegrityError();
  const record = exactRecord(value, ["accessKeyId", "secretAccessKey"]);
  if (
    typeof record.accessKeyId !== "string" ||
    typeof record.secretAccessKey !== "string" ||
    !STATIC_ACCESS_KEY_ID.test(record.accessKeyId) ||
    !STATIC_SECRET_ACCESS_KEY.test(record.secretAccessKey)
  ) {
    throw new RegistryIntegrityError();
  }
  return {
    accessKeyId: record.accessKeyId,
    secretAccessKey: record.secretAccessKey,
  };
}

function parseStaticCredentialSecretState(value: unknown): StaticCredentialSecretState {
  if (!isRecord(value)) throw new RegistryIntegrityError();
  const keys = [
    ...(Object.hasOwn(value, "active") ? ["active"] : []),
    ...(Object.hasOwn(value, "staged") ? ["staged"] : []),
    ...(Object.hasOwn(value, "stagedVerified") ? ["stagedVerified"] : []),
  ];
  const record = exactRecord(value, keys);
  const active = Object.hasOwn(record, "active")
    ? parseStaticCredentialSecretReference(record.active)
    : undefined;
  const staged = Object.hasOwn(record, "staged")
    ? parseStaticCredentialSecretReference(record.staged)
    : undefined;
  if (active === undefined && staged === undefined) throw new RegistryIntegrityError();
  if (active !== undefined && staged !== undefined && active.secretArn !== staged.secretArn) {
    throw new RegistryIntegrityError();
  }
  if (Object.hasOwn(record, "stagedVerified")
    && (record.stagedVerified !== true || staged === undefined)) {
    throw new RegistryIntegrityError();
  }
  return {
    ...(active === undefined ? {} : { active }),
    ...(staged === undefined ? {} : { staged }),
    ...(record.stagedVerified === true ? { stagedVerified: true } : {}),
  };
}

function parseStaticCredentialSecretReference(value: unknown): StaticCredentialSecretReference {
  const record = exactRecord(value, ["secretArn", "versionId", "accessKeyLast4"]);
  if (typeof record.secretArn !== "string"
    || !/^arn:aws:secretsmanager:[a-z0-9-]{1,32}:\d{12}:secret:sutra\/customer-aws-credentials\/v1\/[a-f0-9]{64}\/[a-f0-9]{64}-[A-Za-z0-9]{6}$/u
      .test(record.secretArn)
    || typeof record.versionId !== "string" || !/^[A-Za-z0-9-]{32,64}$/u.test(record.versionId)
    || typeof record.accessKeyLast4 !== "string" || !/^[A-Z0-9]{4}$/u.test(record.accessKeyLast4)) {
    throw new RegistryIntegrityError();
  }
  return {
    secretArn: record.secretArn,
    versionId: record.versionId,
    accessKeyLast4: record.accessKeyLast4,
  };
}

function staticCredentialsEqual(
  left: AwsStaticCredentialMaterial | undefined,
  right: AwsStaticCredentialMaterial | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.accessKeyId === right.accessKeyId &&
    secretsEqual(left.secretAccessKey, right.secretAccessKey)
  );
}

function staticSecretScope(connection: Pick<RegisteredAwsConnection,
  "tenantId" | "connectionId" | "expectedAccountId" | "partition">) {
  return {
    tenantId: connection.tenantId,
    connectionId: connection.connectionId,
    expectedAccountId: connection.expectedAccountId,
    partition: connection.partition,
  } as const;
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
