import assert from "node:assert/strict";
import test from "node:test";
import {
  FINOPS_SOURCE_RUNTIME_REGISTRY,
  FinopsRuntimeRegistryError,
  assertFinopsSourceRuntimeRegistryCoverage,
  createFinopsSourceRuntimeRegistry,
  getFinopsCapabilityRuntime,
  getFinopsSourceRuntimeBinding,
  listFinopsCapabilityRuntimes,
  resolveFinopsCapabilityRuntimeRequest,
  type FinopsCapabilityRuntimeEntry,
  type FinopsRuntimeCodeReference,
} from "../lib/finops-source-runtime-registry.ts";
import {
  FINOPS_CAPABILITY_DEFINITIONS,
  FINOPS_SOURCE_DEFINITIONS,
} from "../lib/finops-source-health.ts";

function errorCode(error: unknown): string | undefined {
  return error instanceof FinopsRuntimeRegistryError ? error.code : undefined;
}

function frozenEntry(
  entry: FinopsCapabilityRuntimeEntry,
  changes: Partial<FinopsCapabilityRuntimeEntry>,
): FinopsCapabilityRuntimeEntry {
  return Object.freeze({ ...entry, ...changes });
}

function assertDeeplyFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) return;
  assert.equal(Object.isFrozen(value), true);
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) assertDeeplyFrozen(child, seen);
}

function codeReferences(entry: FinopsCapabilityRuntimeEntry): readonly FinopsRuntimeCodeReference[] {
  const references: FinopsRuntimeCodeReference[] = [];
  for (const binding of entry.sourceBindings) {
    if (binding.queryContract.operationSet.kind === "code_references") {
      references.push(...binding.queryContract.operationSet.references);
    }
    if (binding.evidenceAdapter.kind === "code_reference") {
      references.push(binding.evidenceAdapter.reference);
    }
  }
  if (entry.processor.kind === "normalizer_and_report_builder") {
    references.push(entry.processor.normalizer, entry.processor.reportBuilder);
  } else if (entry.processor.kind === "report_builder") {
    references.push(entry.processor.reportBuilder);
  } else if (entry.processor.availableNormalizer !== undefined) {
    references.push(entry.processor.availableNormalizer);
  }
  return references;
}

test("registry covers exactly the canonical 27 capabilities and every canonical source", () => {
  assert.doesNotThrow(() => assertFinopsSourceRuntimeRegistryCoverage());
  assert.equal(FINOPS_SOURCE_RUNTIME_REGISTRY.length, 27);
  assert.deepEqual(
    FINOPS_SOURCE_RUNTIME_REGISTRY.map((entry) => entry.capabilityId),
    FINOPS_CAPABILITY_DEFINITIONS.map((entry) => entry.id),
  );
  assert.equal(new Set(FINOPS_SOURCE_RUNTIME_REGISTRY.map((entry) => entry.capabilityId)).size, 27);
  assert.deepEqual(
    [...new Set(FINOPS_SOURCE_RUNTIME_REGISTRY.flatMap((entry) =>
      entry.sourceBindings.map((binding) => binding.sourceId)
    ))].sort(),
    FINOPS_SOURCE_DEFINITIONS.map((entry) => entry.id).sort(),
  );
  assert.equal(listFinopsCapabilityRuntimes(), FINOPS_SOURCE_RUNTIME_REGISTRY);
});

test("every entry pins canonical source health, freshness, operations, limits, processor, and UI identity", () => {
  const sources = new Map(FINOPS_SOURCE_DEFINITIONS.map((definition) => [definition.id, definition]));
  const uiKeys = new Set<string>();
  for (const entry of FINOPS_SOURCE_RUNTIME_REGISTRY) {
    assert.match(entry.capabilityUiKey, /^finops\.(?:foundational|advanced|additional)\.[a-z0-9_]+$/u);
    assert.equal(uiKeys.has(entry.capabilityUiKey), false);
    uiKeys.add(entry.capabilityUiKey);
    assert.match(entry.capabilityQueryContractId, /^sutra\.finops\.capability\.[a-z0-9_]+\.v1$/u);
    assert.ok(entry.bounds.maxPages > 0 && entry.bounds.maxPages <= 10_000);
    assert.ok(entry.bounds.maxBytes > 0 && entry.bounds.maxBytes <= 2 * 1024 * 1024 * 1024);
    assert.ok(entry.bounds.maxRecords > 0 && entry.bounds.maxRecords <= 5_000_000);
    assert.ok(entry.bounds.maxConcurrency > 0 && entry.bounds.maxConcurrency <= 32);
    assert.ok(entry.bounds.deadlineMs > 0 && entry.bounds.deadlineMs <= 15 * 60 * 1_000);
    assert.ok(
      entry.processor.kind === "normalizer_and_report_builder"
      || entry.processor.kind === "report_builder"
      || entry.processor.kind === "deferred",
    );
    for (const binding of entry.sourceBindings) {
      assert.equal(binding.sourceHealthId, binding.sourceId);
      assert.equal(binding.freshnessSlaHours, sources.get(binding.sourceId)?.freshnessSlaHours);
      assert.deepEqual(binding.queryContract.clientControlledFields, []);
      assert.equal(binding.queryContract.tenantScopeBinding, "persisted_org_customer_connection");
      assert.equal(binding.queryContract.accountScopeBinding, "persisted_connection_accounts_only");
      assert.equal(binding.queryContract.endpointBinding, "server_sdk_or_allowlist_only");
      assert.equal(binding.queryContract.arnBinding, "persisted_authorization_only");
      assert.equal(binding.queryContract.filterBinding, "registered_query_only");
      assert.equal(getFinopsSourceRuntimeBinding(binding.sourceId), binding);
    }
  }
  assert.equal(uiKeys.size, 27);
});

