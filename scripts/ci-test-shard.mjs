#!/usr/bin/env node
// Discover every offline test file and (optionally) run one balanced shard of
// them. Discovery is glob-based on purpose: hand-maintained file lists in
// package.json silently orphaned whole suites (kubernetes, enterprise-security,
// phase2) so they never ran in CI. Globbing means a new tests/*.test.* file is
// gated automatically and can never be forgotten.
//
// Isolation: each shard still runs `node --test --test-concurrency=1`. The
// tenant-isolation and runtime-config suites mutate shared process/global
// state, so files must never run concurrently *within* a shard. Parallelism
// comes from running shards on separate CI runners, not from in-process
// concurrency.
//
// Balancing: shards are packed by measured per-file duration (longest job
// first, onto the least-loaded shard) so the critical-path shard is as short as
// possible. Without a durations manifest it falls back to a deterministic
// round-robin.
//
// Usage:
//   node scripts/ci-test-shard.mjs                 # run every PR-gate file
//   node scripts/ci-test-shard.mjs --shard 2/6     # run shard 2 of 6
//   node scripts/ci-test-shard.mjs --nightly       # run the nightly-only set
//   node scripts/ci-test-shard.mjs --list          # print the manifest as JSON
//   node scripts/ci-test-shard.mjs --time          # measure per-file durations

import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = resolve(root, "tests");
const durationsPath = resolve(root, "tests/test-durations.json");

// Files that require an environment the offline shards do not provide. They are
// executed by dedicated CI jobs instead:
//   - rendered-html: needs `pnpm build` output (runs in the build job).
//   - postgres-repositories / postgres-resource-retirement /
//     postgres-trust-audit: need a live PostgreSQL service with migrations
//     applied (run by `pnpm db:postgres:test`).
const EXCLUDED = new Set([
  "rendered-html.test.mjs",
  "postgres-repositories.test.mjs",
  "postgres-resource-retirement.test.mjs",
  "postgres-trust-audit.test.mjs",
]);

// Deliberately long-running endurance tests. They validate stability over time
// rather than the correctness of a single change, so they belong in the nightly
// schedule, not on the per-PR critical path. Run by the nightly workflow via
// `--nightly`; excluded from the PR-gate shards.
const NIGHTLY = new Set([
  "kubernetes-agent-soak.test.ts",
]);

function discoverAll() {
  return readdirSync(testsDir)
    .filter((name) => /\.test\.(ts|mjs)$/u.test(name))
    .filter((name) => !EXCLUDED.has(name))
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((name) => `tests/${name}`);
}

// The PR gate runs everything discoverable except the nightly-only endurance set.
function prGateFiles() {
  return discoverAll().filter((file) => !NIGHTLY.has(file.slice("tests/".length)));
}

function nightlyFiles() {
  return discoverAll().filter((file) => NIGHTLY.has(file.slice("tests/".length)));
}

function loadDurations() {
  if (!existsSync(durationsPath)) return null;
  try {
    return JSON.parse(readFileSync(durationsPath, "utf8"));
  } catch {
    return null;
  }
}

// Longest-processing-time bin packing: sort files by measured duration
// (descending, name tiebreak) and greedily place each onto the currently
// least-loaded shard. Unknown files get the mean known duration so new tests
// are distributed sensibly until the manifest is refreshed. Deterministic given
// the same file set + manifest.
function balancedShard(files, index, total) {
  const durations = loadDurations();
  const known = durations ? Object.values(durations).filter((v) => typeof v === "number") : [];
  const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1000;
  const cost = (file) => (durations && typeof durations[file] === "number" ? durations[file] : fallback);

  const ordered = [...files].sort((a, b) => {
    const diff = cost(b) - cost(a);
    return diff !== 0 ? diff : a.localeCompare(b, "en");
  });

  const load = Array.from({ length: total }, () => 0);
  const buckets = Array.from({ length: total }, () => []);
  for (const file of ordered) {
    let pick = 0;
    for (let s = 1; s < total; s += 1) {
      if (load[s] < load[pick]) pick = s;
    }
    buckets[pick].push(file);
    load[pick] += cost(file);
  }
  // Return the requested shard, files re-sorted by name for stable output.
  return buckets[index - 1].sort((a, b) => a.localeCompare(b, "en"));
}

function parseShard(argv) {
  if (!argv.includes("--shard")) return null;
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

function runFiles(files, label) {
  console.log(`Running ${label}: ${files.length} test files.`);
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
}

// --- entry points ---

if (process.argv.includes("--list")) {
  console.log(
    JSON.stringify(
      { prGate: prGateFiles(), nightly: nightlyFiles(), excluded: [...EXCLUDED] },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (process.argv.includes("--time")) {
  // Measure each PR-gate file individually so balancing has clean per-file data.
  const files = prGateFiles();
  const durations = {};
  for (const file of files) {
    const started = performance.now();
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", file], {
      cwd: root,
      stdio: "ignore",
    });
    const elapsed = Math.round(performance.now() - started);
    durations[file] = elapsed;
    console.log(`${result.status === 0 ? "ok" : "FAIL"} ${elapsed}ms ${file}`);
  }
  const ordered = Object.fromEntries(
    Object.entries(durations).sort((a, b) => b[1] - a[1]),
  );
  writeFileSync(durationsPath, `${JSON.stringify(ordered, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(ordered).length} durations to tests/test-durations.json`);
  process.exit(0);
}

if (process.argv.includes("--nightly")) {
  runFiles(nightlyFiles(), "nightly endurance suite");
}

const shard = parseShard(process.argv);
const gate = prGateFiles();
const files = shard ? balancedShard(gate, shard.index, shard.total) : gate;
const label = shard ? `shard ${shard.index}/${shard.total}` : "all PR-gate tests";
runFiles(files, `${label} (of ${gate.length} PR-gate files)`);
