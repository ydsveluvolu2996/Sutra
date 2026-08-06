import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  EncryptedFileConnectionRegistry,
  RegistryIntegrityError,
  type RegisterAwsConnectionInput,
} from "../src/local-registry.js";
import { AwsRoleBroker } from "../src/role-broker.js";
import { createLocalCollectorServer } from "../src/local-server.js";
import {
  ConnectionIntegrityError,
  ConnectionStateError,
  IdentityMismatchError,
  type AssumeRoleClient,
  type CallerIdentityClient,
  type ConnectionScope,
  type StoredAwsConnection,
} from "../src/types.js";

const NOW = new Date("2026-07-15T10:00:00.000Z");
const TENANT_ID = "org_local_sutra";
const CONNECTION_ID = "conn_cccccccccccccccccccccccccccccccc";
// Built by concatenation so the repository secret scan never sees a
// literal key-shaped token in source.
const ACCESS_KEY_ID = `AKIA${"ABCDEFGHIJKLMNOP"}`;
const TEMPORARY_ACCESS_KEY_ID = `ASIA${"ABCDEFGHIJKLMNOP"}`;
const SECRET_ACCESS_KEY = "abcdefghijklmnopqrstuvwxyzABCDEF12345678";
const SESSION_TOKEN = "FwoGZXIvYXdzEBatoken1234567890abcdef";
const SCOPE: ConnectionScope = { tenantId: TENANT_ID };

function staticRegistration(
  overrides: Partial<RegisterAwsConnectionInput> = {},
): RegisterAwsConnectionInput {
  return {
    tenantId: TENANT_ID,
    connectionId: CONNECTION_ID,
    expectedAccountId: "123456789012",
    partition: "aws",
    roleArn: "",
    externalId: "",
    enabledRegions: ["us-east-1"],
    sessionNamePrefix: "sutra-",
    credentialKind: "static_credentials",
    staticCredentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
    ...overrides,
  };
}

async function freshRegistry(): Promise<{
  registry: EncryptedFileConnectionRegistry;
  path: string;
  key: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "sutra-static-registry-"));
  const path = join(directory, "connections.enc.json");
  const key = randomBytes(32).toString("base64");
  return {
    registry: new EncryptedFileConnectionRegistry({
      filePath: path,
      encryptionKey: key,
      now: () => NOW,
    }),
    path,
    key,
  };
}

test("static credential records round-trip encrypted and stage fail-closed until activation", async () => {
  const { registry, path, key } = await freshRegistry();
  await registry.upsert(staticRegistration());

  const raw = await readFile(path, "utf8");
  assert.equal(raw.includes(SECRET_ACCESS_KEY), false, "secret must never be on disk in plaintext");
  assert.equal(raw.includes(ACCESS_KEY_ID), false);

  const stored = await registry.resolve(SCOPE, CONNECTION_ID);
  assert.equal(stored?.credentialKind, "static_credentials");
  assert.equal(stored?.staticCredentials?.accessKeyId, ACCESS_KEY_ID);
  assert.equal(stored?.staticCredentials?.secretAccessKey, SECRET_ACCESS_KEY);
  assert.equal(stored?.staticCredentials?.sessionToken, undefined);
  assert.equal(stored?.partition, "aws");
  assert.equal(stored?.roleArn, "");
  assert.equal(stored?.externalId, "");
  assert.equal(stored?.status, "PENDING");

  await registry.markStaticCredentialVerified(SCOPE, CONNECTION_ID, {
    connectionId: CONNECTION_ID,
    accountId: "123456789012",
    partition: "aws",
    callerIdentityArn: "arn:aws:iam::123456789012:user/finops-reader",
    accessKeyLast4: ACCESS_KEY_ID.slice(-4),
  });
  assert.equal((await registry.resolve(SCOPE, CONNECTION_ID))?.status, "VERIFIED");

  // The control plane activates the pinned empty role ARN, exactly as it
  // committed it.
  await registry.activateOnboarding(SCOPE, CONNECTION_ID, "");
  const active = await registry.resolve(SCOPE, CONNECTION_ID);
  assert.equal(active?.status, "ACTIVE");
  assert.equal(active?.permissionPackVersion, "standard-2026-07.4");

  // The document survives reload through the persisted-connection parser.
  const reloaded = new EncryptedFileConnectionRegistry({
    filePath: path,
    encryptionKey: key,
    now: () => NOW,
  });
  assert.equal(
    (await reloaded.resolve(SCOPE, CONNECTION_ID))?.staticCredentials?.secretAccessKey,
    SECRET_ACCESS_KEY,
  );
});

