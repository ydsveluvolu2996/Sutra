import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import pg, { type PoolClient } from "pg";

import {
  parseConnectionInput,
  parsePersistedConnection,
  RegistryConfigurationError,
  RegistryConnectionNotFoundError,
  RegistryIntegrityError,
  RegistryStateError,
  type RegisterAwsConnectionInput,
  type RegisteredAwsConnection,
} from "./local-registry.js";
import {
  ADVANCED_FINOPS_PERMISSION_PACK_VERSION,
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
  COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION,
  CURRENT_PERMISSION_PACK_VERSION,
  FOUNDATIONAL_FINOPS_PERMISSION_PACK_VERSION,
  LEGACY_PERMISSION_PACK_VERSION,
  ORGANIZATION_FINOPS_PERMISSION_PACK_VERSION,
  type ComputeOptimizerExportLaunchProvisioningVerification,
  type ConnectionScope,
  type OnboardingTrustVerification,
  type StoredAwsConnection,
} from "./types.js";
import {
  validateComputeOptimizerExportLaunchProvisioningContractSet,
  validateComputeOptimizerExportLaunchProvisioningVerification,
} from "./compute-optimizer-export-launch-provisioning.js";
import type { HostedRequestReplayStore } from "./hosted-request-auth.js";
import {
  AgentlessRunAlreadyRunningError,
  type AgentlessRunClaimInput,
  type AgentlessRunState,
  type AgentlessRunStore,
} from "./agentless-run-registry.js";
import type {
  AgentlessResourceKind,
  AgentlessResourceTracker,
} from "./agentless-execution.js";
import type { AgentlessScanExecution } from "./scan-runner.js";
import type { EndUserComputingCanonicalCostProjection } from
  "./end-user-computing-provider-adapter.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@+\u001f-]{1,255}$/u;
const DEFAULT_LEASE_MS = 15 * 60_000;
const AGENTLESS_LEASE_MS = 45 * 60_000;
const RUN_ID = /^ags_[a-f0-9]{32}$/u;

interface ConnectionRow {
  tenant_id: string;
  connection_id: string;
  encrypted_state: string | null;
  state_sha256: string | null;
  tombstoned_at: string | number | null;
}

interface EndUserComputingPartitionRow {
  id:string;export_name:string;billing_period:string;active_generation_id:string;
  active_manifest_sha256:string;active_source_updated_at:string;active_committed_at:string;
  active_accepted_rows:number|string;
}
interface EndUserComputingCostRow { line_item_id:string;usage_account_id:string;service:string;
  product_code:string|null;product_name:string|null;resource_id:string|null;region:string|null;
  usage_start:string;usage_end:string|null;amount_micros:number|string;
  net_unblended_cost_micros:number|string|null;amortized_micros:number|string|null;
  list_cost_micros:number|string|null;contracted_cost_micros:number|string|null;
  public_on_demand_cost_micros:number|string|null;currency:string;commitment_type:string|null;
  charge_category:string }

function eucMicros(value:number|string|null):string|null { if(value===null)return null;const result=String(value);
  if(!/^-?\d+$/u.test(result))throw new RegistryIntegrityError();return result }
function eucService(row:EndUserComputingCostRow):"WORKSPACES"|"APPSTREAM"|null { const value=
  `${row.service} ${row.product_code??""} ${row.product_name??""}`.toLowerCase();
  if(value.includes("appstream")||value.includes("workspaces applications"))return "APPSTREAM";
  return value.includes("workspace")?"WORKSPACES":null }
function eucCost(row:EndUserComputingCostRow) { const service=eucService(row);if(service===null)return null;
  const commitmentClass=/saving/iu.test(row.commitment_type??"")?"SAVINGS_PLAN":/reserved/iu.test(row.commitment_type??"")?"RESERVED":
    /on.?demand/iu.test(`${row.commitment_type??""} ${row.charge_category}`)?"ON_DEMAND":"UNCLASSIFIED";
  return Object.freeze({lineItemId:row.line_item_id,service,accountId:row.usage_account_id,region:row.region,
    resourceId:service==="WORKSPACES"&&row.resource_id!==null&&/^ws-[0-9a-z]{8,63}$/u.test(row.resource_id)?row.resource_id:null,
    usageStartAt:row.usage_start,usageEndAt:row.usage_end,currency:row.currency,
    amountsMicros:Object.freeze({unblended:eucMicros(row.amount_micros),net:eucMicros(row.net_unblended_cost_micros),
      amortized:eucMicros(row.amortized_micros),list:eucMicros(row.list_cost_micros),contracted:eucMicros(row.contracted_cost_micros),
      public:eucMicros(row.public_on_demand_cost_micros)}),usageAmountMicros:null,usageUnit:null,commitmentClass}) }

export interface HostedOperationLease {
  readonly operationKey: string;
  readonly leaseToken: string;
}

export interface HostedOperationCoordinator {
  claim(operationKey: string): Promise<HostedOperationLease | null>;
  release(lease: HostedOperationLease): Promise<void>;
}

interface AgentlessRunRow {
  tenant_id: string;
  run_id: string;
  connection_id: string;
  phase: "running" | "recovering" | "completed" | "failed";
  request_json: string;
  request_sha256: string;
  execution_json: string | null;
  error_code: string | null;
  error_message: string | null;
  lease_token: string | null;
  lease_owner: string | null;
  lease_expires_at: string | number | null;
  started_at: string | number;
  finished_at: string | number | null;
}

export interface HostedAgentlessResource {
  readonly sourceVolumeId: string;
  readonly resourceId: string;
  readonly resourceKind: AgentlessResourceKind;
  readonly accountScope: "customer" | "sutra-scan-account";
  readonly region: string;
  readonly deleted: boolean;
  readonly lastError: string | null;
}

