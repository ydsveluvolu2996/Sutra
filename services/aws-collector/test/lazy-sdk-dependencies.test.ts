import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Providers that load an AWS SDK client lazily do it through a string variable
 * (`const m = "@aws-sdk/client-x"; import(m)`) so a bundler cannot hoist the
 * module into the build. That indirection also hides the dependency from
 * TypeScript: a missing package still typechecks, still passes every test that
 * injects a fake SDK, and only fails when the vertical actually runs, as
 * ERR_MODULE_NOT_FOUND in production.
 *
 * @aws-sdk/client-config-service and @aws-sdk/client-connect were both reachable
 * from shipped code this way while declared nowhere. This test makes the
 * omission fail in CI instead.
 */

// These tests execute compiled, from dist/test/, so package root is two levels up.
const srcDirectory = new URL("../../src/", import.meta.url).pathname;
const manifestPath = new URL("../../package.json", import.meta.url).pathname;

const AWS_SDK_MODULE = /"(@aws-sdk\/[a-z0-9-]+)"/gu;

async function sourceFiles(): Promise<readonly string[]> {
  const entries = await readdir(srcDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(srcDirectory, entry.name));
}

test("every AWS SDK module referenced by collector source is a declared dependency", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);

  const undeclared = new Map<string, string[]>();
  for (const file of await sourceFiles()) {
    const source = await readFile(file, "utf8");
    for (const [, moduleName] of source.matchAll(AWS_SDK_MODULE)) {
      if (moduleName === undefined || declared.has(moduleName)) continue;
      const sites = undeclared.get(moduleName) ?? [];
      sites.push(file.slice(srcDirectory.length));
      undeclared.set(moduleName, sites);
    }
  }

  assert.deepEqual(
    Object.fromEntries(undeclared),
    {},
    "AWS SDK modules reachable from shipped code must be declared in services/aws-collector/package.json",
  );
});

test("the lazily loaded provider SDKs actually resolve at runtime", async () => {
  // A declaration alone is not proof: the package must be installable and
  // export the exact constructs the providers call.
  const config = await import("@aws-sdk/client-config-service");
  assert.equal(typeof config.ConfigServiceClient, "function");
  assert.equal(typeof config.SelectAggregateResourceConfigCommand, "function");
  assert.equal(typeof config.DescribeConfigRulesCommand, "function");

  const connect = await import("@aws-sdk/client-connect");
  assert.equal(typeof connect.ConnectClient, "function");

  const organizations = await import("@aws-sdk/client-organizations");
  assert.equal(typeof organizations.OrganizationsClient, "function");
  assert.equal(typeof organizations.DescribeOrganizationCommand, "function");
});
