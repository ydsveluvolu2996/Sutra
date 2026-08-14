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

test("turning on the flag cannot bypass an undeployed Secrets Manager backend", () => {
  assert.equal(AWS_STATIC_KEYS_SECRETS_MANAGER_BACKEND_READY, false);
  assert.equal(
    isAwsStaticCredentialsOnboardingEnabled({ SUTRA_AWS_STATIC_KEYS_ENABLED: "true" }),
    false,
  );
  assert.throws(
    () => assertAwsStaticCredentialsOnboardingEnabled({ SUTRA_AWS_STATIC_KEYS_ENABLED: "true" }),
    /Secrets Manager/u,
  );
});
