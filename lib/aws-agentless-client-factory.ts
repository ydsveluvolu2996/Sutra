/**
 * Builds the two EC2 client seams `Ec2AgentlessExecutor` requires, and encodes the
 * rules about WHICH credentials may do WHAT.
 *
 * ── WHY THIS IS A MODULE AND NOT FOUR LINES IN THE ROUTE ────────────────────
 * An agentless scan spans two trust domains and the difference between them is the
 * whole security design:
 *
 *   customerClientFor — the CUSTOMER's account. Read the volume, snapshot it, share
 *     the snapshot. Ceilinged by agentlessSnapshotSessionPolicy, an STS session
 *     policy that denies every destructive verb, so even a compromised control plane
 *     cannot delete a customer's data.
 *   scanClientFor — SUTRA's OWN scan account. Copy the shared snapshot, create the
 *     scan volume, run the task, and DELETE both afterwards.
 *
 * The failure this file exists to make impossible: applying the customer ceiling to
 * the scan-account session. It denies `ec2:Delete*`, which is exactly what teardown
 * in Sutra's own account needs — so that mistake would not fail loudly, it would
 * leave every scan volume and copied snapshot behind, billing forever, while each
 * scan still reported success. The two factories therefore build their sessions by
 * different code paths, and `assertScanSessionIsNotCustomerCeilinged` refuses the
 * combination outright rather than trusting a future caller to remember.
 *
 * Every AWS call is behind an injected seam so the invariants above are unit-tested
 * without an AWS account: the tests assert on what WOULD be sent to STS.
 */

import {
  accountIdFromRoleArn,
  agentlessSnapshotSessionPolicy,
  parseIamRoleArn,
  sanitizeRoleSessionName,
} from "../services/aws-collector/src/role-broker";
import type { AwsTemporaryCredentials } from "../services/aws-collector/src/types";

/** Region format is validated before it can reach an SDK client or an ARN. */
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/u;

/** STS caps a session at 12 hours; a scan that needs longer has gone wrong. */
const MAX_SESSION_SECONDS = 3600;
const MIN_SESSION_SECONDS = 900;

export class AgentlessClientFactoryError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(`agentless-client-factory: ${code}: ${message}`);
    this.name = "AgentlessClientFactoryError";
    this.code = code;
  }
}

export interface AgentlessAssumeRoleInput {
  readonly roleArn: string;
  readonly roleSessionName: string;
  readonly durationSeconds: number;
  /** Required for customer roles; never used for Sutra's own scan account. */
  readonly externalId?: string;
  /** The STS session policy, when one applies. */
  readonly policy?: string;
}

/** The single STS call this module makes, injected so it can be asserted on. */
export type AgentlessAssumeRole = (
  input: AgentlessAssumeRoleInput,
) => Promise<AwsTemporaryCredentials>;

/** Builds a region-bound EC2 client from credentials. Injected for the same reason. */
export type AgentlessEc2ClientFor<TClient> = (
  credentials: AwsTemporaryCredentials,
  region: string,
) => TClient;

export interface AgentlessClientFactoryOptions<TClient> {
  /** The customer's cross-account role, from the stored connection. */
  readonly customerRoleArn: string;
  /** The connection's external id. Absent or blank is refused, never defaulted. */
  readonly customerExternalId: string;
  /** Sutra's orchestrator role, which must live in the scan account. */
  readonly orchestratorRoleArn: string;
  /** The scan account id from configuration, checked against the role ARN above. */
  readonly scanAccountId: string;
  /** Identifies the scan in CloudTrail on both sides. */
  readonly runId: string;
  readonly assumeRole: AgentlessAssumeRole;
  readonly ec2ClientFor: AgentlessEc2ClientFor<TClient>;
  readonly sessionDurationSeconds?: number;
}

export interface AgentlessClientFactories<TClient> {
  readonly customerClientFor: (region: string) => Promise<TClient>;
  readonly scanClientFor: (region: string) => Promise<TClient>;
}

function assertRegion(region: string): void {
  if (!REGION.test(region)) {
    throw new AgentlessClientFactoryError("REGION_INVALID", `not an AWS region: ${region}`);
  }
}

/**
 * Refuses a scan-account session that carries the customer ceiling.
 *
 * Exported because it is an invariant, not an implementation detail: anything that
 * builds scan-account credentials in future should be able to assert it too.
 */
