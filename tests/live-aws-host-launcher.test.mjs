import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LIVE_AWS_ACKNOWLEDGEMENT,
  LIVE_COMPOSE_PROJECT,
  LIVE_RUNTIME_CONFIG,
  assertLiveRuntimeRecoveryState,
  buildLiveRuntimeConfig,
  ensureLiveRuntimeConfiguration,
  parseRuntimeConfig,
  validateAwsProfileCredentialSource,
  validateLiveAwsLaunchEnvironment,
} from "../scripts/live-aws-host.mjs";
import { PROTECTED_POSTGRES_VOLUMES } from "../scripts/docker-local-env.mjs";

const PROFILE = "sutra-demo-sso";
const PRINCIPAL = "arn:aws:iam::111122223333:role/aws-reserved/sso.amazonaws.com/SutraDemoCollector";
const DATABASE_URL = "postgresql://sutra_app:local-password@127.0.0.1:54329/sutra";

function validLaunchEnvironment(overrides = {}) {
  return {
    SUTRA_LIVE_AWS_ACK: LIVE_AWS_ACKNOWLEDGEMENT,
    AWS_PROFILE: PROFILE,
    SUTRA_COLLECTOR_PRINCIPAL_ARN: PRINCIPAL,
    ...overrides,
  };
}

function deterministicSecrets() {
  let count = 0;
  return () => `${String(count++).padStart(2, "0")}${"x".repeat(41)}`;
}

async function awsSharedFiles(config, credentials = "") {
  const root = await mkdtemp(join(tmpdir(), "sutra-aws-profile-"));
  const configPath = join(root, "config");
  const credentialsPath = join(root, "credentials");
  await Promise.all([
    writeFile(configPath, config, { mode: 0o600 }),
    writeFile(credentialsPath, credentials, { mode: 0o600 }),
  ]);
  return {
    AWS_PROFILE: PROFILE,
    AWS_CONFIG_FILE: configPath,
    AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
  };
}

test("live host launcher requires an explicit per-launch acknowledgement and exact profile role", () => {
  assert.throws(
    () => validateLiveAwsLaunchEnvironment(validLaunchEnvironment({ SUTRA_LIVE_AWS_ACK: undefined })),
    /Set SUTRA_LIVE_AWS_ACK exactly/u,
  );
  assert.throws(
    () => validateLiveAwsLaunchEnvironment(validLaunchEnvironment({ AWS_PROFILE: " sutra-demo-sso" })),
    /AWS_PROFILE is required/u,
  );
  assert.throws(
    () => validateLiveAwsLaunchEnvironment(validLaunchEnvironment({ SUTRA_COLLECTOR_PRINCIPAL_ARN: "arn:aws:iam::111122223333:user/demo" })),
    /exact IAM role ARN/u,
  );

  assert.deepEqual(validateLiveAwsLaunchEnvironment(validLaunchEnvironment()), {
    awsProfile: PROFILE,
    principalArn: PRINCIPAL,
    postgresPort: 54329,
    webPort: 3000,
    region: undefined,
  });
});

test("live AWS PostgreSQL uses a separate Compose project and both volumes protect the shared password file", () => {
  assert.equal(LIVE_COMPOSE_PROJECT, "sutra-live-aws");
  assert.deepEqual(PROTECTED_POSTGRES_VOLUMES, [
    "sutra-local_sutra_postgres_data",
    "sutra-live-aws_sutra_postgres_data",
  ]);
  assert.notEqual(PROTECTED_POSTGRES_VOLUMES[0], PROTECTED_POSTGRES_VOLUMES[1]);
});

test("a retained live database cannot silently receive a new encryption keyring", () => {
  assert.doesNotThrow(() => assertLiveRuntimeRecoveryState({
    liveVolumeExists: false,
    runtimeConfigExists: false,
    runtimeConfigIsRegularFile: false,
  }));
  assert.doesNotThrow(() => assertLiveRuntimeRecoveryState({
    liveVolumeExists: true,
    runtimeConfigExists: true,
    runtimeConfigIsRegularFile: true,
  }));
  assert.throws(
    () => assertLiveRuntimeRecoveryState({
      liveVolumeExists: true,
      runtimeConfigExists: false,
      runtimeConfigIsRegularFile: false,
    }),
    /live PostgreSQL volume exists.*live-aws\.env is missing/u,
  );
  assert.throws(
    () => assertLiveRuntimeRecoveryState({
      liveVolumeExists: true,
      runtimeConfigExists: true,
      runtimeConfigIsRegularFile: false,
    }),
    /regular file, never a symbolic link/u,
  );
});

