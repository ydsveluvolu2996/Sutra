import assert from "node:assert/strict";
import test from "node:test";
import {
  AwsItsmManagedSecretStore,
  createRuntimeItsmSecretStore,
  ItsmManagedSecretError,
} from "../lib/itsm-managed-secret.ts";

const scope = { orgId: "org_enterprise", customerId: "cust_alpha" };
const connectorId = "itc_0123456789abcdef0123456789abcdef";
const kmsKeyArn =
  "arn:aws:kms:ap-south-1:111122223333:key/01234567-89ab-cdef-0123-456789abcdef";

class FakeSecretsManager {
  public readonly secrets = new Map<string, { readonly value: string; readonly versionId: string }>();
  public deleted = false;
  public readonly scheduledForDeletion = new Set<string>();
  public readonly commands: Array<{ readonly name: string; readonly input: Record<string, unknown> }> = [];

  public async send(command: unknown): Promise<unknown> {
    const record = command as {
      readonly constructor: { readonly name: string };
      readonly input: Record<string, unknown>;
    };
    this.commands.push({ name: record.constructor.name, input: record.input });
    if (record.constructor.name === "CreateSecretCommand") {
      const name = record.input.Name as string;
      if (this.secrets.has(name)) {
        const error = new Error("exists");
        error.name = "ResourceExistsException";
        throw error;
      }
      const versionId = record.input.ClientRequestToken as string;
      this.secrets.set(name, { value: record.input.SecretString as string, versionId });
      return { ARN: "arn:secret", VersionId: versionId };
    }
    if (record.constructor.name === "GetSecretValueCommand") {
      const name = record.input.SecretId as string;
      if (this.scheduledForDeletion.has(name)) {
        const error = new Error("The secret is scheduled for deletion");
        error.name = "InvalidRequestException";
        throw error;
      }
      const secret = this.secrets.get(name);
      if (secret === undefined) {
        const error = new Error("missing");
        error.name = "ResourceNotFoundException";
        throw error;
      }
      if (record.input.VersionId !== undefined && record.input.VersionId !== secret.versionId) {
        const error = new Error("missing version");
        error.name = "ResourceNotFoundException";
        throw error;
      }
      return { SecretString: secret.value, VersionId: secret.versionId };
    }
    if (record.constructor.name === "DeleteSecretCommand") {
      this.deleted = true;
      this.scheduledForDeletion.add(record.input.SecretId as string);
      return { DeletionDate: new Date() };
    }
    throw new Error("unexpected command");
  }
}

function store(client: FakeSecretsManager): AwsItsmManagedSecretStore {
  return new AwsItsmManagedSecretStore({
    prefix: "sutra/production/itsm/",
    kmsKeyArn,
    client,
  });
}

test("AWS ITSM store creates, resolves, rotates, and recoverably deletes a scoped secret", async () => {
  const client = new FakeSecretsManager();
  const managed = store(client);
  const first = "first-managed-shared-secret";
  const rotated = "rotated-managed-shared-secret";
  const reference = await managed.write(scope, connectorId, first);
  assert.match(reference, new RegExp(`^secret://itsm/${connectorId}/versions/[0-9a-f-]{36}$`, "u"));
  assert.equal(await managed.read(scope, connectorId, reference), first);
  const rotatedReference = await managed.write(scope, connectorId, rotated);
  assert.notEqual(rotatedReference, reference);
  assert.equal(await managed.read(scope, connectorId, reference), first);
  assert.equal(await managed.read(scope, connectorId, rotatedReference), rotated);
  await managed.delete(scope, connectorId, reference);
  assert.equal(client.deleted, true);
  assert.equal(await managed.read(scope, connectorId, reference), null);
  assert.equal(await managed.read(scope, connectorId, rotatedReference), rotated);

  const create = client.commands.find((command) => command.name === "CreateSecretCommand");
  assert.match(
    String(create?.input.Name),
    new RegExp(`^sutra/production/itsm/${connectorId}/versions/[0-9a-f-]{36}$`, "u"),
  );
  assert.equal(create?.input.KmsKeyId, kmsKeyArn);
  const deletion = client.commands.find((command) => command.name === "DeleteSecretCommand");
  assert.equal(deletion?.input.RecoveryWindowInDays, 7);
  assert.equal(JSON.stringify(client.commands).includes(first), true);
  assert.equal(reference.includes(first), false);
});