export function assertScanSessionIsNotCustomerCeilinged(
  input: AgentlessAssumeRoleInput,
  customerRoleArn: string,
): void {
  if (input.policy === undefined) return;
  if (input.policy === agentlessSnapshotSessionPolicy(customerRoleArn)) {
    throw new AgentlessClientFactoryError(
      "SCAN_SESSION_CEILINGED",
      "the scan-account session carries the customer session policy, which denies ec2:Delete* — "
      + "teardown would silently fail and leave every scan volume and copied snapshot billing",
    );
  }
}

export function createAgentlessClientFactories<TClient>(
  options: AgentlessClientFactoryOptions<TClient>,
): AgentlessClientFactories<TClient> {
  // Everything checkable is checked HERE, at construction, rather than on first use.
  // A scan that is going to fail on a malformed ARN should fail before it has taken a
  // snapshot, because the snapshot is the part that costs money.
  const customerRole = parseIamRoleArn(options.customerRoleArn);
  parseIamRoleArn(options.orchestratorRoleArn);

  const externalId = options.customerExternalId.trim();
  if (externalId.length === 0) {
    throw new AgentlessClientFactoryError(
      "EXTERNAL_ID_MISSING",
      "the customer connection has no external id; assuming a customer role without one is "
      + "refused rather than attempted",
    );
  }

  // The orchestrator role must be IN the configured scan account. Without this, a
  // misconfigured ARN would have Sutra copying customer snapshots into an account
  // nobody intended — the exact outcome the no-defaults config rule exists to prevent.
  const orchestratorAccount = accountIdFromRoleArn(options.orchestratorRoleArn);
  if (orchestratorAccount !== options.scanAccountId) {
    throw new AgentlessClientFactoryError(
      "SCAN_ACCOUNT_MISMATCH",
      `orchestrator role lives in ${orchestratorAccount} but the configured scan account is `
      + `${options.scanAccountId}`,
    );
  }

  // A customer role in Sutra's own account means the connection is misconfigured and a
  // "customer" scan would run against the control plane. Refused on both sides.
  if (customerRole.accountId === options.scanAccountId) {
    throw new AgentlessClientFactoryError(
      "CUSTOMER_IS_SCAN_ACCOUNT",
      "the customer role is in Sutra's scan account; refusing to treat the control plane as a "
      + "customer target",
    );
  }

  const duration = options.sessionDurationSeconds ?? MAX_SESSION_SECONDS;
  if (!Number.isInteger(duration) || duration < MIN_SESSION_SECONDS || duration > MAX_SESSION_SECONDS) {
    throw new AgentlessClientFactoryError(
      "SESSION_DURATION_INVALID",
      `session duration must be an integer between ${MIN_SESSION_SECONDS} and ${MAX_SESSION_SECONDS} seconds`,
    );
  }

  // Distinct prefixes so CloudTrail in either account shows which side of the scan a
  // call came from without cross-referencing role ARNs.
  const customerSession = sanitizeRoleSessionName(options.runId, "sutra-agentless-");
  const scanSession = sanitizeRoleSessionName(options.runId, "sutra-agentless-scan-");

  return {
    customerClientFor: async (region: string): Promise<TClient> => {
      assertRegion(region);
      const credentials = await options.assumeRole({
        roleArn: options.customerRoleArn,
        roleSessionName: customerSession,
        durationSeconds: duration,
        externalId,
        // Not optional and not a parameter: the ceiling is the reason a customer is
        // willing to hand Sutra a role at all.
        policy: agentlessSnapshotSessionPolicy(options.customerRoleArn),
      });
      return options.ec2ClientFor(credentials, region);
    },

    scanClientFor: async (region: string): Promise<TClient> => {
      assertRegion(region);
      // No externalId: this is Sutra assuming its own role, and no session policy,
      // because the orchestrator role's own inline policy is the ceiling and it must
      // retain the delete verbs that teardown depends on.
      const input: AgentlessAssumeRoleInput = {
        roleArn: options.orchestratorRoleArn,
        roleSessionName: scanSession,
        durationSeconds: duration,
      };
      assertScanSessionIsNotCustomerCeilinged(input, options.customerRoleArn);
      const credentials = await options.assumeRole(input);
      return options.ec2ClientFor(credentials, region);
    },
  };
}
