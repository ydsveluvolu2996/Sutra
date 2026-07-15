import assert from "node:assert/strict";
import test from "node:test";

import {
  AesGcmSecretKeyring,
  PilotSecurityError,
  assertConnectionTransition,
  assertSameOrigin,
  assertSyncTransition,
  decryptExternalId,
  encryptExternalId,
  generateExternalId,
  mayAdvanceSuccessfulSync,
  mayRetireUnseenResources,
  parseAwsAccountId,
  parseAwsOnboardingInput,
  parseAwsPartition,
  parseIamRoleArn,
  parsePilotScope,
  parsePilotSyncRequest,
  parsePilotSyncSummary,
  parseRegions,
  parseSafePilotFailure,
  readBoundedJson,
  type SecretContext,
} from "../lib/aws-pilot-security.ts";

const validScope = {
  orgId: "org-01",
  customerId: "customer-01",
  actorId: "user-01",
} as const;

const validOnboarding = {
  awsAccountId: "123456789012",
  partition: "aws",
  roleArn: "arn:aws:iam::123456789012:role/mspcmdb/SutraReadRole",
  enabledRegions: ["us-west-2", "us-east-1"],
} as const;

function isPilotError(code: PilotSecurityError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof PilotSecurityError && error.code === code;
}

test("onboarding parser binds canonical role ARN to account and partition", () => {
  assert.deepEqual(parseAwsOnboardingInput(validOnboarding), {
    ...validOnboarding,
    enabledRegions: ["us-east-1", "us-west-2"],
  });

  assert.deepEqual(
    parseIamRoleArn("arn:aws-us-gov:iam::210987654321:role/team/security/SutraReadRole"),
    {
      arn: "arn:aws-us-gov:iam::210987654321:role/team/security/SutraReadRole",
      partition: "aws-us-gov",
      accountId: "210987654321",
      rolePathAndName: "team/security/SutraReadRole",
      roleName: "SutraReadRole",
    },
  );

  assert.equal(parseAwsAccountId("123456789012"), "123456789012");
  assert.equal(parseAwsPartition("aws-us-gov"), "aws-us-gov");
  assert.deepEqual(parseRegions(["us-west-2", "us-east-1"], "aws"), [
    "us-east-1",
    "us-west-2",
  ]);
  assert.throws(
    () =>
      parseIamRoleArn(validOnboarding.roleArn, {
        accountId: "210987654321",
        partition: "aws",
      }),
    isPilotError("INVALID_INPUT"),
  );
});

test("onboarding rejects mismatched, non-role, wildcard, and placeholder identities", () => {
  const invalidInputs = [
    { ...validOnboarding, awsAccountId: "210987654321" },
    { ...validOnboarding, partition: "aws-cn" },
    { ...validOnboarding, roleArn: "arn:aws:iam::123456789012:user/operator" },
    { ...validOnboarding, roleArn: "arn:aws:iam::123456789012:role/*" },
    { ...validOnboarding, roleArn: ` ${validOnboarding.roleArn}` },
    {
      ...validOnboarding,
      awsAccountId: "000000000000",
      roleArn: "arn:aws:iam::000000000000:role/mspcmdb/SutraReadRole",
    },
    { ...validOnboarding, enabledRegions: ["cn-north-1"] },
    { ...validOnboarding, enabledRegions: ["us-east-1", "us-east-1"] },
  ];

  for (const input of invalidInputs) {
    assert.throws(() => parseAwsOnboardingInput(input), isPilotError("INVALID_INPUT"));
  }
});

test("onboarding boundary rejects client scope, ExternalId, credentials, and policy controls", () => {
  const forbidden = [
    { externalId: "sutra_client_chosen_value" },
    { orgId: "org-attacker" },
    { customerId: "customer-attacker" },
    { status: "active" },
    { permissionPackVersion: "admin-v1" },
    { awsAccessKeyId: "AKIAEXAMPLE" },
    { awsSecretAccessKey: "not-a-real-key" },
    { sessionToken: "not-a-real-session" },
  ];

  for (const extra of forbidden) {
    assert.throws(
      () => parseAwsOnboardingInput({ ...validOnboarding, ...extra }),
      isPilotError("INVALID_INPUT"),
    );
  }
});

test("trusted scope is still strictly validated and cannot be inherited from prototypes", () => {
  assert.deepEqual(parsePilotScope(validScope), validScope);
  assert.throws(
    () => parsePilotScope({ ...validScope, orgId: "../other-org" }),
    isPilotError("INVALID_INPUT"),
  );

  const inherited = Object.create(validScope) as Record<string, unknown>;
  assert.throws(() => parsePilotScope(inherited), isPilotError("INVALID_INPUT"));
  assert.throws(
    () => parsePilotScope({ ...validScope, tenantId: "browser-supplied" }),
    isPilotError("INVALID_INPUT"),
  );
});

