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
  "SUTRA_OIDC_PROVIDERS",
  "SUTRA_OIDC_TRANSACTION_KEY",
  "SUTRA_PASSWORD_MFA_REQUIRED",
  "SUTRA_PASSWORD_IDENTITY_ENABLED",
  "SUTRA_PRIVATE_BETA_OIDC_ENABLED",
  "SUTRA_PRIVATE_BETA_PASSWORD_ENABLED",
  "SUTRA_BROKER_URL",
  "SUTRA_COLLECTOR_MODE",
  "SUTRA_ALLOW_LIVE_AWS",
  "SUTRA_COLLECTOR_PRINCIPAL_ARN",
  "SUTRA_TURNSTILE_ENABLED",
  "SUTRA_TURNSTILE_SITE_KEY",
  "SUTRA_TURNSTILE_SECRET_KEY",
  "SUTRA_TURNSTILE_DEV_BYPASS",
  "SUTRA_HOSTED_SELF_SERVE_SIGNUP",
  "SUTRA_HOSTED_SIGNUP_ALLOWED_DOMAINS",
  "SUTRA_EVIDENCE_BACKEND",
  "SUTRA_EVIDENCE_BUCKET",
  "SUTRA_EVIDENCE_KMS_KEY_ARN",
  "SUTRA_EVIDENCE_RETENTION_DAYS",
]);

const RELEASE_IMAGE =
  "738663485493.dkr.ecr.ap-south-1.amazonaws.com/sutra/app@sha256:" + "a".repeat(64);
const TURNSTILE = {
  SUTRA_TURNSTILE_ENABLED: "true",
  SUTRA_TURNSTILE_SITE_KEY: "0x4AAAAAAAAAAAAAAAAAAAAAAA",
  SUTRA_TURNSTILE_SECRET_KEY: "0x4BBBBBBBBBBBBBBBBBBBBBBB",
  SUTRA_TURNSTILE_DEV_BYPASS: "false",
};
const EVIDENCE = {
  SUTRA_EVIDENCE_BACKEND: "s3",
  SUTRA_EVIDENCE_BUCKET: "sutra-private-beta-evidence-test",
  SUTRA_EVIDENCE_KMS_KEY_ARN:
    "arn:aws:kms:ap-south-1:738663485493:key/11111111-2222-3333-4444-555555555555",
  SUTRA_EVIDENCE_RETENTION_DAYS: "365",
};
const PRIVATE_BETA_RUNTIME = { ...TURNSTILE, ...EVIDENCE };
const OIDC = {
  SUTRA_OIDC_PROVIDERS: JSON.stringify([{
    id: "zoho",
    issuer: "https://accounts.zoho.in",
    authorizationEndpoint: "https://accounts.zoho.in/oauth/v2/auth",
    tokenEndpoint: "https://accounts.zoho.in/oauth/v2/token",
    jwksUri: "https://accounts.zoho.in/oauth/v2/keys",
    clientId: "sutra-test-client",
    clientSecret: "not-a-real-secret",
  }]),
  SUTRA_OIDC_TRANSACTION_KEY: "A".repeat(43),
};

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
      ...PRIVATE_BETA_RUNTIME,
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
    assert.match(contents, /^SUTRA_PRIVATE_BETA_OIDC_ENABLED=false$/mu);
    assert.match(contents, /^SUTRA_AUTH_ENCRYPTION_KEY=[A-Za-z0-9_-]{43}$/mu);
    assert.match(contents, /^SUTRA_TURNSTILE_ENABLED=true$/mu);
    assert.match(contents, /^SUTRA_TURNSTILE_SITE_KEY=0x4A+$/mu);
    assert.match(contents, /^SUTRA_TURNSTILE_SECRET_KEY=0x4B+$/mu);
    assert.match(contents, /^SUTRA_TURNSTILE_DEV_BYPASS=false$/mu);
    assert.match(contents, /^SUTRA_EVIDENCE_BACKEND=s3$/mu);
    assert.match(contents, /^SUTRA_EVIDENCE_BUCKET=sutra-private-beta-evidence-test$/mu);
    assert.match(contents, /^SUTRA_EVIDENCE_KMS_KEY_ARN=arn:aws:kms:ap-south-1:738663485493:key\/11111111-2222-3333-4444-555555555555$/mu);
    assert.match(contents, /^SUTRA_EVIDENCE_RETENTION_DAYS=365$/mu);
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
    assert.doesNotMatch(localContents, /^SUTRA_EVIDENCE_/mu);
  });
});

