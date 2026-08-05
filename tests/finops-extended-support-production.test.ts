import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, describe, it } from "node:test";
import { createServer } from "vite";
import type {
  ExtendedSupportProjectionCapture,
  ExtendedSupportTenantBoundary,
} from "../lib/finops-extended-support-projection.ts";
import type { ExtendedSupportCollectorRequest } from
  "../lib/finops-extended-support-collector-job.ts";

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  server: { middlewareMode: true },
});
const projection = await vite.ssrLoadModule("/lib/finops-extended-support-projection.ts");
const transport = await vite.ssrLoadModule("/lib/finops-extended-support-signed-broker.ts");
const { EXTENDED_SUPPORT_PROJECTION_BOUNDS, EXTENDED_SUPPORT_READ_OPERATIONS } = projection;
const { EXTENDED_SUPPORT_BROKER_PATH, ExtendedSupportSignedBrokerError,
  createExtendedSupportSignedBroker } = transport;
after(async () => vite.close());

const NOW = Date.parse("2026-08-02T00:00:00.000Z");
const JOB = `job_${"b".repeat(32)}`;
const BOUNDARY: ExtendedSupportTenantBoundary = {
  scope: {
    orgId: "org_extended",
    customerId: "customer_extended",
    connectionId: `conn_${"a".repeat(32)}`,
  },
  managementAccountId: "111122223333",
  partition: "aws",
  accountIds: ["111122223333"],
  regions: ["us-east-1"],
};

function request(): ExtendedSupportCollectorRequest {
  return {
    schemaVersion: "sutra.extended-support-collector-request.v1",
    jobId: JOB,
    scheduledWindow: "2026-08-02T00:00:00.000Z",
    boundary: BOUNDARY,
    operations: EXTENDED_SUPPORT_READ_OPERATIONS,
    bounds: EXTENDED_SUPPORT_PROJECTION_BOUNDS,
    inventoryScope: "SERVER_PINNED_ACCOUNT_REGION_FANOUT",
    lifecycleSource: "AUTHORITATIVE_AWS_API_OR_DOCUMENTATION",
    pricingSource: "AWS_PRICE_LIST_OR_PUBLIC_PRICING",
    actualCostSource: "ACTIVE_RECONCILED_CUR2_GENERATION",
    deadlineAtIso: "2026-08-02T00:15:00.000Z",
  };
}

function capture(scope = BOUNDARY.scope): ExtendedSupportProjectionCapture {
  return {
    schemaVersion: "sutra.extended-support-projection.v1",
    scope,
    managementAccountId: BOUNDARY.managementAccountId,
    partition: BOUNDARY.partition,
    accountIds: BOUNDARY.accountIds,
    regions: BOUNDARY.regions,
    collectionId: `esp_${"c".repeat(64)}`,
    startedAt: "2026-08-01T23:59:00.000Z",
    completedAt: "2026-08-02T00:00:00.000Z",
    coverage: ["EKS", "RDS", "AURORA", "OPENSEARCH", "ELASTICACHE"].map((service) => ({
      service: service as "EKS",
      status: "SUCCEEDED" as const,
      readPermissionsValidated: true,
      accountIds: BOUNDARY.accountIds,
      regions: BOUNDARY.regions,
      recordCount: 0,
      errorCode: null,
    })),
    observations: [],
    calendars: [],
    rates: [],
    observedCharges: [],
  };
}

function keys() {
  const client = generateKeyPairSync("ed25519");
  const broker = generateKeyPairSync("ed25519");
  return {
    brokerPrivateKey: broker.privateKey,
    signing: {
      clientKeyId: "sutra-app-extended-2026-08",
      clientPrivateKey: client.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
      brokerKeyId: "sutra-broker-extended-2026-08",
      brokerPublicKey: broker.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    },
  };
}

function fetcher(input: {
  readonly key: ReturnType<typeof keys>;
  readonly capture?: ExtendedSupportProjectionCapture;
  readonly badSignature?: boolean;
  readonly mismatchHash?: boolean;
}): typeof fetch {
  return (async (_url: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(init?.method, "POST");
    const headers = init!.headers as Record<string, string>;
    assert.equal(headers["x-sutra-tenant-id"], BOUNDARY.scope.orgId);
    assert.equal(headers["x-sutra-customer-id"], BOUNDARY.scope.customerId);
    assert.equal(headers["x-sutra-connection-id"], BOUNDARY.scope.connectionId);
    assert.equal(headers["x-sutra-job-id"], JOB);
    const body = String(init!.body);
    const parsed = JSON.parse(body) as ExtendedSupportCollectorRequest;
    const bodySha256 = createHash("sha256").update(body).digest("hex");
    const responseBody = JSON.stringify({
      schemaVersion: "sutra.extended-support-provider-response.v1",
      jobId: parsed.jobId,
      requestBodySha256: input.mismatchHash ? "f".repeat(64) : bodySha256,
      capture: input.capture ?? capture(),
    });
    const responseSha256 = createHash("sha256").update(responseBody).digest("hex");
    const canonical = Buffer.from([
      "SUTRA-BROKER-APP-V1", "200", EXTENDED_SUPPORT_BROKER_PATH,
      headers["x-sutra-nonce"], input.key.signing.brokerKeyId, responseSha256,
    ].join("\n"));
    const signature = input.badSignature ? "A".repeat(86)
      : sign(null, canonical, input.key.brokerPrivateKey).toString("base64url");
    return new Response(responseBody, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(responseBody)),
        "x-sutra-key-id": input.key.signing.brokerKeyId,
        "x-sutra-signature": signature,
      },
    });
  }) as typeof fetch;
}

describe("Extended Support production composition and signed transport", () => {
  it("verifies exact response bytes and validates the returned evidence", async () => {
    const key = keys();
    const broker = createExtendedSupportSignedBroker({
      configuration: { brokerOrigin: "https://extended.internal", signing: key.signing },
      fetcher: fetcher({ key }),
      now: () => NOW,
      nonce: () => "n".repeat(32),
    });
    assert.deepEqual(await broker.collect(request()), capture());
  });

  it("rejects forged signatures, substituted evidence and request-hash replay", async () => {
    const key = keys();
    for (const [options, code] of [
      [{ key, badSignature: true }, "AUTHENTICATION_FAILED"],
      [{ key, capture: capture({ ...BOUNDARY.scope, customerId: "attacker" }) }, "EVIDENCE_REJECTED"],
      [{ key, mismatchHash: true }, "RESPONSE_INVALID"],
    ] as const) {
      const broker = createExtendedSupportSignedBroker({
        configuration: { brokerOrigin: "https://extended.internal", signing: key.signing },
        fetcher: fetcher(options),
        now: () => NOW,
        nonce: () => "n".repeat(32),
      });
      await assert.rejects(broker.collect(request()),
        (error: unknown) => error instanceof Error
          && error.name === ExtendedSupportSignedBrokerError.name
          && "code" in error && error.code === code
          && !error.message.includes("attacker"));
    }
  });

  it("reports the shared worker hook as registered", async () => {
    const source = await readFile(new URL(
      "../lib/finops-extended-support-production-composition.ts", import.meta.url,
    ), "utf8");
    assert.match(source, /durableReplayRepositoryImplemented:\s*true/u);
    assert.match(source, /signedBrokerClientImplemented:\s*true/u);
    assert.match(source, /REGISTERED_LOCAL_RUNTIME/u);
    assert.match(source, /EXTENDED_SUPPORT_EXACTLY_ONE_BROKER_CONFIGURATION_REQUIRED/u);
  });
});