export interface HostedAgentlessRecoveryClaim {
  readonly tenantId: string;
  readonly runId: string;
  readonly connectionId: string;
  readonly executionRequest: unknown;
  readonly resources: readonly HostedAgentlessResource[];
}

export interface HostedAgentlessCleanupLedgerResource {
  readonly connectionId: string;
  readonly resourceId: string;
  readonly resourceKind: "snapshot" | "volume" | "instance";
  readonly accountScope: "customer" | "sutra-scan-account";
  readonly region: string;
}

function decodeKey(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new RegistryConfigurationError(
      "SUTRA_REGISTRY_ENCRYPTION_KEY must be a base64url value containing exactly 256 bits",
    );
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32) {
    throw new RegistryConfigurationError(
      "SUTRA_REGISTRY_ENCRYPTION_KEY must contain exactly 256 bits",
    );
  }
  return decoded;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertScope(scope: ConnectionScope, connectionId: string): void {
  if (!IDENTIFIER.test(scope.tenantId) || !IDENTIFIER.test(connectionId)) {
    throw new RegistryIntegrityError();
  }
}

function stableEqual(left: RegisteredAwsConnection, right: RegisteredAwsConnection): boolean {
  const leftExternalId = Buffer.from(left.externalId);
  const rightExternalId = Buffer.from(right.externalId);
  return (
    left.expectedAccountId === right.expectedAccountId &&
    left.partition === right.partition &&
    left.roleArn === right.roleArn &&
    leftExternalId.byteLength === rightExternalId.byteLength &&
    timingSafeEqual(leftExternalId, rightExternalId) &&
    left.sessionNamePrefix === right.sessionNamePrefix &&
    left.roleProvisioningMode === right.roleProvisioningMode &&
    left.expectedRolePath === right.expectedRolePath &&
    left.expectedRoleName === right.expectedRoleName &&
    JSON.stringify(left.enabledRegions) === JSON.stringify(right.enabledRegions)
  );
}

/**
 * Shared hosted-broker state. All connection mutations are row-locked in
 * PostgreSQL; trust material is AES-256-GCM encrypted before it reaches the
 * database. Replay reservations and operation leases use single-statement
 * conditional writes, so separate ECS tasks make one decision.
 */
export class HostedPostgresState implements HostedRequestReplayStore, HostedOperationCoordinator {
  private readonly pool: pg.Pool;
  private readonly key: Buffer;
  private readonly owner: string;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly agentlessLeases = new Map<string, { tenantId: string; token: string }>();

