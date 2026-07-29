/**
 * Builds the two EC2 client seams `Ec2AgentlessExecutor` requires.
 *
 * ── WHY THIS GOES THROUGH THE BROKER ────────────────────────────────────────
 * An earlier version of this file took a plaintext `customerExternalId` and called
 * STS itself. It could never have worked: the external id is stored ENCRYPTED
 * (externalIdCiphertext + externalIdKeyVersion) and the role broker is what holds
 * the key. Rebuilding the decrypt-assume-attest path here would have been a second
 * credential path to audit, and the first place a mistake would go unnoticed.
 *
 * So the customer side is `broker.assumeAgentlessSession(...)`, which reuses the
 * connection resolution, the identity check, the confused-deputy protections and
 * the per-use role re-attestation that every collection already depends on. The
 * only thing agentless changes is the STS ceiling.
 *
 * ── THE TWO SIDES ARE NOT SYMMETRIC, ON PURPOSE ─────────────────────────────
 *   customerClientFor — the CUSTOMER's account, via the broker, ceilinged by
 *     agentlessSnapshotSessionPolicy: snapshot verbs allowed, every destructive
 *     verb explicitly denied, so even a compromised control plane cannot delete a
 *     customer's data.
 *   scanClientFor — SUTRA's OWN scan account, assuming the orchestrator role
 *     directly. No external id (we are not a third party to ourselves) and NO
 *     session policy, because the orchestrator role's own inline policy is the
 *     ceiling and it must retain the delete verbs teardown depends on.
 *
 * The failure this file is built to prevent: applying the customer ceiling to the
 * scan-account session. It denies `ec2:Delete*`, which is exactly what teardown in
 * Sutra's own account needs — so that mistake would not fail loudly, it would leave
 * every scan volume and copied snapshot behind, billing forever, while each scan
 * still reported success.
 */

// TYPE-ONLY import: erased at build time, so this module stays loadable by the
// app's own test runner. A VALUE import from the collector is not possible here —
// that package compiles to `dist` and its internal imports use `.js` specifiers,
// which a root-level `node --test` on `.ts` sources cannot resolve. So the two
// things this needed from the broker are handled without importing it: the ARN is
// validated locally (below), and the STS session name is built by whatever
// implements AssumeScanAccountRole, which is bundled app code that CAN reach the
// collector's sanitizer. Neither is duplicated logic — one is a regex, the other
// moved to where it was always reachable.
import type { AwsTemporaryCredentials } from "../services/aws-collector/src/types.ts";

const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/u;
/** Path-bearing role ARNs included: the orchestrator role lives at /sutra/. */
const IAM_ROLE_ARN = /^arn:aws(-us-gov|-cn)?:iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]+$/u;
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

/** The slice of the broker this needs. Narrow so tests need no broker instance. */
export interface AgentlessSessionBroker {
  assumeAgentlessSession(
    scope: { readonly orgId: string; readonly customerId: string },
    connectionId: string,
    jobId: string,
  ): Promise<{ readonly credentials: AwsTemporaryCredentials }>;
}

export interface AgentlessScanAccountAssumeInput {
  readonly roleArn: string;
  /** Raw run id. The implementation sanitizes it into an STS session name. */
  readonly runId: string;
  readonly durationSeconds: number;
}

/** Assumes SUTRA's own orchestrator role. Deliberately cannot take a session policy. */
export type AssumeScanAccountRole = (
  input: AgentlessScanAccountAssumeInput,
) => Promise<AwsTemporaryCredentials>;

export type AgentlessEc2ClientFor<TClient> = (
  credentials: AwsTemporaryCredentials,
  region: string,
) => TClient;

export interface AgentlessClientFactoryOptions<TClient> {
  readonly broker: AgentlessSessionBroker;
  readonly scope: { readonly orgId: string; readonly customerId: string };
  readonly connectionId: string;
  /** Sutra's orchestrator role. Must live in the scan account. */
  readonly orchestratorRoleArn: string;
  readonly scanAccountId: string;
  /**
   * Identifies the scan in CloudTrail on both sides. Passed through to
   * AssumeScanAccountRole, which is responsible for sanitizing it into a legal STS
   * session name — that sanitizer lives in the collector and is reachable from the
   * bundled implementation, not from here.
   */
  readonly runId: string;
  readonly assumeScanAccountRole: AssumeScanAccountRole;
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

export function createAgentlessClientFactories<TClient>(
  options: AgentlessClientFactoryOptions<TClient>,
): AgentlessClientFactories<TClient> {
  // Checked at construction, not on first use: a scan that will fail on a malformed
  // ARN should fail before it has taken a snapshot, because the snapshot costs money.
  const parsedRole = IAM_ROLE_ARN.exec(options.orchestratorRoleArn);
  if (parsedRole === null) {
    throw new AgentlessClientFactoryError(
      "ORCHESTRATOR_ARN_INVALID",
      `not an IAM role ARN: ${options.orchestratorRoleArn}`,
    );
  }

  const orchestratorAccount = parsedRole[2];
  if (orchestratorAccount !== options.scanAccountId) {
    throw new AgentlessClientFactoryError(
      "SCAN_ACCOUNT_MISMATCH",
      `orchestrator role lives in ${orchestratorAccount} but the configured scan account is `
      + `${options.scanAccountId}; refusing to copy a customer snapshot into an unintended account`,
    );
  }

  const duration = options.sessionDurationSeconds ?? MAX_SESSION_SECONDS;
  if (!Number.isInteger(duration) || duration < MIN_SESSION_SECONDS || duration > MAX_SESSION_SECONDS) {
    throw new AgentlessClientFactoryError(
      "SESSION_DURATION_INVALID",
      `session duration must be an integer between ${MIN_SESSION_SECONDS} and ${MAX_SESSION_SECONDS} seconds`,
    );
  }

  return {
    customerClientFor: async (region: string): Promise<TClient> => {
      assertRegion(region);
      // The broker owns decryption, the identity check and re-attestation. The
      // agentless ceiling is selected by the method, not by an argument this caller
      // could get wrong.
      const session = await options.broker.assumeAgentlessSession(
        options.scope,
        options.connectionId,
        options.runId,
      );
      return options.ec2ClientFor(session.credentials, region);
    },

    scanClientFor: async (region: string): Promise<TClient> => {
      assertRegion(region);
      // No external id and no session policy — see the header. The type of
      // AssumeScanAccountRole has no policy field, so the customer ceiling cannot be
      // passed here even by mistake; that is enforced by the signature rather than
      // by a runtime check that someone could forget to call.
      const credentials = await options.assumeScanAccountRole({
        roleArn: options.orchestratorRoleArn,
        runId: options.runId,
        durationSeconds: duration,
      });
      return options.ec2ClientFor(credentials, region);
    },
  };
}
