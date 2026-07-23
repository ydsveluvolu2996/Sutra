#!/usr/bin/env node
// Discover every offline test file and (optionally) run one deterministic
// shard of them. Discovery is glob-based on purpose: hand-maintained file
// lists in package.json silently orphaned whole suites (kubernetes,
// enterprise-security, phase2) so they never ran in CI. Globbing means a new
// tests/*.test.* file is gated automatically and can never be forgotten.
//
// Isolation: each shard still runs `node --test --test-concurrency=1`. The
// tenant-isolation and runtime-config suites mutate shared process/global
// state, so files must never run concurrently *within* a shard. Parallelism
// comes from running shards on separate CI runners, not from in-process
// concurrency.
//
// Usage:
//   node scripts/ci-test-shard.mjs                 # run every offline file
//   node scripts/ci-test-shard.mjs --shard 2/6     # run shard 2 of 6
//   node scripts/ci-test-shard.mjs --list          # print the manifest as JSON

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = resolve(root, "tests");

// Files that require an environment the offline shards do not provide. They are
// executed by dedicated CI jobs instead:
//   - rendered-html: needs `pnpm build` output (runs in the build job).
//   - postgres-repositories / postgres-trust-audit: need a live PostgreSQL
//     service with migrations applied (run by `pnpm db:postgres:test`).
const EXCLUDED = new Set([
  "rendered-html.test.mjs",
  "postgres-repositories.test.mjs",
  "postgres-trust-audit.test.mjs",
]);

function discover() {
  return readdirSync(testsDir)
    .filter((name) => /\.test\.(ts|mjs)$/u.test(name))
    .filter((name) => !EXCLUDED.has(name))
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((name) => `tests/${name}`);
}

function parseShard(argv) {
  const flag = argv.find((arg) => arg === "--shard");
  if (!flag) return null;
  const value = argv[argv.indexOf("--shard") + 1] ?? "";
  const match = /^(\d+)\/(\d+)$/u.exec(value);
  if (!match) {
    console.error(`Invalid --shard value: "${value}". Expected e.g. 2/6.`);
    process.exit(2);
  }
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (index < 1 || index > total) {
    console.error(`Shard index ${index} out of range 1..${total}.`);
    process.exit(2);
  }
  return { index, total };
}

const all = discover();

if (process.argv.includes("--list")) {
  console.log(JSON.stringify({ total: all.length, files: all }, null, 2));
  process.exit(0);
}

const shard = parseShard(process.argv);
// Round-robin assignment keeps each shard's file mix even (adjacent files in a
// sorted list tend to be the same, uneven-cost suite), so no single shard
// inherits all of the heavy kubernetes/phase2 files.
const files = shard ? all.filter((_, i) => i % shard.total === shard.index - 1) : all;

const label = shard ? `shard ${shard.index}/${shard.total}` : "all offline tests";
console.log(`Running ${label}: ${files.length} of ${all.length} test files.`);

if (files.length === 0) {
  console.error("No test files selected — refusing to pass an empty run.");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", ...files],
  { cwd: root, stdio: "inherit" },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
