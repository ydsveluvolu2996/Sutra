import { createHash } from "node:crypto";

import {
  AssumeRoleCommand,
  GetCallerIdentityCommand,
  STSClient,
  type STSClientConfig,
} from "@aws-sdk/client-sts";

import {
  AssumeRoleFailedError,
  CallerIdentityFailedError,
  ConnectionIntegrityError,
  ConnectionNotFoundError,
  ConnectionScopeViolationError,
  ConnectionStateError,
  IdentityMismatchError,
  NegativeProbeInconclusiveError,
  StsResponseError,
  UnsafeTrustPolicyError,
  type AssumeRoleClient,
  type AwsConnectionStatus,
  type AwsPartition,
  type AwsTemporaryCredentials,
  type CallerIdentityClientFactory,
  type ConnectionScope,
  type NegativeExternalIdProbe,
  type OnboardingTrustVerification,
  type ParsedIamRoleArn,
  type ScopedConnectionRegistry,
  type StoredAwsConnection,
  type ValidatedRoleSession,
} from "./types.js";

const IAM_ROLE_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):iam::([0-9]{12}):role\/([A-Za-z0-9_+=,.@\/-]+)$/;

const ASSUMED_ROLE_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):sts::([0-9]{12}):assumed-role\/([A-Za-z0-9_+=,.@-]+)\/([A-Za-z0-9_+=,.@-]{2,64})$/;

const ACCOUNT_ID = /^[0-9]{12}$/;
const EXTERNAL_ID = /^[A-Za-z0-9_+=,.@:/-]{20,128}$/;
const SESSION_PREFIX = /^[A-Za-z0-9_+=,.@-]{3,32}$/;
const SESSION_NAME = /^[A-Za-z0-9_+=,.@-]{2,64}$/;

const EXPECTED_ACCESS_DENIALS = new Set([
  "AccessDenied",
  "AccessDeniedException",
  "NotAuthorized",
  "NotAuthorizedException",
  "UnauthorizedOperation",
]);

interface ResolvedConnection {
  readonly connection: StoredAwsConnection;
  readonly parsedRoleArn: ParsedIamRoleArn;
  readonly sessionNamePrefix: string;
}

export interface AwsRoleBrokerDependencies {
  readonly registry: ScopedConnectionRegistry;
  readonly assumeRoleClient: AssumeRoleClient;
  readonly callerIdentityClientFactory: CallerIdentityClientFactory;
  readonly now?: () => Date;
}

export interface WorkloadIdentityRoleBrokerOptions {
  readonly registry: ScopedConnectionRegistry;
  readonly region?: string;
  readonly maxAttempts?: number;
}

/**
 * Parse only IAM role ARNs. Account-root, user, STS session, and malformed ARNs are
 * rejected before any AWS call is made.
 */
export function parseIamRoleArn(roleArn: string): ParsedIamRoleArn {
  const match = IAM_ROLE_ARN.exec(roleArn);
  if (match === null) {
    throw new ConnectionIntegrityError("Stored role ARN is not a valid IAM role ARN");
  }

  const partition = match[1] as AwsPartition;
  const accountId = match[2];
  const rolePathAndName = match[3];

  if (
    accountId === undefined ||
    rolePathAndName === undefined ||
    rolePathAndName.startsWith("/") ||
    rolePathAndName.endsWith("/") ||
    rolePathAndName.includes("//")
  ) {
    throw new ConnectionIntegrityError("Stored role ARN contains an invalid role path");
  }

  const roleName = rolePathAndName.split("/").at(-1);
  if (roleName === undefined || roleName.length === 0 || roleName.length > 64) {
    throw new ConnectionIntegrityError("Stored role ARN contains an invalid role name");
  }

  return {
    arn: roleArn,
    partition,
    accountId,
    rolePathAndName,
    roleName,
  };
}

/** Convenience helper used by connection-registration and authorization code. */
export function accountIdFromRoleArn(roleArn: string): string {
  return parseIamRoleArn(roleArn).accountId;
}

/**
 * Produce a deterministic, CloudTrail-friendly STS session name. A short digest
 * avoids collisions after replacement/truncation without exposing trust material.
 */
export function sanitizeRoleSessionName(
  rawJobId: string,
  prefix = "mspcmdb-",
): string {
  if (!SESSION_PREFIX.test(prefix)) {
    throw new ConnectionIntegrityError("Stored STS session-name prefix is invalid");
  }
  if (rawJobId.length === 0 || rawJobId.length > 256) {
    throw new ConnectionIntegrityError("Collector job ID cannot form an STS session name");
  }

  const readable = rawJobId
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_+=,.@-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "job";
  const digest = createHash("sha256").update(rawJobId, "utf8").digest("hex").slice(0, 10);
  const availableReadableLength = 64 - prefix.length - digest.length - 1;

  if (availableReadableLength < 1) {
    throw new ConnectionIntegrityError("Stored STS session-name prefix is too long");
  }

  const result = `${prefix}${readable.slice(0, availableReadableLength)}-${digest}`;
  if (!SESSION_NAME.test(result)) {
    throw new ConnectionIntegrityError("Collector job ID produced an invalid STS session name");
  }
  return result;
}

