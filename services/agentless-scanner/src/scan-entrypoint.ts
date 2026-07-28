/**
 * Container entrypoint for the agentless disk scanner.
 *
 * Contract: a block device derived from a COPY of a customer snapshot is attached
 * to this task. Mount it read-only, run Trivy over it, print findings as JSON on
 * stdout, exit. Nothing else. The container holds no AWS credentials and does not
 * create, share, or delete snapshots — the executor owns that lifecycle.
 *
 * ── FAILURE POLICY: REFUSE, NEVER DOWNGRADE ─────────────────────────────────
 * Every failure mode here exits non-zero rather than printing an empty findings
 * array, because an empty array is indistinguishable from a clean disk once it
 * reaches the vulnerability queue. A scan that could not run must look different
 * from a scan that found nothing. That applies to a failed DB update just as much
 * as to a failed mount: Trivy will happily scan with a stale or missing database
 * and report zero vulnerabilities.
 */

import { spawn } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";

import { parseTrivyReport, type ParsedFinding } from "./trivy-report.js";

const MOUNT_POINT = "/mnt/scan";
/** Trivy exits 0 with findings and 0 without; a non-zero exit is a real error. */
const TRIVY_OK = 0;

export interface RunResult {
  readonly findings: readonly ParsedFinding[];
  readonly summary: Record<string, number>;
  readonly device: string;
  readonly filesystem: string;
  readonly trivyDbUpdatedAt: string;
}

export class ScanRefusedError extends Error {
  public constructor(public readonly code: string, detail: string) {
    super(`agentless-scan-refused: ${code}: ${detail}`);
    this.name = "ScanRefusedError";
  }
}

interface Exec {
  (command: string, args: readonly string[], options?: { readonly timeoutMs?: number }):
    Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
}

const execProcess: Exec = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    // Bounded so a hung mount or a wedged Trivy cannot hold the task open until
    // the platform timeout, which would bill for an hour of nothing.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ScanRefusedError("TIMEOUT", `${command} exceeded ${options?.timeoutMs ?? 0}ms`));
    }, options?.timeoutMs ?? 15 * 60 * 1000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });

/**
 * Resolves the attached data device.
 *
 * UNVALIDATED: on Nitro instances EBS volumes appear as /dev/nvme*n1 and the
 * requested device name is NOT honoured, so the caller cannot simply pass
 * /dev/sdf and be believed. This picks the single non-root block device, and
 * refuses when the count is anything other than one rather than guessing —
 * scanning the wrong disk would attribute findings to the wrong customer.
 */
