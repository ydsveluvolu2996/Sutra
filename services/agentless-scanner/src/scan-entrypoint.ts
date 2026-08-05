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
import { mkdir, readFile, readdir, stat } from "node:fs/promises";

import { parseTrivyReport, type ParsedFinding } from "./trivy-report.js";

const MOUNT_POINT = "/mnt/scan";
const SCAN_DEVICE = "/dev/sutra-scan-device";
/** Trivy exits 0 with findings and 0 without; a non-zero exit is a real error. */
const TRIVY_OK = 0;

export interface RunResult {
  readonly findings: readonly ParsedFinding[];
  readonly summary: Record<string, number>;
  readonly device: string;
  readonly filesystem: string;
  readonly trivyDbUpdatedAt: string;
  readonly trivyJavaDbUpdatedAt: string;
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

interface TrivyDatabaseMetadata {
  readonly Version: number;
  readonly NextUpdate: string;
  readonly UpdatedAt: string;
  readonly DownloadedAt: string;
}

interface VerifiedTrivyDatabases {
  readonly vulnerabilityUpdatedAt: string;
  readonly javaUpdatedAt: string;
}

type ReadTextFile = (path: string) => Promise<string>;

const TRIVY_VULNERABILITY_DB_METADATA = "/var/cache/trivy/db/metadata.json";
const TRIVY_JAVA_DB_METADATA = "/var/cache/trivy/java-db/metadata.json";
const VULNERABILITY_DB_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const JAVA_DB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

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
 * Accepts only the single device node that the host resolved from the requested
 * EBS volume ID and explicitly granted read-only to this container. Resolving a
 * device from the container-wide block-device list would reintroduce ambiguity
 * and would require exposing the host's entire /dev tree.
 */
export function requiredScanDevice(
  configuredDevice = process.env.SUTRA_SCAN_DEVICE,
): string {
  if (configuredDevice !== SCAN_DEVICE) {
    throw new ScanRefusedError(
      "SCAN_DEVICE_NOT_BOUND",
      `SUTRA_SCAN_DEVICE must identify the exact read-only device ${SCAN_DEVICE}`,
    );
  }
  return configuredDevice;
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

function parseDatabaseMetadata(
  raw: string,
  label: "VULN" | "JAVA",
  nowMs: number,
  maxAgeMs: number,
): TrivyDatabaseMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ScanRefusedError(`${label}_DB_METADATA_INVALID`, "database metadata is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ScanRefusedError(`${label}_DB_METADATA_INVALID`, "database metadata is not an object");
  }
  const metadata = parsed as Record<string, unknown>;
  if (
    !Number.isSafeInteger(metadata.Version)
    || (metadata.Version as number) < 1
    || typeof metadata.NextUpdate !== "string"
    || typeof metadata.UpdatedAt !== "string"
    || typeof metadata.DownloadedAt !== "string"
  ) {
    throw new ScanRefusedError(`${label}_DB_METADATA_INVALID`, "database metadata fields are incomplete");
  }
  const updatedAtMs = Date.parse(metadata.UpdatedAt);
  const downloadedAtMs = Date.parse(metadata.DownloadedAt);
  const nextUpdateMs = Date.parse(metadata.NextUpdate);
  if (
    !Number.isFinite(updatedAtMs)
    || !Number.isFinite(downloadedAtMs)
    || !Number.isFinite(nextUpdateMs)
    || updatedAtMs > nowMs + MAX_CLOCK_SKEW_MS
    || downloadedAtMs > nowMs + MAX_CLOCK_SKEW_MS
    || nextUpdateMs < updatedAtMs
  ) {
    throw new ScanRefusedError(`${label}_DB_METADATA_INVALID`, "database metadata timestamps are invalid");
  }
  if (nowMs - updatedAtMs > maxAgeMs || nowMs - downloadedAtMs > maxAgeMs) {
    throw new ScanRefusedError(
      `${label}_DB_STALE`,
      `database exceeds the ${Math.floor(maxAgeMs / (60 * 60 * 1000))}-hour release freshness limit`,
    );
  }
  return metadata as unknown as TrivyDatabaseMetadata;
}

/**
 * Verifies the databases baked into the immutable release image.
 *
 * Production has no public OCI route. Runtime downloads are therefore forbidden:
 * the release build fetches both databases, and each scan reads Trivy's own
 * metadata and refuses stale, missing, malformed, or future-dated content.
 */
export async function verifyTrivyDatabases(
  readText: ReadTextFile = async (path) => readFile(path, "utf8"),
  nowMs = Date.now(),
): Promise<VerifiedTrivyDatabases> {
  let vulnerabilityRaw: string;
  let javaRaw: string;
  try {
    [vulnerabilityRaw, javaRaw] = await Promise.all([
      readText(TRIVY_VULNERABILITY_DB_METADATA),
      readText(TRIVY_JAVA_DB_METADATA),
    ]);
  } catch {
    throw new ScanRefusedError(
      "TRIVY_DATABASES_MISSING",
      "the immutable scanner image does not contain both required databases",
    );
  }
  const vulnerability = parseDatabaseMetadata(
    vulnerabilityRaw,
    "VULN",
    nowMs,
    VULNERABILITY_DB_MAX_AGE_MS,
  );
  const java = parseDatabaseMetadata(javaRaw, "JAVA", nowMs, JAVA_DB_MAX_AGE_MS);
  return {
    vulnerabilityUpdatedAt: new Date(Date.parse(vulnerability.UpdatedAt)).toISOString(),
    javaUpdatedAt: new Date(Date.parse(java.UpdatedAt)).toISOString(),
  };
}

export async function runTrivy(exec: Exec = execProcess): Promise<unknown> {
  const scanned = await exec("trivy", [
    "rootfs",
    "--format", "json",
    "--scanners", "vuln,secret,misconfig",
    // Production is private. These flags are both a network guarantee and a
    // fail-closed guarantee: only the already-verified immutable DBs may be used.
    "--skip-db-update",
    "--skip-java-db-update",
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

export async function runScan(
  exec: Exec = execProcess,
  device = requiredScanDevice(),
): Promise<RunResult> {
  const filesystem = await detectFilesystem(device, exec);
  await mountReadOnly(device, filesystem, exec);
  const databases = await verifyTrivyDatabases();
  const parsed = parseTrivyReport(await runTrivy(exec));
  return {
    findings: parsed.findings,
    summary: { ...parsed.summary },
    device,
    filesystem,
    trivyDbUpdatedAt: databases.vulnerabilityUpdatedAt,
    trivyJavaDbUpdatedAt: databases.javaUpdatedAt,
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
