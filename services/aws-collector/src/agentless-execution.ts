/**
 * Drives an agentless scan. Lives in the COLLECTOR because this is the only process
 * that may talk to AWS.
 *
 * ── WHY NOT IN THE WORKER ───────────────────────────────────────────────────
 * The execute route originally intended to build the executor itself. It cannot:
 * workerd holds no AWS SDK (`@aws-sdk/*` is not even a root dependency) and never
 * constructs a role broker. It reaches AWS solely over the loopback collector at
 * SUTRA_BROKER_URL. That boundary is deliberate — the Worker serves public HTTP and
 * must not hold AWS credentials — so execution belongs here, next to the SDK, the
 * broker and the workload credentials.
 *
 * ── THE CEILINGS, WHICH ARE THE WHOLE SECURITY DESIGN ───────────────────────
 * The two sides are deliberately asymmetric, and getting this wrong is the failure
 * this file is written to prevent:
 *
 *   CUSTOMER account — `broker.assumeAgentlessSession`, never
 *     `assumeValidatedSession`. The agentless STS ceiling permits the snapshot verbs
 *     the read-only collection ceiling withholds, and denies every destructive verb,
 *     so even a compromised control plane cannot delete a customer's data.
 *
 *   SUTRA's scan account — the orchestrator role, with NO session policy. That
 *     policy denies `ec2:Delete*`, which is exactly what teardown in our own account
 *     needs. Applying it there would not fail loudly: it would leave every scan
 *     volume and copied snapshot behind, billing forever, while each scan still
 *     reported success.
 */

import {
  DeleteSnapshotCommand,
  DeleteVolumeCommand,
  DescribeInstancesCommand,
  DescribeSnapshotsCommand,
  DescribeVolumesCommand,
  EC2Client,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { Ec2ScanWorker } from "./ec2-scan-worker.js";
import { AwsScanInstanceOperations } from "./scan-instance-operations.js";
import { Ec2AgentlessExecutor } from "./executor.js";
import type { AgentlessExecutor } from "./scan-runner.js";

import {
  createWorkloadIdentityRoleBroker,
  sanitizeRoleSessionName,
  workloadIdentityAwsClientConfig,
} from "./role-broker.js";
import type { AwsTemporaryCredentials, ScopedConnectionRegistry } from "./types.js";

/** The 12 resolved SUTRA_AGENTLESS_* values, passed from the Worker. */
export interface AgentlessExecutionSettings {
  readonly scanAccountId: string;
  readonly scanAvailabilityZone: string;
  readonly kmsKeyArn: string | null;
  readonly scannerImage: string;
  readonly liveValidated: boolean;
  readonly orchestratorRoleArn: string;
  readonly instance: {
    readonly amiId: string;
    readonly instanceType: string;
    readonly subnetId: string;
    readonly securityGroupId: string;
    readonly instanceProfileArn: string;
    readonly findingsBucket: string;
  };
}

export interface AgentlessExecutionRequest {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly runId: string;
  readonly region: string;
  readonly settings: AgentlessExecutionSettings;
}

export interface AgentlessExecutionDependencies {
  readonly registry: ScopedConnectionRegistry;
  readonly principalArn: string;
  readonly resourceTracker?: AgentlessResourceTracker;
}

export type AgentlessResourceKind =
  | "customer_snapshot"
  | "scan_snapshot"
  | "scan_volume"
  | "scan_instance";

export interface AgentlessResourceTracker {
  created(input: {
    readonly sourceVolumeId: string;
    readonly resourceId: string;
    readonly resourceKind: AgentlessResourceKind;
    readonly accountScope: "customer" | "sutra-scan-account";
    readonly region: string;
  }): Promise<void>;
  deleted(input: {
    readonly resourceId: string;
    readonly resourceKind: AgentlessResourceKind;
    readonly region: string;
  }): Promise<void>;
  heartbeat(): Promise<void>;
}

export interface RecoverableAgentlessResource {
  readonly resourceId: string;
  readonly resourceKind: AgentlessResourceKind;
  readonly accountScope: "customer" | "sutra-scan-account";
  readonly region: string;
  readonly deleted: boolean;
}

export interface AgentlessRecoveryOutcome {
  readonly resourceId: string;
  readonly recovered: boolean;
  readonly error: string | null;
}

export interface HostedAgentlessTeardownResource {
  readonly connectionId: string;
  readonly resourceId: string;
  readonly resourceKind: "snapshot" | "volume" | "instance";
  readonly accountScope: "customer" | "sutra-scan-account";
  readonly region: string;
}

export interface HostedAgentlessTeardownResult {
  readonly schema: "sutra.aws-agentless-teardown-sweep.v1";
  readonly outcomes: readonly {
    readonly resourceId: string;
    readonly disposition:
      | "settled"
      | "deleted"
      | "awaiting-customer"
      | "retry-failed"
      | "unknown";
    readonly detail: string;
  }[];
  readonly summary: {
    readonly considered: number;
    readonly settled: number;
    readonly deleted: number;
    readonly awaitingCustomer: number;
    readonly retryFailed: number;
    readonly unknown: number;
    readonly stillOutstanding: number;
  };
}

export class AgentlessExecutionError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(`agentless-execution: ${code}: ${message}`);
    this.name = "AgentlessExecutionError";
    this.code = code;
  }
}

