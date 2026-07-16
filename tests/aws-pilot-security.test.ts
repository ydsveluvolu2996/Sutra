import assert from "node:assert/strict";
import test from "node:test";

import {
  AesGcmSecretKeyring,
  PilotSecurityError,
  assertOffboardAccountConfirmation,
  assertConnectionTransition,
  assertSameOrigin,
  assertSyncTransition,
  decryptExternalId,
  deriveLocalAwsConnectionIdentity,
  encryptExternalId,
  generateExternalId,
  mayAdvanceSuccessfulSync,
  mayRetireUnseenResources,
  parseAwsAccountId,
  parseAwsConnectionDraftRequest,
  parseAwsOnboardingInput,
  parseAwsPartition,
  parseIamRoleArn,
  parseOffboardConnectionRequest,
  parsePilotScope,
  parsePilotSyncRequest,
  parsePilotSyncSummary,
  parseRegions,
  parseSafePilotFailure,
  readBoundedJson,
  type SecretContext,
} from "../lib/aws-pilot-security.ts";
import {
  applyControlPlaneLifecycleThenReconcileCollector,
  commitRoleThenRegisterCollector,
} from "../lib/local-aws-lifecycle.ts";
import { withLocalOnboardingAccountLock } from "../lib/local-onboarding-lock.ts";

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

test("initial connection route boundary requires an opaque retry operation and canonicalizes evidence", () => {
  const request = {
    operationId: `onb_${"a".repeat(32)}`,
    customerName: "  Pilot   Customer  ",
    awsAccountId: "123456789012",
    partition: "aws",
    enabledRegions: ["us-west-2", "us-east-1"],
  };
  assert.deepEqual(parseAwsConnectionDraftRequest(request), {
    ...request,
    customerName: "Pilot Customer",
    enabledRegions: ["us-east-1", "us-west-2"],
  });

  for (const invalid of [
    { ...request, operationId: crypto.randomUUID() },
    { ...request, operationId: `onb_${"A".repeat(32)}` },
    { ...request, operationId: `onb_${"a".repeat(31)}` },
    { ...request, externalId: "client-controlled" },
    { ...request, customerId: "cust_attacker" },
    { ...request, roleArn: validOnboarding.roleArn },
    { ...request, enabledRegions: [] },
  ]) {
    assert.throws(
      () => parseAwsConnectionDraftRequest(invalid),
      isPilotError("INVALID_INPUT"),
    );
  }
});

test("local one-account identity is stable and partition-bound", async () => {
  const first = await deriveLocalAwsConnectionIdentity("123456789012", "aws");
  const replay = await deriveLocalAwsConnectionIdentity("123456789012", "aws");
  const otherPartition = await deriveLocalAwsConnectionIdentity("123456789012", "aws-us-gov");
  const otherAccount = await deriveLocalAwsConnectionIdentity("210987654321", "aws");
  assert.deepEqual(replay, first);
  assert.match(first.customerId, /^cust_[a-f0-9]{32}$/u);
  assert.match(first.connectionId, /^conn_[a-f0-9]{32}$/u);
  assert.notDeepEqual(otherPartition, first);
  assert.notDeepEqual(otherAccount, first);
});

test("local onboarding handoff and role registration serialize per AWS account", async () => {
  const events: string[] = [];
  let releaseFirst = (): void => undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = withLocalOnboardingAccountLock("aws", "123456789012", async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
  });
  const second = withLocalOnboardingAccountLock("aws", "123456789012", async () => {
    events.push("second-start");
    events.push("second-end");
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);
});