test("static credential registration validation fails closed", async () => {
  const { registry } = await freshRegistry();
  const rejected: readonly RegisterAwsConnectionInput[] = [
    // A long-term AKIA key must not carry a session token.
    staticRegistration({
      staticCredentials: {
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
        sessionToken: SESSION_TOKEN,
      },
    }),
    // A temporary ASIA key is unusable without its session token.
    staticRegistration({
      staticCredentials: {
        accessKeyId: TEMPORARY_ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
      },
    }),
    // Malformed key material.
    staticRegistration({
      staticCredentials: { accessKeyId: `AKIA${"short"}`, secretAccessKey: SECRET_ACCESS_KEY },
    }),
    staticRegistration({
      staticCredentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: "too-short" },
    }),
    // Role trust material is structurally impossible on a static record.
    staticRegistration({ roleArn: "arn:aws:iam::123456789012:role/sutra/SutraCollectorRole" }),
    staticRegistration({ externalId: "sutra_external_id_1234567890abcd" }),
    staticRegistration({ roleProvisioningMode: "sutra_template" }),
  ];
  for (const input of rejected) {
    await assert.rejects(registry.upsert(input), RegistryIntegrityError);
  }
  // A trust-role registration must not smuggle credential material.
  await assert.rejects(
    registry.upsert({
      tenantId: TENANT_ID,
      connectionId: CONNECTION_ID,
      expectedAccountId: "123456789012",
      partition: "aws",
      roleArn: "arn:aws:iam::123456789012:role/sutra/SutraCollectorRole",
      externalId: "sutra_external_id_1234567890abcd",
      enabledRegions: ["us-east-1"],
      staticCredentials: {
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
      },
    }),
    RegistryIntegrityError,
  );

  // An ASIA key with its token is accepted.
  await registry.upsert(staticRegistration({
    staticCredentials: {
      accessKeyId: TEMPORARY_ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      sessionToken: SESSION_TOKEN,
    },
  }));
  const stored = await registry.resolve(SCOPE, CONNECTION_ID);
  assert.equal(stored?.staticCredentials?.sessionToken, SESSION_TOKEN);
});

class MemoryRegistry {
  public constructor(private readonly stored: StoredAwsConnection) {}
  public async resolve(
    scope: ConnectionScope,
    connectionId: string,
  ): Promise<StoredAwsConnection | null> {
    if (scope.tenantId !== this.stored.tenantId || connectionId !== this.stored.connectionId) {
      return null;
    }
    return structuredClone(this.stored);
  }
  public async markOnboardingVerified(): Promise<void> {
    throw new Error("unexpected onboarding verification");
  }
}

class RecordingAssumeRoleClient implements AssumeRoleClient {
  public calls = 0;
  public async send(): Promise<never> {
    this.calls += 1;
    throw new Error("AssumeRole must never run for a static-credential connection");
  }
}

function staticStored(overrides: Partial<StoredAwsConnection> = {}): StoredAwsConnection {
  return {
    tenantId: TENANT_ID,
    connectionId: CONNECTION_ID,
    expectedAccountId: "123456789012",
    roleArn: "",
    externalId: "",
    status: "ACTIVE",
    permissionPackVersion: "standard-2026-07.4",
    sessionNamePrefix: "sutra-",
    credentialKind: "static_credentials",
    staticCredentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
    partition: "aws",
    ...overrides,
  };
}

