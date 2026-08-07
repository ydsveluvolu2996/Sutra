import assert from "node:assert/strict";
import test from "node:test";

import {
  DataExportDiscoveryError,
  discoverFoundationalDataExports,
  FOUNDATIONAL_EXPORT_TABLES,
} from "../src/finops-data-export-discovery-reader.js";

const REGION = "ap-south-1";
const ACCOUNT = "373665157695";
const ARN = (name: string) => `arn:aws:bcm-data-exports:${REGION}:${ACCOUNT}:export/${name}`;

// Deliberately NOT shaped like a real key id. scripts/check-repository-secrets.mjs
// matches /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ and cannot tell a fixture from a live
// credential, which is the correct posture -- so the fixture is built at runtime
// from a lowercase stem that can never match. The reader never inspects these
// values; they exist only to satisfy the credential type.
const CREDENTIALS = {
  accessKeyId: `fixture-${"x".repeat(12)}`,
  secretAccessKey: "s".repeat(40),
  sessionToken: "t".repeat(64),
  expiration: new Date(Date.now() + 900_000).toISOString(),
} as unknown as Parameters<typeof discoverFoundationalDataExports>[0]["credentials"];

function detailFor(input: {
  readonly name: string;
  readonly table?: string;
  readonly bucket?: string;
  readonly prefix?: string;
}) {
  return {
    Export: {
      Name: input.name,
      ExportArn: ARN(input.name),
      DataQuery: {
        TableConfigurations: { [input.table ?? "COST_AND_USAGE_REPORT"]: { TIME_GRANULARITY: "HOURLY" } },
      },
      DestinationConfigurations: {
        S3Destination: {
          S3Bucket: input.bucket ?? "acme-cur-exports",
          S3Prefix: input.prefix ?? "billing",
          S3Region: REGION,
        },
      },
    },
  };
}

/** Records every command the reader issues so the action surface can be asserted. */
function stubClient(handlers: {
  readonly list: (input: unknown) => unknown;
  readonly get?: (input: unknown) => unknown;
}) {
  const issued: string[] = [];
  return {
    issued,
    factory: () => ({
      send(command: unknown) {
        const name = command?.constructor?.name ?? "unknown";
        issued.push(name);
        const input = (command as { input?: unknown }).input;
        if (name === "ListExportsCommand") return Promise.resolve(handlers.list(input));
        if (name === "GetExportCommand") {
          if (handlers.get === undefined) throw new Error("unexpected GetExport");
          return Promise.resolve(handlers.get(input));
        }
        throw new Error(`unexpected command ${name}`);
      },
      destroy() { issued.push("destroy"); },
    }),
  };
}

test("a CUR 2.0 export resolves to its exact destination and contract", async () => {
  const stub = stubClient({
    list: () => ({ Exports: [{ ExportArn: ARN("acme-cur2") }] }),
    get: () => detailFor({ name: "acme-cur2" }),
  });
  const outcome = await discoverFoundationalDataExports(
    { region: REGION, credentials: CREDENTIALS, clientFactory: stub.factory },
    new AbortController().signal,
  );
  assert.equal(outcome.kind, "discovered");
  assert.equal(outcome.kind === "discovered" ? outcome.exports.length : -1, 1);
  const found = outcome.kind === "discovered" ? outcome.exports[0]! : null;
  assert.equal(found?.contractId, FOUNDATIONAL_EXPORT_TABLES.COST_AND_USAGE_REPORT);
  assert.equal(found?.bucket, "acme-cur-exports");
  // The ingest contract wants the export-name root with a trailing slash. AWS
  // reports the configured prefix without the export segment.
  assert.equal(found?.prefix, "billing/acme-cur2/");
  assert.equal(found?.region, REGION);
  // The client is always destroyed, so no credential outlives the call.
  assert.equal(stub.issued.at(-1), "destroy");
});

test("only the two granted actions are ever issued", async () => {
  // The permission pack grants exactly ListExports and GetExport. A third call
  // would be a permission this repository never asked a customer for.
  const stub = stubClient({
    list: () => ({ Exports: [{ ExportArn: ARN("acme-cur2") }] }),
    get: () => detailFor({ name: "acme-cur2" }),
  });
  await discoverFoundationalDataExports(
    { region: REGION, credentials: CREDENTIALS, clientFactory: stub.factory },
    new AbortController().signal,
  );
  assert.deepEqual(
    [...new Set(stub.issued.filter((name) => name.endsWith("Command")))].sort(),
    ["GetExportCommand", "ListExportsCommand"],
  );
});

