import {
  activateVerifiedConnectionCredentials,
  commitVerifiedConnectionCredentials,
  getStoredConnectionSecretForOrg,
  markConnectionNeedsAttention,
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
  safeValidationFailureCode,
  verifyCollectorCredentialConnection,
} from "../../../../../lib/pilot-server";
import { assertSessionCapability } from "../../../../../lib/api-auth";
import { withLocalOnboardingAccountLock } from "../../../../../lib/local-onboarding-lock";
import { stageVerifyThenCommitRole } from "../../../../../lib/local-aws-lifecycle";
import { JobQueueRepository } from "../../../../../db/job-queue-repository";
import { enqueueTenantCollectionJob } from "../../../../../lib/hosted-collector-job";
import { assertAwsStaticCredentialsOnboardingEnabled } from "../../../../../lib/aws-static-credentials-feature";
import type { AwsStaticCredentialSecretReference } from "../../../../../lib/pilot-boundary";

export const dynamic = "force-dynamic";

async function onboardingCollectionOperationId(connectionId: string, versionId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${connectionId}\u0000${versionId}`),
  ));
  return `creds_${[...digest].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function requireStagedSecretReference(
  holder: { readonly value: AwsStaticCredentialSecretReference | null },
): AwsStaticCredentialSecretReference {
  if (holder.value !== null) return holder.value;
  throw Object.assign(
    new Error("The collector did not return the staged credential reference"),
    { code: "BROKER_RESPONSE_INVALID" },
  );
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertAwsStaticCredentialsOnboardingEnabled();
    const actor = await requirePilotActor(request, "workspace:read");
    assertSameOrigin(request);
    // The submitted credentials exist only in this request-scoped binding.
    // They are forwarded once to the collector broker and are never persisted,
    // logged, echoed into a response, or included in any error or audit event.
    const body = parseAwsStaticCredentialsSubmission(await readBoundedJson(request));
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
        if (health.mode !== "live" || !health.staticCredentials.ready) {
          throw Object.assign(new Error("AWS credential registration requires an explicitly enabled live collector"), { code: "INVALID_STATE" });
        }
        const stagedSecretReference: { value: AwsStaticCredentialSecretReference | null } = {
          value: null,
        };
        const registerCredentialsWithCollector = async () => {
          const registration = await registerCollectorStaticCredentialConnection({
            tenantId: actor.orgId,
            connectionId: current.connectionId,
            accountId: current.accountId,
            partition: current.partition,
            enabledRegions: current.enabledRegions,
            staticCredentials: {
              accessKeyId: body.accessKeyId,
              secretAccessKey: body.secretAccessKey,
            },
          });
          stagedSecretReference.value = registration.secretReference;
          if (health.sourceAccountId === null
            || registration.secretReference.secretArn.split(":")[4] !== health.sourceAccountId) {
            throw Object.assign(
              new Error("The collector returned a credential reference outside its workload account"),
              { code: "BROKER_RESPONSE_INVALID" },
            );
          }
          return registration;
        };
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
          commitVerifiedControlPlaneRole: (verification) =>
            commitVerifiedConnectionCredentials({
              orgId: actor.orgId,
              connectionId: current.connectionId,
              actorId: actor.id,
              verification,
              secretReference: requireStagedSecretReference(stagedSecretReference),
            }),
          activateCollector: () => activateCollectorConnection({
            tenantId: actor.orgId,
            connectionId: current.connectionId,
            roleArn: "",
            secretVersionId: requireStagedSecretReference(stagedSecretReference).versionId,
          }),
          finalizeControlPlaneActivation: () => activateVerifiedConnectionCredentials({
            orgId: actor.orgId,
            connectionId: current.connectionId,
            actorId: actor.id,
            secretReference: requireStagedSecretReference(stagedSecretReference),
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
              secretVersionId: requireStagedSecretReference(stagedSecretReference).versionId,
            });
          },
          onActivationFailure: (error) => markConnectionNeedsAttention(
            current.connectionId,
            actor.id,
            safeValidationFailureCode(error),
            actor.orgId,
          ),
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
          operationId: await onboardingCollectionOperationId(
            current.connectionId,
            requireStagedSecretReference(stagedSecretReference).versionId,
          ),
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
