import { AwsRoleBroker } from "./role-broker.js";
import {
  InvalidJobError,
  type ConnectionScope,
  type InventoryCollectionResult,
  type InventoryJobRequest,
  type InventoryJobResult,
  type InventoryRunner,
  type OnboardingVerificationJobRequest,
  type OnboardingVerificationJobResult,
  type ScopedConnectionRegistry,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const ALLOWED_JOB_KEYS = new Set(["jobId", "connectionId"]);

export interface AwsCollectorJobHandlerDependencies {
  readonly roleBroker: AwsRoleBroker;
  readonly registry: ScopedConnectionRegistry;
  readonly inventoryRunner: InventoryRunner;
  readonly now?: () => Date;
}

/**
 * Boundary for queue/API jobs. Trust material is never read from a job, and all
 * responses are constructed from explicit safe-field allowlists.
 */
export class AwsCollectorJobHandler {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: AwsCollectorJobHandlerDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  public async handleInventoryJob(
    scope: ConnectionScope,
    rawJob: unknown,
  ): Promise<InventoryJobResult> {
    assertTrustedScope(scope);
    const job = parseInventoryJob(rawJob);

    // Role ARN and External ID are resolved inside the broker from the scoped registry.
    const session = await this.dependencies.roleBroker.assumeValidatedSession(
      scope,
      job.connectionId,
      job.jobId,
    );

    // This is the only handoff of temporary credentials. They go directly to the
    // internal inventory runner and are never copied into the public result.
    const collected = await this.dependencies.inventoryRunner.collect({
      tenantId: scope.tenantId,
      connectionId: job.connectionId,
      jobId: job.jobId,
      accountId: session.accountId,
      partition: session.partition,
      roleSessionName: session.roleSessionName,
      credentials: session.credentials,
    });
    assertInventoryResult(collected);

    return {
      jobId: job.jobId,
      connectionId: job.connectionId,
      accountId: session.accountId,
      partition: session.partition,
      resourcesObserved: collected.resourcesObserved,
      findingsObserved: collected.findingsObserved,
      coverage: collected.coverage,
      completedAt: this.now().toISOString(),
    };
  }

  public async handleOnboardingVerificationJob(
    scope: ConnectionScope,
    rawJob: unknown,
  ): Promise<OnboardingVerificationJobResult> {
    assertTrustedScope(scope);
    const job = parseOnboardingJob(rawJob);
    const verification = await this.dependencies.roleBroker.verifyOnboardingTrust(
      scope,
      job.connectionId,
      job.jobId,
    );

    // A registry implementation should make this transition conditional on the
    // connection still being pending/degraded to prevent stale verification races.
    await this.dependencies.registry.markOnboardingVerified(
      scope,
      job.connectionId,
      verification,
    );

    return {
      jobId: job.jobId,
      connectionId: job.connectionId,
      accountId: verification.accountId,
      partition: verification.partition,
      roleArn: verification.roleArn,
      callerIdentityArn: verification.callerIdentityArn,
      missingExternalIdDenied: true,
      wrongExternalIdDenied: true,
      trustPolicyAttested: true,
      permissionPolicyAttested: true,
      sessionPolicyApplied: true,
      permissionPackVersion: verification.permissionPackVersion,
      verifiedAt: this.now().toISOString(),
    };
  }
}

function parseInventoryJob(value: unknown): InventoryJobRequest {
  const parsed = parseJob(value);
  return { jobId: parsed.jobId, connectionId: parsed.connectionId };
}

function parseOnboardingJob(value: unknown): OnboardingVerificationJobRequest {
  const parsed = parseJob(value);
  return { jobId: parsed.jobId, connectionId: parsed.connectionId };
}

function parseJob(value: unknown): { jobId: string; connectionId: string } {
  if (!isRecord(value)) {
    throw new InvalidJobError();
  }

  for (const key of Object.keys(value)) {
    if (!ALLOWED_JOB_KEYS.has(key)) {
      // Reject roleArn, externalId, credentials, tenantId, and every unknown field.
      throw new InvalidJobError("Collector job contains a field that is not allowed");
    }
  }

  const jobId = value.jobId;
  const connectionId = value.connectionId;
  if (
    typeof jobId !== "string" ||
    !IDENTIFIER.test(jobId) ||
    typeof connectionId !== "string" ||
    !IDENTIFIER.test(connectionId)
  ) {
    throw new InvalidJobError();
  }

  return { jobId, connectionId };
}

function assertTrustedScope(scope: ConnectionScope): void {
  if (!IDENTIFIER.test(scope.tenantId)) {
    throw new InvalidJobError("Trusted tenant scope is invalid");
  }
}

function assertInventoryResult(value: InventoryCollectionResult): void {
  if (
    !Number.isSafeInteger(value.resourcesObserved) ||
    value.resourcesObserved < 0 ||
    !Number.isSafeInteger(value.findingsObserved) ||
    value.findingsObserved < 0 ||
    (value.coverage !== "COMPLETE" && value.coverage !== "PARTIAL")
  ) {
    throw new InvalidJobError("Inventory runner returned an invalid summary");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
