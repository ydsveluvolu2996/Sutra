import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentlessBrokerExecution } from "../lib/agentless-broker-reconciliation.ts";
import { buildAgentlessScanPlan } from "../lib/aws-agentless-scan-plan.ts";

const plan = buildAgentlessScanPlan({
  scanAccountId: "111111111111",
  volumes: [
    {
      volumeId: "vol-11111111",
      region: "us-east-1",
      sizeGiB: 8,
      encrypted: true,
      attached: true,
    },
  ],
});

function execution(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "sutra.aws-agentless-scan-execution.v1",
    results: [{
      volumeId: "vol-11111111",
      status: "scanned",
      findings: [{ source: "trivy", severity: "high", title: "CVE evidence" }],
      error: null,
      toreDown: ["vol-22222222", "snap-22222222"],
      teardownFailures: [],
      cleanupHandoff: ["snap-11111111"],
      teardownDebt: [{
        resourceId: "snap-11111111",
        resourceKind: "snapshot",
        accountScope: "customer",
        region: "us-east-1",
        error: "customer lifecycle handoff",
      }],
    }],
    // Deliberately false: the parser must recalculate every count.
    summary: {
      scanned: 999,
      failed: 999,
      findings: 999,
      resourcesToreDown: 999,
      teardownFailures: 999,
      cleanupHandoffs: 999,
    },
    ...overrides,
  };
}

test("agentless reconciliation recalculates summary and preserves typed teardown ownership", () => {
  const parsed = parseAgentlessBrokerExecution(execution(), plan);
  assert.deepEqual(parsed.summary, {
    scanned: 1,
    failed: 0,
    findings: 1,
    resourcesToreDown: 2,
    teardownFailures: 0,
    cleanupHandoffs: 1,
  });
  assert.equal(parsed.results[0]?.teardownDebt?.[0]?.accountScope, "customer");
});

test("agentless reconciliation rejects volume injection and duplicate resource evidence", () => {
  const foreign = execution();
  foreign.results = [{
    ...(foreign.results as Record<string, unknown>[])[0],
    volumeId: "vol-deadbeef",
  }];
  assert.throws(() => parseAgentlessBrokerExecution(foreign, plan), /invalid/u);

  const duplicate = execution();
  duplicate.results = [{
    ...(duplicate.results as Record<string, unknown>[])[0],
    toreDown: ["vol-22222222", "vol-22222222"],
  }];
  assert.throws(() => parseAgentlessBrokerExecution(duplicate, plan), /invalid/u);
});

test("agentless reconciliation rejects unbounded debt and undeclared fields", () => {
  const tooMuchDebt = execution();
  tooMuchDebt.results = [{
    ...(tooMuchDebt.results as Record<string, unknown>[])[0],
    teardownDebt: Array.from({ length: 33 }, () => ({
      resourceId: "snap-11111111",
      resourceKind: "snapshot",
      accountScope: "customer",
      region: "us-east-1",
      error: "handoff",
    })),
  }];
  assert.throws(() => parseAgentlessBrokerExecution(tooMuchDebt, plan), /invalid/u);

  assert.throws(
    () => parseAgentlessBrokerExecution({ ...execution(), tenantId: "org_foreign" }, plan),
    /invalid/u,
  );
});
