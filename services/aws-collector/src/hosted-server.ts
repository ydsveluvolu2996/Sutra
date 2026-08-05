import { pathToFileURL } from "node:url";

import { runSandboxIdentityPreflight } from "./aws-sandbox-preflight.js";
import {
  createLocalCollectorServer,
  decodeAwsSupportCasesEvidenceKey,
} from "./local-server.js";
import {
  HostedPostgresState,
  type HostedAgentlessRecoveryClaim,
} from "./hosted-postgres-state.js";
import { HostedComputeOptimizerExportLaunchLedger } from
  "./compute-optimizer-export-launch-ledger.js";
import { HostedRequestAuthenticator } from "./hosted-request-auth.js";
import {
  recoverAgentlessOwnedResources,
  type AgentlessExecutionSettings,
} from "./agentless-execution.js";
import type { AgentlessScanExecution } from "./scan-runner.js";

const HOST = "0.0.0.0";
const DEFAULT_PORT = 8788;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || /[\r\n]/u.test(value)) throw new Error(`${name} is required and must be one line`);
  return value;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? String(DEFAULT_PORT));
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("SUTRA_BROKER_PORT is invalid");
  }
  return port;
}

function parseClientPublicKeys(value: string): Readonly<Record<string, string>> {
  if (Buffer.byteLength(value, "utf8") > 64 * 1024) {
    throw new Error("SUTRA_APP_PUBLIC_KEYS is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SUTRA_APP_PUBLIC_KEYS must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SUTRA_APP_PUBLIC_KEYS must be an object");
  }
  const entries = Object.entries(parsed);
  if (
    entries.length === 0 ||
    entries.length > 16 ||
    entries.some(([keyId, key]) =>
      !KEY_ID.test(keyId) ||
      typeof key !== "string" ||
      !/^[A-Za-z0-9_-]{40,4096}$/u.test(key))
  ) {
    throw new Error("SUTRA_APP_PUBLIC_KEYS contains an invalid key");
  }
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function requiredPattern(name: string, pattern: RegExp): string {
  const value = required(name);
  if (!pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function hostedTaxonomySigningKey(accountId: string, region: string): string {
  const keyArn = requiredPattern(
    "SUTRA_TA_TAXONOMY_SIGNING_KEY_ARN",
    /^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/u,
  );
  if (!keyArn.startsWith(`arn:aws:kms:${region}:${accountId}:key/`)) {
    throw new Error(
      "Trusted Advisor taxonomy signing key must remain in the broker workload account and region",
    );
  }
  return keyArn;
}

function hostedAgentlessConfiguration(
  accountId: string,
  region: string,
): {
  readonly settings: AgentlessExecutionSettings;
  readonly executionApproved: boolean;
} {
  const liveValidated = required("SUTRA_AGENTLESS_LIVE_VALIDATED");
  const approval = required("SUTRA_AGENTLESS_LIVE_VALIDATION_APPROVAL");
  const executionApproved =
    liveValidated === "true" &&
    approval === "approved-after-live-end-to-end-agentless-validation";
  const preApproval =
    liveValidated === "false" &&
    approval === "not-approved";
  if (!executionApproved && !preApproval) {
    throw new Error("Hosted agentless validation settings are inconsistent");
  }
  const scanAccountId = requiredPattern("SUTRA_AGENTLESS_SCAN_ACCOUNT_ID", /^\d{12}$/u);
  if (scanAccountId !== accountId) {
    throw new Error("Hosted agentless scan account must match the broker workload account");
  }
  const scanAvailabilityZone = requiredPattern(
    "SUTRA_AGENTLESS_SCAN_AZ",
    /^[a-z]{2}(-gov)?-[a-z]+-\d[a-z]$/u,
  );
  if (!scanAvailabilityZone.startsWith(region)) {
    throw new Error("SUTRA_AGENTLESS_SCAN_AZ must be in the broker region");
  }
  const orchestratorRoleArn = requiredPattern(
    "SUTRA_AGENTLESS_ORCHESTRATOR_ROLE_ARN",
    /^arn:aws:iam::\d{12}:role\/sutra\/[A-Za-z0-9+=,.@_/-]+$/u,
  );
  const instanceProfileArn = requiredPattern(
    "SUTRA_AGENTLESS_INSTANCE_PROFILE_ARN",
    /^arn:aws:iam::\d{12}:instance-profile\/sutra\/[A-Za-z0-9+=,.@_/-]+$/u,
  );
  if (!orchestratorRoleArn.includes(`::${accountId}:`) ||
      !instanceProfileArn.includes(`::${accountId}:`)) {
    throw new Error("Hosted agentless roles must remain in the broker workload account");
  }
  const scannerImage = requiredPattern(
    "SUTRA_AGENTLESS_SCANNER_IMAGE",
    /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/u,
  );
  if (!scannerImage.startsWith(`${accountId}.dkr.ecr.${region}.amazonaws.com/`)) {
    throw new Error("Hosted agentless scanner image must be digest-pinned in the workload account and region");
  }
  const kmsKeyArn = requiredPattern(
    "SUTRA_AGENTLESS_KMS_KEY_ARN",
    /^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/u,
  );
  if (!kmsKeyArn.startsWith(`arn:aws:kms:${region}:${accountId}:key/`)) {
    throw new Error("Hosted agentless KMS key must remain in the workload account and region");
  }
  const settings: AgentlessExecutionSettings = {
    scanAccountId,
    scanAvailabilityZone,
    kmsKeyArn,
    scannerImage,
    liveValidated: executionApproved,
    orchestratorRoleArn,
    instance: {
      amiId: requiredPattern("SUTRA_AGENTLESS_AMI_ID", /^ami-[0-9a-f]{8,17}$/u),
      instanceType: requiredPattern("SUTRA_AGENTLESS_INSTANCE_TYPE", /^[a-z0-9]+\.[a-z0-9]+$/u),
      subnetId: requiredPattern("SUTRA_AGENTLESS_SUBNET_ID", /^subnet-[0-9a-f]{8,17}$/u),
      securityGroupId: requiredPattern("SUTRA_AGENTLESS_SECURITY_GROUP_ID", /^sg-[0-9a-f]{8,17}$/u),
      instanceProfileArn,
      findingsBucket: requiredPattern(
        "SUTRA_AGENTLESS_FINDINGS_BUCKET",
        /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u,
      ),
    },
  };
  return { settings, executionApproved };
}

function recoveryExecution(
  claim: HostedAgentlessRecoveryClaim,
  resources: Awaited<ReturnType<HostedPostgresState["listAgentlessResources"]>>,
): AgentlessScanExecution {
  const request = claim.executionRequest as {
    plan?: { volumes?: readonly { volumeId?: unknown; region?: unknown }[] };
  };
  const volumes = Array.isArray(request.plan?.volumes) ? request.plan.volumes : [];
  const results = volumes
    .filter((volume): volume is { volumeId: string; region?: unknown } =>
      typeof volume.volumeId === "string")
    .map((volume) => {
      const owned = resources.filter((resource) => resource.sourceVolumeId === volume.volumeId);
      const toreDown = owned
        .filter((resource) => resource.deleted && resource.accountScope === "sutra-scan-account")
        .map((resource) => resource.resourceId);
      const teardownDebt = owned
        .filter((resource) => !resource.deleted)
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
            : resource.lastError ?? "restart recovery could not prove teardown",
        }));
      return {
        volumeId: volume.volumeId,
        status: "failed" as const,
        findings: [],
        error: "BROKER_RESTART_RECOVERY",
        toreDown,
        teardownFailures: teardownDebt
          .filter((resource) => resource.accountScope === "sutra-scan-account")
          .map((resource) => resource.resourceId),
        cleanupHandoff: teardownDebt
          .filter((resource) => resource.accountScope === "customer")
          .map((resource) => resource.resourceId),
        teardownDebt,
      };
    });
  return {
    schema: "sutra.aws-agentless-scan-execution.v1",
    results,
    summary: {
      scanned: 0,
      failed: results.length,
      findings: 0,
      resourcesToreDown: results.reduce((sum, result) => sum + result.toreDown.length, 0),
      teardownFailures: results.reduce((sum, result) => sum + result.teardownFailures.length, 0),
      cleanupHandoffs: results.reduce((sum, result) => sum + result.cleanupHandoff.length, 0),
    },
  };
}