test("a FOCUS 1.2 export maps to its own contract, and other tables are ignored", async () => {
  const stub = stubClient({
    list: () => ({
      Exports: [{ ExportArn: ARN("focus") }, { ExportArn: ARN("unrelated") }],
    }),
    get: (input) => {
      const arn = (input as { ExportArn: string }).ExportArn;
      return arn.endsWith("/focus")
        ? detailFor({ name: "focus", table: "FOCUS_1_2_AWS" })
        : detailFor({ name: "unrelated", table: "SOME_OTHER_TABLE" });
    },
  });
  const outcome = await discoverFoundationalDataExports(
    { region: REGION, credentials: CREDENTIALS, clientFactory: stub.factory },
    new AbortController().signal,
  );
  assert.equal(outcome.kind, "discovered");
  const exports = outcome.kind === "discovered" ? outcome.exports : [];
  assert.equal(exports.length, 1);
  assert.equal(exports[0]?.contractId, FOUNDATIONAL_EXPORT_TABLES.FOCUS_1_2_AWS);
});

test("no exports is 'none', and a denial is 'unavailable' — never the same fact", async () => {
  // This distinction is the whole point of the outcome union. A customer who has
  // not created an export and a customer whose role was denied ListExports need
  // different actions, and a dashboard that conflates them sends the operator to
  // the wrong place.
  const empty = await discoverFoundationalDataExports(
    {
      region: REGION,
      credentials: CREDENTIALS,
      clientFactory: stubClient({ list: () => ({ Exports: [] }) }).factory,
    },
    new AbortController().signal,
  );
  assert.equal(empty.kind, "none");

  for (const [name, reason] of [
    ["AccessDeniedException", "ACCESS_DENIED"],
    ["ThrottlingException", "THROTTLED"],
    ["InternalServerException", "PROVIDER_ERROR"],
  ] as const) {
    const outcome = await discoverFoundationalDataExports(
      {
        region: REGION,
        credentials: CREDENTIALS,
        clientFactory: stubClient({
          list: () => { throw Object.assign(new Error(name), { name }); },
        }).factory,
      },
      new AbortController().signal,
    );
    assert.equal(outcome.kind, "unavailable", name);
    assert.equal(outcome.kind === "unavailable" ? outcome.reason : null, reason);
  }
});

test("a malformed provider response yields nothing rather than a guessed destination", async () => {
  for (const detail of [
    { Export: { Name: "acme-cur2", ExportArn: ARN("acme-cur2") } },
    detailFor({ name: "acme-cur2", bucket: "UPPERCASE" }),
    detailFor({ name: "acme-cur2", prefix: "../escape" }),
    detailFor({ name: "acme-cur2", prefix: "/absolute" }),
  ]) {
    const outcome = await discoverFoundationalDataExports(
      {
        region: REGION,
        credentials: CREDENTIALS,
        clientFactory: stubClient({
          list: () => ({ Exports: [{ ExportArn: ARN("acme-cur2") }] }),
          get: () => detail,
        }).factory,
      },
      new AbortController().signal,
    );
    assert.equal(outcome.kind, "none", JSON.stringify(detail).slice(0, 60));
  }
});

test("results are ordered deterministically so rediscovery stays idempotent", async () => {
  // The outbox dedupes on a payload hash. Two sweeps over the same account must
  // produce byte-identical payloads, or every sweep writes a new observation.
  const stub = stubClient({
    list: () => ({ Exports: [{ ExportArn: ARN("zeta") }, { ExportArn: ARN("alpha") }] }),
    get: (input) => detailFor({
      name: (input as { ExportArn: string }).ExportArn.split("/")[1]!,
    }),
  });
  const outcome = await discoverFoundationalDataExports(
    { region: REGION, credentials: CREDENTIALS, clientFactory: stub.factory },
    new AbortController().signal,
  );
  const names = outcome.kind === "discovered" ? outcome.exports.map((e) => e.exportName) : [];
  assert.deepEqual(names, ["alpha", "zeta"]);
});

test("an invalid region is refused before any credential reaches a client", async () => {
  let built = false;
  await assert.rejects(
    () => discoverFoundationalDataExports(
      {
        region: "not-a-region",
        credentials: CREDENTIALS,
        clientFactory: () => { built = true; throw new Error("must not build"); },
      },
      new AbortController().signal,
    ),
    DataExportDiscoveryError,
  );
  assert.equal(built, false);
});

test("an aborted sweep stops instead of returning a partial answer as complete", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => discoverFoundationalDataExports(
      {
        region: REGION,
        credentials: CREDENTIALS,
        clientFactory: stubClient({ list: () => ({ Exports: [] }) }).factory,
      },
      controller.signal,
    ),
    DataExportDiscoveryError,
  );
});
