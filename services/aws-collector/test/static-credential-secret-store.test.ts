import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  EncryptedFileConnectionRegistry,
  RegistryIntegrityError,
  RegistryStateError,
  parsePersistedConnection,
} from "../src/local-registry.js";
import {
  AwsStaticCredentialSecretStore,
  StaticCredentialSecretStoreError,
  type StaticCredentialSecretApi,
} from "../src/static-credential-secret-store.js";

const ACCESS_KEY_ID = `AKIA${"ABCDEFGHIJKLMNOP"}`;
const ROTATED_ACCESS_KEY_ID = `AKIA${"QRSTUVWXYZABCDEF"}`;
const SECRET_ACCESS_KEY = "abcdefghijklmnopqrstuvwxyzABCDEF12345678";
const ROTATED_SECRET_ACCESS_KEY = "1234567890abcdefghijklmnopqrstuvwxyzABCD";
const SCOPE = {
  tenantId: "org_local_sutra",
  connectionId: "conn_cccccccccccccccccccccccccccccccc",
  expectedAccountId: "123456789012",
  partition: "aws" as const,
};

interface MemoryVersion {
  secretString: string;
  stages: Set<string>;
}

class MemorySecretApi implements StaticCredentialSecretApi {
  public readonly createInputs: Array<{
    name: string;
    description: string;
    clientRequestToken: string;
    secretString: string;
  }> = [];
  public readonly putInputs: Array<{ secretId: string; versionId: string; stages: readonly string[] }> = [];
  public readonly versions = new Map<string, MemoryVersion>();
  public arn: string | null = null;
  public missing = false;
  public deleted = false;
  public deletionWindow: number | null = null;

  public async create(input: {
    readonly name: string;
    readonly description: string;
    readonly clientRequestToken: string;
    readonly secretString: string;
  }): Promise<{ readonly arn: string; readonly versionId: string }> {
    this.createInputs.push(input);
    if (this.arn !== null) throw Object.assign(new Error("exists"), { name: "ResourceExistsException" });
    this.arn = `arn:aws:secretsmanager:ap-south-1:738663485493:secret:${input.name}-Ab12Cd`;
    this.versions.set(input.clientRequestToken, {
      secretString: input.secretString,
      stages: new Set(["AWSCURRENT"]),
    });
    return { arn: this.arn, versionId: input.clientRequestToken };
  }

  public async put(input: {
    readonly secretId: string;
    readonly clientRequestToken: string;
    readonly secretString: string;
    readonly versionStages: readonly string[];
  }): Promise<{ readonly arn: string; readonly versionId: string }> {
    assert.equal(input.secretId, this.arn);
    const existing = this.versions.get(input.clientRequestToken);
    if (existing !== undefined && existing.secretString !== input.secretString) {
      throw new Error("idempotency conflict");
    }
    if (existing !== undefined) {
      this.putInputs.push({
        secretId: input.secretId,
        versionId: input.clientRequestToken,
        stages: input.versionStages,
      });
      return { arn: input.secretId, versionId: input.clientRequestToken };
    }
    for (const stage of input.versionStages) {
      for (const version of this.versions.values()) version.stages.delete(stage);
    }
    this.versions.set(input.clientRequestToken, {
      secretString: input.secretString,
      stages: new Set(input.versionStages),
    });
    this.putInputs.push({
      secretId: input.secretId,
      versionId: input.clientRequestToken,
      stages: input.versionStages,
    });
    return { arn: input.secretId, versionId: input.clientRequestToken };
  }

  public async describe(secretId: string) {
    assert.equal(secretId === this.arn || secretId.startsWith("sutra/"), true);
    if (this.missing || this.arn === null) {
      throw Object.assign(new Error("missing"), { name: "ResourceNotFoundException" });
    }
    return {
      arn: this.arn,
      versionStages: Object.fromEntries(
        [...this.versions].map(([versionId, version]) => [versionId, [...version.stages]]),
      ),
      deleted: this.deleted,
    };
  }

