import assert from "node:assert/strict";
import test from "node:test";

import {
  assessSandboxIdentity,
  SandboxPreflightError,
} from "../src/aws-sandbox-preflight.js";

const EXPECTED = "arn:aws:iam::111122223333:role/sutra/SutraLocalCollectorRole";
const NOW = new Date("2026-07-16T08:00:00.000Z");

test("sandbox preflight accepts the exact short-lived collector role session", () => {
  const result = assessSandboxIdentity({
    expectedPrincipalArn: EXPECTED,
    accountId: "111122223333",
    callerIdentityArn:
      "arn:aws:sts::111122223333:assumed-role/SutraLocalCollectorRole/sutra-demo",
    credentialExpiration: new Date("2026-07-16T09:00:00.000Z"),
    now: NOW,
  });

  assert.equal(result.remainingMinutes, 60);
  assert.equal(result.expectedPrincipalArn, EXPECTED);
  assert.equal(result.accountId, "111122223333");
});

test("sandbox preflight rejects a different role even in the expected account", () => {
  assert.throws(
    () =>
      assessSandboxIdentity({
        expectedPrincipalArn: EXPECTED,
        accountId: "111122223333",
        callerIdentityArn:
          "arn:aws:sts::111122223333:assumed-role/AdministratorAccess/sutra-demo",
        credentialExpiration: new Date("2026-07-16T09:00:00.000Z"),
        now: NOW,
      }),
    (error: unknown) =>
      error instanceof SandboxPreflightError && error.code === "IDENTITY_ROLE_MISMATCH",
  );
});

test("sandbox preflight rejects static or nearly expired credentials", () => {
  for (const expiration of [undefined, new Date("2026-07-16T08:14:59.000Z")]) {
    assert.throws(
      () =>
        assessSandboxIdentity({
          expectedPrincipalArn: EXPECTED,
          accountId: "111122223333",
          callerIdentityArn:
            "arn:aws:sts::111122223333:assumed-role/SutraLocalCollectorRole/sutra-demo",
          credentialExpiration: expiration,
          now: NOW,
        }),
      (error: unknown) =>
        error instanceof SandboxPreflightError &&
        error.code === "CREDENTIALS_NOT_SHORT_LIVED",
    );
  }
});
