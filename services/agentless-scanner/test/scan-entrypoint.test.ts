import assert from "node:assert/strict";
import test from "node:test";

import {
  ScanRefusedError,
  detectFilesystem,
  resolveScanDevice,
  runTrivy,
  verifyTrivyDatabases,
} from "../src/scan-entrypoint.js";

type Call = { readonly command: string; readonly args: readonly string[] };

/** Fake exec: returns a scripted result per command name, recording the calls. */
function fakeExec(
  script: Record<string, { code?: number; stdout?: string; stderr?: string }>,
  calls: Call[] = [],
) {
  return async (command: string, args: readonly string[]) => {
    calls.push({ command, args });
    const entry = script[command] ?? { code: 0, stdout: "", stderr: "" };
    return { code: entry.code ?? 0, stdout: entry.stdout ?? "", stderr: entry.stderr ?? "" };
  };
}

function lsblk(devices: unknown): string {
  return JSON.stringify({ blockdevices: devices });
}

test("picks the single unmounted partition and ignores the container's own root disk", async () => {
  const device = await resolveScanDevice(fakeExec({
    lsblk: { stdout: lsblk([
      { name: "nvme0n1", type: "disk", mountpoint: null, children: [{ name: "nvme0n1p1", type: "part", mountpoint: "/" }] },
      { name: "nvme1n1", type: "disk", mountpoint: null, children: [{ name: "nvme1n1p1", type: "part", mountpoint: null }] },
    ]) },
  }));
  // The scan target, not the disk this container is running from.
  assert.equal(device, "/dev/nvme1n1p1");
});

test("REFUSES when two candidate disks are attached rather than guessing", async () => {
  // Guessing here would attribute one customer's CVEs to another's volume.
  await assert.rejects(
    () => resolveScanDevice(fakeExec({
      lsblk: { stdout: lsblk([
        { name: "nvme0n1", type: "disk", mountpoint: null, children: [{ name: "nvme0n1p1", type: "part", mountpoint: "/" }] },
        { name: "nvme1n1", type: "disk", mountpoint: null, children: [] },
        { name: "nvme2n1", type: "disk", mountpoint: null, children: [] },
      ]) },
    })),
    (error: unknown) => error instanceof ScanRefusedError && error.code === "AMBIGUOUS_DEVICE",
  );
});

test("REFUSES when nothing is attached — an empty scan is not a clean scan", async () => {
  await assert.rejects(
    () => resolveScanDevice(fakeExec({
      lsblk: { stdout: lsblk([
        { name: "nvme0n1", type: "disk", mountpoint: null, children: [{ name: "nvme0n1p1", type: "part", mountpoint: "/" }] },
      ]) },
    })),
    (error: unknown) => error instanceof ScanRefusedError && error.code === "AMBIGUOUS_DEVICE",
  );
});

test("handles a whole-disk volume with no partition table", async () => {
  const device = await resolveScanDevice(fakeExec({
    lsblk: { stdout: lsblk([
      { name: "nvme0n1", type: "disk", mountpoint: null, children: [{ name: "nvme0n1p1", type: "part", mountpoint: "/" }] },
      { name: "nvme1n1", type: "disk", mountpoint: null, children: [] },
    ]) },
  }));
  assert.equal(device, "/dev/nvme1n1");
});

test("lsblk failure and unparsable output are distinct refusals", async () => {
  await assert.rejects(
    () => resolveScanDevice(fakeExec({ lsblk: { code: 1, stderr: "no permission" } })),
    (e: unknown) => e instanceof ScanRefusedError && e.code === "LSBLK_FAILED",
  );
  await assert.rejects(
    () => resolveScanDevice(fakeExec({ lsblk: { stdout: "not json" } })),
    (e: unknown) => e instanceof ScanRefusedError && e.code === "LSBLK_UNPARSABLE",
  );
  await assert.rejects(
    () => resolveScanDevice(fakeExec({ lsblk: { stdout: JSON.stringify({}) } })),
    (e: unknown) => e instanceof ScanRefusedError && e.code === "LSBLK_UNPARSABLE",
  );
});

test("an unidentifiable filesystem is refused, not mounted blind", async () => {
  await assert.rejects(
    () => detectFilesystem("/dev/nvme1n1p1", fakeExec({ blkid: { stdout: "  \n" } })),
    (e: unknown) => e instanceof ScanRefusedError && e.code === "FILESYSTEM_UNKNOWN",
  );
  assert.equal(await detectFilesystem("/dev/x", fakeExec({ blkid: { stdout: "xfs\n" } })), "xfs");
});