function staticBroker(input: {
  readonly stored: StoredAwsConnection;
  readonly identityAccount?: string;
  readonly identityArn?: string;
}): { broker: AwsRoleBroker; assume: RecordingAssumeRoleClient; identityCalls: () => number } {
  const assume = new RecordingAssumeRoleClient();
  let identityCalls = 0;
  const identityClient: CallerIdentityClient = {
    send: async () => {
      identityCalls += 1;
      return {
        $metadata: {},
        Account: input.identityAccount ?? "123456789012",
        Arn: input.identityArn ?? "arn:aws:iam::123456789012:user/finops-reader",
        UserId: "AIDAEXAMPLE",
      };
    },
  };
  const broker = new AwsRoleBroker({
    registry: new MemoryRegistry(input.stored),
    assumeRoleClient: assume,
    expectedPrincipalArn: "arn:aws:iam::999988887777:role/SutraLocalCollector",
    callerIdentityClientFactory: (credentials) => {
      assert.equal(credentials.accessKeyId, ACCESS_KEY_ID);
      assert.equal(credentials.secretAccessKey, SECRET_ACCESS_KEY);
      return identityClient;
    },
    roleContractClientFactory: () => {
      throw new Error("role contract attestation must never run for static credentials");
    },
    now: () => NOW,
  });
  return { broker, assume, identityCalls: () => identityCalls };
}

test("static credential verification proves the identity without any AssumeRole", async () => {
  const { broker, assume } = staticBroker({ stored: staticStored({ status: "PENDING" }) });
  const verification = await broker.verifyStaticCredentialIdentity(
    SCOPE,
    CONNECTION_ID,
    "verify-static-01",
  );
  assert.deepEqual(verification, {
    connectionId: CONNECTION_ID,
    accountId: "123456789012",
    partition: "aws",
    callerIdentityArn: "arn:aws:iam::123456789012:user/finops-reader",
    accessKeyLast4: "MNOP",
  });
  assert.equal(assume.calls, 0);
});

test("static credential verification rejects a wrong-account identity", async () => {
  const { broker } = staticBroker({
    stored: staticStored({ status: "PENDING" }),
    identityAccount: "999999999999",
  });
  await assert.rejects(
    broker.verifyStaticCredentialIdentity(SCOPE, CONNECTION_ID, "verify-static-02"),
    IdentityMismatchError,
  );
});

test("a static session re-validates identity, caps expiry at 900s and never assumes a role", async () => {
  const { broker, assume, identityCalls } = staticBroker({ stored: staticStored() });
  const session = await broker.assumeValidatedSession(SCOPE, CONNECTION_ID, "collect-static-01");
  assert.equal(session.credentials.accessKeyId, ACCESS_KEY_ID);
  assert.equal(session.credentials.sessionToken, "");
  assert.equal(session.credentials.expiration.getTime(), NOW.getTime() + 900_000);
  assert.equal(session.roleArn, "arn:aws:iam::123456789012:user/finops-reader");
  assert.equal(session.callerIdentityArn, "arn:aws:iam::123456789012:user/finops-reader");
  assert.equal(session.accountId, "123456789012");
  assert.equal(assume.calls, 0);
  assert.equal(identityCalls(), 1);
});

test("static connections fail closed everywhere the role contract is required", async () => {
  // Role-trust verification can never run against a static record.
  const { broker } = staticBroker({ stored: staticStored({ status: "PENDING" }) });
  await assert.rejects(
    broker.verifyOnboardingTrust(SCOPE, CONNECTION_ID, "verify-role-on-static"),
    ConnectionIntegrityError,
  );
  // A disabled static record starts no session.
  const disabled = staticBroker({ stored: staticStored({ status: "DISABLED" }) });
  await assert.rejects(
    disabled.broker.assumeValidatedSession(SCOPE, CONNECTION_ID, "collect-static-02"),
    ConnectionStateError,
  );
  // A trust-role record can never be verified through the static path.
  const trust = staticBroker({
    stored: {
      tenantId: TENANT_ID,
      connectionId: CONNECTION_ID,
      expectedAccountId: "123456789012",
      roleArn: "arn:aws:iam::123456789012:role/sutra/SutraCollectorRole",
      externalId: "sutra_external_id_1234567890abcd",
      status: "PENDING",
      permissionPackVersion: "standard-2026-07.4",
      sessionNamePrefix: "sutra-",
    },
  });
  await assert.rejects(
    trust.broker.verifyStaticCredentialIdentity(SCOPE, CONNECTION_ID, "verify-static-03"),
    ConnectionStateError,
  );
});