interface AwsSdkCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration: Date;
}

type ScanCredentialProvider = () => Promise<AwsSdkCredentials>;

function sdkCredentials(credentials: AwsTemporaryCredentials): AwsSdkCredentials {
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    expiration: credentials.expiration,
  };
}

function ec2ClientFor(
  credentials: AwsTemporaryCredentials | ScanCredentialProvider,
  region: string,
): EC2Client {
  return new EC2Client({
    ...workloadIdentityAwsClientConfig(region),
    credentials: typeof credentials === "function" ? credentials : sdkCredentials(credentials),
  });
}

/**
 * Assumes SUTRA's own orchestrator role. Takes no session-policy argument by design:
 * see the header. The absence is enforced by this signature rather than by a runtime
 * check someone could forget to call.
 */
async function assumeScanAccountRole(
  orchestratorRoleArn: string,
  runId: string,
  region: string,
): Promise<AwsTemporaryCredentials> {
  const sts = new STSClient(workloadIdentityAwsClientConfig(region));
  const output = await sts.send(new AssumeRoleCommand({
    RoleArn: orchestratorRoleArn,
    RoleSessionName: sanitizeRoleSessionName(runId, "sutra-agentless-scan-"),
    DurationSeconds: 3600,
  }));
  const credentials = output.Credentials;
  if (
    credentials?.AccessKeyId === undefined ||
    credentials.SecretAccessKey === undefined ||
    credentials.SessionToken === undefined ||
    credentials.Expiration === undefined
  ) {
    throw new AgentlessExecutionError(
      "SCAN_ROLE_ASSUME_INCOMPLETE",
      "STS returned an incomplete credential set for the orchestrator role",
    );
  }
  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
    expiration: credentials.Expiration,
  };
}

/**
 * Refreshing provider for long agentless runs. Snapshot readiness plus scanner
 * execution can exceed the one-hour STS session, so every scan-account AWS
 * client receives this provider instead of credentials captured at run start.
 * Refreshes are coalesced and occur five minutes before expiry.
 */