export async function resolveScanDevice(
  exec: Exec = execProcess,
  rootDeviceHint = "/",
): Promise<string> {
  const listed = await exec("lsblk", ["-J", "-o", "NAME,TYPE,MOUNTPOINT,SIZE"]);
  if (listed.code !== 0) {
    throw new ScanRefusedError("LSBLK_FAILED", listed.stderr.trim() || `exit ${listed.code}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(listed.stdout);
  } catch {
    throw new ScanRefusedError("LSBLK_UNPARSABLE", "lsblk did not return JSON");
  }
  const devices = (parsed as { blockdevices?: unknown }).blockdevices;
  if (!Array.isArray(devices)) {
    throw new ScanRefusedError("LSBLK_UNPARSABLE", "no blockdevices array");
  }

  const candidates: string[] = [];
  /** Candidate -> its candidate children, so a parent disk can be dropped. */
  const childrenOf = new Map<string, string[]>();
  const visit = (node: unknown, depth: number): void => {
    const record = typeof node === "object" && node !== null ? node as Record<string, unknown> : null;
    if (record === null) return;
    const name = typeof record.name === "string" ? record.name : null;
    const type = typeof record.type === "string" ? record.type : "";
    const mountpoint = typeof record.mountpoint === "string" ? record.mountpoint : null;
    const children = Array.isArray(record.children) ? record.children : [];
    // A device carrying the running root filesystem is this container's own disk.
    const holdsRoot = mountpoint === rootDeviceHint
      || children.some((child) => {
        const c = typeof child === "object" && child !== null ? child as Record<string, unknown> : null;
        return c !== null && c.mountpoint === rootDeviceHint;
      });
    if (name !== null && (type === "disk" || (type === "part" && depth > 0)) && !holdsRoot && mountpoint === null) {
      const path = `/dev/${name}`;
      candidates.push(path);
      childrenOf.set(path, children.flatMap((child) => {
        const c = typeof child === "object" && child !== null ? child as Record<string, unknown> : null;
        return c !== null && typeof c.name === "string" && c.mountpoint == null ? [`/dev/${c.name}`] : [];
      }));
    }
    for (const child of children) visit(child, depth + 1);
  };
  for (const device of devices) visit(device, 0);

  // Prefer a partition over its whole-disk parent: a snapshot of a normal root
  // volume has a partition table, and mounting the raw disk fails.
  //
  // Decided from the lsblk TREE, not from the device name. A name pattern cannot
  // do this — `/dev/nvme1n1` ends in a digit exactly like a partition does, so a
  // regex reads the parent disk as a partition and the whole set looks ambiguous.
  const withCandidateChildren = new Set(
    candidates.filter((device) => (childrenOf.get(device) ?? []).some((child) => candidates.includes(child))),
  );
  const chosen = candidates.filter((device) => !withCandidateChildren.has(device));
  if (chosen.length !== 1) {
    throw new ScanRefusedError(
      "AMBIGUOUS_DEVICE",
      `expected exactly one unmounted candidate, found ${chosen.length}: ${chosen.join(", ") || "none"}`,
    );
  }
  return chosen[0] as string;
}

/** Detects the filesystem so the right read-only mount options are used. */
export async function detectFilesystem(device: string, exec: Exec = execProcess): Promise<string> {
  const probed = await exec("blkid", ["-o", "value", "-s", "TYPE", device]);
  const fs = probed.stdout.trim();
  if (probed.code !== 0 || fs.length === 0) {
    throw new ScanRefusedError("FILESYSTEM_UNKNOWN", `blkid could not identify ${device}`);
  }
  return fs;
}

export async function mountReadOnly(
  device: string,
  filesystem: string,
  exec: Exec = execProcess,
): Promise<void> {
  await mkdir(MOUNT_POINT, { recursive: true });
  // `ro` is the whole security posture of this container, and `noexec`/`nosuid`/
  // `nodev` stop anything on a hostile customer disk from being run by accident.
  const options = ["ro", "noexec", "nosuid", "nodev"];
  // XFS refuses to mount a filesystem whose UUID already exists on the host, and
  // a snapshot copy is by definition a UUID duplicate. Without nouuid, every
  // Amazon Linux 2023 root volume fails to mount.
  if (filesystem === "xfs") options.push("nouuid");
  const mounted = await exec("mount", ["-t", filesystem, "-o", options.join(","), device, MOUNT_POINT], {
    timeoutMs: 120_000,
  });
  if (mounted.code !== 0) {
    throw new ScanRefusedError("MOUNT_FAILED", mounted.stderr.trim() || `exit ${mounted.code}`);
  }
  const entries = await readdir(MOUNT_POINT);
  if (entries.length === 0) {
    // An empty mount is almost always the wrong device rather than an empty disk.
    throw new ScanRefusedError("MOUNT_EMPTY", `${MOUNT_POINT} is empty after mounting ${device}`);
  }
}

/**
 * Refreshes the vulnerability database and REFUSES if it could not be refreshed.
 * Trivy scans happily against a stale or absent DB and reports zero findings,
 * which would be published as "this disk is clean".
 */
export async function updateTrivyDatabase(exec: Exec = execProcess): Promise<string> {
  const updated = await exec("trivy", ["image", "--download-db-only"], { timeoutMs: 10 * 60 * 1000 });
  if (updated.code !== TRIVY_OK) {
    throw new ScanRefusedError(
      "VULN_DB_UNAVAILABLE",
      `refusing to scan with an unrefreshed database: ${updated.stderr.trim() || `exit ${updated.code}`}`,
    );
  }
  return new Date().toISOString();
}

export async function runTrivy(exec: Exec = execProcess): Promise<unknown> {
  const scanned = await exec("trivy", [
    "rootfs",
    "--format", "json",
    "--scanners", "vuln,secret,misconfig",
    // Skip our own cache so the report never describes the scanner's own files.
    "--skip-dirs", "/var/cache/trivy",
    "--quiet",
    MOUNT_POINT,
  ], { timeoutMs: 60 * 60 * 1000 });
  if (scanned.code !== TRIVY_OK) {
    throw new ScanRefusedError("TRIVY_FAILED", scanned.stderr.trim() || `exit ${scanned.code}`);
  }
  try {
    return JSON.parse(scanned.stdout);
  } catch {
    throw new ScanRefusedError("TRIVY_UNPARSABLE", "trivy did not return JSON on stdout");
  }
}

export async function runScan(exec: Exec = execProcess): Promise<RunResult> {
  const device = await resolveScanDevice(exec);
  const filesystem = await detectFilesystem(device, exec);
  await mountReadOnly(device, filesystem, exec);
  const trivyDbUpdatedAt = await updateTrivyDatabase(exec);
  const parsed = parseTrivyReport(await runTrivy(exec));
  return {
    findings: parsed.findings,
    summary: { ...parsed.summary },
    device,
    filesystem,
    trivyDbUpdatedAt,
  };
}

/* c8 ignore start — process wiring, exercised by the container not by unit tests */
const invokedDirectly = process.argv[1] !== undefined
  && (await stat(process.argv[1]).catch(() => null)) !== null
  && process.argv[1].endsWith("scan-entrypoint.js");

if (invokedDirectly) {
  try {
    const result = await runScan();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (error) {
    // Structured on stderr so the orchestrator records WHY rather than inferring
    // "clean" from an empty result.
    const code = error instanceof ScanRefusedError ? error.code : "UNEXPECTED";
    process.stderr.write(`${JSON.stringify({
      refused: true,
      code,
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exit(1);
  }
}
/* c8 ignore stop */