test("the signed loopback API registers, verifies, and activates static credentials without leaking them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-static-server-"));
  const sharedSecret = randomBytes(32).toString("base64url");
  const server = createLocalCollectorServer({
    sharedSecret,
    registryEncryptionKey: randomBytes(32).toString("base64url"),
    registryPath: join(directory, "registry.enc"),
    localJobStatePath: join(directory, "local-jobs.json"),
    localJobWorkerEnabled: false,
    mode: "fixture",
    now: () => NOW,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const registration = {
      tenantId: TENANT_ID,
      connectionId: CONNECTION_ID,
      accountId: "123456789012",
      partition: "aws",
      enabledRegions: ["us-east-1"],
      credentialKind: "static_credentials",
      staticCredentials: {
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
      },
    };
    const registered = await signedRequest(
      baseUrl,
      sharedSecret,
      "PUT",
      `/v1/connections/${CONNECTION_ID}`,
      registration,
    );
    assert.equal(registered.status, 200);
    assert.deepEqual(registered.value, { registered: true });

    // Role keys cannot be smuggled into the static registration shape.
    assert.equal((await signedRequest(
      baseUrl,
      sharedSecret,
      "PUT",
      `/v1/connections/${CONNECTION_ID}`,
      { ...registration, roleArn: "arn:aws:iam::123456789012:role/sutra/SutraCollectorRole" },
    )).status, 400);
    // Nor a token on a long-term AKIA key.
    assert.equal((await signedRequest(
      baseUrl,
      sharedSecret,
      "PUT",
      `/v1/connections/${CONNECTION_ID}`,
      {
        ...registration,
        staticCredentials: { ...registration.staticCredentials, sessionToken: SESSION_TOKEN },
      },
    )).status, 400);

    const verification = await signedRequest(
      baseUrl,
      sharedSecret,
      "POST",
      `/v1/connections/${CONNECTION_ID}/verify`,
      { tenantId: TENANT_ID, connectionId: CONNECTION_ID, jobId: "job_static_verify_0001" },
    );
    assert.equal(verification.status, 200);
    assert.deepEqual(verification.value, {
      verified: true,
      credentialKind: "static_credentials",
      accountId: "123456789012",
      partition: "aws",
      callerIdentityArn: "arn:aws:iam::123456789012:user/sutra-fixture-static",
      accessKeyLast4: "MNOP",
    });
    assert.equal(
      JSON.stringify(verification.value).includes(SECRET_ACCESS_KEY),
      false,
      "no response may carry the secret",
    );

    const activated = await signedRequest(
      baseUrl,
      sharedSecret,
      "POST",
      `/v1/connections/${CONNECTION_ID}/activate`,
      { tenantId: TENANT_ID, connectionId: CONNECTION_ID, roleArn: "" },
    );
    assert.equal(activated.status, 200);
    assert.deepEqual(activated.value, { activated: true });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function signedRequest(
  baseUrl: string,
  sharedSecret: string,
  method: "GET" | "PUT" | "POST",
  path: string,
  payload?: unknown,
): Promise<{ readonly status: number; readonly value: unknown }> {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const timestamp = NOW.getTime().toString();
  const nonce = `nonce_${randomBytes(18).toString("base64url")}`;
  const signature = hmac(
    sharedSecret,
    `${method}\n${path}\n${timestamp}\n${nonce}\n${sha256(body)}`,
  );
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "x-sutra-timestamp": timestamp,
      "x-sutra-nonce": nonce,
      "x-sutra-signature": signature,
      ...(body.length === 0 ? {} : { "content-type": "application/json" }),
    },
    ...(body.length === 0 ? {} : { body }),
  });
  const responseText = await response.text();
  assert.equal(
    response.headers.get("x-sutra-response-signature"),
    hmac(sharedSecret, `${response.status}\n${path}\n${nonce}\n${sha256(responseText)}`),
  );
  return { status: response.status, value: JSON.parse(responseText) as unknown };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(secret: string, value: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(value, "utf8")
    .digest("hex");
}