export function createRefreshingScanAccountCredentialProvider(input: {
  readonly orchestratorRoleArn: string;
  readonly runId: string;
  readonly region: string;
  readonly assume?: (
    orchestratorRoleArn: string,
    runId: string,
    region: string,
  ) => Promise<AwsTemporaryCredentials>;
  readonly now?: () => number;
  readonly refreshBeforeMs?: number;
}): ScanCredentialProvider {
  const assume = input.assume ?? assumeScanAccountRole;
  const now = input.now ?? Date.now;
  const refreshBeforeMs = input.refreshBeforeMs ?? 5 * 60_000;
  if (
    !Number.isSafeInteger(refreshBeforeMs) ||
    refreshBeforeMs < 60_000 ||
    refreshBeforeMs > 15 * 60_000
  ) {
    throw new AgentlessExecutionError(
      "SCAN_ROLE_REFRESH_INVALID",
      "the scan-account credential refresh window is invalid",
    );
  }
  let current: AwsTemporaryCredentials | null = null;
  let inFlight: Promise<AwsTemporaryCredentials> | null = null;
  return async () => {
    if (
      current !== null &&
      current.expiration.getTime() - now() > refreshBeforeMs
    ) {
      return sdkCredentials(current);
    }
    if (inFlight === null) {
      inFlight = assume(input.orchestratorRoleArn, input.runId, input.region)
        .then((credentials) => {
          if (credentials.expiration.getTime() - now() <= refreshBeforeMs) {
            throw new AgentlessExecutionError(
              "SCAN_ROLE_SESSION_TOO_SHORT",
              "STS returned scan-account credentials too close to expiry",
            );
          }
          current = credentials;
          return credentials;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return sdkCredentials(await inFlight);
  };
}

function isAlreadyAbsent(error: unknown): boolean {
  const value = error as { name?: unknown; Code?: unknown; code?: unknown };
  const text = [value.name, value.Code, value.code]
    .filter((entry): entry is string => typeof entry === "string")
    .join(" ");
  return /(?:InvalidInstanceID|InvalidVolume|InvalidSnapshot).*NotFound/iu.test(text);
}

function safeAwsFailure(error: unknown): string {
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(name)
    ? `AWS ${name}`
    : "AWS request failed";
}

async function resourceStillExists(
  client: EC2Client,
  resource: HostedAgentlessTeardownResource,
): Promise<boolean> {
  try {
    if (resource.resourceKind === "snapshot") {
      const result = await client.send(new DescribeSnapshotsCommand({
        SnapshotIds: [resource.resourceId],
      }));
      return (result.Snapshots?.length ?? 0) > 0;
    }
    if (resource.resourceKind === "volume") {
      const result = await client.send(new DescribeVolumesCommand({
        VolumeIds: [resource.resourceId],
      }));
      return (result.Volumes?.length ?? 0) > 0;
    }
    const result = await client.send(new DescribeInstancesCommand({
      InstanceIds: [resource.resourceId],
    }));
    return (result.Reservations ?? []).some(
      (reservation) => (reservation.Instances?.length ?? 0) > 0,
    );
  } catch (error) {
    if (isAlreadyAbsent(error)) return false;
    throw error;
  }
}

/**
 * Reconciles persisted control-plane teardown debt through the broker. The app
 * supplies only scoped identifiers; every AWS session is created here. Customer
 * resources are observation-only through the agentless deny ceiling, while
 * delete calls use Sutra's scan-account orchestrator role.
 */
export async function sweepHostedAgentlessTeardownDebt(input: {
  readonly tenantId: string;
  readonly operationId: string;
  readonly settings: AgentlessExecutionSettings;
  readonly resources: readonly HostedAgentlessTeardownResource[];
}, dependencies: {
  readonly registry: ScopedConnectionRegistry;
  readonly principalArn: string;
}): Promise<HostedAgentlessTeardownResult> {
  const region = input.settings.scanAvailabilityZone.slice(0, -1);
  const roleBroker = createWorkloadIdentityRoleBroker({
    registry: dependencies.registry,
    principalArn: dependencies.principalArn,
    region,
  });
  const scanCredentialProvider = createRefreshingScanAccountCredentialProvider({
    orchestratorRoleArn: input.settings.orchestratorRoleArn,
    runId: input.operationId,
    region,
  });
  const scanClients = new Map<string, EC2Client>();
  const customerClients = new Map<string, Promise<EC2Client>>();
  const scanClient = (resourceRegion: string): EC2Client => {
    const existing = scanClients.get(resourceRegion);
    if (existing !== undefined) return existing;
    const created = ec2ClientFor(scanCredentialProvider, resourceRegion);
    scanClients.set(resourceRegion, created);
    return created;
  };
  const customerClient = (
    connectionId: string,
    resourceRegion: string,
  ): Promise<EC2Client> => {
    const key = `${connectionId}\u0000${resourceRegion}`;
    const existing = customerClients.get(key);
    if (existing !== undefined) return existing;
    const created = roleBroker.assumeAgentlessSession(
      { tenantId: input.tenantId },
      connectionId,
      input.operationId,
    ).then((session) => ec2ClientFor(session.credentials, resourceRegion));
    customerClients.set(key, created);
    return created;
  };

  const resources = input.resources.slice(0, 200);
  const outcomes: HostedAgentlessTeardownResult["outcomes"][number][] =
    new Array(resources.length);
  let nextIndex = 0;
  const processResource = async (
    resource: HostedAgentlessTeardownResource,
  ): Promise<HostedAgentlessTeardownResult["outcomes"][number]> => {
    let deletingOwnedResource = false;
    try {
      const client = resource.accountScope === "customer"
        ? await customerClient(resource.connectionId, resource.region)
        : scanClient(resource.region);
      const exists = await resourceStillExists(client, resource);
      if (!exists) {
        return {
          resourceId: resource.resourceId,
          disposition: "settled",
          detail: "resource is no longer present in AWS",
        };
      }
      if (resource.accountScope === "customer") {
        return {
          resourceId: resource.resourceId,
          disposition: "awaiting-customer",
          detail: "customer lifecycle policy owns deletion; Sutra is observation-only",
        };
      }
      deletingOwnedResource = true;
      if (resource.resourceKind === "snapshot") {
        await client.send(new DeleteSnapshotCommand({ SnapshotId: resource.resourceId }));
      } else if (resource.resourceKind === "volume") {
        await client.send(new DeleteVolumeCommand({ VolumeId: resource.resourceId }));
      } else {
        await client.send(new TerminateInstancesCommand({ InstanceIds: [resource.resourceId] }));
      }
      return {
        resourceId: resource.resourceId,
        disposition: "deleted",
        detail: "deleted from Sutra's scan account",
      };
    } catch (error) {
      return {
        resourceId: resource.resourceId,
        disposition: deletingOwnedResource ? "retry-failed" : "unknown",
        detail: safeAwsFailure(error),
      };
    }
  };
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      const resource = resources[index];
      if (resource === undefined) return;
      outcomes[index] = await processResource(resource);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(8, resources.length) }, () => worker()),
  );
  if (outcomes.some((outcome) => outcome === undefined)) {
    throw new AgentlessExecutionError(
      "CLEANUP_RESULT_INCOMPLETE",
      "the bounded cleanup worker did not produce a complete result",
    );
  }
  const count = (
    disposition: HostedAgentlessTeardownResult["outcomes"][number]["disposition"],
  ): number => outcomes.filter((entry) => entry.disposition === disposition).length;
  const settled = count("settled");
  const deleted = count("deleted");
  const awaitingCustomer = count("awaiting-customer");
  const retryFailed = count("retry-failed");
  const unknown = count("unknown");
  return {
    schema: "sutra.aws-agentless-teardown-sweep.v1",
    outcomes,
    summary: {
      considered: outcomes.length,
      settled,
      deleted,
      awaitingCustomer,
      retryFailed,
      unknown,
      stillOutstanding: awaitingCustomer + retryFailed + unknown,
    },
  };
}

