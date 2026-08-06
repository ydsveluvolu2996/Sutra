import {
  commitVerifiedConnectionCredentials,
  getStoredConnectionSecretForOrg,
} from "../../../../../db/pilot-repository";
import {
  assertSameOrigin,
  parseAwsStaticCredentialsSubmission,
  readBoundedJson,
} from "../../../../../lib/aws-pilot-security";
import {
  activateCollectorConnection,
  discardStagedCollectorConnection,
  errorResponse,
  getCollectorHealth,
  jsonResponse,
  registerCollectorStaticCredentialConnection,
  requirePilotActor,
  verifyCollectorCredentialConnection,
} from "../../../../../lib/pilot-server";
import { assertSessionCapability } from "../../../../../lib/api-auth";
import { withLocalOnboardingAccountLock } from "../../../../../lib/local-onboarding-lock";
import { stageVerifyThenCommitRole } from "../../../../../lib/local-aws-lifecycle";
import { JobQueueRepository } from "../../../../../db/job-queue-repository";
import { enqueueTenantCollectionJob } from "../../../../../lib/hosted-collector-job";

export const dynamic = "force-dynamic";

async function onboardingCollectionOperationId(connectionId: string, accessKeyLast4: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${connectionId}\u0000${accessKeyLast4}`),
  ));
  return `creds_${[...digest].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requirePilotActor(request, "workspace:read");
    assertSameOrigin(request);
    // The submitted credentials exist only in this request-scoped binding.
    // They are forwarded once to the collector broker and are never persisted,
    // logged, echoed into a response, or included in any error or audit event.
    const body = parseAwsStaticCredentialsSubmission(await readBoundedJson(request));
    const accessKeyLast4 = body.accessKeyId.slice(-4);
    const stored = await getStoredConnectionSecretForOrg(actor.orgId, body.connectionId);
    assertSessionCapability(actor.authenticated, "connection:manage", stored.customerId);
    return await withLocalOnboardingAccountLock(
      stored.partition,
      stored.accountId,
      async () => {
        const current = await getStoredConnectionSecretForOrg(actor.orgId, body.connectionId);
        if (
          current.customerId !== stored.customerId ||
          current.accountId !== stored.accountId ||
          current.partition !== stored.partition
        ) {
          throw Object.assign(new Error("The AWS connection changed while credential registration was waiting"), { code: "INVALID_STATE" });
        }
        if (current.sourceKind !== "aws_static_credentials") {
          throw Object.assign(
            new Error("This AWS connection does not accept static credentials"),
            { code: "INVALID_STATE" },
          );
        }
        if (current.status === "disabled") {
          throw Object.assign(
            new Error("A disabled AWS connection cannot register or replace its credentials"),
            { code: "INVALID_STATE" },
          );
        }
        const health = await getCollectorHealth(current.partition);
        if (health.mode !== "live") {
          throw Object.assign(new Error("AWS credential registration requires an explicitly enabled live collector"), { code: "INVALID_STATE" });
        }
        const registerCredentialsWithCollector = () => registerCollectorStaticCredentialConnection({
          tenantId: actor.orgId,
          connectionId: current.connectionId,
          accountId: current.accountId,
          partition: current.partition,
          enabledRegions: current.enabledRegions,
          staticCredentials: {
            accessKeyId: body.accessKeyId,
            secretAccessKey: body.secretAccessKey,
            sessionToken: body.sessionToken,
          },
        });
        const verifyCredentialsWithCollector = () => verifyCollectorCredentialConnection({
          tenantId: actor.orgId,
          connectionId: current.connectionId,
          jobId: `verify_creds_${crypto.randomUUID().replaceAll("-", "")}`,
          accountId: current.accountId,
          partition: current.partition,
        });
        const result = await stageVerifyThenCommitRole({
          stageCollector: registerCredentialsWithCollector,
          verifyCollector: verifyCredentialsWithCollector,
          commitVerifiedControlPlaneRole: (verification) => commitVerifiedConnectionCredentials({
            orgId: actor.orgId,
            connectionId: current.connectionId,
            actorId: actor.id,
            verification,
          }),
          activateCollector: () => activateCollectorConnection({
            tenantId: actor.orgId,
            connectionId: current.connectionId,
            roleArn: "",
          }),
          compensateStagedCollector: async () => {
            // v1 compensation deliberately only discards the staged candidate.
            // The control plane cannot re-register previously verified static
            // credentials (it never stores them), so a failed re-submission on
            // an already-active connection leaves the collector's previously
            // ACTIVE material untouched and simply drops the new candidate;
            // the customer retries the submission. This is safe: discard never
            // writes an offboarding tombstone.
            await discardStagedCollectorConnection({
              tenantId: actor.orgId,
              connectionId: current.connectionId,
              roleArn: "",
            });
          },
        });
        // Credential activation is only the trust handoff. The first real
        // inventory is scheduled durably and drained by the private production
        // job runner. A stable operation id makes an HTTP retry converge on
        // the same logical collection even if it creates a second
        // at-least-once queue envelope.
        const collection = await enqueueTenantCollectionJob(new JobQueueRepository(), {
          orgId: actor.orgId,
          customerId: current.customerId,
          connectionId: current.connectionId,
          operationId: await onboardingCollectionOperationId(current.connectionId, accessKeyLast4),
        });
        return jsonResponse({
          connection: result.connection,
          registered: true,
          verification: {
            accountId: result.verification.accountId,
            callerIdentityArn: result.verification.callerIdentityArn,
            accessKeyLast4: result.verification.accessKeyLast4,
          },
          collection: { jobId: collection.jobId, status: "queued" },
        });
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