  public async get(input: {
    readonly secretId: string;
    readonly versionId: string;
    readonly versionStage?: string;
  }) {
    assert.equal(input.secretId, this.arn);
    const version = this.versions.get(input.versionId);
    if (version === undefined
      || (input.versionStage !== undefined && !version.stages.has(input.versionStage))) {
      throw Object.assign(new Error("missing"), { name: "ResourceNotFoundException" });
    }
    return {
      arn: input.secretId,
      versionId: input.versionId,
      versionStages: [...version.stages],
      secretString: version.secretString,
    };
  }

  public async moveStage(input: {
    readonly secretId: string;
    readonly stage: string;
    readonly moveToVersionId?: string;
    readonly removeFromVersionId?: string;
  }): Promise<void> {
    assert.equal(input.secretId, this.arn);
    if (input.removeFromVersionId !== undefined) {
      this.versions.get(input.removeFromVersionId)?.stages.delete(input.stage);
    }
    if (input.moveToVersionId !== undefined) {
      const target = this.versions.get(input.moveToVersionId);
      if (target === undefined) throw new Error("missing target version");
      for (const version of this.versions.values()) version.stages.delete(input.stage);
      target.stages.add(input.stage);
    }
  }

  public async scheduleDeletion(secretId: string, recoveryWindowInDays: number): Promise<void> {
    assert.equal(secretId, this.arn);
    this.deleted = true;
    this.deletionWindow = recoveryWindowInDays;
  }
}

function store(api: MemorySecretApi): AwsStaticCredentialSecretStore {
  return new AwsStaticCredentialSecretStore({
    accountId: "738663485493",
    region: "ap-south-1",
    api,
  });
}

async function stageSecret(
  secrets: AwsStaticCredentialSecretStore,
  credentials: { readonly accessKeyId: string; readonly secretAccessKey: string },
  existingSecretArn?: string,
) {
  const prepared = await secrets.prepare(SCOPE, credentials, existingSecretArn);
  return await secrets.stagePrepared(SCOPE, credentials, prepared);
}

function staticRegistration(
  accessKeyId = ACCESS_KEY_ID,
  secretAccessKey = SECRET_ACCESS_KEY,
) {
  return {
    ...SCOPE,
    roleArn: "",
    externalId: "",
    enabledRegions: ["us-east-1"],
    sessionNamePrefix: "sutra-",
    credentialKind: "static_credentials" as const,
    staticCredentials: { accessKeyId, secretAccessKey },
  };
}

test("initial static credentials are AWSPENDING until exact-version promotion", async () => {
  const api = new MemorySecretApi();
  const secrets = store(api);
  const reference = await stageSecret(secrets, {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  });

  assert.equal(api.createInputs.length, 1);
  assert.equal(api.createInputs[0]?.secretString.includes(ACCESS_KEY_ID), false);
  assert.equal(api.createInputs[0]?.secretString.includes(SECRET_ACCESS_KEY), false);
  assert.equal(api.putInputs.length, 1);
  assert.deepEqual(api.putInputs[0]?.stages, ["SUTRAPENDING"]);
  assert.equal(api.versions.get(reference.versionId)?.stages.has("AWSCURRENT"), false);
  const currentBeforeVerification = [...api.versions.values()]
    .find((version) => version.stages.has("AWSCURRENT"));
  assert.ok(currentBeforeVerification);
  assert.equal(currentBeforeVerification.secretString.includes(ACCESS_KEY_ID), false);
  assert.equal(currentBeforeVerification.secretString.includes(SECRET_ACCESS_KEY), false);
  assert.equal(reference.accessKeyLast4, "MNOP");
  assert.deepEqual(await secrets.read(SCOPE, reference, "candidate"), {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  });
  await assert.rejects(
    secrets.read({ ...SCOPE, tenantId: "org_other" }, reference, "candidate"),
    StaticCredentialSecretStoreError,
  );

  await secrets.promote(SCOPE, reference);
  assert.equal(api.versions.get(reference.versionId)?.stages.has("AWSCURRENT"), true);
  assert.equal(api.versions.get(reference.versionId)?.stages.has("SUTRAPENDING"), false);
  assert.equal((await secrets.read(SCOPE, reference, "active")).accessKeyId, ACCESS_KEY_ID);
});