/**
 * Restart compensation for resources Sutra owns. Customer snapshots are
 * deliberately skipped: the customer-role session has an explicit delete deny
 * and their lifecycle policy owns that handoff.
 */
export async function recoverAgentlessOwnedResources(input: {
  readonly runId: string;
  readonly settings: AgentlessExecutionSettings;
  readonly resources: readonly RecoverableAgentlessResource[];
}): Promise<readonly AgentlessRecoveryOutcome[]> {
  const credentialProvider = createRefreshingScanAccountCredentialProvider({
    orchestratorRoleArn: input.settings.orchestratorRoleArn,
    runId: input.runId,
    region: input.settings.scanAvailabilityZone.slice(0, -1),
  });
  await credentialProvider();
  const clients = new Map<string, EC2Client>();
  const client = (region: string): EC2Client => {
    const existing = clients.get(region);
    if (existing !== undefined) return existing;
    const created = ec2ClientFor(credentialProvider, region);
    clients.set(region, created);
    return created;
  };
  const order: Readonly<Record<AgentlessResourceKind, number>> = {
    scan_instance: 0,
    scan_volume: 1,
    scan_snapshot: 2,
    customer_snapshot: 3,
  };
  const outcomes: AgentlessRecoveryOutcome[] = [];
  for (const resource of [...input.resources].sort(
    (left, right) => order[left.resourceKind] - order[right.resourceKind],
  )) {
    if (resource.deleted || resource.accountScope === "customer") continue;
    try {
      if (resource.resourceKind === "scan_instance") {
        await client(resource.region).send(
          new TerminateInstancesCommand({ InstanceIds: [resource.resourceId] }),
        );
      } else if (resource.resourceKind === "scan_volume") {
        await client(resource.region).send(
          new DeleteVolumeCommand({ VolumeId: resource.resourceId }),
        );
      } else if (resource.resourceKind === "scan_snapshot") {
        await client(resource.region).send(
          new DeleteSnapshotCommand({ SnapshotId: resource.resourceId }),
        );
      }
      outcomes.push({ resourceId: resource.resourceId, recovered: true, error: null });
    } catch (error) {
      if (isAlreadyAbsent(error)) {
        outcomes.push({ resourceId: resource.resourceId, recovered: true, error: null });
      } else {
        outcomes.push({
          resourceId: resource.resourceId,
          recovered: false,
          error: error instanceof Error ? error.message : "AWS teardown failed",
        });
      }
    }
  }
  return outcomes;
}

