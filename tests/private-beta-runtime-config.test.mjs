import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const setupScript = resolve(import.meta.dirname, "../scripts/setup-local-pilot.mjs");
const PRIVATE_BETA_KEYS = new Set([
  "SUTRA_DEPLOYMENT_ENV",
  "SUTRA_PUBLIC_ORIGIN",
  "SUTRA_RELEASE_IMAGE",
  "SUTRA_LOCAL_MODE",
  "SUTRA_IDENTITY_MODE",
  "SUTRA_PASSWORD_MFA_REQUIRED",
  "SUTRA_PASSWORD_IDENTITY_ENABLED",
  "SUTRA_PRIVATE_BETA_PASSWORD_ENABLED",
  "SUTRA_BROKER_URL",
  "SUTRA_COLLECTOR_MODE",
  "SUTRA_ALLOW_LIVE_AWS",
  "SUTRA_COLLECTOR_PRINCIPAL_ARN",
]);

const RELEASE_IMAGE =
  "738663485493.dkr.ecr.ap-south-1.amazonaws.com/sutra/app@sha256:" + "a".repeat(64);

function cleanEnvironment(overrides = {}) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !PRIVATE_BETA_KEYS.has(name)),
  );
  return { ...environment, ...overrides };
}

async function withConfig(run) {
  const directory = await mkdtemp(resolve(tmpdir(), "sutra-private-beta-"));
  const config = resolve(directory, ".dev.vars");
  try {
    await run(config);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("setup materializes only the explicit staging private-beta password allowlist", async () => {
  await withConfig(async (config) => {
    const environment = cleanEnvironment({
      SUTRA_LOCAL_CONFIG_PATH: config,
      SUTRA_DEPLOYMENT_ENV: "staging",
      SUTRA_PUBLIC_ORIGIN: "https://www.sutracmdb.com",
      SUTRA_RELEASE_IMAGE: RELEASE_IMAGE,
      SUTRA_LOCAL_MODE: "false",
      SUTRA_IDENTITY_MODE: "password",
      SUTRA_PASSWORD_MFA_REQUIRED: "true",
      SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "true",
    });
    await execute(process.execPath, [setupScript], { env: environment });
    const contents = await readFile(config, "utf8");
    assert.match(contents, /^SUTRA_DEPLOYMENT_ENV=staging$/mu);
    assert.match(contents, /^SUTRA_PUBLIC_ORIGIN=https:\/\/www\.sutracmdb\.com$/mu);
    assert.match(contents, new RegExp(`^SUTRA_RELEASE_IMAGE=${RELEASE_IMAGE}$`, "mu"));
    assert.match(contents, /^SUTRA_LOCAL_MODE=false$/mu);
    assert.match(contents, /^SUTRA_IDENTITY_MODE=password$/mu);
    assert.match(contents, /^SUTRA_PASSWORD_MFA_REQUIRED=true$/mu);
    assert.match(contents, /^SUTRA_PRIVATE_BETA_PASSWORD_ENABLED=true$/mu);
    assert.match(contents, /^SUTRA_AUTH_ENCRYPTION_KEY=[A-Za-z0-9_-]{43}$/mu);
    assert.doesNotMatch(contents, /^SUTRA_PASSWORD_IDENTITY_ENABLED=true$/mu);

    // Removing the process-level opt-in disables a value retained on the
    // persistent runtime volume instead of silently leaving the pilot public.
    await execute(process.execPath, [setupScript], {
      env: cleanEnvironment({
        SUTRA_LOCAL_CONFIG_PATH: config,
        SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "false",
      }),
    });
    const localContents = await readFile(config, "utf8");
    assert.match(localContents, /^SUTRA_PRIVATE_BETA_PASSWORD_ENABLED=false$/mu);
    assert.doesNotMatch(localContents, /^SUTRA_RELEASE_IMAGE=/mu);
  });
});

test("setup refuses production, loopback and implicit private-beta activation", async () => {
  for (const overrides of [
    {
      SUTRA_DEPLOYMENT_ENV: "production",
      SUTRA_PUBLIC_ORIGIN: "https://www.sutracmdb.com",
      SUTRA_RELEASE_IMAGE: RELEASE_IMAGE,
      SUTRA_LOCAL_MODE: "false",
      SUTRA_IDENTITY_MODE: "password",
      SUTRA_PASSWORD_MFA_REQUIRED: "true",
      SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "true",
    },
    {
      SUTRA_DEPLOYMENT_ENV: "staging",
      SUTRA_PUBLIC_ORIGIN: "http://127.0.0.1:3000",
      SUTRA_RELEASE_IMAGE: RELEASE_IMAGE,
      SUTRA_LOCAL_MODE: "false",
      SUTRA_IDENTITY_MODE: "password",
      SUTRA_PASSWORD_MFA_REQUIRED: "true",
      SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "true",
    },
    {
      SUTRA_DEPLOYMENT_ENV: "staging",
      SUTRA_PUBLIC_ORIGIN: "https://www.sutracmdb.com",
      SUTRA_LOCAL_MODE: "false",
      SUTRA_IDENTITY_MODE: "password",
      SUTRA_PASSWORD_MFA_REQUIRED: "true",
      SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "true",
    },
    {
      SUTRA_DEPLOYMENT_ENV: "staging",
      SUTRA_PUBLIC_ORIGIN: "https://www.sutracmdb.com",
      SUTRA_RELEASE_IMAGE: "738663485493.dkr.ecr.ap-south-1.amazonaws.com/sutra/app:latest",
      SUTRA_LOCAL_MODE: "false",
      SUTRA_IDENTITY_MODE: "password",
      SUTRA_PASSWORD_MFA_REQUIRED: "true",
      SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "true",
    },
    { SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "TRUE" },
    { SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: " true" },
  ]) {
    await withConfig(async (config) => {
      await assert.rejects(
        execute(process.execPath, [setupScript], {
          env: cleanEnvironment({ ...overrides, SUTRA_LOCAL_CONFIG_PATH: config }),
        }),
      );
    });
  }
});

test("ordinary local setup remains loopback-local and does not opt into private beta", async () => {
  await withConfig(async (config) => {
    await execute(process.execPath, [setupScript], {
      env: cleanEnvironment({ SUTRA_LOCAL_CONFIG_PATH: config }),
    });
    const contents = await readFile(config, "utf8");
    assert.match(contents, /^SUTRA_LOCAL_MODE=true$/mu);
    assert.doesNotMatch(contents, /^SUTRA_PRIVATE_BETA_PASSWORD_ENABLED=true$/mu);
  });
});

test("setup persists the explicit live collector boundary and replaces retained fixture values", async () => {
  await withConfig(async (config) => {
    await execute(process.execPath, [setupScript], {
      env: cleanEnvironment({ SUTRA_LOCAL_CONFIG_PATH: config }),
    });
    await execute(process.execPath, [setupScript], {
      env: cleanEnvironment({
        SUTRA_LOCAL_CONFIG_PATH: config,
        SUTRA_COLLECTOR_MODE: "live",
        SUTRA_ALLOW_LIVE_AWS: "true",
        SUTRA_COLLECTOR_PRINCIPAL_ARN: "arn:aws:iam::738663485493:role/sutra-private-beta-InstanceRole-example",
        SUTRA_BROKER_URL: "http://127.0.0.1:8788",
      }),
    });
    const contents = await readFile(config, "utf8");
    assert.match(contents, /^SUTRA_COLLECTOR_MODE=live$/mu);
    assert.match(contents, /^SUTRA_ALLOW_LIVE_AWS=true$/mu);
    assert.match(contents, /^SUTRA_COLLECTOR_PRINCIPAL_ARN=arn:aws:iam::738663485493:role\/sutra-private-beta-InstanceRole-example$/mu);
    assert.match(contents, /^SUTRA_BROKER_URL=http:\/\/127\.0\.0\.1:8788$/mu);
  });
});

test("setup rejects partial or malformed live collector activation", async () => {
  for (const overrides of [
    { SUTRA_COLLECTOR_MODE: "live", SUTRA_ALLOW_LIVE_AWS: "false" },
    { SUTRA_COLLECTOR_MODE: "fixture", SUTRA_ALLOW_LIVE_AWS: "true" },
    { SUTRA_COLLECTOR_MODE: "LIVE", SUTRA_ALLOW_LIVE_AWS: "true" },
    {
      SUTRA_COLLECTOR_MODE: "live",
      SUTRA_ALLOW_LIVE_AWS: "true",
      SUTRA_COLLECTOR_PRINCIPAL_ARN: "arn:aws:iam::738663485493:user/not-a-role",
    },
  ]) {
    await withConfig(async (config) => {
      await assert.rejects(execute(process.execPath, [setupScript], {
        env: cleanEnvironment({ ...overrides, SUTRA_LOCAL_CONFIG_PATH: config }),
      }));
    });
  }
});