export class AwsRoleBroker {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: AwsRoleBrokerDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  /** Resolve server-side trust material and return a caller-identity-validated session. */
  public async assumeValidatedSession(
    scope: ConnectionScope,
    connectionId: string,
    jobId: string,
  ): Promise<ValidatedRoleSession> {
    const resolved = await this.resolveConnection(scope, connectionId, ["ACTIVE"]);
    return this.assumeAndValidateIdentity(resolved, jobId);
  }

  /**
   * Onboarding is accepted only after a positive identity check and two explicit
   * negative confused-deputy probes. No temporary credentials leave this method.
   */
  public async verifyOnboardingTrust(
    scope: ConnectionScope,
    connectionId: string,
    jobId: string,
  ): Promise<OnboardingTrustVerification> {
    const resolved = await this.resolveConnection(scope, connectionId, [
      "PENDING",
      "DEGRADED",
    ]);
    const validated = await this.assumeAndValidateIdentity(resolved, jobId);

    const missingResult = await this.runNegativeProbe(
      resolved,
      `${jobId}-missing-external-id`,
      "MISSING_EXTERNAL_ID",
    );
    const wrongResult = await this.runNegativeProbe(
      resolved,
      `${jobId}-wrong-external-id`,
      "WRONG_EXTERNAL_ID",
      createWrongExternalId(resolved.connection),
    );

    if (missingResult === "SUCCEEDED") {
      throw new UnsafeTrustPolicyError("MISSING_EXTERNAL_ID");
    }
    if (wrongResult === "SUCCEEDED") {
      throw new UnsafeTrustPolicyError("WRONG_EXTERNAL_ID");
    }

    return {
      connectionId: validated.connectionId,
      accountId: validated.accountId,
      partition: validated.partition,
      roleArn: validated.roleArn,
      callerIdentityArn: validated.callerIdentityArn,
      roleSessionName: validated.roleSessionName,
      missingExternalIdDenied: true,
      wrongExternalIdDenied: true,
    };
  }

  private async resolveConnection(
    scope: ConnectionScope,
    connectionId: string,
    allowedStatuses: readonly AwsConnectionStatus[],
  ): Promise<ResolvedConnection> {
    if (scope.tenantId.length === 0 || connectionId.length === 0) {
      throw new ConnectionNotFoundError();
    }

    const connection = await this.dependencies.registry.resolve(scope, connectionId);
    if (connection === null) {
      throw new ConnectionNotFoundError();
    }
    if (connection.tenantId !== scope.tenantId) {
      throw new ConnectionScopeViolationError();
    }
    if (connection.connectionId !== connectionId) {
      throw new ConnectionIntegrityError("Scoped registry returned the wrong connection ID");
    }
    if (!allowedStatuses.includes(connection.status)) {
      throw new ConnectionStateError();
    }
    if (!ACCOUNT_ID.test(connection.expectedAccountId)) {
      throw new ConnectionIntegrityError("Stored expected AWS account ID is invalid");
    }
    if (!EXTERNAL_ID.test(connection.externalId)) {
      throw new ConnectionIntegrityError("Stored External ID does not meet platform policy");
    }

    const parsedRoleArn = parseIamRoleArn(connection.roleArn);
    if (parsedRoleArn.accountId !== connection.expectedAccountId) {
      throw new ConnectionIntegrityError(
        "Stored role ARN account does not match the expected AWS account",
      );
    }

    const sessionNamePrefix = connection.sessionNamePrefix ?? "mspcmdb-";
    if (!SESSION_PREFIX.test(sessionNamePrefix)) {
      throw new ConnectionIntegrityError("Stored STS session-name prefix is invalid");
    }

    return { connection, parsedRoleArn, sessionNamePrefix };
  }