test("setup materializes an explicitly approved invitation-only private-beta OIDC adapter", async () => {
  await withConfig(async (config) => {
    const environment = cleanEnvironment({
      SUTRA_LOCAL_CONFIG_PATH: config,
      SUTRA_DEPLOYMENT_ENV: "staging",
      SUTRA_PUBLIC_ORIGIN: "https://www.sutracmdb.com",
      SUTRA_RELEASE_IMAGE: RELEASE_IMAGE,
      SUTRA_LOCAL_MODE: "false",
      SUTRA_IDENTITY_MODE: "oidc",
      SUTRA_PASSWORD_MFA_REQUIRED: "true",
      SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "false",
      SUTRA_PRIVATE_BETA_OIDC_ENABLED: "true",
      ...OIDC,
      ...PRIVATE_BETA_RUNTIME,
    });
    await execute(process.execPath, [setupScript], { env: environment });
    const contents = await readFile(config, "utf8");
    assert.match(contents, /^SUTRA_DEPLOYMENT_ENV=staging$/mu);
    assert.match(contents, /^SUTRA_IDENTITY_MODE=oidc$/mu);
    assert.match(contents, /^SUTRA_PRIVATE_BETA_PASSWORD_ENABLED=false$/mu);
    assert.match(contents, /^SUTRA_PRIVATE_BETA_OIDC_ENABLED=true$/mu);
    assert.match(contents, /^SUTRA_OIDC_TRANSACTION_KEY=A{43}$/mu);
    assert.ok(contents.includes(`SUTRA_OIDC_PROVIDERS=${OIDC.SUTRA_OIDC_PROVIDERS}`));
  });
});

test("the self-serve signup switch reaches the Worker runtime file and fails closed when withdrawn", async () => {
  await withConfig(async (config) => {
    const privateBetaOidc = {
      SUTRA_LOCAL_CONFIG_PATH: config,
      SUTRA_DEPLOYMENT_ENV: "staging",
      SUTRA_PUBLIC_ORIGIN: "https://www.sutracmdb.com",
      SUTRA_RELEASE_IMAGE: RELEASE_IMAGE,
      SUTRA_LOCAL_MODE: "false",
      SUTRA_IDENTITY_MODE: "oidc",
      SUTRA_PASSWORD_MFA_REQUIRED: "true",
      SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "false",
      SUTRA_PRIVATE_BETA_OIDC_ENABLED: "true",
      ...OIDC,
      ...PRIVATE_BETA_RUNTIME,
    };
    // The compose file passes the switch into the container process env; the
    // Worker only ever sees what setup writes to .dev.vars. Release 24 shipped
    // without this passthrough, so the live flag could never turn on.
    await execute(process.execPath, [setupScript], {
      env: cleanEnvironment({
        ...privateBetaOidc,
        SUTRA_HOSTED_SELF_SERVE_SIGNUP: "true",
        SUTRA_HOSTED_SIGNUP_ALLOWED_DOMAINS: "example.com,example.org",
      }),
    });
    const enabled = await readFile(config, "utf8");
    assert.match(enabled, /^SUTRA_HOSTED_SELF_SERVE_SIGNUP=true$/mu);
    assert.match(enabled, /^SUTRA_HOSTED_SIGNUP_ALLOWED_DOMAINS=example\.com,example\.org$/mu);

    // Compose's default supplies the exact string "false" when the operator
    // has not opted in; the retained volume value must be overwritten.
    await execute(process.execPath, [setupScript], {
      env: cleanEnvironment({
        ...privateBetaOidc,
        SUTRA_HOSTED_SELF_SERVE_SIGNUP: "false",
        SUTRA_HOSTED_SIGNUP_ALLOWED_DOMAINS: "",
      }),
    });
    const disabled = await readFile(config, "utf8");
    assert.match(disabled, /^SUTRA_HOSTED_SELF_SERVE_SIGNUP=false$/mu);
    assert.doesNotMatch(disabled, /^SUTRA_HOSTED_SIGNUP_ALLOWED_DOMAINS=/mu);

    // A wholly absent switch (no compose default at all) is also withdrawn
    // from the retained runtime file, never left at a stale enabled value.
    await execute(process.execPath, [setupScript], {
      env: cleanEnvironment({
        ...privateBetaOidc,
        SUTRA_HOSTED_SELF_SERVE_SIGNUP: "true",
      }),
    });
    await execute(process.execPath, [setupScript], {
      env: cleanEnvironment(privateBetaOidc),
    });
    const withdrawn = await readFile(config, "utf8");
    assert.doesNotMatch(withdrawn, /^SUTRA_HOSTED_SELF_SERVE_SIGNUP=/mu);
  });
});

