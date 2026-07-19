import { pathToFileURL } from "node:url";

import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

import { parseIamRoleArn } from "./role-broker.js";

const ASSUMED_ROLE_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):sts::([0-9]{12}):assumed-role\/([A-Za-z0-9+=,.@_-]{1,64})\/([A-Za-z0-9+=,.@_-]{2,64})$/;
const MINIMUM_REMAINING_MS = 15 * 60 * 1_000;

export interface SandboxIdentityAssessment {
  readonly accountId: string;
  readonly callerIdentityArn: string;
  readonly expectedPrincipalArn: string;
  readonly credentialExpiresAt: string;
  readonly remainingMinutes: number;
}

export interface AssessSandboxIdentityInput {
  readonly expectedPrincipalArn: string;
  readonly accountId: string | undefined;
  readonly callerIdentityArn: string | undefined;
  readonly credentialExpiration: Date | undefined;
  readonly now?: Date;
}

/**
 * Validate the source identity before Sutra is allowed to contact a customer
 * trust role. The check deliberately requires expiring credentials so a static
 * access key cannot silently become the local collector identity.
 */
export function assessSandboxIdentity(
  input: AssessSandboxIdentityInput,
): SandboxIdentityAssessment {
  const expected = parseIamRoleArn(input.expectedPrincipalArn);
  if (input.accountId !== expected.accountId) {
    throw new SandboxPreflightError(
      "IDENTITY_ACCOUNT_MISMATCH",
      "The active AWS identity account does not match the configured collector role",
    );
  }
  if (input.callerIdentityArn === undefined) {
    throw new SandboxPreflightError(
      "IDENTITY_MISSING",
      "AWS STS did not return a caller identity ARN",
    );
  }

  const caller = parseCallerIdentity(input.callerIdentityArn);
  if (
    caller.partition !== expected.partition ||
    caller.accountId !== expected.accountId ||
    caller.roleName !== expected.roleName
  ) {
    throw new SandboxPreflightError(
      "IDENTITY_ROLE_MISMATCH",
      "The active AWS identity is not the configured collector role",
    );
  }

  const now = input.now ?? new Date();
  const expiration = input.credentialExpiration;
  if (
    !(expiration instanceof Date) ||
    !Number.isFinite(expiration.getTime()) ||
    expiration.getTime() - now.getTime() < MINIMUM_REMAINING_MS
  ) {
    throw new SandboxPreflightError(
      "CREDENTIALS_NOT_SHORT_LIVED",
      "Use a short-lived AWS SSO/profile or workload identity with at least 15 minutes remaining",
    );
  }

  return {
    accountId: expected.accountId,
    callerIdentityArn: input.callerIdentityArn,
    expectedPrincipalArn: input.expectedPrincipalArn,
    credentialExpiresAt: expiration.toISOString(),
    remainingMinutes: Math.floor((expiration.getTime() - now.getTime()) / 60_000),
  };
}

export class SandboxPreflightError extends Error {
  public constructor(
    public readonly code:
      | "IDENTITY_ACCOUNT_MISMATCH"
      | "IDENTITY_MISSING"
      | "IDENTITY_ROLE_MISMATCH"
      | "CREDENTIALS_NOT_SHORT_LIVED",
    message: string,
  ) {
    super(message);
    this.name = "SandboxPreflightError";
  }
}

export async function runSandboxIdentityPreflight(
  expectedPrincipalArn: string,
  region = process.env.AWS_REGION?.trim() ||
    process.env.AWS_DEFAULT_REGION?.trim() ||
    "us-east-1",
): Promise<SandboxIdentityAssessment> {
  const client = new STSClient({
    region,
    retryMode: "standard",
    maxAttempts: 3,
  });
  const credentials = await client.config.credentials();
  const identity = await client.send(new GetCallerIdentityCommand({}));
  return assessSandboxIdentity({
    expectedPrincipalArn,
    accountId: identity.Account,
    callerIdentityArn: identity.Arn,
    credentialExpiration: credentials.expiration,
  });
}

interface CallerIdentity {
  readonly partition: string;
  readonly accountId: string;
  readonly roleName: string;
}

function parseCallerIdentity(value: string): CallerIdentity {
  try {
    const role = parseIamRoleArn(value);
    return {
      partition: role.partition,
      accountId: role.accountId,
      roleName: role.roleName,
    };
  } catch {
    const assumed = ASSUMED_ROLE_ARN.exec(value);
    if (assumed === null || assumed[1] === undefined || assumed[2] === undefined || assumed[3] === undefined) {
      throw new SandboxPreflightError(
        "IDENTITY_ROLE_MISMATCH",
        "The active AWS identity is not an IAM role or assumed-role session",
      );
    }
    return {
      partition: assumed[1],
      accountId: assumed[2],
      roleName: assumed[3],
    };
  }
}

async function main(): Promise<void> {
  const expectedPrincipalArn = process.env.SUTRA_COLLECTOR_PRINCIPAL_ARN?.trim();
  if (expectedPrincipalArn === undefined || expectedPrincipalArn.length === 0) {
    throw new Error("SUTRA_COLLECTOR_PRINCIPAL_ARN is required");
  }

  const assessment = await runSandboxIdentityPreflight(expectedPrincipalArn);
  process.stdout.write(`${JSON.stringify({ ok: true, ...assessment }, null, 2)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const code = error instanceof SandboxPreflightError ? error.code : "PREFLIGHT_FAILED";
    const message = error instanceof Error ? error.message : "AWS sandbox preflight failed";
    process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`);
    process.exitCode = 1;
  });
}