  private async assumeAndValidateIdentity(
    resolved: ResolvedConnection,
    jobId: string,
  ): Promise<ValidatedRoleSession> {
    const roleSessionName = sanitizeRoleSessionName(jobId, resolved.sessionNamePrefix);
    let output;

    try {
      output = await this.dependencies.assumeRoleClient.send(
        new AssumeRoleCommand({
          RoleArn: resolved.connection.roleArn,
          RoleSessionName: roleSessionName,
          ExternalId: resolved.connection.externalId,
          DurationSeconds: 900,
        }),
      );
    } catch (error: unknown) {
      throw new AssumeRoleFailedError(errorName(error));
    }

    const credentials = parseTemporaryCredentials(output.Credentials, this.now());
    const identityClient = this.dependencies.callerIdentityClientFactory(credentials);
    let identity;

    try {
      identity = await identityClient.send(new GetCallerIdentityCommand({}));
    } catch (error: unknown) {
      throw new CallerIdentityFailedError(errorName(error));
    }

    const callerIdentityArn = identity.Arn;
    if (
      identity.Account !== resolved.connection.expectedAccountId ||
      callerIdentityArn === undefined ||
      identity.UserId === undefined ||
      !identity.UserId.endsWith(`:${roleSessionName}`) ||
      !matchesExpectedAssumedRoleArn(
        callerIdentityArn,
        resolved.parsedRoleArn,
        roleSessionName,
      )
    ) {
      throw new IdentityMismatchError();
    }

    return {
      connectionId: resolved.connection.connectionId,
      accountId: resolved.connection.expectedAccountId,
      partition: resolved.parsedRoleArn.partition,
      roleArn: resolved.connection.roleArn,
      roleSessionName,
      callerIdentityArn,
      expiresAt: credentials.expiration,
      credentials,
    };
  }

  private async runNegativeProbe(
    resolved: ResolvedConnection,
    jobId: string,
    probe: NegativeExternalIdProbe,
    externalId?: string,
  ): Promise<"DENIED" | "SUCCEEDED"> {
    const input = {
      RoleArn: resolved.connection.roleArn,
      RoleSessionName: sanitizeRoleSessionName(jobId, resolved.sessionNamePrefix),
      DurationSeconds: 900,
      ...(externalId === undefined ? {} : { ExternalId: externalId }),
    };

    try {
      await this.dependencies.assumeRoleClient.send(new AssumeRoleCommand(input));
      return "SUCCEEDED";
    } catch (error: unknown) {
      const name = errorName(error);
      if (EXPECTED_ACCESS_DENIALS.has(name)) {
        return "DENIED";
      }
      throw new NegativeProbeInconclusiveError(probe, name);
    }
  }
}

/**
 * Production constructor. The source STS client intentionally has no static
 * credentials configuration, so the AWS SDK resolves the service's workload identity.
 */
export function createWorkloadIdentityRoleBroker(
  options: WorkloadIdentityRoleBrokerOptions,
): AwsRoleBroker {
  const clientConfig: STSClientConfig = {
    retryMode: "standard",
    maxAttempts: options.maxAttempts ?? 4,
  };
  if (options.region !== undefined) {
    clientConfig.region = options.region;
  }

  const assumeRoleClient = new STSClient(clientConfig);
  return new AwsRoleBroker({
    registry: options.registry,
    assumeRoleClient,
    callerIdentityClientFactory: (credentials) =>
      new STSClient({ ...clientConfig, credentials }),
  });
}

function parseTemporaryCredentials(
  value:
    | {
        AccessKeyId?: string | undefined;
        SecretAccessKey?: string | undefined;
        SessionToken?: string | undefined;
        Expiration?: Date | undefined;
      }
    | undefined,
  now: Date,
): AwsTemporaryCredentials {
  if (
    value?.AccessKeyId === undefined ||
    value.AccessKeyId.length === 0 ||
    value.SecretAccessKey === undefined ||
    value.SecretAccessKey.length === 0 ||
    value.SessionToken === undefined ||
    value.SessionToken.length === 0 ||
    !(value.Expiration instanceof Date) ||
    !Number.isFinite(value.Expiration.getTime()) ||
    value.Expiration.getTime() <= now.getTime() + 60_000
  ) {
    throw new StsResponseError();
  }

  return {
    accessKeyId: value.AccessKeyId,
    secretAccessKey: value.SecretAccessKey,
    sessionToken: value.SessionToken,
    expiration: value.Expiration,
  };
}

function matchesExpectedAssumedRoleArn(
  callerIdentityArn: string,
  expectedRole: ParsedIamRoleArn,
  expectedSessionName: string,
): boolean {
  const match = ASSUMED_ROLE_ARN.exec(callerIdentityArn);
  return (
    match !== null &&
    match[1] === expectedRole.partition &&
    match[2] === expectedRole.accountId &&
    match[3] === expectedRole.roleName &&
    match[4] === expectedSessionName
  );
}

function createWrongExternalId(connection: StoredAwsConnection): string {
  const digest = createHash("sha256")
    .update(`${connection.tenantId}:${connection.connectionId}:${connection.externalId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  const candidate = `mspcmdb-negative-${digest}`;
  return candidate === connection.externalId ? `${candidate}-x` : candidate;
}

function errorName(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    error.name.length > 0
  ) {
    return error.name;
  }
  return "UnknownError";
}
