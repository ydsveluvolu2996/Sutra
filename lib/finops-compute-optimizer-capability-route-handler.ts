/** Authorized control-plane boundary for the separate Compute Optimizer .8.5 capability. */
import { canonicalJson } from "./canonical-json.ts";
import {
  ComputeOptimizerMaterializationActivationReaderError,
  readComputeOptimizerMaterializationActivationManifest,
  type ComputeOptimizerMaterializationActivationManifestTransport,
} from "./finops-compute-optimizer-materialization-activation-reader.ts";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const MAX_BODY_BYTES = 1_024;
const PERMISSION_PACK = "standard-2026-08.5" as const;

type Partition = "aws" | "aws-us-gov" | "aws-cn";

interface CapabilityRouteAuth {
  readonly subject: { readonly orgId: string };
}

interface CapabilityRouteConnection {
  readonly id: string;
  readonly customerId: string;
  readonly sourceKind: string;
  readonly status: string;
  readonly awsAccountId: string;
  readonly partition: Partition;
  readonly enabledRegions: readonly string[];
}

interface CapabilityScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

interface StoredCapability {
  readonly capabilityId: string;
  readonly scope: CapabilityScope;
  readonly accountId: string;
  readonly partition: Partition;
  readonly permissionPackVersion: typeof PERMISSION_PACK;
  readonly regions: readonly string[];
  readonly manifestSha256: string;
  readonly verifiedAtIso: string;
  readonly enabled: boolean;
}

export interface ComputeOptimizerCapabilityRouteDependencies<
  TAuth extends CapabilityRouteAuth = CapabilityRouteAuth,
> {
  readonly assertSameOrigin: (request: Request) => void;
  readonly readBody: (request: Request, maximumBytes: number) => Promise<unknown>;
  readonly requireSession: (request: Request) => Promise<TAuth>;
  readonly getConnection: (
    organizationId: string,
    connectionId: string,
  ) => Promise<CapabilityRouteConnection | null>;
  readonly assertManage: (auth: TAuth, customerId: string) => void;
  readonly transport: ComputeOptimizerMaterializationActivationManifestTransport;
  readonly getCurrentCapability: (scope: CapabilityScope) => Promise<StoredCapability | null>;
  readonly recordCapability: (scope: CapabilityScope, input: {
    readonly accountId: string;
    readonly partition: Partition;
    readonly regions: readonly string[];
    readonly manifestSha256: string;
    readonly verifiedAtMs: number;
    readonly enabled: boolean;
  }, nowMs?: number) => Promise<StoredCapability>;
  readonly nowMs: () => number;
}

function fail(code: string, status: number): never {
  throw Object.assign(new Error("Compute Optimizer capability request rejected"), { code, status });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function sanitizedError(error: unknown): Response {
  const candidate = error as { readonly code?: unknown; readonly status?: unknown } | null;
  const code = typeof candidate?.code === "string" ? candidate.code : "REQUEST_FAILED";
  const status = typeof candidate?.status === "number"
    && [400, 401, 403, 404, 409, 429, 503].includes(candidate.status)
    ? candidate.status
    : error instanceof ComputeOptimizerMaterializationActivationReaderError ? 502
      : code === "NOT_FOUND" ? 404
        : code === "INVALID_INPUT" ? 400
          : code === "INVALID_STATE" ? 409 : 500;
  const exposedCode = error instanceof ComputeOptimizerMaterializationActivationReaderError
    ? "CAPABILITY_VERIFICATION_FAILED" : code;
  return json({ error: { code: exposedCode, message: "Compute Optimizer capability request rejected" } }, status);
}

function exactRequest(value: unknown): { readonly connectionId: string; readonly enabled: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== 2
    || !("connectionId" in value) || !("enabled" in value)
    || typeof value.connectionId !== "string" || !CONNECTION_ID.test(value.connectionId)
    || typeof value.enabled !== "boolean") fail("INVALID_INPUT", 400);
  return Object.freeze({ connectionId: value.connectionId, enabled: value.enabled });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0")).join("");
}

function sameRegions(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((region, index) => region === right[index]);
}

function publicCapability(value: StoredCapability) {
  return Object.freeze({
    capabilityId: value.capabilityId,
    connectionId: value.scope.connectionId,
    permissionPackVersion: value.permissionPackVersion,
    enabled: value.enabled,
    regions: value.regions,
    regionCount: value.regions.length,
    verifiedAt: value.verifiedAtIso,
    manifestSha256: value.manifestSha256,
  });
}

/**
 * The browser supplies only identity + desired state. Account, partition and
 * Regions come from the already-authorized active connection; the hostile
 * collector response must pass the signed manifest reader before persistence.
 */
export function createComputeOptimizerCapabilityPostHandler<TAuth extends CapabilityRouteAuth>(
  dependencies: ComputeOptimizerCapabilityRouteDependencies<TAuth>,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    try {
      dependencies.assertSameOrigin(request);
      const input = exactRequest(await dependencies.readBody(request, MAX_BODY_BYTES));
      const auth = await dependencies.requireSession(request);
      const connection = await dependencies.getConnection(auth.subject.orgId, input.connectionId);
      if (connection === null || connection.id !== input.connectionId
        || connection.sourceKind !== "aws_trust_role" || connection.status !== "active") {
        fail("NOT_FOUND", 404);
      }
      dependencies.assertManage(auth, connection.customerId);
      // `all-enabled` is an onboarding instruction, not a trusted materializer
      // Region matrix. Capability activation requires the persisted explicit set.
      if (connection.enabledRegions.length < 1 || connection.enabledRegions.length > 50
        || connection.enabledRegions.includes("all-enabled")) fail("INVALID_STATE", 409);
      const regions = Object.freeze([...connection.enabledRegions].sort());
      const scope = Object.freeze({
        organizationId: auth.subject.orgId,
        customerId: connection.customerId,
        connectionId: connection.id,
      });
      const requestIdentitySha256 = await sha256(canonicalJson({
        schemaVersion: "sutra.compute-optimizer-capability-verification.v1",
        scope,
        accountId: connection.awsAccountId,
        partition: connection.partition,
        regions,
      }));
      const requestId = `coav_${requestIdentitySha256}`;
      const manifest = await readComputeOptimizerMaterializationActivationManifest({
        request: {
          schema: "sutra.compute-optimizer-materialization-activation-manifest-request.v1",
          requestId,
          tenantId: scope.organizationId,
          connectionId: scope.connectionId,
          accountId: connection.awsAccountId,
          partition: connection.partition,
          requiredPermissionPackVersion: PERMISSION_PACK,
        },
        enabledRegions: regions,
      }, dependencies.transport);
      const manifestSha256 = await sha256(canonicalJson(manifest));
      const current = await dependencies.getCurrentCapability(scope);
      const capability = current !== null
        && current.accountId === connection.awsAccountId
        && current.partition === connection.partition
        && current.permissionPackVersion === PERMISSION_PACK
        && current.manifestSha256 === manifestSha256
        && current.enabled === input.enabled
        && sameRegions(current.regions, regions)
        ? current
        : await (async () => {
          const nowMs = dependencies.nowMs();
          return dependencies.recordCapability(scope, {
            accountId: connection.awsAccountId,
            partition: connection.partition,
            regions,
            manifestSha256,
            verifiedAtMs: nowMs,
            enabled: input.enabled,
          }, nowMs);
        })();
      return json({
        schema: "sutra.finops-compute-optimizer-capability.v1",
        capability: publicCapability(capability),
      });
    } catch (error) {
      return sanitizedError(error);
    }
  };
}