test("offboarding requires an exact server-validated account confirmation shape", () => {
  const connectionId = `conn_${"a".repeat(32)}`;
  assert.deepEqual(
    parseOffboardConnectionRequest({ connectionId, awsAccountId: "123456789012" }),
    { connectionId, awsAccountId: "123456789012" },
  );
  for (const invalid of [
    { connectionId },
    { connectionId, awsAccountId: "12345678901" },
    { connectionId, awsAccountId: "123456789012", confirmed: true },
    { connectionId: `conn_${"A".repeat(32)}`, awsAccountId: "123456789012" },
  ]) {
    assert.throws(() => parseOffboardConnectionRequest(invalid), isPilotError("INVALID_INPUT"));
  }
  assert.doesNotThrow(() => assertOffboardAccountConfirmation("123456789012", "123456789012"));
  assert.throws(
    () => assertOffboardAccountConfirmation("210987654321", "123456789012"),
    isPilotError("INVALID_INPUT"),
  );
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
    ["active", "pending"],
    ["active", "disabled"],
    ["needs_attention", "pending"],
    ["needs_attention", "validating"],
  ] as const) {
    assert.doesNotThrow(() => assertConnectionTransition(from, to));
  }
  for (const [from, to] of [
    ["pending", "active"],
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

test("lifecycle changes become authoritative before best-effort collector cleanup", async () => {
  const events: string[] = [];
  const completed = await applyControlPlaneLifecycleThenReconcileCollector({
    transitionControlPlane: async () => {
      events.push("control-plane");
      return { status: "disabled" as const };
    },
    reconcileCollector: async () => {
      events.push("collector");
    },
  });
  assert.deepEqual(events, ["control-plane", "collector"]);
  assert.deepEqual(completed, {
    connection: { status: "disabled" },
    collectorCleanup: "completed",
  });
});

test("role registration keeps the durable pending role when collector reconciliation fails", async () => {
  const events: string[] = [];
  let durableRole: string | null = null;
  await assert.rejects(
    commitRoleThenRegisterCollector({
      commitControlPlaneRole: async () => {
        events.push("control-plane-role");
        durableRole = "arn:aws:iam::123456789012:role/sutra/SutraReadOnlyRole";
        return { status: "pending" as const, roleArn: durableRole };
      },
      registerCollector: async () => {
        events.push("collector-register");
        throw new Error("collector unavailable");
      },
    }),
    /collector unavailable/u,
  );
  assert.deepEqual(events, ["control-plane-role", "collector-register"]);
  assert.equal(durableRole, "arn:aws:iam::123456789012:role/sutra/SutraReadOnlyRole");

  let collectorCalled = false;
  await assert.rejects(
    commitRoleThenRegisterCollector({
      commitControlPlaneRole: async () => { throw new Error("database unavailable"); },
      registerCollector: async () => { collectorCalled = true; },
    }),
    /database unavailable/u,
  );
  assert.equal(collectorCalled, false);
});

test("collector lifecycle cleanup is safe to retry after an unavailable collector", async () => {
  let transitions = 0;
  let cleanupAttempts = 0;
  const transitionControlPlane = async () => {
    transitions += 1;
    return { status: "disabled" as const };
  };
  const reconcileCollector = async () => {
    cleanupAttempts += 1;
    if (cleanupAttempts === 1) throw new Error("sensitive collector detail");
  };

  const pending = await applyControlPlaneLifecycleThenReconcileCollector({
    transitionControlPlane,
    reconcileCollector,
  });
  assert.deepEqual(pending, {
    connection: { status: "disabled" },
    collectorCleanup: "pending",
  });
  assert.doesNotMatch(JSON.stringify(pending), /sensitive collector detail/u);

  const retried = await applyControlPlaneLifecycleThenReconcileCollector({
    transitionControlPlane,
    reconcileCollector,
  });
  assert.equal(retried.collectorCleanup, "completed");
  assert.equal(transitions, 2);
  assert.equal(cleanupAttempts, 2);
});

test("failed control-plane lifecycle transitions never mutate collector state", async () => {
  let collectorCalled = false;
  await assert.rejects(
    applyControlPlaneLifecycleThenReconcileCollector({
      transitionControlPlane: async () => {
        throw new Error("active inventory");
      },
      reconcileCollector: async () => {
        collectorCalled = true;
      },
    }),
    /active inventory/u,
  );
  assert.equal(collectorCalled, false);
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
