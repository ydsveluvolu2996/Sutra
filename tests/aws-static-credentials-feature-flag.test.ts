import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAwsStaticCredentialsOnboardingEnabled,
  AWS_STATIC_KEYS_SECRETS_MANAGER_BACKEND_READY,
  isAwsStaticCredentialsOnboardingEnabled,
} from "../lib/aws-static-credentials-feature.ts";

test("static AWS keys fail closed when the runtime flag is absent or false", () => {
  assert.equal(isAwsStaticCredentialsOnboardingEnabled({}), false);
  assert.equal(isAwsStaticCredentialsOnboardingEnabled({ SUTRA_AWS_STATIC_KEYS_ENABLED: "false" }), false);
  assert.throws(() => assertAwsStaticCredentialsOnboardingEnabled({}), /Secrets Manager/u);
});

test("the reviewed backend still requires an exact runtime opt-in", () => {
  assert.equal(AWS_STATIC_KEYS_SECRETS_MANAGER_BACKEND_READY, true);
  assert.equal(
    isAwsStaticCredentialsOnboardingEnabled({ SUTRA_AWS_STATIC_KEYS_ENABLED: "true" }),
    true,
  );
  assert.doesNotThrow(() =>
    assertAwsStaticCredentialsOnboardingEnabled({ SUTRA_AWS_STATIC_KEYS_ENABLED: "true" }));
});