test("private-beta identity switches cannot cross-enable password and OIDC adapters", async () => {
  for (const overrides of [
    {
      SUTRA_IDENTITY_MODE: "oidc",
      SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "true",
      SUTRA_PRIVATE_BETA_OIDC_ENABLED: "false",
      ...OIDC,
    },
    {
      SUTRA_IDENTITY_MODE: "password",
      SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "false",
      SUTRA_PRIVATE_BETA_OIDC_ENABLED: "true",
    },
    {
      SUTRA_IDENTITY_MODE: "oidc",
      SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "false",
      SUTRA_PRIVATE_BETA_OIDC_ENABLED: "true",
      ...OIDC,
      SUTRA_OIDC_TRANSACTION_KEY: "too-short",
    },
  ]) {
    await withConfig(async (config) => {
      await assert.rejects(execute(process.execPath, [setupScript], {
        env: cleanEnvironment({
          SUTRA_LOCAL_CONFIG_PATH: config,
          SUTRA_DEPLOYMENT_ENV: "staging",
          SUTRA_PUBLIC_ORIGIN: "https://www.sutracmdb.com",
          SUTRA_RELEASE_IMAGE: RELEASE_IMAGE,
          SUTRA_LOCAL_MODE: "false",
          SUTRA_PASSWORD_MFA_REQUIRED: "true",
          ...PRIVATE_BETA_RUNTIME,
          ...overrides,
        }),
      }));
    });
  }
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
    assert.match(contents, /^SUTRA_TURNSTILE_ENABLED=false$/mu);
    assert.match(contents, /^SUTRA_TURNSTILE_DEV_BYPASS=true$/mu);
    assert.doesNotMatch(contents, /^SUTRA_PRIVATE_BETA_PASSWORD_ENABLED=true$/mu);
  });
});

test("network private-beta setup rejects Cloudflare's public test credentials", async () => {
  for (const turnstile of [
    {
      SUTRA_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      SUTRA_TURNSTILE_SECRET_KEY: TURNSTILE.SUTRA_TURNSTILE_SECRET_KEY,
    },
    {
      SUTRA_TURNSTILE_SITE_KEY: TURNSTILE.SUTRA_TURNSTILE_SITE_KEY,
      SUTRA_TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    },
  ]) {
    await withConfig(async (config) => {
      await assert.rejects(
        execute(process.execPath, [setupScript], {
          env: cleanEnvironment({
            SUTRA_LOCAL_CONFIG_PATH: config,
            SUTRA_DEPLOYMENT_ENV: "staging",
            SUTRA_PUBLIC_ORIGIN: "https://www.sutracmdb.com",
            SUTRA_RELEASE_IMAGE: RELEASE_IMAGE,
            SUTRA_LOCAL_MODE: "false",
            SUTRA_IDENTITY_MODE: "password",
            SUTRA_PASSWORD_MFA_REQUIRED: "true",
            SUTRA_PRIVATE_BETA_PASSWORD_ENABLED: "true",
            ...PRIVATE_BETA_RUNTIME,
            ...turnstile,
          }),
        }),
        /test credentials are forbidden/u,
      );
    });
  }
});

test("network private-beta setup rejects missing or malformed managed evidence storage", async () => {
  const cases = [
    ["SUTRA_EVIDENCE_BACKEND", undefined],
    ["SUTRA_EVIDENCE_BACKEND", "local"],
    ["SUTRA_EVIDENCE_BUCKET", "sutra-private-beta-evidence-placeholder"],
    [
      "SUTRA_EVIDENCE_KMS_KEY_ARN",
      "arn:aws:kms:us-east-1:738663485493:key/11111111-2222-3333-4444-555555555555",
    ],
    [
      "SUTRA_EVIDENCE_KMS_KEY_ARN",
      "arn:aws:kms:ap-south-1:000000000000:key/11111111-2222-3333-4444-555555555555",
    ],
    ["SUTRA_EVIDENCE_RETENTION_DAYS", "29"],
    ["SUTRA_EVIDENCE_RETENTION_DAYS", "3651"],
  ];
  for (const [name, value] of cases) {
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
        ...PRIVATE_BETA_RUNTIME,
      });
      if (value === undefined) delete environment[name];
      else environment[name] = value;
      await assert.rejects(
        execute(process.execPath, [setupScript], { env: environment }),
        /SUTRA_EVIDENCE_/u,
      );
    });
  }
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