/**
 * Builds the executor for one run. This assumes the orchestrator role, which creates
 * no RESOURCE — so a misconfiguration still fails before anything is billable, but a
 * denied assume is discovered here rather than mid-scan with a snapshot already taken.
 */
export async function createAgentlessExecutor(
  request: AgentlessExecutionRequest,
  dependencies: AgentlessExecutionDependencies,
): Promise<AgentlessExecutor> {
  if (!request.settings.liveValidated) {
    // Belt and braces: the Worker refuses first, but this is the process that would
    // actually spend money, so it refuses too rather than trusting its caller.
    throw new AgentlessExecutionError(
      "NOT_LIVE_VALIDATED",
      "refusing to execute without the operator attestation that the AWS calls were validated",
    );
  }

  const broker = createWorkloadIdentityRoleBroker({
    registry: dependencies.registry,
    principalArn: dependencies.principalArn,
    region: request.region,
  });

  const scanCredentialProvider = createRefreshingScanAccountCredentialProvider({
    orchestratorRoleArn: request.settings.orchestratorRoleArn,
    runId: request.runId,
    region: request.region,
  });
  // Fail before anything is billable, while retaining refresh for a run whose
  // snapshot waits and scanner execution cross the initial session expiry.
  await scanCredentialProvider();
  const s3 = new S3Client({
    ...workloadIdentityAwsClientConfig(request.region),
    credentials: scanCredentialProvider,
  });


  const operations = new AwsScanInstanceOperations({
    settings: {
      amiId: request.settings.instance.amiId,
      instanceType: request.settings.instance.instanceType,
      subnetId: request.settings.instance.subnetId,
      securityGroupId: request.settings.instance.securityGroupId,
      instanceProfileArn: request.settings.instance.instanceProfileArn,
      findingsBucket: request.settings.instance.findingsBucket,
      scannerImage: request.settings.scannerImage,
      region: request.region,
      runId: request.runId,
    },
    // The instance lifecycle happens in SUTRA's account, so it always uses the
    // scan-account session — never the customer's.
    ec2: (region) => ec2ClientFor(scanCredentialProvider, region),
    readObject: async (bucket, key) => {
      try {
        const output = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return (await output.Body?.transformToString()) ?? null;
      } catch (error) {
        // A genuinely absent object means "still running". Anything else must not be
        // flattened into that, or a broken read would look like a scan in progress
        // forever — or worse, be retried until the timeout reports no result.
        const name = (error as { name?: unknown }).name;
        if (name === "NoSuchKey" || name === "NotFound") return null;
        throw error;
      }
    },
    ...(dependencies.resourceTracker === undefined ? {} : {
      resourceTracker: dependencies.resourceTracker,
    }),
  });

  const worker = new Ec2ScanWorker({
    operations,
    scannerImage: request.settings.scannerImage,
  });

  const delegate = new Ec2AgentlessExecutor({
    customerClientFor: async (region) => {
      // The broker owns external-id decryption, the identity check and the per-use
      // role re-attestation. The agentless ceiling is chosen by the METHOD, so a
      // caller cannot widen it by passing the wrong argument.
      const session = await broker.assumeAgentlessSession(
        { tenantId: request.tenantId },
        request.connectionId,
        request.runId,
      );
      return ec2ClientFor(session.credentials, region);
    },
    scanClientFor: async (region) => ec2ClientFor(scanCredentialProvider, region),
    scanAccountId: request.settings.scanAccountId,
    scanAvailabilityZone: request.settings.scanAvailabilityZone,
    kmsKeyArn: request.settings.kmsKeyArn,
    worker,
    liveValidated: true,
  });
  const tracker = dependencies.resourceTracker;
  if (tracker === undefined) return delegate;
  return {
    async createSnapshot(input) {
      await tracker.heartbeat();
      const created = await delegate.createSnapshot(input);
      await tracker.created({
        sourceVolumeId: input.volumeId,
        resourceId: created.snapshotId,
        resourceKind: "customer_snapshot",
        accountScope: "customer",
        region: input.region,
      });
      return created;
    },
    async copySnapshotKms(input) {
      await tracker.heartbeat();
      const created = await delegate.copySnapshotKms(input);
      await tracker.created({
        sourceVolumeId: input.snapshotId,
        resourceId: created.snapshotId,
        resourceKind: "scan_snapshot",
        accountScope: "sutra-scan-account",
        region: input.region,
      });
      return created;
    },
    async createScanVolume(input) {
      await tracker.heartbeat();
      const created = await delegate.createScanVolume(input);
      await tracker.created({
        sourceVolumeId: input.snapshotId,
        resourceId: created.volumeId,
        resourceKind: "scan_volume",
        accountScope: "sutra-scan-account",
        region: input.region,
      });
      return created;
    },
    async runScan(input) {
      await tracker.heartbeat();
      const result = await delegate.runScan(input);
      await tracker.heartbeat();
      return result;
    },
    async deleteVolume(input) {
      await delegate.deleteVolume(input);
      await tracker.deleted({
        resourceId: input.volumeId,
        resourceKind: "scan_volume",
        region: request.region,
      });
    },
    async deleteScanAccountSnapshot(input) {
      await delegate.deleteScanAccountSnapshot(input);
      await tracker.deleted({
        resourceId: input.snapshotId,
        resourceKind: "scan_snapshot",
        region: request.region,
      });
    },
  };
}