test("sync boundary accepts opaque IDs only and rejects trust material", () => {
  assert.deepEqual(
    parsePilotSyncRequest({ connectionId: "conn-01", idempotencyKey: "sync-2026-07-15T1200" }),
    { connectionId: "conn-01", idempotencyKey: "sync-2026-07-15T1200" },
  );

  for (const extra of [
    { roleArn: validOnboarding.roleArn },
    { externalId: "sutra_not_allowed" },
    { credentials: { accessKeyId: "AKIAEXAMPLE" } },
    { customerId: "customer-attacker" },
  ]) {
    assert.throws(
      () =>
        parsePilotSyncRequest({
          connectionId: "conn-01",
          idempotencyKey: "sync-01",
          ...extra,
        }),
      isPilotError("INVALID_INPUT"),
    );
  }
});

test("sync summaries and failures use bounded allowlisted persistence shapes", () => {
  assert.deepEqual(
    parsePilotSyncSummary({
      coverage: "partial",
      resourcesObserved: 12,
      findingsObserved: 3,
    }),
    { coverage: "partial", resourcesObserved: 12, findingsObserved: 3 },
  );
  assert.throws(
    () =>
      parsePilotSyncSummary({
        coverage: "complete",
        resourcesObserved: Number.MAX_SAFE_INTEGER,
        findingsObserved: 0,
      }),
    isPilotError("INVALID_INPUT"),
  );
  assert.deepEqual(parseSafePilotFailure({ code: "THROTTLED" }), { code: "THROTTLED" });

  const rawProviderSecret = "provider-error-with-session-token";
  assert.throws(
    () => parseSafePilotFailure({ code: "THROTTLED", message: rawProviderSecret }),
    (error) =>
      error instanceof PilotSecurityError &&
      error.code === "INVALID_INPUT" &&
      !error.message.includes(rawProviderSecret),
  );
  assert.throws(
    () => parseSafePilotFailure({ code: "AccessDeniedException: verbose AWS payload" }),
    isPilotError("INVALID_INPUT"),
  );
});

test("connection and sync state machines reject stale or terminal transitions", () => {
  for (const [from, to] of [
    ["pending", "validating"],
    ["validating", "active"],
    ["validating", "needs_attention"],
    ["active", "disabled"],
    ["needs_attention", "validating"],
  ] as const) {
    assert.doesNotThrow(() => assertConnectionTransition(from, to));
  }
  for (const [from, to] of [
    ["pending", "active"],
    ["active", "pending"],
    ["disabled", "active"],
    ["validating", "pending"],
  ] as const) {
    assert.throws(() => assertConnectionTransition(from, to), isPilotError("INVALID_STATE"));
  }

  for (const [from, to] of [
    ["queued", "running"],
    ["queued", "failed"],
    ["running", "partial"],
    ["running", "succeeded"],
    ["running", "failed"],
  ] as const) {
    assert.doesNotThrow(() => assertSyncTransition(from, to));
  }
  for (const [from, to] of [
    ["queued", "succeeded"],
    ["partial", "succeeded"],
    ["failed", "running"],
    ["succeeded", "running"],
  ] as const) {
    assert.throws(() => assertSyncTransition(from, to), isPilotError("INVALID_STATE"));
  }
});

test("only complete successful syncs can retire resources or advance freshness", () => {
  assert.equal(mayRetireUnseenResources("succeeded", "complete"), true);
  assert.equal(mayAdvanceSuccessfulSync("succeeded", "complete"), true);

  for (const [status, coverage] of [
    ["partial", "partial"],
    ["failed", "unknown"],
    ["cancelled", "unknown"],
    ["running", "complete"],
    ["succeeded", "partial"],
  ] as const) {
    assert.equal(mayRetireUnseenResources(status, coverage), false);
    assert.equal(mayAdvanceSuccessfulSync(status, coverage), false);
  }
});

test("ExternalIds are server-generated with 192 bits of randomness", () => {
  const first = generateExternalId();
  const second = generateExternalId();
  assert.match(first, /^sutra_[A-Za-z0-9_-]{32}$/);
  assert.match(second, /^sutra_[A-Za-z0-9_-]{32}$/);
  assert.notEqual(first, second);
});