test("live host launcher rejects every process-level static or token credential source", async (t) => {
  const forbidden = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  ];
  for (const key of forbidden) {
    await t.test(key, () => {
      const secretValue = "must-not-appear-in-errors";
      assert.throws(
        () => validateLiveAwsLaunchEnvironment(validLaunchEnvironment({ [key]: secretValue })),
        (error) => error instanceof Error && error.message.includes(key) && !error.message.includes(secretValue),
      );
    });
  }
});

test("live host launcher accepts a role source_profile chain that terminates in an SSO session", async () => {
  const environment = await awsSharedFiles(`
[sso-session sutra-demo]
sso_start_url = https://example.awsapps.com/start
sso_region = us-east-1

[profile sutra-demo-operator]
sso_session = sutra-demo
sso_account_id = 111122223333
sso_role_name = SutraOperator

[profile ${PROFILE}]
role_arn = ${PRINCIPAL}
source_profile = sutra-demo-operator
role_session_name = sutra-local-demo
`);
  const result = await validateAwsProfileCredentialSource({ environment });
  assert.deepEqual(result, {
    selectedProfile: PROFILE,
    chain: [PROFILE, "sutra-demo-operator"],
    terminal: "sso",
    configFile: environment.AWS_CONFIG_FILE,
    credentialsFile: environment.AWS_SHARED_CREDENTIALS_FILE,
  });
});

test("live host launcher accepts a role chain that terminates in a legacy SSO profile", async () => {
  const environment = await awsSharedFiles(`
[profile sutra-demo-operator]
sso_start_url = https://example.awsapps.com/start
sso_region = us-east-1
sso_account_id = 111122223333
sso_role_name = SutraOperator

[profile ${PROFILE}]
role_arn = ${PRINCIPAL}
source_profile = sutra-demo-operator
`);
  const result = await validateAwsProfileCredentialSource({ environment });
  assert.deepEqual(result.chain, [PROFILE, "sutra-demo-operator"]);
  assert.equal(result.terminal, "sso");
});

test("live host launcher rejects a source_profile backed by static shared-file credentials without exposing values", async () => {
  const accessKey = "example-access-key-must-not-leak";
  const secretKey = "example-secret-key-must-not-leak";
  const environment = await awsSharedFiles(`
[profile ${PROFILE}]
role_arn = ${PRINCIPAL}
source_profile = sutra-demo-static
`, `
[sutra-demo-static]
aws_access_key_id = ${accessKey}
aws_secret_access_key = ${secretKey}
`);
  await assert.rejects(
    validateAwsProfileCredentialSource({ environment }),
    (error) =>
      error instanceof Error &&
      /must not use static shared-file credentials/u.test(error.message) &&
      !error.message.includes(accessKey) &&
      !error.message.includes(secretKey),
  );
});

test("live host launcher rejects source_profile cycles and missing profiles", async (t) => {
  await t.test("cycle", async () => {
    const environment = await awsSharedFiles(`
[profile ${PROFILE}]
role_arn = ${PRINCIPAL}
source_profile = loop

[profile loop]
role_arn = arn:aws:iam::111122223333:role/Loop
source_profile = ${PROFILE}
`);
    await assert.rejects(validateAwsProfileCredentialSource({ environment }), /contains a cycle/u);
  });

  await t.test("missing profile", async () => {
    const environment = await awsSharedFiles(`
[profile ${PROFILE}]
role_arn = ${PRINCIPAL}
source_profile = absent
`);
    await assert.rejects(validateAwsProfileCredentialSource({ environment }), /references a missing profile/u);
  });
});