const NOW = Date.parse("2026-07-30T12:00:00.000Z");

function databaseMetadata(updatedAt: string, downloadedAt = "2026-07-30T11:00:00.000Z"): string {
  return JSON.stringify({
    Version: 2,
    NextUpdate: "2026-07-30T18:00:00.000Z",
    UpdatedAt: updatedAt,
    DownloadedAt: downloadedAt,
  });
}

test("the baked vulnerability and Java databases must both exist", async () => {
  await assert.rejects(
    () => verifyTrivyDatabases(async () => { throw new Error("not found"); }, NOW),
    (e: unknown) => e instanceof ScanRefusedError && e.code === "TRIVY_DATABASES_MISSING",
  );
});

test("freshness comes from Trivy's actual baked DB metadata", async () => {
  const reads: string[] = [];
  const result = await verifyTrivyDatabases(async (path) => {
    reads.push(path);
    return path.includes("java-db")
      ? databaseMetadata("2026-07-29T12:00:00.000Z")
      : databaseMetadata("2026-07-30T06:00:00.000Z");
  }, NOW);
  assert.deepEqual(reads.sort(), [
    "/var/cache/trivy/db/metadata.json",
    "/var/cache/trivy/java-db/metadata.json",
  ]);
  assert.deepEqual(result, {
    vulnerabilityUpdatedAt: "2026-07-30T06:00:00.000Z",
    javaUpdatedAt: "2026-07-29T12:00:00.000Z",
  });
});

test("stale, malformed, and future-dated databases REFUSE the scan", async () => {
  await assert.rejects(
    () => verifyTrivyDatabases(async (path) =>
      path.includes("java-db")
        ? databaseMetadata("2026-07-29T12:00:00.000Z")
        : databaseMetadata("2026-07-27T12:00:00.000Z"), NOW),
    (e: unknown) => e instanceof ScanRefusedError && e.code === "VULN_DB_STALE",
  );
  await assert.rejects(
    () => verifyTrivyDatabases(async (path) =>
      path.includes("java-db")
        ? databaseMetadata("2026-07-20T12:00:00.000Z")
        : databaseMetadata("2026-07-30T06:00:00.000Z"), NOW),
    (e: unknown) => e instanceof ScanRefusedError && e.code === "JAVA_DB_STALE",
  );
  await assert.rejects(
    () => verifyTrivyDatabases(async () => "{\"UpdatedAt\":false}", NOW),
    (e: unknown) => e instanceof ScanRefusedError && e.code === "VULN_DB_METADATA_INVALID",
  );
  await assert.rejects(
    () => verifyTrivyDatabases(async () =>
      databaseMetadata("2026-07-31T12:00:00.000Z"), NOW),
    (e: unknown) => e instanceof ScanRefusedError && e.code === "VULN_DB_METADATA_INVALID",
  );
});

test("trivy is invoked read-only over the mount with all three scanners", async () => {
  const calls: Call[] = [];
  await runTrivy(fakeExec({ trivy: { stdout: JSON.stringify({ Results: [] }) } }, calls));
  const args = calls[0]?.args ?? [];
  assert.equal(args[0], "rootfs");
  assert.ok(args.includes("/mnt/scan"), "scans the mount point, not the container root");
  assert.deepEqual(args[args.indexOf("--scanners") + 1], "vuln,secret,misconfig");
  assert.ok(args.includes("--skip-db-update"), "must never fetch the vulnerability DB at runtime");
  assert.ok(args.includes("--skip-java-db-update"), "must never fetch the Java DB at runtime");
  // Our own DB cache must not appear in a customer's findings.
  assert.deepEqual(args[args.indexOf("--skip-dirs") + 1], "/var/cache/trivy");
});

test("a non-JSON or failed trivy run is refused, never treated as no findings", async () => {
  await assert.rejects(
    () => runTrivy(fakeExec({ trivy: { stdout: "panic: runtime error" } })),
    (e: unknown) => e instanceof ScanRefusedError && e.code === "TRIVY_UNPARSABLE",
  );
  await assert.rejects(
    () => runTrivy(fakeExec({ trivy: { code: 2, stderr: "fatal" } })),
    (e: unknown) => e instanceof ScanRefusedError && e.code === "TRIVY_FAILED",
  );
});