test("failed rotation discards only the candidate and preserves AWSCURRENT", async () => {
  const api = new MemorySecretApi();
  const secrets = store(api);
  const active = await stageSecret(secrets, {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  });
  await secrets.promote(SCOPE, active);

  const candidate = await stageSecret(secrets, {
    accessKeyId: ROTATED_ACCESS_KEY_ID,
    secretAccessKey: ROTATED_SECRET_ACCESS_KEY,
  }, active.secretArn);
  assert.equal(api.versions.get(active.versionId)?.stages.has("AWSCURRENT"), true);
  assert.equal(api.versions.get(candidate.versionId)?.stages.has("SUTRAPENDING"), true);

  await secrets.discard(SCOPE, candidate, active);
  assert.equal(api.versions.get(active.versionId)?.stages.has("AWSCURRENT"), true);
  assert.equal(api.versions.get(candidate.versionId)?.stages.size, 0);
  assert.equal((await secrets.read(SCOPE, active, "active")).accessKeyId, ACCESS_KEY_ID);
});

test("offboarding schedules the exact secret with a seven-day recovery window", async () => {
  const api = new MemorySecretApi();
  const secrets = store(api);
  const reference = await stageSecret(secrets, {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  });
  await secrets.promote(SCOPE, reference);
  await secrets.destroy(SCOPE, reference);
  assert.equal(api.deleted, true);
  assert.equal(api.deletionWindow, 7);
});

