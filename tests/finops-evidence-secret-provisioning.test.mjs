import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const setupScript = resolve(root, "scripts/setup-local-pilot.mjs");
const KEY_NAME = "SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY";
const VERSION_NAME = "SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY_VERSION";
const TEST_KEY = Buffer.alloc(32, 19).toString("base64url");
const TEST_VERSION = "pilot-finops-evidence-v7";

function environment(config, overrides = {}) {
  return {
    PATH: process.env.PATH,
    ...(process.env.NODE_OPTIONS === undefined ? {} : { NODE_OPTIONS: process.env.NODE_OPTIONS }),
    SUTRA_LOCAL_CONFIG_PATH: config,
    ...overrides,
  };
}

async function withConfig(run) {
  const directory = await mkdtemp(resolve(tmpdir(), "sutra-finops-secret-"));
  const config = resolve(directory, ".dev.vars");
  try {
    await run(config);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("fresh local setup provisions one canonical evidence key pair without logging it", async () => {
  await withConfig(async (config) => {
    const result = await execute(process.execPath, [setupScript], {
      env: environment(config),
    });
    const contents = await readFile(config, "utf8");
    const key = new RegExp(`^${KEY_NAME}=([A-Za-z0-9_-]{43})$`, "mu").exec(contents)?.[1];
    assert.equal(Buffer.from(key ?? "", "base64url").byteLength, 32);
    assert.match(contents, new RegExp(`^${VERSION_NAME}=local-finops-evidence-v1$`, "mu"));
    assert.equal(contents.match(new RegExp(`^${KEY_NAME}=`, "gmu"))?.length, 1);
    assert.equal(contents.match(new RegExp(`^${VERSION_NAME}=`, "gmu"))?.length, 1);
    assert.equal((await stat(config)).mode & 0o777, 0o600);
    assert.equal(result.stdout, "Created secure local pilot configuration.\n");
    assert.doesNotMatch(result.stderr, new RegExp(key ?? "not-present", "u"));
    assert.doesNotMatch(result.stdout, new RegExp(key ?? "not-present", "u"));
  });
});

test("operator-provided evidence key rotations are validated and passed through without disclosure", async () => {
  await withConfig(async (config) => {
    const first = await execute(process.execPath, [setupScript], {
      env: environment(config),
    });
    assert.doesNotMatch(first.stdout, new RegExp(TEST_KEY, "u"));

    const rotated = await execute(process.execPath, [setupScript], {
      env: environment(config, {
        [KEY_NAME]: TEST_KEY,
        [VERSION_NAME]: TEST_VERSION,
      }),
    });
    const contents = await readFile(config, "utf8");
    assert.match(contents, new RegExp(`^${KEY_NAME}=${TEST_KEY}$`, "mu"));
    assert.match(contents, new RegExp(`^${VERSION_NAME}=${TEST_VERSION}$`, "mu"));
    assert.equal(contents.match(new RegExp(`^${KEY_NAME}=`, "gmu"))?.length, 1);
    assert.equal(contents.match(new RegExp(`^${VERSION_NAME}=`, "gmu"))?.length, 1);
    assert.equal(rotated.stdout, "Local pilot configuration is ready.\n");
    assert.doesNotMatch(rotated.stderr, new RegExp(TEST_KEY, "u"));
    assert.doesNotMatch(rotated.stdout, new RegExp(TEST_KEY, "u"));
  });
});

test("partial, empty, malformed and duplicate key material fails before runtime creation", async () => {
  const invalidEnvironments = [
    { [KEY_NAME]: TEST_KEY },
    { [VERSION_NAME]: TEST_VERSION },
    { [KEY_NAME]: "", [VERSION_NAME]: TEST_VERSION },
    { [KEY_NAME]: `${TEST_KEY}=`, [VERSION_NAME]: TEST_VERSION },
    { [KEY_NAME]: TEST_KEY, [VERSION_NAME]: "bad version" },
  ];
  for (const overrides of invalidEnvironments) {
    await withConfig(async (config) => {
      await assert.rejects(
        execute(process.execPath, [setupScript], { env: environment(config, overrides) }),
        (error) => {
          assert.doesNotMatch(String(error.stderr), new RegExp(TEST_KEY, "u"));
          return true;
        },
      );
      await assert.rejects(stat(config), { code: "ENOENT" });
    });
  }

  for (const stored of [
    `${KEY_NAME}=${TEST_KEY}\n`,
    `${VERSION_NAME}=${TEST_VERSION}\n`,
    `${KEY_NAME}=${TEST_KEY}\n${KEY_NAME}=${TEST_KEY}\n${VERSION_NAME}=${TEST_VERSION}\n`,
    `${KEY_NAME}=${TEST_KEY}\r\n${VERSION_NAME}=${TEST_VERSION}\r\n`,
  ]) {
    await withConfig(async (config) => {
      await writeFile(config, stored, { mode: 0o600 });
      await assert.rejects(
        execute(process.execPath, [setupScript], { env: environment(config) }),
      );
      assert.equal(await readFile(config, "utf8"), stored);
    });
  }
});

test("EC2 fails interpolation without the pair while the managed HA path remains intact", async () => {
  const [compose, setup, dockerEntrypoint, productionEntrypoint, haTemplate] = await Promise.all([
    readFile(resolve(root, "deploy/ec2/compose.prod.yaml"), "utf8"),
    readFile(setupScript, "utf8"),
    readFile(resolve(root, "docker/entrypoint.sh"), "utf8"),
    readFile(resolve(root, "deploy/production/entrypoint.sh"), "utf8"),
    readFile(resolve(root, "infrastructure/production-ha.yaml"), "utf8"),
  ]);
  for (const name of [KEY_NAME, VERSION_NAME]) {
    assert.match(compose, new RegExp(name + ": \\$\\{" + name + ":\\?", "u"));
    assert.doesNotMatch(compose, new RegExp(name + ": \\$\\{" + name + ":-", "u"));
    assert.match(productionEntrypoint, new RegExp(`^${name}$`, "mu"));
    assert.match(productionEntrypoint, new RegExp(`"${name}=\\$${name}"`, "u"));
  }
  assert.match(
    dockerEntrypoint,
    /setup-local-pilot\.mjs\nexec node scripts\/start-pilot\.mjs/u,
  );
  assert.match(
    haTemplate,
    /ApplicationRuntimeSecretArn\}:SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY::\$\{ApplicationRuntimeSecretVersionId\}/u,
  );
  assert.match(
    haTemplate,
    /Name: SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY_VERSION, Value: production-finops-evidence-v1/u,
  );
  assert.doesNotMatch(setup, /SUTRA_FINOPS_EVIDENCE_REFERENCE_KEY=[A-Za-z0-9_-]{43}/u);
});