async function recoverOneAgentlessRun(state: HostedPostgresState): Promise<void> {
  const claim = await state.claimExpiredAgentlessRun();
  if (claim === null) return;
  const request = claim.executionRequest as { settings?: unknown };
  const settings = request.settings as AgentlessExecutionSettings | undefined;
  if (settings === undefined) throw new Error("Durable agentless recovery request is unreadable");
  const outcomes = await recoverAgentlessOwnedResources({
    runId: claim.runId,
    settings,
    resources: claim.resources,
  });
  for (const outcome of outcomes) {
    await state.settleRecoveredAgentlessResource({
      tenantId: claim.tenantId,
      runId: claim.runId,
      resourceId: outcome.resourceId,
      ...(outcome.error === null ? {} : { error: outcome.error }),
    });
  }
  const resources = await state.listAgentlessResources(claim.tenantId, claim.runId);
  await state.finishAgentlessRecovery(
    claim,
    recoveryExecution(claim, resources),
  );
}

export async function startHostedCollectorServer(): Promise<{
  readonly close: () => Promise<void>;
  readonly port: number;
}> {
  if (required("SUTRA_DEPLOYMENT_ENV") !== "production") {
    throw new Error("The hosted broker is restricted to SUTRA_DEPLOYMENT_ENV=production");
  }
  if (required("SUTRA_BROKER_AUTH_MODE") !== "asymmetric") {
    throw new Error("The hosted broker requires asymmetric authentication");
  }
  const principalArn = required("SUTRA_COLLECTOR_PRINCIPAL_ARN");
  const identity = await runSandboxIdentityPreflight(principalArn);
  const region = required("AWS_REGION");
  const agentless = hostedAgentlessConfiguration(identity.accountId, region);
  const taxonomySigningKeyId = hostedTaxonomySigningKey(identity.accountId, region);

  const databaseUrl = required("DATABASE_URL");
  const state = new HostedPostgresState({
    connectionString: databaseUrl,
    encryptionKey: required("SUTRA_REGISTRY_ENCRYPTION_KEY"),
  });
  const launchLedger = new HostedComputeOptimizerExportLaunchLedger({
    connectionString: databaseUrl,
  });
  if (!await state.ready() || !await launchLedger.ready()) {
    await launchLedger.close();
    await state.close();
    throw new Error("The hosted broker database schema is unavailable");
  }
  const authenticator = new HostedRequestAuthenticator({
    clientPublicKeys: parseClientPublicKeys(required("SUTRA_APP_PUBLIC_KEYS")),
    brokerKeyId: required("SUTRA_BROKER_RESPONSE_KEY_ID"),
    brokerPrivateKey: required("SUTRA_BROKER_RESPONSE_PRIVATE_KEY"),
    replayStore: state,
  });
  const server = createLocalCollectorServer({
    mode: "live",
    allowLiveAws: true,
    principalArn,
    registry: state,
    authenticator,
    operationCoordinator: state,
    computeOptimizerExportLaunchLedger: launchLedger,
    hostedRuntime: true,
    awsSupportCasesEvidenceKey: decodeAwsSupportCasesEvidenceKey(
      required("SUTRA_AWS_SUPPORT_CASES_EVIDENCE_KEY_BASE64URL"),
    ),
    trustedAdvisorTaxonomySigningKeyId: taxonomySigningKeyId,
    readiness: () => state.ready(),
    agentlessRunStore: state.agentlessRunStore(),
    agentlessResourceTracker: (scope) => state.agentlessResourceTracker(scope),
    agentlessExecutionFinalizer: (tenantId, runId, execution) =>
      state.finalizeAgentlessExecution(tenantId, runId, execution),
    hostedAgentlessPlanProfile: {
      scanAccountId: agentless.settings.scanAccountId,
      kmsReencrypt: agentless.settings.kmsKeyArn !== null,
    },
    hostedAgentlessCleanupSettings: agentless.settings,
    agentlessCleanupLedger: {
      authorize: (tenantId, resources) =>
        state.authorizeAgentlessCleanup(tenantId, resources),
      record: (input) => state.recordAgentlessCleanupOutcome(input),
    },
    endUserComputingCostProjectionLoader:
      state.loadEndUserComputingCostProjection.bind(state),
    ...(agentless.executionApproved
      ? { hostedAgentlessSettings: agentless.settings }
      : {}),
  });
  const port = parsePort(process.env.SUTRA_BROKER_PORT);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let recovering = false;
  const recover = (): void => {
    if (recovering) return;
    recovering = true;
    void recoverOneAgentlessRun(state)
      .catch(() => undefined)
      .finally(() => { recovering = false; });
  };
  recover();
  const recoveryTimer = setInterval(recover, 60_000);
  recoveryTimer.unref();
  return {
    port,
    close: async () => {
      clearInterval(recoveryTimer);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await Promise.all([state.close(), launchLedger.close()]);
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startHostedCollectorServer()
    .then((runtime) => {
      process.stdout.write(`Sutra hosted AWS broker listening on ${HOST}:${runtime.port}\n`);
      let closing = false;
      const shutdown = () => {
        if (closing) return;
        closing = true;
        void runtime.close()
          .then(() => { process.exitCode = 0; })
          .catch(() => { process.exitCode = 1; });
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : "unknown startup error";
      process.stderr.write(`Sutra hosted AWS broker could not start: ${reason}\n`);
      process.exitCode = 1;
    });
}