test("managed resolver rejects a scope-confused document and arbitrary reference", async () => {
  const client = new FakeSecretsManager();
  const managed = store(client);
  const reference = await managed.write(scope, connectorId, "tenant-bound-secret-value");
  await assert.rejects(
    managed.read({ ...scope, customerId: "cust_beta" }, connectorId, reference),
    (error) => error instanceof ItsmManagedSecretError && error.code === "SCOPE_MISMATCH",
  );
  await assert.rejects(
    managed.read(scope, connectorId, "secret://itsm/itc_ffffffffffffffffffffffffffffffff"),
    (error) => error instanceof ItsmManagedSecretError && error.code === "INVALID_REFERENCE",
  );
});

test("legacy unversioned references remain readable and are not mutated by staged rotation", async () => {
  const client = new FakeSecretsManager();
  const legacyReference = `secret://itsm/${connectorId}`;
  client.secrets.set(`sutra/production/itsm/${connectorId}`, {
    versionId: "legacy-version",
    value: JSON.stringify({
      version: 1,
      purpose: "sutra-itsm-hmac",
      ...scope,
      connectorId,
      sharedSecret: "legacy-managed-secret-value",
    }),
  });
  const managed = store(client);
  assert.equal(
    await managed.read(scope, connectorId, legacyReference),
    "legacy-managed-secret-value",
  );
  const staged = await managed.write(scope, connectorId, "new-versioned-secret-value");
  assert.equal(
    await managed.read(scope, connectorId, legacyReference),
    "legacy-managed-secret-value",
  );
  assert.equal(await managed.read(scope, connectorId, staged), "new-versioned-secret-value");
});

test("direct writes reject malformed credentials before an AWS command is sent", async () => {
  const client = new FakeSecretsManager();
  const managed = store(client);
  for (const sharedSecret of ["short", `valid-prefix\u0000but-invalid`, "x".repeat(513)]) {
    await assert.rejects(
      managed.write(scope, connectorId, sharedSecret),
      (error) => error instanceof ItsmManagedSecretError && error.code === "INVALID_SECRET",
    );
  }
  assert.deepEqual(client.commands, []);
});

test("a staged version cannot overwrite an existing immutable connector version", async () => {
  const client = new FakeSecretsManager();
  const managed = store(client);
  const original = await managed.write(scope, connectorId, "tenant-alpha-secret-value");
  const staged = await managed.write(
    { orgId: scope.orgId, customerId: "cust_beta" },
    connectorId,
    "tenant-beta-secret-value",
  );
  assert.equal(await managed.read(scope, connectorId, original), "tenant-alpha-secret-value");
  await assert.rejects(
    managed.read(scope, connectorId, staged),
    (error) => error instanceof ItsmManagedSecretError && error.code === "SCOPE_MISMATCH",
  );
  assert.equal(
    client.commands.filter((command) => command.name === "PutSecretValueCommand").length,
    0,
  );
});

test("non-local runtime refuses database fallback when managed configuration is incomplete", () => {
  assert.throws(
    () => createRuntimeItsmSecretStore({ SUTRA_DEPLOYMENT_ENV: "production" }),
    (error) => error instanceof ItsmManagedSecretError && error.code === "INVALID_CONFIGURATION",
  );
  assert.equal(createRuntimeItsmSecretStore({ SUTRA_DEPLOYMENT_ENV: "local" }), null);
  assert.equal(createRuntimeItsmSecretStore({ SUTRA_DEPLOYMENT_ENV: "development" }), null);
  assert.equal(createRuntimeItsmSecretStore({ SUTRA_DEPLOYMENT_ENV: "test" }), null);
  assert.throws(
    () => createRuntimeItsmSecretStore({ SUTRA_DEPLOYMENT_ENV: "staging" }),
    (error) => error instanceof ItsmManagedSecretError && error.code === "INVALID_CONFIGURATION",
  );
});
