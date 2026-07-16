import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
      permissionPackVersion: "live-demo-2026-07.1" as const,
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
      permissionPackVersion: "live-demo-2026-07.1" as const,
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