test("scope-only offboarding deletes an orphaned initial secret and tombstones the connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-static-orphan-cleanup-"));
  const api = new MemorySecretApi();
  const secrets = store(api);
  const registry = new EncryptedFileConnectionRegistry({
    filePath: join(directory, "connections.enc.json"),
    encryptionKey: randomBytes(32).toString("base64"),
    staticCredentialSecretStore: secrets,
  });
  const registration = {
    ...SCOPE,
    roleArn: "",
    externalId: "",
    enabledRegions: ["us-east-1"],
    sessionNamePrefix: "sutra-",
    credentialKind: "static_credentials" as const,
    staticCredentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
  };
  try {
    // Model a crash after PutSecretValue but before the encrypted registry
    // commits its reference.
    await stageSecret(secrets, registration.staticCredentials);
    await registry.offboard({ tenantId: SCOPE.tenantId }, SCOPE.connectionId);
    assert.equal(api.deleted, true);
    assert.equal(api.deletionWindow, 7);
    await assert.rejects(registry.upsert(registration), RegistryStateError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing Secrets Manager state still permits a durable offboard tombstone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-static-missing-secret-"));
  const api = new MemorySecretApi();
  const secrets = store(api);
  const registry = new EncryptedFileConnectionRegistry({
    filePath: join(directory, "connections.enc.json"),
    encryptionKey: randomBytes(32).toString("base64"),
    staticCredentialSecretStore: secrets,
  });
  const registration = {
    ...SCOPE,
    roleArn: "",
    externalId: "",
    enabledRegions: ["us-east-1"],
    sessionNamePrefix: "sutra-",
    credentialKind: "static_credentials" as const,
    staticCredentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
  };
  try {
    await registry.upsert(registration);
    api.missing = true;
    await registry.offboard({ tenantId: SCOPE.tenantId }, SCOPE.connectionId);
    await assert.rejects(registry.upsert(registration), RegistryStateError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an identical failed initial credential can regain its pending stage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-static-initial-retry-"));
  const api = new MemorySecretApi();
  const secrets = store(api);
  const registry = new EncryptedFileConnectionRegistry({
    filePath: join(directory, "connections.enc.json"),
    encryptionKey: randomBytes(32).toString("base64"),
    staticCredentialSecretStore: secrets,
  });
  const registration = {
    ...SCOPE,
    roleArn: "",
    externalId: "",
    enabledRegions: ["us-east-1"],
    sessionNamePrefix: "sutra-",
    credentialKind: "static_credentials" as const,
    staticCredentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
  };
  const scope = { tenantId: SCOPE.tenantId };
  try {
    await registry.upsert(registration);
    const first = await registry.getStaticCredentialSecretReference(scope, SCOPE.connectionId);
    assert.ok(first);
    await registry.discardStagedOnboarding(scope, SCOPE.connectionId, "", first.versionId);
    assert.equal(api.versions.get(first.versionId)?.stages.size, 0);
    await registry.upsert(registration);
    const retry = await registry.getStaticCredentialSecretReference(scope, SCOPE.connectionId);
    assert.ok(retry);
    assert.equal(retry.versionId, first.versionId);
    assert.equal((await registry.getStaticCredentialCandidate(scope, SCOPE.connectionId))
      ?.staticCredentials?.accessKeyId, ACCESS_KEY_ID);
    assert.equal(api.versions.get(first.versionId)?.stages.has("SUTRAPENDING"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const faultPoint of ["beforeRename", "afterRename"] as const) {
  test(`initial credential write is retry-safe across ${faultPoint}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `sutra-static-${faultPoint}-`));
    const filePath = join(directory, "connections.enc.json");
    const encryptionKey = randomBytes(32).toString("base64");
    const api = new MemorySecretApi();
    const secrets = store(api);
    let injected = false;
    const faultingRegistry = new EncryptedFileConnectionRegistry({
      filePath,
      encryptionKey,
      staticCredentialSecretStore: secrets,
      testOnlyWriteFaultInjector(point) {
        if (!injected && point === faultPoint) {
          injected = true;
          throw new Error(`injected ${faultPoint} registry failure`);
        }
      },
    });
    const registration = staticRegistration();
    const scope = { tenantId: SCOPE.tenantId };
    try {
      await assert.rejects(
        faultingRegistry.upsert(registration),
        new RegExp(`injected ${faultPoint} registry failure`, "u"),
      );
      assert.equal(injected, true);
      assert.equal(api.putInputs.length, 0,
        "credential material must not be written before the registry reference is durable");
      assert.equal(api.deleted, false,
        "retry must not depend on restoring a secret scheduled for deletion");
      assert.equal(api.createInputs.length >= 1, true);
      assert.equal(api.createInputs[0]?.secretString.includes(ACCESS_KEY_ID), false);
      assert.equal(api.createInputs[0]?.secretString.includes(SECRET_ACCESS_KEY), false);

      const retryRegistry = new EncryptedFileConnectionRegistry({
        filePath,
        encryptionKey,
        staticCredentialSecretStore: secrets,
      });
      const referenceAfterFault = await retryRegistry.getStaticCredentialSecretReference(
        scope,
        SCOPE.connectionId,
      );
      if (faultPoint === "beforeRename") {
        assert.equal(referenceAfterFault, null,
          "a pre-rename failure must not publish the prepared pointer");
      } else {
        assert.ok(referenceAfterFault,
          "a post-rename failure may publish only the non-secret prepared pointer");
      }

      await retryRegistry.upsert(registration);
      const retryReference = await retryRegistry.getStaticCredentialSecretReference(
        scope,
        SCOPE.connectionId,
      );
      assert.ok(retryReference);
      if (referenceAfterFault !== null) assert.deepEqual(retryReference, referenceAfterFault);
      assert.equal(api.putInputs.length, 1);
      assert.equal(api.versions.get(retryReference.versionId)?.stages.has("SUTRAPENDING"), true);
      assert.equal((await retryRegistry.getStaticCredentialCandidate(scope, SCOPE.connectionId))
        ?.staticCredentials?.accessKeyId, ACCESS_KEY_ID);
      const encryptedRegistry = await readFile(filePath, "utf8");
      assert.equal(encryptedRegistry.includes(ACCESS_KEY_ID), false);
      assert.equal(encryptedRegistry.includes(SECRET_ACCESS_KEY), false);

      await retryRegistry.offboard(scope, SCOPE.connectionId);
      assert.equal(api.deleted, true);
      assert.equal(api.deletionWindow, 7);
      await assert.rejects(retryRegistry.upsert(registration), RegistryStateError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("registry rotation keeps the previous active version runnable until promotion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-static-secret-registry-"));
  const api = new MemorySecretApi();
  const secrets = store(api);
  const registry = new EncryptedFileConnectionRegistry({
    filePath: join(directory, "connections.enc.json"),
    encryptionKey: randomBytes(32).toString("base64"),
    staticCredentialSecretStore: secrets,
  });
  const registration = (accessKeyId: string, secretAccessKey: string) => ({
    ...SCOPE,
    roleArn: "",
    externalId: "",
    enabledRegions: ["us-east-1"],
    sessionNamePrefix: "sutra-",
    credentialKind: "static_credentials" as const,
    staticCredentials: { accessKeyId, secretAccessKey },
  });
  const scope = { tenantId: SCOPE.tenantId };
  try {
    await registry.upsert(registration(ACCESS_KEY_ID, SECRET_ACCESS_KEY));
    const initialCandidateReference = await registry.getStaticCredentialSecretReference(
      scope,
      SCOPE.connectionId,
    );
    assert.ok(initialCandidateReference);
    await registry.markStaticCredentialVerified(scope, SCOPE.connectionId, {
      connectionId: SCOPE.connectionId,
      accountId: SCOPE.expectedAccountId,
      partition: SCOPE.partition,
      callerIdentityArn: `arn:aws:iam::${SCOPE.expectedAccountId}:user/sutra-reader`,
      accessKeyLast4: ACCESS_KEY_ID.slice(-4),
      secretVersionId: initialCandidateReference.versionId,
    });
    await registry.activateOnboarding(
      scope,
      SCOPE.connectionId,
      "",
      initialCandidateReference.versionId,
    );
    const activeReference = await registry.getStaticCredentialSecretReference(
      scope,
      SCOPE.connectionId,
    );
    assert.equal((await registry.resolve(scope, SCOPE.connectionId))?.staticCredentials?.accessKeyId,
      ACCESS_KEY_ID);

    // Secrets Manager treats the same ClientRequestToken as an idempotent
    // replay. The store explicitly reattaches SUTRAPENDING to that exact
    // immutable version so an identical retry can be verified safely.
    await registry.upsert(registration(ACCESS_KEY_ID, SECRET_ACCESS_KEY));
    const replayReference = await registry.getStaticCredentialSecretReference(
      scope,
      SCOPE.connectionId,
    );
    assert.ok(replayReference);
    assert.equal((await registry.getStaticCredentialCandidate(scope, SCOPE.connectionId))
      ?.staticCredentials?.accessKeyId, ACCESS_KEY_ID);
    await registry.markStaticCredentialVerified(scope, SCOPE.connectionId, {
      connectionId: SCOPE.connectionId,
      accountId: SCOPE.expectedAccountId,
      partition: SCOPE.partition,
      callerIdentityArn: `arn:aws:iam::${SCOPE.expectedAccountId}:user/sutra-reader`,
      accessKeyLast4: ACCESS_KEY_ID.slice(-4),
      secretVersionId: replayReference.versionId,
    });
    await registry.activateOnboarding(
      scope,
      SCOPE.connectionId,
      "",
      replayReference.versionId,
    );

    await registry.upsert(registration(ROTATED_ACCESS_KEY_ID, ROTATED_SECRET_ACCESS_KEY));
    assert.equal((await registry.resolve(scope, SCOPE.connectionId))?.staticCredentials?.accessKeyId,
      ACCESS_KEY_ID, "rotation must leave the previous AWSCURRENT usable");
    assert.equal((await registry.getStaticCredentialCandidate(scope, SCOPE.connectionId))
      ?.staticCredentials?.accessKeyId, ROTATED_ACCESS_KEY_ID);
    const discardedReference = await registry.getStaticCredentialSecretReference(
      scope,
      SCOPE.connectionId,
    );
    assert.ok(discardedReference);
    await registry.discardStagedOnboarding(
      scope,
      SCOPE.connectionId,
      "",
      discardedReference.versionId,
    );
    assert.deepEqual(
      await registry.getStaticCredentialSecretReference(scope, SCOPE.connectionId),
      activeReference,
    );
    assert.equal((await registry.resolve(scope, SCOPE.connectionId))?.staticCredentials?.accessKeyId,
      ACCESS_KEY_ID);

    await registry.upsert(registration(ROTATED_ACCESS_KEY_ID, ROTATED_SECRET_ACCESS_KEY));
    const rotatedCandidateReference = await registry.getStaticCredentialSecretReference(
      scope,
      SCOPE.connectionId,
    );
    assert.ok(rotatedCandidateReference);
    const staleVersion = "f".repeat(64);
    await assert.rejects(
      registry.activateOnboarding(scope, SCOPE.connectionId, "", staleVersion),
      RegistryStateError,
    );
    await assert.rejects(
      registry.discardStagedOnboarding(scope, SCOPE.connectionId, "", staleVersion),
      RegistryStateError,
    );
    assert.equal((await registry.getStaticCredentialCandidate(scope, SCOPE.connectionId))
      ?.staticCredentials?.accessKeyId, ROTATED_ACCESS_KEY_ID);
    await registry.markStaticCredentialVerified(scope, SCOPE.connectionId, {
      connectionId: SCOPE.connectionId,
      accountId: SCOPE.expectedAccountId,
      partition: SCOPE.partition,
      callerIdentityArn: `arn:aws:iam::${SCOPE.expectedAccountId}:user/sutra-reader`,
      accessKeyLast4: ROTATED_ACCESS_KEY_ID.slice(-4),
      secretVersionId: rotatedCandidateReference.versionId,
    });
    await registry.activateOnboarding(
      scope,
      SCOPE.connectionId,
      "",
      rotatedCandidateReference.versionId,
    );
    assert.equal((await registry.resolve(scope, SCOPE.connectionId))?.staticCredentials?.accessKeyId,
      ROTATED_ACCESS_KEY_ID);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an ACTIVE registry record cannot point only at an unpromoted candidate", () => {
  assert.throws(() => parsePersistedConnection({
    tenantId: SCOPE.tenantId,
    connectionId: SCOPE.connectionId,
    expectedAccountId: SCOPE.expectedAccountId,
    partition: SCOPE.partition,
    roleArn: "",
    externalId: "",
    status: "ACTIVE",
    sessionNamePrefix: "sutra-",
    enabledRegions: ["us-east-1"],
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    permissionPackVersion: "standard-2026-07.4",
    credentialKind: "static_credentials",
    staticCredentialSecretState: {
      staged: {
        secretArn: `arn:aws:secretsmanager:ap-south-1:738663485493:secret:sutra/customer-aws-credentials/v1/${"a".repeat(64)}/${"b".repeat(64)}-Ab12Cd`,
        versionId: "c".repeat(64),
        accessKeyLast4: "MNOP",
      },
      stagedVerified: true,
    },
  }), RegistryIntegrityError);
});
