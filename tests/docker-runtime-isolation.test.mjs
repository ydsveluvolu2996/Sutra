import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
const entrypoint = await readFile(new URL("../docker/entrypoint.sh", import.meta.url), "utf8");
const rootDockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const notificationWorkerDockerfile = await readFile(
  new URL("../services/notification-worker/Dockerfile", import.meta.url),
  "utf8",
);
const packageManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const workspaceManifest = await readFile(
  new URL("../pnpm-workspace.yaml", import.meta.url),
  "utf8",
);

test("the long-running app never receives or invokes the PostgreSQL owner credential", () => {
  const migrateStart = compose.indexOf("  migrate:\n");
  const appStart = compose.indexOf("  app:\n");
  const volumesStart = compose.indexOf("\nvolumes:\n");
  assert.ok(migrateStart > 0 && appStart > migrateStart && volumesStart > appStart);

  const migrateService = compose.slice(migrateStart, appStart);
  const appService = compose.slice(appStart, volumesStart);
  assert.match(migrateService, /SUTRA_MIGRATOR_DATABASE_URL: postgresql:\/\/sutra_owner:/u);
  assert.match(migrateService, /entrypoint: \["node", "scripts\/postgres-migrate\.mjs"\]/u);
  assert.doesNotMatch(appService, /SUTRA_MIGRATOR_DATABASE_URL|sutra_owner/u);
  assert.match(appService, /condition: service_completed_successfully/u);
  assert.doesNotMatch(entrypoint, /MIGRATOR|postgres:migrate|sutra_owner/u);
  assert.doesNotMatch(entrypoint, /\bpnpm\b/u);
});

test("PostgreSQL verification cannot restart or reuse the live demo Compose project", () => {
  const source = readFile(new URL("../scripts/test-postgres.mjs", import.meta.url), "utf8");
  return source.then((contents) => {
    assert.match(contents, /const POSTGRES_TEST_PROJECT = "sutra-postgres-test";/u);
    assert.match(contents, /"--project-name",\s*POSTGRES_TEST_PROJECT/u);
    assert.match(contents, /"down",\s*"--volumes",\s*"--remove-orphans"/u);
  });
});

test("Docker builders use the repository package-manager version", () => {
  for (const dockerfile of [rootDockerfile, notificationWorkerDockerfile]) {
    const match = dockerfile.match(/corepack prepare (pnpm@\d+\.\d+\.\d+) --activate/u);
    assert.ok(match, "Dockerfile must pin pnpm through Corepack");
    assert.equal(match[1], packageManifest.packageManager);
  }
});

test("the application runtime contains only deployed runtime dependencies and built artifacts", () => {
  assert.match(rootDockerfile, /pnpm --filter sutra deploy --prod \/app\/\.runtime\/root/u);
  assert.match(
    rootDockerfile,
    /pnpm --filter @msp\/aws-collector deploy --prod \/app\/\.runtime\/collector/u,
  );
  assert.match(workspaceManifest, /injectWorkspacePackages: true/u);
  assert.match(rootDockerfile, /FROM node:22-bookworm-slim@sha256:[a-f0-9]{64} AS runtime/u);
  assert.match(rootDockerfile, /apt-get install --yes --no-install-recommends ca-certificates/u);
  assert.match(rootDockerfile, /update-ca-certificates/u);
  assert.match(rootDockerfile, /rm -rf \/var\/lib\/apt\/lists\/\*/u);
  assert.match(rootDockerfile, /rm -rf \/usr\/local\/lib\/node_modules\/npm/u);
  assert.match(rootDockerfile, /\/opt\/yarn-\*/u);
  assert.match(rootDockerfile, /rm -f \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx/u);
  assert.match(rootDockerfile, /\/app\/\.runtime\/root\/node_modules \/app\/node_modules/u);
  assert.match(
    rootDockerfile,
    /\/app\/\.runtime\/collector\/node_modules \/app\/services\/aws-collector\/node_modules/u,
  );
  assert.match(rootDockerfile, /\/app\/dist \/app\/dist/u);
  assert.match(rootDockerfile, /\/app\/services\/aws-collector\/dist \/app\/services\/aws-collector\/dist/u);
  assert.match(rootDockerfile, /\/app\/docker\/postgres-init\.sh \/app\/docker\/postgres-init\.sh/u);
  assert.match(rootDockerfile, /\/app\/lib\/release-identity\.ts \/app\/lib\/release-identity\.ts/u);
  assert.match(rootDockerfile, /\/app\/lib\/hosted-oidc-providers\.ts \/app\/lib\/hosted-oidc-providers\.ts/u);
  for (const shipped of [
    "scripts/start-pilot.mjs",
    "scripts/serve-worker.mjs",
    "scripts/worker-serve-config.mjs",
  ]) {
    assert.match(
      rootDockerfile,
      new RegExp(`/app/${shipped.replaceAll("/", "\\/").replaceAll(".", "\\.")} /app/${shipped.replaceAll("/", "\\/").replaceAll(".", "\\.")}`, "u"),
      `${shipped} must be copied into the runtime image`,
    );
  }
  // The host EPSS timer runs `docker exec sutra-prod-app-1 node
  // scripts/vuln-feed-refresh.mjs`, so the script AND its whole import closure must
  // be in the image. Shipping the unit without these made the timer fail on first
  // fire with "Cannot find module" and left the CVE mirror silently un-refreshed.
  // Assert the closure, not just the entrypoint: a missing leaf fails identically.
  for (const shipped of [
    "scripts/vuln-feed-refresh.mjs",
    "lib/vulnerability-feed-ingest.ts",
    "lib/exploitability-feed.ts",
    "lib/vulnerability-database.ts",
  ]) {
    assert.match(
      rootDockerfile,
      new RegExp(`/app/${shipped.replaceAll("/", "\\/").replaceAll(".", "\\.")} /app/${shipped.replaceAll("/", "\\/").replaceAll(".", "\\.")}`, "u"),
      `${shipped} must be copied into the runtime image`,
    );
  }
  assert.match(rootDockerfile, /\/app\/deploy\/ec2 \/app\/deploy\/ec2/u);
  assert.doesNotMatch(rootDockerfile, /COPY --from=builder[^\n]*\/app \/app/u);
  // What matters here is the DEPENDENCY CLASS, not the version: the runtime image
  // is built from `pnpm deploy --prod`, so wrangler has to be a real dependency
  // or it is absent from the deployed closure and the container cannot serve.
  // Asserting the exact version instead made every routine wrangler bump fail an
  // unrelated Docker-isolation test, which trains people to edit the number
  // rather than read the check.
  assert.equal(typeof packageManifest.dependencies.wrangler, "string");
  assert.equal(packageManifest.devDependencies.wrangler, undefined);
  assert.equal(typeof packageManifest.dependencies.miniflare, "string");
  assert.equal(packageManifest.devDependencies.miniflare, undefined);
  // Still exact-pinned, though — a range would let the image drift between
  // builds and make a release non-reproducible.
  assert.match(packageManifest.dependencies.wrangler, /^\d+\.\d+\.\d+$/u);
  assert.match(packageManifest.dependencies.miniflare, /^\d+\.\d+\.\d+$/u);
});
