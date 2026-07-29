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

import { EC2Client } from "@aws-sdk/client-ec2";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { Ec2ScanWorker } from "@msp/agentless-scanner/ec2-scan-worker";
import { AwsScanInstanceOperations } from "@msp/agentless-scanner/scan-instance-operations";
import { Ec2AgentlessExecutor } from "@msp/agentless-scanner/executor";

import {
  createWorkloadIdentityRoleBroker,
  sanitizeRoleSessionName,
  workloadIdentityAwsClientConfig,
} from "./role-broker.js";
import type { EncryptedFileConnectionRegistry } from "./local-registry.js";
import type { AwsTemporaryCredentials } from "./types.js";

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
  readonly registry: EncryptedFileConnectionRegistry;
  readonly principalArn: string;
}

export class AgentlessExecutionError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(`agentless-execution: ${code}: ${message}`);
    this.name = "AgentlessExecutionError";
    this.code = code;
  }
}

function ec2ClientFor(credentials: AwsTemporaryCredentials, region: string): EC2Client {
  return new EC2Client({
    ...workloadIdentityAwsClientConfig(region),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      expiration: credentials.expiration,
    },
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
 * Builds the executor for one run. This assumes the orchestrator role, which creates
 * no RESOURCE — so a misconfiguration still fails before anything is billable, but a
 * denied assume is discovered here rather than mid-scan with a snapshot already taken.
 */
export async function createAgentlessExecutor(
  request: AgentlessExecutionRequest,
  dependencies: AgentlessExecutionDependencies,
): Promise<Ec2AgentlessExecutor> {
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

  const s3 = new S3Client(workloadIdentityAwsClientConfig(request.region));

  // Resolved UP FRONT, not lazily. AwsScanInstanceOperations takes a synchronous
  // `ec2` seam, so a lazily-filled holder would only work if scanClientFor happened
  // to be called before the first instance operation. That is true of today's
  // executor and is exactly the kind of implicit ordering that breaks silently when
  // the sequence changes. One assume per run, before anything is billable.
  const scanCredentials = await assumeScanAccountRole(
    request.settings.orchestratorRoleArn,
    request.runId,
    request.region,
  );


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
    ec2: (region) => ec2ClientFor(scanCredentials, region),
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
  });

  const worker = new Ec2ScanWorker({
    operations,
    scannerImage: request.settings.scannerImage,
  });

  return new Ec2AgentlessExecutor({
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
    scanClientFor: async (region) => ec2ClientFor(scanCredentials, region),
    scanAccountId: request.settings.scanAccountId,
    scanAvailabilityZone: request.settings.scanAvailabilityZone,
    kmsKeyArn: request.settings.kmsKeyArn,
    worker,
    liveValidated: true,
  });
}
