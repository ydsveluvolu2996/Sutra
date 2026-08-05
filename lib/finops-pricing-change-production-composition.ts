/** Production-only ADD-13 composition with durable accepted replay. */
import type { JobHandler, RunnableJob } from "./background-job-runner.ts";
import { canonicalJson } from "./canonical-json.ts";
import { PricingChangeCur2Reader } from "../db/finops-pricing-change-cur2-reader.ts";
import { PricingChangeRuntimeRepository, type PricingChangeRuntimeAcceptance, type PricingChangeRuntimeFailureCode } from "../db/finops-pricing-change-runtime-repository.ts";
import {
  FINOPS_PRICING_CHANGE_MATERIALIZE_JOB_KIND,
  PRICING_CHANGE_MATERIALIZER_ACTIVATION_REASONS,
  PricingChangeMaterializationJobError,
  PricingChangeMaterializationUnavailableError,
  runPricingChangeMaterializationJob,
  type PricingChangeMaterializationJobDependencies,
  type PricingChangeMaterializerRequest,
  type PricingChangeJobScope,
} from "./finops-pricing-change-materialization-job.ts";
import { createPricingChangeSignedBroker } from "./finops-pricing-change-signed-broker.ts";
import type { HostedBrokerClientSigningConfiguration } from "./hosted-broker-client-security.ts";

const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;

export interface PricingChangeRuntimeStore {
  getAccepted(scope: PricingChangeJobScope, requestKey: string): Promise<PricingChangeRuntimeAcceptance | null>;
  accept(input: PricingChangeRuntimeAcceptance): Promise<PricingChangeRuntimeAcceptance>;
  recordFailure(input: { readonly failureId: string; readonly requestKey: string; readonly scope: PricingChangeJobScope;
    readonly jobId: string; readonly policyId: string; readonly attempt: number; readonly code: PricingChangeRuntimeFailureCode; readonly failedAt: number }): Promise<void>;
}

function reject(): never { throw new Error("PRICING_CHANGE_PRODUCTION_RUNTIME_REJECTED"); }
async function sha(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
function payload(job: RunnableJob): { readonly scope: PricingChangeJobScope; readonly policyId: string } {
  if (job.kind !== FINOPS_PRICING_CHANGE_MATERIALIZE_JOB_KIND || job.customerId === null || job.connectionId === null
    || !ID.test(job.id) || !ID.test(job.orgId) || !ID.test(job.customerId) || !CONNECTION.test(job.connectionId)
    || typeof job.payload !== "object" || job.payload === null || Array.isArray(job.payload)) reject();
  const record = job.payload as Readonly<Record<string, unknown>>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["connectionId", "policyId"])
    || record.connectionId !== job.connectionId || typeof record.policyId !== "string" || !ID.test(record.policyId)) reject();
  return { scope: { organizationId: job.orgId, customerId: job.customerId, connectionId: job.connectionId }, policyId: record.policyId };
}
export async function pricingChangeRuntimeRequestKey(job: RunnableJob): Promise<string> {
  const parsed = payload(job);
  return `pcrt_${await sha(canonicalJson({ schemaVersion: "sutra.pricing-change.runtime-request.v1", scope: parsed.scope,
    jobId: job.id, policyId: parsed.policyId, payload: job.payload }))}`;
}
function failureCode(error: unknown): PricingChangeRuntimeFailureCode {
  if (error instanceof PricingChangeMaterializationUnavailableError) {
    if (error.reason === PRICING_CHANGE_MATERIALIZER_ACTIVATION_REASONS.policy) return "POLICY_UNAVAILABLE";
    if (error.reason === PRICING_CHANGE_MATERIALIZER_ACTIVATION_REASONS.cur2) return "CUR2_UNAVAILABLE";
    return "PROVIDER_UNAVAILABLE";
  }
  if (error instanceof PricingChangeMaterializationJobError) {
    if (error.code === "EVIDENCE_REJECTED") return "EVIDENCE_REJECTED";
    if (error.code === "PERSISTENCE_REJECTED") return "PERSISTENCE_REJECTED";
  }
  return "MATERIALIZATION_REJECTED";
}

export function createPricingChangeProductionJobHandler(input: {
  readonly dependencies: Omit<PricingChangeMaterializationJobDependencies, "materializer">;
  readonly materializer: NonNullable<PricingChangeMaterializationJobDependencies["materializer"]>;
  readonly runtime?: PricingChangeRuntimeStore;
  readonly now?: () => number;
}): JobHandler {
  const runtime = input.runtime ?? new PricingChangeRuntimeRepository(), now = input.now ?? Date.now;
  return async (job) => {
    const parsed = payload(job), requestKey = await pricingChangeRuntimeRequestKey(job);
    if (await runtime.getAccepted(parsed.scope, requestKey) !== null) return;
    try {
      const result = await runPricingChangeMaterializationJob(job, { ...input.dependencies, materializer: input.materializer });
      if (result.status === "unavailable") throw new PricingChangeMaterializationUnavailableError(result.reason);
      await runtime.accept({ requestKey, scope: parsed.scope, jobId: job.id, policyId: parsed.policyId,
        snapshotId: result.materialization.snapshotId, evidenceGenerationId: result.evidenceGenerationId,
        contentSha256: result.contentSha256, activeCur2GenerationId: result.materialization.activeCur2GenerationId,
        capturedAt: result.materialization.capturedAt, becameActive: result.becameActive, acceptedAt: now() });
    } catch (error) {
      const failedAt = now(), code = failureCode(error), failureId = `pcrf_${await sha(canonicalJson({ requestKey, jobId: job.id, attempt: job.attempt, code }))}`;
      await runtime.recordFailure({ failureId, requestKey, scope: parsed.scope, jobId: job.id,
        policyId: parsed.policyId, attempt: job.attempt, code, failedAt });
      throw error;
    }
  };
}

export function createPricingChangeProductionComposition(input: {
  readonly brokerOrigin: string; readonly signing: HostedBrokerClientSigningConfiguration;
  readonly dependencies: Omit<PricingChangeMaterializationJobDependencies, "materializer">;
  readonly cur2?: PricingChangeCur2Reader; readonly runtime?: PricingChangeRuntimeStore;
  readonly fetcher?: typeof fetch; readonly now?: () => number; readonly nonce?: () => string;
}) {
  const cur2 = input.cur2 ?? new PricingChangeCur2Reader();
  const materializer = createPricingChangeSignedBroker({ brokerOrigin: input.brokerOrigin, signing: input.signing,
    readCur2: (request: PricingChangeMaterializerRequest) => cur2.read(request.scope, request.activeCur2),
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }), ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.nonce === undefined ? {} : { nonce: input.nonce }) });
  return Object.freeze({ jobKind: FINOPS_PRICING_CHANGE_MATERIALIZE_JOB_KIND, runtimeState: "ready" as const,
    handler: createPricingChangeProductionJobHandler({ dependencies: input.dependencies, materializer,
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }), ...(input.now === undefined ? {} : { now: input.now }) }) });
}