test("all declared code references point to real engine exports", async () => {
  const references = new Map<string, FinopsRuntimeCodeReference>();
  for (const entry of FINOPS_SOURCE_RUNTIME_REGISTRY) {
    for (const reference of codeReferences(entry)) {
      references.set(`${reference.modulePath}#${reference.exportName}`, reference);
    }
  }
  for (const reference of references.values()) {
    const moduleUrl = new URL(`../lib/${reference.modulePath.slice(2)}`, import.meta.url);
    const loaded = await import(moduleUrl.href) as Record<string, unknown>;
    assert.notEqual(loaded[reference.exportName], undefined, `${moduleUrl.pathname}#${reference.exportName}`);
  }
});

test("registry and all returned contracts are deeply immutable", () => {
  assertDeeplyFrozen(FINOPS_SOURCE_RUNTIME_REGISTRY);
  const capability = getFinopsCapabilityRuntime("cudos");
  const source = getFinopsSourceRuntimeBinding("aws_cur2_data_export");
  assertDeeplyFrozen(capability);
  assertDeeplyFrozen(source);
  assert.throws(() => {
    (capability.bounds as { maxPages: number }).maxPages = Number.MAX_SAFE_INTEGER;
  }, TypeError);
  assert.throws(() => {
    (source.queryContract.clientControlledFields as unknown as unknown[]).push("accountId");
  }, TypeError);
});

test("client resolver accepts only a capability ID and rejects provider-controlled fields", () => {
  assert.equal(resolveFinopsCapabilityRuntimeRequest({ capabilityId: "cudos" }).capabilityId, "cudos");
  for (const field of ["operations", "endpoint", "arn", "accountId", "accountScope", "filters", "maxPages", "deadlineMs"]) {
    assert.throws(
      () => resolveFinopsCapabilityRuntimeRequest({ capabilityId: "cudos", [field]: "attacker-controlled" }),
      (error) => errorCode(error) === "INVALID_CLIENT_REQUEST",
    );
  }
  for (const request of [null, [], "cudos", {}, { capabilityId: "unknown" }, { capabilityId: 1 }]) {
    assert.throws(
      () => resolveFinopsCapabilityRuntimeRequest(request),
      (error) => errorCode(error) === (request !== null && typeof request === "object" && "capabilityId" in request && request.capabilityId === "unknown"
        ? "UNKNOWN_CAPABILITY"
        : "INVALID_CLIENT_REQUEST"),
    );
  }
});

test("capability and source lookup functions fail closed on unknown identities", () => {
  assert.equal(getFinopsCapabilityRuntime("pricing_change").capabilityId, "pricing_change");
  assert.equal(getFinopsSourceRuntimeBinding("aws_pricing_catalog").sourceId, "aws_pricing_catalog");
  for (const value of ["", "unknown", "cudos*", null, 27]) {
    assert.throws(() => getFinopsCapabilityRuntime(value), (error) => errorCode(error) === "UNKNOWN_CAPABILITY");
    assert.throws(() => getFinopsSourceRuntimeBinding(value), (error) => errorCode(error) === "SOURCE_CONTRACT_MISMATCH");
  }
});

test("registry construction rejects mutable, duplicate, missing, unknown, and source-divergent policy", () => {
  assert.throws(
    () => createFinopsSourceRuntimeRegistry([...FINOPS_SOURCE_RUNTIME_REGISTRY]),
    (error) => errorCode(error) === "MUTABLE_REGISTRY",
  );

  const duplicate = Object.freeze([
    ...FINOPS_SOURCE_RUNTIME_REGISTRY.slice(0, -1),
    FINOPS_SOURCE_RUNTIME_REGISTRY[0]!,
  ]);
  assert.throws(
    () => createFinopsSourceRuntimeRegistry(duplicate),
    (error) => errorCode(error) === "DUPLICATE_CAPABILITY",
  );

  const missing = Object.freeze(FINOPS_SOURCE_RUNTIME_REGISTRY.slice(0, -1));
  assert.throws(
    () => createFinopsSourceRuntimeRegistry(missing),
    (error) => errorCode(error) === "INCOMPLETE_REGISTRY",
  );

  const unknown = Object.freeze([
    frozenEntry(FINOPS_SOURCE_RUNTIME_REGISTRY[0]!, { capabilityId: "unknown" as never }),
    ...FINOPS_SOURCE_RUNTIME_REGISTRY.slice(1),
  ]);
  assert.throws(
    () => createFinopsSourceRuntimeRegistry(unknown),
    (error) => errorCode(error) === "UNKNOWN_CAPABILITY",
  );

  const sourceDivergent = Object.freeze([
    frozenEntry(FINOPS_SOURCE_RUNTIME_REGISTRY[0]!, {
      requiredSourceIds: Object.freeze(["aws_focus_1_2_data_export"]),
    }),
    ...FINOPS_SOURCE_RUNTIME_REGISTRY.slice(1),
  ]);
  assert.throws(
    () => createFinopsSourceRuntimeRegistry(sourceDivergent),
    (error) => errorCode(error) === "SOURCE_CONTRACT_MISMATCH",
  );
});
