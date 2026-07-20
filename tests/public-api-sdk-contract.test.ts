import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { GET as openapiGet } from "../app/api/public/v1/openapi.json/route.ts";
import { ENDPOINTS as TS_ENDPOINTS, SutraClient } from "../clients/typescript/src/index.ts";

// Guards the hand-written SDKs against the OpenAPI spec: every spec operation
// must have exactly one method in each SDK, and neither SDK may expose an
// endpoint the spec lacks. No network, no code generation — the spec is read
// straight from the route handler and the Python surface is parsed statically.

interface OperationObject {
  readonly summary?: string;
}
type PathItem = Partial<Record<string, OperationObject>>;
interface OpenApiSpec {
  readonly paths: Readonly<Record<string, PathItem>>;
}

async function loadSpec(): Promise<OpenApiSpec> {
  return (await openapiGet().json()) as OpenApiSpec;
}

function specOperations(spec: OpenApiSpec): Set<string> {
  const operations = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      operations.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return operations;
}

const PYTHON_CLIENT = readFileSync(new URL("../clients/python/sutra/client.py", import.meta.url), "utf8");

function pythonEndpoints(): { operations: Set<string>; methods: string[] } {
  const operations = new Set<string>();
  const methods: string[] = [];
  const pattern = /Endpoint\("(GET|PATCH)",\s*"([^"]+)",\s*"([a-z_]+)"\)/gu;
  let match: RegExpExecArray | null = pattern.exec(PYTHON_CLIENT);
  while (match !== null) {
    operations.add(`${match[1]} ${match[2]}`);
    methods.push(match[3]);
    match = pattern.exec(PYTHON_CLIENT);
  }
  return { operations, methods };
}

describe("public API SDK contract", () => {
  it("the TypeScript SDK covers exactly the spec's operations", async () => {
    const spec = specOperations(await loadSpec());
    const sdk = new Set(TS_ENDPOINTS.map((endpoint) => `${endpoint.method.toUpperCase()} ${endpoint.path}`));
    assert.deepEqual([...sdk].sort(), [...spec].sort(), "TypeScript SDK endpoints must match the spec 1:1");
  });

  it("every TypeScript endpoint maps to a real client method", () => {
    const prototype = SutraClient.prototype as unknown as Record<string, unknown>;
    for (const endpoint of TS_ENDPOINTS) {
      assert.equal(
        typeof prototype[endpoint.clientMethod],
        "function",
        `SutraClient is missing method ${endpoint.clientMethod} for ${endpoint.operationId}`,
      );
    }
  });

  it("the Python SDK covers exactly the spec's operations", async () => {
    const spec = specOperations(await loadSpec());
    const { operations } = pythonEndpoints();
    assert.notEqual(operations.size, 0, "no Endpoint(...) entries were parsed from the Python client");
    assert.deepEqual([...operations].sort(), [...spec].sort(), "Python SDK endpoints must match the spec 1:1");
  });

  it("every Python endpoint maps to a real def in the client module", () => {
    const { methods } = pythonEndpoints();
    for (const method of methods) {
      assert.ok(
        new RegExp(`def ${method}\\(`, "u").test(PYTHON_CLIENT),
        `Python client is missing method def ${method}`,
      );
    }
  });

  it("both SDKs agree with each other", async () => {
    const spec = specOperations(await loadSpec());
    const ts = new Set(TS_ENDPOINTS.map((endpoint) => `${endpoint.method.toUpperCase()} ${endpoint.path}`));
    const { operations: py } = pythonEndpoints();
    assert.deepEqual([...ts].sort(), [...py].sort(), "the two SDKs must expose the same operation surface");
    // And that shared surface is exactly the spec (transitive, but assert it plainly).
    assert.equal(ts.size, spec.size);
  });
});