  public constructor(options: {
    readonly connectionString: string;
    readonly encryptionKey: string;
    readonly owner?: string;
    readonly now?: () => number;
    readonly leaseMs?: number;
    readonly pool?: pg.Pool;
  }) {
    if (!options.connectionString.startsWith("postgres")) {
      throw new RegistryConfigurationError("DATABASE_URL must be a PostgreSQL URL");
    }
    this.pool = options.pool ?? new pg.Pool({
      connectionString: options.connectionString,
      application_name: "sutra-hosted-broker",
      max: 8,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    this.key = decodeKey(options.encryptionKey);
    this.owner = options.owner ?? `broker-${randomUUID()}`;
    if (!IDENTIFIER.test(this.owner)) throw new RegistryConfigurationError("Broker owner id is invalid");
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 60_000 || this.leaseMs > 3_600_000) {
      throw new RegistryConfigurationError("Hosted broker lease duration is invalid");
    }
  }

  public async ready(): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `SELECT
           to_regclass('public.hosted_broker_connections') IS NOT NULL AS connections,
           to_regclass('public.hosted_broker_request_nonces') IS NOT NULL AS nonces,
           to_regclass('public.hosted_broker_operation_leases') IS NOT NULL AS leases,
           to_regclass('public.hosted_broker_agentless_runs') IS NOT NULL AS agentless_runs,
           to_regclass('public.hosted_broker_agentless_resources') IS NOT NULL AS agentless_resources`,
      );
      const row = result.rows[0] as {
        connections?: boolean; nonces?: boolean; leases?: boolean;
        agentless_runs?: boolean; agentless_resources?: boolean;
      } | undefined;
      return row?.connections === true && row.nonces === true && row.leases === true &&
        row.agentless_runs === true && row.agentless_resources === true;
    } catch {
      return false;
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  /** Loads only the exact active reconciled generation named by the signed ADV-11 request. */
  public async loadEndUserComputingCostProjection(input:{readonly tenantId:string;readonly customerId:string;
    readonly connectionId:string;readonly requestId:string;readonly cur2:Readonly<Record<string,unknown>>;
    readonly accountIds:readonly string[];readonly regions:readonly string[]}):Promise<EndUserComputingCanonicalCostProjection>{
    if(input.cur2.availability==="UNAVAILABLE")return Object.freeze({billingEvidence:null,costs:Object.freeze([])});
    const partitionResult=await this.pool.query<EndUserComputingPartitionRow>(`SELECT id,export_name,billing_period,
      active_generation_id,active_manifest_sha256,active_source_updated_at,active_committed_at,active_accepted_rows
      FROM finops_export_partitions WHERE org_id=$1 AND customer_id=$2 AND connection_id=$3
        AND id=$4 AND billing_period=$5 AND active_generation_id=$6 AND active_manifest_sha256=$7
        AND active_source_format='aws-cur' AND active_source_version='2.0' LIMIT 1`,[input.tenantId,input.customerId,
      input.connectionId,input.cur2.sourceEvidenceId,input.cur2.billingPeriod,input.cur2.generationId,input.cur2.manifestSha256]);
    const partition=partitionResult.rows[0];
    if(partition===undefined||partition.active_source_updated_at!==input.cur2.sourceUpdatedAt
      ||partition.active_committed_at!==input.cur2.committedAt
      ||Number(partition.active_accepted_rows)!==input.cur2.activeGenerationRowCount)throw new RegistryIntegrityError();
    const lines=await this.pool.query<EndUserComputingCostRow>(`SELECT line_item_id,usage_account_id,service,product_code,
      product_name,resource_id,region,usage_start,usage_end,amount_micros,net_unblended_cost_micros,amortized_micros,
      list_cost_micros,contracted_cost_micros,public_on_demand_cost_micros,currency,commitment_type,charge_category
      FROM finops_billing_lines_v2 WHERE org_id=$1 AND customer_id=$2 AND connection_id=$3 AND export_name=$4
        AND billing_period=$5 AND generation_id=$6 AND usage_account_id=ANY($7::text[]) AND region=ANY($8::text[])
      ORDER BY line_item_id ASC LIMIT 250001`,[input.tenantId,input.customerId,input.connectionId,partition.export_name,
      partition.billing_period,partition.active_generation_id,input.accountIds,input.regions]);
    const costs=lines.rows.map(eucCost).filter((value):value is NonNullable<ReturnType<typeof eucCost>>=>value!==null);
    if(costs.length>250_000||costs.length!==input.cur2.matchedLineItemCount
      ||sha256(JSON.stringify(costs))!==input.cur2.projectedCostLinesSha256)throw new RegistryIntegrityError();
    return Object.freeze({billingEvidence:Object.freeze({generationId:partition.active_generation_id,
      billingPeriod:partition.billing_period,sourceEvidenceId:partition.id,manifestSha256:partition.active_manifest_sha256,
      sourceUpdatedAt:partition.active_source_updated_at,committedAt:partition.active_committed_at,sourceFormat:"aws-cur",
      sourceVersion:"2.0",reconciled:true,activeGenerationRowCount:Number(partition.active_accepted_rows),
      matchedLineItemCount:costs.length}),costs:Object.freeze(costs)});
  }

  public async resolve(scope: ConnectionScope, connectionId: string): Promise<StoredAwsConnection | null> {
    return this.getRegistered(scope, connectionId);
  }

  public async getRegistered(
    scope: ConnectionScope,
    connectionId: string,
  ): Promise<RegisteredAwsConnection | null> {
    assertScope(scope, connectionId);
    const result = await this.pool.query<ConnectionRow>(
      `SELECT tenant_id, connection_id, encrypted_state, state_sha256, tombstoned_at
         FROM hosted_broker_connections
        WHERE tenant_id = $1 AND connection_id = $2
        LIMIT 1`,
      [scope.tenantId, connectionId],
    );
    const row = result.rows[0];
    if (row === undefined || row.tombstoned_at !== null) return null;
    return this.decrypt(row);
  }

  public async upsert(input: RegisterAwsConnectionInput): Promise<void> {
    // Static-credential connections are a local-collector capability: customer
    // key material has a reviewed at-rest contract only in the encrypted local
    // registry file. The hosted broker fails closed until a hosted storage
    // contract for that material is separately reviewed.
    if (input.credentialKind === "static_credentials") {
      throw new RegistryStateError();
    }
    const candidate = parseConnectionInput(input);
    await this.mutate(candidate.tenantId, candidate.connectionId, (previous, tombstoned) => {
      if (tombstoned || previous?.status === "DISABLED") throw new RegistryStateError();
      const unchanged = previous !== null && stableEqual(previous, candidate);
      const timestamp = new Date(this.now()).toISOString();
      return {
        ...candidate,
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
        ...(unchanged && previous.computeOptimizerExportObjectContracts !== undefined
          ? {
              computeOptimizerExportObjectContracts: structuredClone(
                previous.computeOptimizerExportObjectContracts,
              ),
            }
          : {}),
        ...(unchanged && previous.computeOptimizerExportLaunchContracts !== undefined
          ? {
              computeOptimizerExportLaunchContracts: structuredClone(
                previous.computeOptimizerExportLaunchContracts,
              ),
            }
          : {}),
        status: unchanged ? previous.status : "PENDING",
        permissionPackVersion: unchanged
          ? previous.permissionPackVersion
          : LEGACY_PERMISSION_PACK_VERSION,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
    });
  }

  public async disable(scope: ConnectionScope, connectionId: string): Promise<void> {
    assertScope(scope, connectionId);
    await this.mutate(scope.tenantId, connectionId, (previous, tombstoned) => {
      if (tombstoned || previous === null || previous.status === "DISABLED") return previous;
      return { ...previous, status: "DISABLED", updatedAt: new Date(this.now()).toISOString() };
    }, true);
  }

  public async offboard(scope: ConnectionScope, connectionId: string): Promise<void> {
    assertScope(scope, connectionId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.lockRow(client, scope.tenantId, connectionId);
      if (result?.tombstoned_at !== null && result !== null) {
        await client.query("COMMIT");
        return;
      }
      const now = this.now();
      await client.query(
        `INSERT INTO hosted_broker_connections
           (tenant_id, connection_id, encrypted_state, state_sha256, tombstoned_at, created_at, updated_at)
         VALUES ($1, $2, NULL, NULL, $3, $3, $3)
         ON CONFLICT (tenant_id, connection_id) DO UPDATE
           SET encrypted_state = NULL, state_sha256 = NULL,
               tombstoned_at = EXCLUDED.tombstoned_at, updated_at = EXCLUDED.updated_at`,
        [scope.tenantId, connectionId, now],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** See upsert: static credentials never reach hosted storage, so this fails closed. */
  public async markStaticCredentialVerified(
    scope: ConnectionScope,
    connectionId: string,
  ): Promise<void> {
    assertScope(scope, connectionId);
    throw new RegistryStateError();
  }

  public async markOnboardingVerified(
    scope: ConnectionScope,
    connectionId: string,
    verification: OnboardingTrustVerification,
  ): Promise<void> {
    assertScope(scope, connectionId);
    await this.mutate(scope.tenantId, connectionId, (connection, tombstoned) => {
      if (tombstoned || connection === null) throw new RegistryConnectionNotFoundError();
      if (
        !new Set(["PENDING", "VERIFIED", "DEGRADED", "ACTIVE"]).has(connection.status) ||
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
        ...connection,
        status: connection.status === "ACTIVE" ? "ACTIVE" : "VERIFIED",
        permissionPackVersion: CURRENT_PERMISSION_PACK_VERSION,
        updatedAt: new Date(this.now()).toISOString(),
      };
    });
  }

  public async markComputeOptimizerExportLaunchProvisioningVerified(
    scope: ConnectionScope,
    connectionId: string,
    unsafeVerification: ComputeOptimizerExportLaunchProvisioningVerification,
  ): Promise<void> {
    assertScope(scope, connectionId);
    await this.mutate(scope.tenantId, connectionId, (connection, tombstoned) => {
      if (tombstoned || connection === null) throw new RegistryConnectionNotFoundError();
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
        return connection;
      }
      return {
        ...connection,
        status: "VERIFIED",
        permissionPackVersion:
          COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
        finopsSourceContracts: structuredClone(verification.sourceContracts),
        computeOptimizerExportObjectContracts:
          structuredClone(verification.objectContracts),
        computeOptimizerExportLaunchContracts:
          structuredClone(verification.launchContracts),
        updatedAt: new Date(this.now()).toISOString(),
      };
    });
  }

  public async activateComputeOptimizerExportLaunchProvisioning(
    scope: ConnectionScope,
    connectionId: string,
    expectedRoleArn: string,
  ): Promise<void> {
    assertScope(scope, connectionId);
    await this.mutate(scope.tenantId, connectionId, (connection, tombstoned) => {
      if (tombstoned || connection === null || connection.roleArn !== expectedRoleArn) {
        throw new RegistryStateError();
      }
      if (connection.status === "ACTIVE" && connection.permissionPackVersion ===
          COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION) return connection;
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
        ...connection,
        status: "ACTIVE",
        updatedAt: new Date(this.now()).toISOString(),
      };
    });
  }

  public async activateOnboarding(
    scope: ConnectionScope,
    connectionId: string,
    expectedRoleArn: string,
  ): Promise<void> {
    assertScope(scope, connectionId);
    await this.mutate(scope.tenantId, connectionId, (connection, tombstoned) => {
      if (tombstoned || connection === null || connection.roleArn !== expectedRoleArn) {
        throw new RegistryStateError();
      }
      if (
        connection.status === "ACTIVE" &&
        connection.permissionPackVersion === CURRENT_PERMISSION_PACK_VERSION
      ) return connection;
      if (
        connection.status !== "VERIFIED" ||
        connection.permissionPackVersion !== CURRENT_PERMISSION_PACK_VERSION
      ) throw new RegistryStateError();
      return { ...connection, status: "ACTIVE", updatedAt: new Date(this.now()).toISOString() };
    });
  }

  public async discardStagedOnboarding(
    scope: ConnectionScope,
    connectionId: string,
    expectedRoleArn: string,
  ): Promise<void> {
    assertScope(scope, connectionId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await this.lockRow(client, scope.tenantId, connectionId);
      if (row === null) {
        await client.query("COMMIT");
        return;
      }
      if (row.tombstoned_at !== null) throw new RegistryStateError();
      const connection = this.decrypt(row);
      if (
        connection.roleArn !== expectedRoleArn ||
        (connection.status !== "PENDING" && connection.status !== "VERIFIED")
      ) throw new RegistryStateError();
      await client.query(
        "DELETE FROM hosted_broker_connections WHERE tenant_id = $1 AND connection_id = $2",
        [scope.tenantId, connectionId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async consume(key: string, expiresAt: number): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/u.test(key) || !Number.isSafeInteger(expiresAt)) return false;
    const result = await this.pool.query(
      `INSERT INTO hosted_broker_request_nonces (nonce_key, expires_at)
       VALUES ($1, $2)
       ON CONFLICT (nonce_key) DO UPDATE SET expires_at = EXCLUDED.expires_at
         WHERE hosted_broker_request_nonces.expires_at <= $3
       RETURNING nonce_key`,
      [key, expiresAt, this.now()],
    );
    return result.rowCount === 1;
  }

  public async claim(operationKey: string): Promise<HostedOperationLease | null> {
    if (!OPERATION_KEY.test(operationKey)) throw new RegistryIntegrityError();
    const now = this.now();
    const leaseToken = randomBytes(24).toString("base64url");
    const result = await this.pool.query(
      `INSERT INTO hosted_broker_operation_leases
         (operation_key, lease_token, lease_owner, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (operation_key) DO UPDATE
         SET lease_token = EXCLUDED.lease_token,
             lease_owner = EXCLUDED.lease_owner,
             expires_at = EXCLUDED.expires_at,
             updated_at = EXCLUDED.updated_at
         WHERE hosted_broker_operation_leases.expires_at <= $5
       RETURNING operation_key`,
      [operationKey, leaseToken, this.owner, now + this.leaseMs, now],
    );
    return result.rowCount === 1 ? { operationKey, leaseToken } : null;
  }

  public async release(lease: HostedOperationLease): Promise<void> {
    if (!OPERATION_KEY.test(lease.operationKey) || !/^[A-Za-z0-9_-]{32}$/u.test(lease.leaseToken)) {
      throw new RegistryIntegrityError();
    }
    await this.pool.query(
      `DELETE FROM hosted_broker_operation_leases
        WHERE operation_key = $1 AND lease_token = $2 AND lease_owner = $3`,
      [lease.operationKey, lease.leaseToken, this.owner],
    );
  }

  public agentlessRunStore(): AgentlessRunStore {
    return {
      claim: (input) => this.claimAgentlessRun(input),
      complete: (runId, execution) => this.completeAgentlessRun(runId, execution),
      fail: (runId, error) => this.failAgentlessRun(runId, error),
      read: (runId, scope) => this.readAgentlessRun(runId, scope),
    };
  }

  public agentlessResourceTracker(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly connectionId: string;
  }): AgentlessResourceTracker {
    return {
      created: (resource) => this.recordAgentlessResource(input, resource),
      deleted: (resource) => this.deleteAgentlessResource(input, resource),
      heartbeat: () => this.heartbeatAgentlessRun(input.runId),
    };
  }

  private async claimAgentlessRun(input: AgentlessRunClaimInput): Promise<AgentlessRunState> {
    if (
      !RUN_ID.test(input.runId) ||
      !IDENTIFIER.test(input.tenantId) ||
      !IDENTIFIER.test(input.connectionId) ||
      input.executionRequest === undefined
    ) throw new RegistryIntegrityError();
    const requestJson = JSON.stringify(input.executionRequest);
    if (Buffer.byteLength(requestJson, "utf8") > 1024 * 1024) throw new RegistryIntegrityError();
    const requestSha256 = sha256(requestJson);
    const now = this.now();
    const token = randomBytes(24).toString("base64url");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<AgentlessRunRow>(
        `SELECT tenant_id, run_id, connection_id, phase, request_json, request_sha256,
                execution_json, error_code, error_message, lease_token, lease_owner,
                lease_expires_at, started_at, finished_at
           FROM hosted_broker_agentless_runs
          WHERE tenant_id = $1 AND run_id = $2
          FOR UPDATE`,
        [input.tenantId, input.runId],
      );
      const existing = selected.rows[0];
      if (existing !== undefined) {
        if (
          existing.connection_id !== input.connectionId ||
          existing.request_sha256 !== requestSha256
        ) throw new RegistryIntegrityError();
        await client.query("COMMIT");
        if (existing.phase === "running" || existing.phase === "recovering") {
          throw new AgentlessRunAlreadyRunningError(input.runId);
        }
        return this.agentlessState(existing);
      }
      await client.query(
        `INSERT INTO hosted_broker_agentless_runs
           (tenant_id, run_id, connection_id, phase, request_json, request_sha256,
            lease_token, lease_owner, lease_expires_at, started_at, updated_at)
         VALUES ($1, $2, $3, 'running', $4, $5, $6, $7, $8, $9, $9)`,
        [
          input.tenantId,
          input.runId,
          input.connectionId,
          requestJson,
          requestSha256,
          token,
          this.owner,
          now + AGENTLESS_LEASE_MS,
          now,
        ],
      );
      await client.query("COMMIT");
      this.agentlessLeases.set(input.runId, { tenantId: input.tenantId, token });
      return {
        runId: input.runId,
        tenantId: input.tenantId,
        connectionId: input.connectionId,
        phase: "running",
        startedAt: new Date(now).toISOString(),
        finishedAt: null,
        execution: null,
        error: null,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async completeAgentlessRun(runId: string, execution: unknown): Promise<void> {
    const lease = this.agentlessLeases.get(runId);
    if (lease === undefined) throw new RegistryStateError();
    const now = this.now();
    const executionJson = JSON.stringify(execution);
    if (Buffer.byteLength(executionJson, "utf8") > 12 * 1024 * 1024) {
      throw new RegistryIntegrityError();
    }
    const result = await this.pool.query(
      `UPDATE hosted_broker_agentless_runs
          SET phase = 'completed', execution_json = $1, error_code = NULL,
              error_message = NULL, lease_token = NULL, lease_owner = NULL,
              lease_expires_at = NULL, finished_at = $2, updated_at = $2
        WHERE tenant_id = $3 AND run_id = $4 AND phase = 'running'
          AND lease_token = $5 AND lease_owner = $6`,
      [executionJson, now, lease.tenantId, runId, lease.token, this.owner],
    );
    this.agentlessLeases.delete(runId);
    if (result.rowCount !== 1) throw new RegistryStateError();
  }

  private async failAgentlessRun(
    runId: string,
    error: { readonly code: string; readonly message: string },
  ): Promise<void> {
    const lease = this.agentlessLeases.get(runId);
    if (lease === undefined) throw new RegistryStateError();
    const now = this.now();
    const result = await this.pool.query(
      `UPDATE hosted_broker_agentless_runs
          SET phase = 'failed', error_code = $1, error_message = $2,
              lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
              finished_at = $3, updated_at = $3
        WHERE tenant_id = $4 AND run_id = $5 AND phase = 'running'
          AND lease_token = $6 AND lease_owner = $7`,
      [
        error.code.slice(0, 128),
        error.message.slice(0, 1000),
        now,
        lease.tenantId,
        runId,
        lease.token,
        this.owner,
      ],
    );
    this.agentlessLeases.delete(runId);
    if (result.rowCount !== 1) throw new RegistryStateError();
  }

  private async readAgentlessRun(
    runId: string,
    scope: { readonly tenantId: string; readonly connectionId: string },
  ): Promise<AgentlessRunState | null> {
    if (!RUN_ID.test(runId) || !IDENTIFIER.test(scope.tenantId) || !IDENTIFIER.test(scope.connectionId)) {
      throw new RegistryIntegrityError();
    }
    const result = await this.pool.query<AgentlessRunRow>(
      `SELECT tenant_id, run_id, connection_id, phase, request_json, request_sha256,
              execution_json, error_code, error_message, lease_token, lease_owner,
              lease_expires_at, started_at, finished_at
         FROM hosted_broker_agentless_runs
        WHERE tenant_id = $1 AND run_id = $2 AND connection_id = $3
        LIMIT 1`,
      [scope.tenantId, runId, scope.connectionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : this.agentlessState(row);
  }

  private agentlessState(row: AgentlessRunRow): AgentlessRunState {
    let execution: unknown | null = null;
    if (row.execution_json !== null) {
      try {
        execution = JSON.parse(row.execution_json) as unknown;
      } catch {
        throw new RegistryIntegrityError();
      }
    }
    return {
      runId: row.run_id,
      tenantId: row.tenant_id,
      connectionId: row.connection_id,
      phase: row.phase === "recovering" ? "running" : row.phase,
      startedAt: new Date(Number(row.started_at)).toISOString(),
      finishedAt: row.finished_at === null ? null : new Date(Number(row.finished_at)).toISOString(),
      execution,
      error: row.error_code === null
        ? null
        : { code: row.error_code, message: row.error_message ?? "The agentless scan failed" },
    };
  }

  private async heartbeatAgentlessRun(runId: string): Promise<void> {
    const lease = this.agentlessLeases.get(runId);
    if (lease === undefined) throw new RegistryStateError();
    const now = this.now();
    const result = await this.pool.query(
      `UPDATE hosted_broker_agentless_runs
          SET lease_expires_at = $1, updated_at = $2
        WHERE tenant_id = $3 AND run_id = $4 AND phase = 'running'
          AND lease_token = $5 AND lease_owner = $6`,
      [now + AGENTLESS_LEASE_MS, now, lease.tenantId, runId, lease.token, this.owner],
    );
    if (result.rowCount !== 1) throw new RegistryStateError();
  }

  private async recordAgentlessResource(
    run: { readonly tenantId: string; readonly runId: string; readonly connectionId: string },
    resource: {
      readonly sourceVolumeId: string;
      readonly resourceId: string;
      readonly resourceKind: AgentlessResourceKind;
      readonly accountScope: "customer" | "sutra-scan-account";
      readonly region: string;
    },
  ): Promise<void> {
    await this.heartbeatAgentlessRun(run.runId);
    const parent = await this.pool.query<{ source_volume_id: string }>(
      `SELECT source_volume_id FROM hosted_broker_agentless_resources
        WHERE tenant_id = $1 AND run_id = $2 AND resource_id = $3 LIMIT 1`,
      [run.tenantId, run.runId, resource.sourceVolumeId],
    );
    const sourceVolumeId = parent.rows[0]?.source_volume_id ?? resource.sourceVolumeId;
    const now = this.now();
    await this.pool.query(
      `INSERT INTO hosted_broker_agentless_resources
         (tenant_id, run_id, connection_id, source_volume_id, resource_id,
          resource_kind, account_scope, region, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT (tenant_id, run_id, resource_id) DO UPDATE
         SET updated_at = EXCLUDED.updated_at
       WHERE hosted_broker_agentless_resources.connection_id = EXCLUDED.connection_id
         AND hosted_broker_agentless_resources.resource_kind = EXCLUDED.resource_kind
         AND hosted_broker_agentless_resources.account_scope = EXCLUDED.account_scope`,
      [
        run.tenantId,
        run.runId,
        run.connectionId,
        sourceVolumeId,
        resource.resourceId,
        resource.resourceKind,
        resource.accountScope,
        resource.region,
        now,
      ],
    );
  }

  private async deleteAgentlessResource(
    run: { readonly tenantId: string; readonly runId: string; readonly connectionId: string },
    resource: {
      readonly resourceId: string;
      readonly resourceKind: AgentlessResourceKind;
      readonly region: string;
    },
  ): Promise<void> {
    await this.heartbeatAgentlessRun(run.runId);
    const now = this.now();
    const result = await this.pool.query(
      `UPDATE hosted_broker_agentless_resources
          SET deleted_at = $1, last_error = NULL, updated_at = $1
        WHERE tenant_id = $2 AND run_id = $3 AND connection_id = $4
          AND resource_id = $5 AND resource_kind = $6 AND region = $7`,
      [
        now,
        run.tenantId,
        run.runId,
        run.connectionId,
        resource.resourceId,
        resource.resourceKind,
        resource.region,
      ],
    );
    if (result.rowCount !== 1) throw new RegistryStateError();
  }

  public async claimExpiredAgentlessRun(): Promise<HostedAgentlessRecoveryClaim | null> {
    const now = this.now();
    const token = randomBytes(24).toString("base64url");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<AgentlessRunRow>(
        `SELECT tenant_id, run_id, connection_id, phase, request_json, request_sha256,
                execution_json, error_code, error_message, lease_token, lease_owner,
                lease_expires_at, started_at, finished_at
           FROM hosted_broker_agentless_runs
          WHERE phase IN ('running', 'recovering')
            AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1
          ORDER BY updated_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [now],
      );
      const row = selected.rows[0];
      if (row === undefined) {
        await client.query("COMMIT");
        return null;
      }
      await client.query(
        `UPDATE hosted_broker_agentless_runs
            SET phase = 'recovering', lease_token = $1, lease_owner = $2,
                lease_expires_at = $3, updated_at = $4
          WHERE tenant_id = $5 AND run_id = $6`,
        [token, this.owner, now + AGENTLESS_LEASE_MS, now, row.tenant_id, row.run_id],
      );
      await client.query("COMMIT");
      this.agentlessLeases.set(row.run_id, { tenantId: row.tenant_id, token });
      let executionRequest: unknown;
      try {
        executionRequest = JSON.parse(row.request_json) as unknown;
      } catch {
        throw new RegistryIntegrityError();
      }
      return {
        tenantId: row.tenant_id,
        runId: row.run_id,
        connectionId: row.connection_id,
        executionRequest,
        resources: await this.listAgentlessResources(row.tenant_id, row.run_id),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async listAgentlessResources(
    tenantId: string,
    runId: string,
  ): Promise<readonly HostedAgentlessResource[]> {
    const result = await this.pool.query<{
      source_volume_id: string; resource_id: string; resource_kind: AgentlessResourceKind;
      account_scope: "customer" | "sutra-scan-account"; region: string;
      deleted_at: string | number | null; last_error: string | null;
    }>(
      `SELECT source_volume_id, resource_id, resource_kind, account_scope, region,
              deleted_at, last_error
         FROM hosted_broker_agentless_resources
        WHERE tenant_id = $1 AND run_id = $2
        ORDER BY created_at ASC`,
      [tenantId, runId],
    );
    return result.rows.map((row) => ({
      sourceVolumeId: row.source_volume_id,
      resourceId: row.resource_id,
      resourceKind: row.resource_kind,
      accountScope: row.account_scope,
      region: row.region,
      deleted: row.deleted_at !== null,
      lastError: row.last_error,
    }));
  }

  /**
   * A signed app request is not deletion authority. Every requested identifier
   * must exactly match unresolved broker-owned provenance before any AWS call.
   */
  public async authorizeAgentlessCleanup(
    tenantId: string,
    resources: readonly HostedAgentlessCleanupLedgerResource[],
  ): Promise<void> {
    if (!IDENTIFIER.test(tenantId) || resources.length === 0 || resources.length > 200) {
      throw new RegistryStateError();
    }
    for (const resource of resources) {
      const internalKind = resource.resourceKind === "snapshot"
        ? resource.accountScope === "customer" ? "customer_snapshot" : "scan_snapshot"
        : resource.resourceKind === "volume"
          ? "scan_volume"
          : "scan_instance";
      const result = await this.pool.query<{ run_id: string }>(
        `SELECT run_id
           FROM hosted_broker_agentless_resources
          WHERE tenant_id = $1 AND connection_id = $2 AND resource_id = $3
            AND resource_kind = $4 AND account_scope = $5 AND region = $6
            AND deleted_at IS NULL
          LIMIT 2`,
        [
          tenantId,
          resource.connectionId,
          resource.resourceId,
          internalKind,
          resource.accountScope,
          resource.region,
        ],
      );
      if (result.rows.length !== 1) throw new RegistryStateError();
    }
  }

  public async recordAgentlessCleanupOutcome(input: {
    readonly tenantId: string;
    readonly resource: HostedAgentlessCleanupLedgerResource;
    readonly settled: boolean;
    readonly detail: string;
  }): Promise<void> {
    const resourceKind = input.resource.resourceKind === "snapshot"
      ? input.resource.accountScope === "customer" ? "customer_snapshot" : "scan_snapshot"
      : input.resource.resourceKind === "volume"
        ? "scan_volume"
        : "scan_instance";
    const now = this.now();
    const result = await this.pool.query(
      `UPDATE hosted_broker_agentless_resources
          SET deleted_at = CASE WHEN $1 THEN $2 ELSE deleted_at END,
              last_error = CASE WHEN $1 THEN NULL ELSE $3 END,
              updated_at = $2
        WHERE tenant_id = $4 AND connection_id = $5 AND resource_id = $6
          AND resource_kind = $7 AND account_scope = $8 AND region = $9
          AND deleted_at IS NULL`,
      [
        input.settled,
        now,
        input.detail.slice(0, 1000),
        input.tenantId,
        input.resource.connectionId,
        input.resource.resourceId,
        resourceKind,
        input.resource.accountScope,
        input.resource.region,
      ],
    );
    if (result.rowCount !== 1) throw new RegistryStateError();
  }

  public async settleRecoveredAgentlessResource(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly resourceId: string;
    readonly error?: string;
  }): Promise<void> {
    const now = this.now();
    if (input.error === undefined) {
      await this.pool.query(
        `UPDATE hosted_broker_agentless_resources
            SET deleted_at = $1, last_error = NULL, updated_at = $1
          WHERE tenant_id = $2 AND run_id = $3 AND resource_id = $4`,
        [now, input.tenantId, input.runId, input.resourceId],
      );
      return;
    }
    await this.pool.query(
      `UPDATE hosted_broker_agentless_resources
          SET last_error = $1, updated_at = $2
        WHERE tenant_id = $3 AND run_id = $4 AND resource_id = $5`,
      [input.error.slice(0, 1000), now, input.tenantId, input.runId, input.resourceId],
    );
  }

  public async finishAgentlessRecovery(
    claim: HostedAgentlessRecoveryClaim,
    execution: unknown,
  ): Promise<void> {
    const lease = this.agentlessLeases.get(claim.runId);
    if (lease === undefined || lease.tenantId !== claim.tenantId) throw new RegistryStateError();
    const now = this.now();
    const result = await this.pool.query(
      `UPDATE hosted_broker_agentless_runs
          SET phase = 'failed', execution_json = $1,
              error_code = 'BROKER_RESTART_RECOVERY',
              error_message = 'The broker restarted during the scan; owned resources were reconciled and the run has no clean result',
              lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
              finished_at = $2, updated_at = $2
        WHERE tenant_id = $3 AND run_id = $4 AND phase = 'recovering'
          AND lease_token = $5 AND lease_owner = $6`,
      [JSON.stringify(execution), now, claim.tenantId, claim.runId, lease.token, this.owner],
    );
    this.agentlessLeases.delete(claim.runId);
    if (result.rowCount !== 1) throw new RegistryStateError();
  }

  public async finalizeAgentlessExecution(
    tenantId: string,
    runId: string,
    execution: AgentlessScanExecution,
  ): Promise<AgentlessScanExecution> {
    const resources = await this.listAgentlessResources(tenantId, runId);
    const results = execution.results.map((result) => {
      const debt = resources
        .filter((resource) => !resource.deleted && resource.sourceVolumeId === result.volumeId)
        .map((resource) => ({
          resourceId: resource.resourceId,
          resourceKind:
            resource.resourceKind === "scan_volume"
              ? "volume" as const
              : resource.resourceKind === "scan_instance"
                ? "instance" as const
                : "snapshot" as const,
          accountScope: resource.accountScope,
          region: resource.region,
          error: resource.accountScope === "customer"
            ? "awaiting the customer-owned lifecycle policy; Sutra cannot delete it"
            : resource.lastError ?? "hosted broker teardown has not been proven complete",
        }));
      return { ...result, teardownDebt: debt };
    });
    const scanOwnedDebt = results.reduce(
      (sum, result) => sum + (result.teardownDebt ?? [])
        .filter((resource) => resource.accountScope === "sutra-scan-account").length,
      0,
    );
    const customerDebt = results.reduce(
      (sum, result) => sum + (result.teardownDebt ?? [])
        .filter((resource) => resource.accountScope === "customer").length,
      0,
    );
    return {
      ...execution,
      results,
      summary: {
        ...execution.summary,
        teardownFailures: Math.max(execution.summary.teardownFailures, scanOwnedDebt),
        cleanupHandoffs: Math.max(execution.summary.cleanupHandoffs, customerDebt),
      },
    };
  }

  private async mutate(
    tenantId: string,
    connectionId: string,
    transform: (
      previous: RegisteredAwsConnection | null,
      tombstoned: boolean,
    ) => RegisteredAwsConnection | null,
    allowMissing = false,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await this.lockRow(client, tenantId, connectionId);
      const previous = row === null || row.tombstoned_at !== null ? null : this.decrypt(row);
      if (row === null && allowMissing) {
        await client.query("COMMIT");
        return;
      }
      const next = transform(previous, row?.tombstoned_at !== null && row !== null);
      if (next !== null) {
        const encrypted = this.encrypt(next);
        const now = this.now();
        await client.query(
          `INSERT INTO hosted_broker_connections
             (tenant_id, connection_id, encrypted_state, state_sha256, tombstoned_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NULL, $5, $5)
           ON CONFLICT (tenant_id, connection_id) DO UPDATE
             SET encrypted_state = EXCLUDED.encrypted_state,
                 state_sha256 = EXCLUDED.state_sha256,
                 tombstoned_at = NULL,
                 updated_at = EXCLUDED.updated_at`,
          [tenantId, connectionId, encrypted.value, encrypted.sha256, now],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockRow(
    client: PoolClient,
    tenantId: string,
    connectionId: string,
  ): Promise<ConnectionRow | null> {
    const result = await client.query<ConnectionRow>(
      `SELECT tenant_id, connection_id, encrypted_state, state_sha256, tombstoned_at
         FROM hosted_broker_connections
        WHERE tenant_id = $1 AND connection_id = $2
        FOR UPDATE`,
      [tenantId, connectionId],
    );
    return result.rows[0] ?? null;
  }

  private encrypt(connection: RegisteredAwsConnection): { value: string; sha256: string } {
    const cleartext = JSON.stringify(connection);
    const iv = randomBytes(12);
    const aad = Buffer.from(`${connection.tenantId}\0${connection.connectionId}`, "utf8");
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(cleartext, "utf8"), cipher.final()]);
    return {
      value: JSON.stringify({
        version: 1,
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      }),
      sha256: sha256(cleartext),
    };
  }

  private decrypt(row: ConnectionRow): RegisteredAwsConnection {
    if (row.encrypted_state === null || row.state_sha256 === null) throw new RegistryIntegrityError();
    try {
      const envelope = JSON.parse(row.encrypted_state) as {
        version?: unknown; iv?: unknown; tag?: unknown; ciphertext?: unknown;
      };
      if (
        envelope.version !== 1 ||
        typeof envelope.iv !== "string" ||
        typeof envelope.tag !== "string" ||
        typeof envelope.ciphertext !== "string"
      ) throw new Error("invalid envelope");
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64url"));
      decipher.setAAD(Buffer.from(`${row.tenant_id}\0${row.connection_id}`, "utf8"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const cleartext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      if (sha256(cleartext) !== row.state_sha256) throw new Error("state digest mismatch");
      const parsed = JSON.parse(cleartext) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid state");
      const connection = parsePersistedConnection(parsed as Record<string, unknown>);
      if (connection.tenantId !== row.tenant_id || connection.connectionId !== row.connection_id) {
        throw new Error("scope mismatch");
      }
      return connection;
    } catch (error) {
      if (error instanceof RegistryIntegrityError) throw error;
      throw new RegistryIntegrityError();
    }
  }
}