test("AES-GCM encryption hides ExternalId and binds it to tenant scope", async () => {
  const keyring = await AesGcmSecretKeyring.fromRawKeys({
    currentKeyVersion: "local-v1",
    keys: { "local-v1": new Uint8Array(32).fill(7) },
  });
  const context: SecretContext = {
    orgId: validScope.orgId,
    customerId: validScope.customerId,
    connectionId: "conn-01",
  };
  const externalId = generateExternalId();

  const first = await keyring.seal(externalId, context);
  const second = await keyring.seal(externalId, context);
  assert.equal(first.keyVersion, "local-v1");
  assert.match(first.ciphertext, /^aesgcm1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(first.ciphertext.includes(externalId), false);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(await keyring.open(first, context), externalId);

  await assert.rejects(
    keyring.open(first, { ...context, customerId: "customer-02" }),
    isPilotError("SECRET_UNAVAILABLE"),
  );
  await assert.rejects(
    keyring.open({ ...first, keyVersion: "retired-v0" }, context),
    isPilotError("SECRET_UNAVAILABLE"),
  );

  const last = first.ciphertext.at(-1);
  assert.ok(last);
  const tampered = `${first.ciphertext.slice(0, -1)}${last === "A" ? "B" : "A"}`;
  await assert.rejects(
    keyring.open({ ...first, ciphertext: tampered }, context),
    isPilotError("SECRET_UNAVAILABLE"),
  );
});

test("single-key helpers accept a 32-byte base64 key and keep context binding", async () => {
  let binaryKey = "";
  for (const byte of new Uint8Array(32).fill(11)) {
    binaryKey += String.fromCharCode(byte);
  }
  const configuredKey = btoa(binaryKey);
  const context: SecretContext = {
    orgId: validScope.orgId,
    customerId: validScope.customerId,
    connectionId: "conn-api-01",
  };
  const externalId = generateExternalId();
  const encrypted = await encryptExternalId(externalId, configuredKey, "pilot-v1", context);

  assert.equal(encrypted.ciphertext.includes(externalId), false);
  assert.equal(await decryptExternalId(encrypted, configuredKey, context), externalId);
  await assert.rejects(
    decryptExternalId(encrypted, configuredKey, { ...context, orgId: "org-02" }),
    isPilotError("SECRET_UNAVAILABLE"),
  );
  await assert.rejects(
    encryptExternalId(externalId, btoa("short-key"), "pilot-v1", context),
    isPilotError("SECRET_UNAVAILABLE"),
  );
});

test("same-origin boundary rejects absent, cross-site, and malformed origins", () => {
  const request = new Request("https://sutra.example/api/pilot/onboard", {
    method: "POST",
    headers: {
      origin: "https://sutra.example",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.doesNotThrow(() => assertSameOrigin(request));
  assert.doesNotThrow(() => assertSameOrigin(request, "https://sutra.example"));

  const invalidHeaderCases: Array<Record<string, string>> = [
    {},
    { origin: "https://attacker.example" },
    { origin: "null" },
    { origin: "https://sutra.example/path" },
    { origin: "https://sutra.example", "sec-fetch-site": "cross-site" },
  ];
  for (const headers of invalidHeaderCases) {
    assert.throws(
      () =>
        assertSameOrigin(
          new Request("https://sutra.example/api/pilot/onboard", {
            method: "POST",
            headers,
          }),
        ),
      isPilotError("INVALID_INPUT"),
    );
  }
});

test("bounded JSON reader checks content type, declared size, and streamed size", async () => {
  const parsed = await readBoundedJson(
    new Request("https://sutra.example/api/pilot/onboard", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ account: "123456789012" }),
    }),
    128,
  );
  assert.deepEqual(parsed, { account: "123456789012" });

  await assert.rejects(
    readBoundedJson(
      new Request("https://sutra.example/api/pilot/onboard", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
    ),
    isPilotError("INVALID_INPUT"),
  );
  await assert.rejects(
    readBoundedJson(
      new Request("https://sutra.example/api/pilot/onboard", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "999" },
        body: "{}",
      }),
      16,
    ),
    isPilotError("INVALID_INPUT"),
  );
  await assert.rejects(
    readBoundedJson(
      new Request("https://sutra.example/api/pilot/onboard", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "1" },
        body: JSON.stringify({ oversized: "x".repeat(64) }),
      }),
      32,
    ),
    isPilotError("INVALID_INPUT"),
  );
  await assert.rejects(
    readBoundedJson(
      new Request("https://sutra.example/api/pilot/onboard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json}",
      }),
    ),
    isPilotError("INVALID_INPUT"),
  );
});
