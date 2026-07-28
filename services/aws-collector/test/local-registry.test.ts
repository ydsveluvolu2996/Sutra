import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  EncryptedFileConnectionRegistry,
  RegistryIntegrityError,
  RegistryStateError,
} from "../src/local-registry.js";

const NOW = new Date("2026-07-15T10:00:00.000Z");
const EXTERNAL_ID = "sutra_external_id_1234567890abcd";

test("registry stages verified trust until the control plane explicitly activates it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-registry-"));
  const path = join(directory, "connections.enc.json");
  const key = randomBytes(32).toString("base64");
  try {
    const registry = new EncryptedFileConnectionRegistry({
      filePath: path,
      encryptionKey: key,
      now: () => NOW,
    });
    await registry.upsert(connection("conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));

    const encrypted = await readFile(path, "utf8");
    assert.equal(encrypted.includes(EXTERNAL_ID), false);
    assert.equal(encrypted.includes("123456789012"), false);
    assert.equal((await stat(path)).mode & 0o777, 0o600);

    const scoped = await registry.resolve(
      { tenantId: "org_local_sutra" },
      "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert.equal(scoped?.externalId, EXTERNAL_ID);
    assert.equal(scoped?.status, "PENDING");
    assert.equal(scoped?.permissionPackVersion, "live-demo-2026-07.1");
    assert.equal(scoped?.roleProvisioningMode, "sutra_template");
    assert.equal(scoped?.expectedRolePath, "/sutra/");
    assert.equal(scoped?.expectedRoleName, "SutraReadOnlyRole");
    assert.equal(
      await registry.resolve(
        { tenantId: "org_other" },
        "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
      null,
    );

    const verification = {
      connectionId: "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      accountId: "123456789012",
      partition: "aws" as const,
      roleArn: "arn:aws:iam::123456789012:role/mspcmdb/SutraReadOnlyRole",
      callerIdentityArn:
        "arn:aws:sts::123456789012:assumed-role/SutraReadOnlyRole/sutra-fixture-test",
      roleSessionName: "sutra-fixture-test",
      missingExternalIdDenied: true as const,
      wrongExternalIdDenied: true as const,
      trustPolicyAttested: true as const,
      permissionPolicyAttested: true as const,
      sessionPolicyApplied: true as const,
      permissionPackVersion: "standard-2026-07.3" as const,
      capabilityAssessment: { grantedActions: [], missingActions: [] },
    };
    await registry.markOnboardingVerified(
      { tenantId: "org_local_sutra" },
      "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      verification,
    );
    assert.equal(
      (await registry.resolve(
        { tenantId: "org_local_sutra" },
        "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ))?.status,
      "VERIFIED",
    );
    assert.equal(
      (await registry.resolve(
        { tenantId: "org_local_sutra" },
        "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ))?.permissionPackVersion,
      "standard-2026-07.3",
    );
    await registry.activateOnboarding(
      { tenantId: "org_local_sutra" },
      "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      verification.roleArn,
    );
    assert.equal(
      (await registry.resolve(
        { tenantId: "org_local_sutra" },
        "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ))?.status,
      "ACTIVE",
    );

    // Explicit revalidation is idempotent for an unchanged active trust
    // contract; operators do not need to recreate the customer role after a
    // transient or partial inventory failure.
    await registry.markOnboardingVerified(
      { tenantId: "org_local_sutra" },
      "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      verification,
    );
    assert.equal(
      (await registry.resolve(
        { tenantId: "org_local_sutra" },
        "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ))?.status,
      "ACTIVE",
    );
    await registry.activateOnboarding(
      { tenantId: "org_local_sutra" },
      "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      verification.roleArn,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registry persists a customer-managed dedicated role contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-registry-custom-role-"));
  const path = join(directory, "connections.enc.json");
  const key = randomBytes(32).toString("base64");
  try {
    const connectionId = "conn_customroleaaaaaaaaaaaaaaaaaaaaa";
    const input = {
      ...connection(connectionId),
      roleArn: "arn:aws:iam::123456789012:role/sutra/acme/security/AcmeSutraEvidenceRole",
      roleProvisioningMode: "customer_managed" as const,
      expectedRolePath: "/sutra/acme/security/",
      expectedRoleName: "AcmeSutraEvidenceRole",
    };
    const first = new EncryptedFileConnectionRegistry({ filePath: path, encryptionKey: key });
    await first.upsert(input);

    const reopened = new EncryptedFileConnectionRegistry({ filePath: path, encryptionKey: key });
    const stored = await reopened.resolve({ tenantId: input.tenantId }, connectionId);
    assert.equal(stored?.roleProvisioningMode, "customer_managed");
    assert.equal(stored?.expectedRolePath, "/sutra/acme/security/");
    assert.equal(stored?.expectedRoleName, "AcmeSutraEvidenceRole");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy encrypted records decode as permission pack .1 until complete proof upgrades them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-registry-legacy-pack-"));
  const path = join(directory, "connections.enc.json");
  const keyBytes = randomBytes(32);
  const key = keyBytes.toString("base64");
  const connectionId = "conn_99999999999999999999999999999999";
  const legacy = {
    version: 2,
    connections: {
      [`org_local_sutra\u001f${connectionId}`]: {
        ...connection(connectionId),
        status: "ACTIVE",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    },
    tombstones: {},
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes, iv);
  cipher.setAAD(Buffer.from("sutra-local-registry:v1", "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(legacy), "utf8"),
    cipher.final(),
  ]);
  await writeFile(path, JSON.stringify({
    version: 1,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  }), { mode: 0o600 });

  try {
    const registry = new EncryptedFileConnectionRegistry({ filePath: path, encryptionKey: key });
    const resolved = await registry.resolve({ tenantId: "org_local_sutra" }, connectionId);
    assert.equal(resolved?.status, "ACTIVE");
    assert.equal(resolved?.permissionPackVersion, "live-demo-2026-07.1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v1 and v2 registry documents preserve the previous pack and migrate in place to v3", async () => {
  for (const documentVersion of [1, 2] as const) {
    const directory = await mkdtemp(join(tmpdir(), `sutra-registry-v${documentVersion}-upgrade-`));
    const path = join(directory, "connections.enc.json");
    const keyBytes = randomBytes(32);
    const key = keyBytes.toString("base64");
    const connectionId = `conn_${String(documentVersion).repeat(32)}`;
    const candidate = {
      ...connection(connectionId),
      roleArn: "arn:aws:iam::123456789012:role/sutra/SutraReadOnlyRole",
    };
    const persisted = {
      ...candidate,
      status: "ACTIVE",
      permissionPackVersion: "standard-2026-07",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    const document = documentVersion === 1
      ? {
          version: 1,
          connections: { [`org_local_sutra\u001f${connectionId}`]: persisted },
        }
      : {
          version: 2,
          connections: { [`org_local_sutra\u001f${connectionId}`]: persisted },
          tombstones: {},
        };
    await writeEncryptedDocument(path, keyBytes, document);

    try {
      const registry = new EncryptedFileConnectionRegistry({
        filePath: path,
        encryptionKey: key,
        now: () => NOW,
      });
      const before = await registry.resolve({ tenantId: candidate.tenantId }, connectionId);
      assert.equal(before?.status, "ACTIVE");
      assert.equal(before?.permissionPackVersion, "standard-2026-07");
      assert.equal(before?.roleProvisioningMode, "sutra_template");
      assert.equal(before?.expectedRolePath, "/sutra/");
      assert.equal(before?.expectedRoleName, "SutraReadOnlyRole");

      // Registration of the same contract must preserve the active previous
      // pack until a complete current-pack proof is committed.
      await registry.upsert(candidate);
      assert.equal(
        (await registry.resolve({ tenantId: candidate.tenantId }, connectionId))
          ?.permissionPackVersion,
        "standard-2026-07",
      );
      await registry.markOnboardingVerified(
        { tenantId: candidate.tenantId },
        connectionId,
        {
          connectionId,
          accountId: candidate.expectedAccountId,
          partition: candidate.partition,
          roleArn: candidate.roleArn,
          callerIdentityArn:
            "arn:aws:sts::123456789012:assumed-role/SutraReadOnlyRole/sutra-upgrade-test",
          roleSessionName: "sutra-upgrade-test",
          missingExternalIdDenied: true,
          wrongExternalIdDenied: true,
          trustPolicyAttested: true,
          permissionPolicyAttested: true,
          sessionPolicyApplied: true,
          permissionPackVersion: "standard-2026-07.3",
          capabilityAssessment: { grantedActions: [], missingActions: [] },
        },
      );
      const after = await registry.resolve({ tenantId: candidate.tenantId }, connectionId);
      assert.equal(after?.status, "ACTIVE");
      assert.equal(after?.permissionPackVersion, "standard-2026-07.3");

      const migrated = await readEncryptedDocument(path, keyBytes) as {
        version: number;
        connections: Record<string, { permissionPackVersion: string }>;
      };
      assert.equal(migrated.version, 3);
      assert.equal(
        migrated.connections[`org_local_sutra\u001f${connectionId}`]?.permissionPackVersion,
        "standard-2026-07.3",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("failed initial registration discards only staged material and remains retryable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-registry-compensation-"));
  const path = join(directory, "connections.enc.json");
  const connectionId = "conn_22222222222222222222222222222222";
  try {
    const registry = new EncryptedFileConnectionRegistry({
      filePath: path,
      encryptionKey: randomBytes(32).toString("base64"),
      now: () => NOW,
    });
    const candidate = connection(connectionId);
    await registry.upsert(candidate);
    await registry.discardStagedOnboarding(
      { tenantId: candidate.tenantId },
      connectionId,
      candidate.roleArn,
    );
    assert.equal(
      await registry.resolve({ tenantId: candidate.tenantId }, connectionId),
      null,
    );

    // Discard does not create the irreversible tombstone used by offboarding.
    await registry.upsert(candidate);
    assert.equal(
      (await registry.resolve({ tenantId: candidate.tenantId }, connectionId))?.status,
      "PENDING",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("staged activation is role-bound and cannot remove an active connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-registry-cas-"));
  const path = join(directory, "connections.enc.json");
  const connectionId = "conn_33333333333333333333333333333333";
  try {
    const registry = new EncryptedFileConnectionRegistry({
      filePath: path,
      encryptionKey: randomBytes(32).toString("base64"),
      now: () => NOW,
    });
    const candidate = connection(connectionId);
    await registry.upsert(candidate);
    await assert.rejects(
      registry.activateOnboarding(
        { tenantId: candidate.tenantId },
        connectionId,
        "arn:aws:iam::123456789012:role/sutra/AnotherRole",
      ),
      RegistryStateError,
    );
    await registry.discardStagedOnboarding(
      { tenantId: candidate.tenantId },
      connectionId,
      candidate.roleArn,
    );
    await registry.upsert(candidate);
    const verification = {
      connectionId,
      accountId: candidate.expectedAccountId,
      partition: candidate.partition,
      roleArn: candidate.roleArn,
      callerIdentityArn:
        "arn:aws:sts::123456789012:assumed-role/SutraReadOnlyRole/sutra-fixture-test",
      roleSessionName: "sutra-fixture-test",
      missingExternalIdDenied: true as const,
      wrongExternalIdDenied: true as const,
      trustPolicyAttested: true as const,
      permissionPolicyAttested: true as const,
      sessionPolicyApplied: true as const,
      permissionPackVersion: "standard-2026-07.3" as const,
      capabilityAssessment: { grantedActions: [], missingActions: [] },
    };
    await registry.markOnboardingVerified(
      { tenantId: candidate.tenantId },
      connectionId,
      verification,
    );
    await registry.activateOnboarding(
      { tenantId: candidate.tenantId },
      connectionId,
      candidate.roleArn,
    );
    await assert.rejects(
      registry.discardStagedOnboarding(
        { tenantId: candidate.tenantId },
        connectionId,
        candidate.roleArn,
      ),
      RegistryStateError,
    );
    assert.equal(
      (await registry.resolve({ tenantId: candidate.tenantId }, connectionId))?.status,
      "ACTIVE",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registry serializes concurrent writes without dropping connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-registry-"));
  const path = join(directory, "connections.enc.json");
  try {
    const registry = new EncryptedFileConnectionRegistry({
      filePath: path,
      encryptionKey: randomBytes(32).toString("base64"),
      now: () => NOW,
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        registry.upsert(connection(`conn_${index.toString(16).padStart(32, "0")}`)),
      ),
    );
    for (let index = 0; index < 12; index += 1) {
      const id = `conn_${index.toString(16).padStart(32, "0")}`;
      assert.equal(
        (await registry.resolve({ tenantId: "org_local_sutra" }, id))?.connectionId,
        id,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registry persists the strict all-enabled selection and rejects ambiguous scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-registry-regions-"));
  const path = join(directory, "connections.enc.json");
  try {
    const registry = new EncryptedFileConnectionRegistry({
      filePath: path,
      encryptionKey: randomBytes(32).toString("base64"),
      now: () => NOW,
    });
    const connectionId = "conn_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    await registry.upsert({
      ...connection(connectionId),
      enabledRegions: ["all-enabled"],
    });
    assert.deepEqual(
      (await registry.getRegistered({ tenantId: "org_local_sutra" }, connectionId))
        ?.enabledRegions,
      ["all-enabled"],
    );
    await assert.rejects(
      registry.upsert({
        ...connection("conn_ffffffffffffffffffffffffffffffff"),
        enabledRegions: ["all-enabled", "us-east-1"],
      }),
      RegistryIntegrityError,
    );
    await assert.rejects(
      registry.upsert({
        ...connection("conn_11111111111111111111111111111111"),
        partition: "aws-cn",
        roleArn: "arn:aws-cn:iam::123456789012:role/mspcmdb/SutraReadOnlyRole",
        enabledRegions: ["us-east-1"],
      }),
      RegistryIntegrityError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disable is idempotent and cannot be bypassed by a delayed registration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-registry-disable-"));
  const path = join(directory, "connections.enc.json");
  const connectionId = "conn_cccccccccccccccccccccccccccccccc";
  try {
    const registry = new EncryptedFileConnectionRegistry({
      filePath: path,
      encryptionKey: randomBytes(32).toString("base64"),
      now: () => NOW,
    });
    await registry.upsert(connection(connectionId));
    await registry.disable({ tenantId: "org_local_sutra" }, connectionId);
    await registry.disable({ tenantId: "org_local_sutra" }, connectionId);
    assert.equal(
      (await registry.resolve({ tenantId: "org_local_sutra" }, connectionId))?.status,
      "DISABLED",
    );
    await assert.rejects(
      registry.upsert({
        ...connection(connectionId),
        externalId: "sutra_rotated_external_id_123456789",
      }),
      RegistryStateError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("offboard removes trust material and persists a non-recreatable tombstone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-registry-offboard-"));
  const path = join(directory, "connections.enc.json");
  const encryptionKey = randomBytes(32).toString("base64");
  const connectionId = "conn_dddddddddddddddddddddddddddddddd";
  try {
    const registry = new EncryptedFileConnectionRegistry({
      filePath: path,
      encryptionKey,
      now: () => NOW,
    });
    await registry.upsert(connection(connectionId));
    await registry.offboard({ tenantId: "org_local_sutra" }, connectionId);
    await registry.offboard({ tenantId: "org_local_sutra" }, connectionId);
    assert.equal(
      await registry.resolve({ tenantId: "org_local_sutra" }, connectionId),
      null,
    );

    const restarted = new EncryptedFileConnectionRegistry({
      filePath: path,
      encryptionKey,
      now: () => NOW,
    });
    assert.equal(
      await restarted.resolve({ tenantId: "org_local_sutra" }, connectionId),
      null,
    );
    await assert.rejects(restarted.upsert(connection(connectionId)), RegistryStateError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registry authentication rejects a wrong encryption key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sutra-registry-"));
  const path = join(directory, "connections.enc.json");
  try {
    const writer = new EncryptedFileConnectionRegistry({
      filePath: path,
      encryptionKey: randomBytes(32).toString("base64"),
      now: () => NOW,
    });
    await writer.upsert(connection("conn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
    const reader = new EncryptedFileConnectionRegistry({
      filePath: path,
      encryptionKey: randomBytes(32).toString("base64"),
      now: () => NOW,
    });
    await assert.rejects(
      reader.resolve(
        { tenantId: "org_local_sutra" },
        "conn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ),
      RegistryIntegrityError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function connection(connectionId: string) {
  return {
    tenantId: "org_local_sutra",
    connectionId,
    expectedAccountId: "123456789012",
    partition: "aws" as const,
    roleArn: "arn:aws:iam::123456789012:role/mspcmdb/SutraReadOnlyRole",
    externalId: EXTERNAL_ID,
    enabledRegions: ["us-east-1", "ap-south-1"],
    sessionNamePrefix: "sutra-",
  };
}

async function writeEncryptedDocument(
  path: string,
  key: Buffer,
  document: unknown,
): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("sutra-local-registry:v1", "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(document), "utf8"),
    cipher.final(),
  ]);
  await writeFile(path, JSON.stringify({
    version: 1,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  }), { mode: 0o600 });
}

async function readEncryptedDocument(path: string, key: Buffer): Promise<unknown> {
  const envelope = JSON.parse(await readFile(path, "utf8")) as {
    iv: string;
    tag: string;
    ciphertext: string;
  };
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
  decipher.setAAD(Buffer.from("sutra-local-registry:v1", "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8")) as unknown;
}
