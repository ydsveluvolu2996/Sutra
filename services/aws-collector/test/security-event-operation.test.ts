import assert from "node:assert/strict";
import { test } from "node:test";

import { runTimedSecurityEventOperation } from "../src/local-server.js";

test("a hard operation timeout releases the connection lock for the next request", async () => {
  const activeOperations = new Set<string>();
  const operationKey = "org-test\u0000connection-test";
  const ignoredOperation = new Promise<never>(() => undefined);
  const keepAlive = setTimeout(() => undefined, 200);

  try {
    await assert.rejects(
      runTimedSecurityEventOperation({
        activeOperations,
        operationKey,
        deadlineMs: 20,
        operation: async () => ignoredOperation,
      }),
      (error: unknown) => (
        typeof error === "object" && error !== null &&
        "status" in error && error.status === 504
      ),
    );
    assert.equal(activeOperations.has(operationKey), false);

    const secondResult = await runTimedSecurityEventOperation({
      activeOperations,
      operationKey,
      deadlineMs: 20,
      operation: async () => "second-request-completed",
    });
    assert.equal(secondResult, "second-request-completed");
    assert.equal(activeOperations.has(operationKey), false);
  } finally {
    clearTimeout(keepAlive);
  }
});