test("live host launcher rejects non-SSO credential providers and unsafe shared-file overrides", async (t) => {
  await t.test("credential_source", async () => {
    const environment = await awsSharedFiles(`
[profile ${PROFILE}]
role_arn = ${PRINCIPAL}
credential_source = Ec2InstanceMetadata
`);
    await assert.rejects(validateAwsProfileCredentialSource({ environment }), /must not use credential_source/u);
  });

  await t.test("credential_process", async () => {
    const environment = await awsSharedFiles(`
[profile ${PROFILE}]
credential_process = do-not-run
`);
    await assert.rejects(validateAwsProfileCredentialSource({ environment }), /must not use credential_process/u);
  });

  await t.test("relative config path", async () => {
    await assert.rejects(
      validateAwsProfileCredentialSource({
        environment: {
          AWS_PROFILE: PROFILE,
          AWS_CONFIG_FILE: "relative/config",
        },
      }),
      /AWS_CONFIG_FILE must be an absolute path/u,
    );
  });

  await t.test("group-writable config file", async () => {
    const environment = await awsSharedFiles(`
[profile ${PROFILE}]
sso_start_url = https://example.awsapps.com/start
sso_region = us-east-1
sso_account_id = 111122223333
sso_role_name = SutraOperator
`);
    await chmod(environment.AWS_CONFIG_FILE, 0o620);
    await assert.rejects(
      validateAwsProfileCredentialSource({ environment }),
      /must not be writable by group or other users/u,
    );
  });

  await t.test("symbolic-link config file", async () => {
    const environment = await awsSharedFiles(`
[profile ${PROFILE}]
sso_start_url = https://example.awsapps.com/start
sso_region = us-east-1
sso_account_id = 111122223333
sso_role_name = SutraOperator
`);
    const linkedPath = `${environment.AWS_CONFIG_FILE}-link`;
    await symlink(environment.AWS_CONFIG_FILE, linkedPath);
    await assert.rejects(
      validateAwsProfileCredentialSource({
        environment: { ...environment, AWS_CONFIG_FILE: linkedPath },
      }),
      /not a symbolic link/u,
    );
  });
});

test("runtime configuration contains no AWS profile, acknowledgement, access key, or session token", () => {
  const built = buildLiveRuntimeConfig({
    databaseUrl: DATABASE_URL,
    principalArn: PRINCIPAL,
    createSecret: deterministicSecrets(),
  });
  assert.equal(/^AWS_/mu.test(built.contents), false);
  assert.equal(built.contents.includes("AWS_PROFILE="), false);
  assert.equal(built.contents.includes("AWS_ACCESS_KEY_ID="), false);
  assert.equal(built.contents.includes("AWS_SESSION_TOKEN="), false);
  assert.equal(built.contents.includes("SUTRA_LIVE_AWS_ACK="), false);
  assert.equal(built.variables.get("SUTRA_COLLECTOR_MODE"), "live");
  assert.equal(built.variables.get("SUTRA_ALLOW_LIVE_AWS"), "true");
  assert.equal(built.variables.get("SUTRA_COLLECTOR_PRINCIPAL_ARN"), PRINCIPAL);

  assert.throws(
    () => parseRuntimeConfig("AWS_PROFILE=must-never-be-persisted\n"),
    /unsupported key AWS_PROFILE/u,
  );
});

test("runtime configuration preserves encryption secrets and updates only operational values", () => {
  const first = buildLiveRuntimeConfig({
    databaseUrl: DATABASE_URL,
    principalArn: PRINCIPAL,
    createSecret: deterministicSecrets(),
  });
  const nextPrincipal = "arn:aws:iam::444455556666:role/SutraDemoCollector";
  const second = buildLiveRuntimeConfig({
    databaseUrl: "postgresql://sutra_app:next-password@127.0.0.1:54330/sutra",
    principalArn: nextPrincipal,
    existingContents: first.contents,
    createSecret: () => {
      throw new Error("existing secrets must be reused");
    },
  });
  for (const key of [
    "SUTRA_LOCAL_BOOTSTRAP_TOKEN",
    "SUTRA_AUTH_ENCRYPTION_KEY",
    "SUTRA_CONNECTION_ENCRYPTION_KEY",
    "SUTRA_BROKER_SHARED_SECRET",
    "SUTRA_REGISTRY_ENCRYPTION_KEY",
  ]) {
    assert.equal(second.variables.get(key), first.variables.get(key));
  }
  assert.equal(second.variables.get("SUTRA_COLLECTOR_PRINCIPAL_ARN"), nextPrincipal);
  assert.match(second.variables.get("DATABASE_URL"), /127\.0\.0\.1:54330/u);
});

test("live runtime file and state directory are permission restricted", async () => {
  const root = await mkdtemp(join(tmpdir(), "sutra-live-launcher-"));
  const runtime = await ensureLiveRuntimeConfiguration({
    root,
    databaseUrl: DATABASE_URL,
    principalArn: PRINCIPAL,
    createSecret: deterministicSecrets(),
  });
  assert.equal(runtime.configPath, join(root, LIVE_RUNTIME_CONFIG));
  assert.equal((await stat(join(root, ".sutra"))).mode & 0o777, 0o700);
  assert.equal((await stat(runtime.configPath)).mode & 0o777, 0o600);
  const contents = await readFile(runtime.configPath, "utf8");
  assert.equal(contents.includes(PROFILE), false);
  assert.equal(contents.includes(LIVE_AWS_ACKNOWLEDGEMENT), false);
});
