import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const FIXTURE_POSTGRES_VOLUME = "sutra-local_sutra_postgres_data";
export const LIVE_POSTGRES_VOLUME = "sutra-live-aws_sutra_postgres_data";
export const PROTECTED_POSTGRES_VOLUMES = Object.freeze([
  FIXTURE_POSTGRES_VOLUME,
  LIVE_POSTGRES_VOLUME,
]);

async function existingProtectedPostgresVolumes() {
  const existing = [];
  for (const volume of PROTECTED_POSTGRES_VOLUMES) {
    try {
      await execFileAsync("docker", ["volume", "inspect", volume]);
      existing.push(volume);
    } catch (error) {
      if (error?.code !== 1) {
        throw new Error("Docker must be running before Sutra can protect or create its local database secret", { cause: error });
      }
    }
  }
  return existing;
}

export async function ensureDockerLocalEnvironment(root) {
  const stateDirectory = resolve(root, ".sutra");
  const environmentPath = resolve(stateDirectory, "docker.env");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700);

  let contents;
  try {
    contents = await readFile(environmentPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const retainedVolumes = await existingProtectedPostgresVolumes();
    if (retainedVolumes.length > 0) {
      throw new Error(
        `${retainedVolumes.join(", ")} exists but .sutra/docker.env is missing. Restore the original secret file; ` +
        "do not generate a replacement or delete the volume unless its database is intentionally discarded",
      );
    }
    const ownerPassword = randomBytes(32).toString("base64url");
    const appPassword = randomBytes(32).toString("base64url");
    const jobRunnerToken = randomBytes(32).toString("hex");
    contents = [
      `SUTRA_POSTGRES_OWNER_PASSWORD=${ownerPassword}`,
      `SUTRA_POSTGRES_APP_PASSWORD=${appPassword}`,
      `SUTRA_JOB_RUNNER_TOKEN=${jobRunnerToken}`,
      "",
    ].join("\n");
    await writeFile(environmentPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  await chmod(environmentPath, 0o600);

  const values = new Map();
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(".sutra/docker.env contains an invalid line");
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const ownerPassword = values.get("SUTRA_POSTGRES_OWNER_PASSWORD");
  const appPassword = values.get("SUTRA_POSTGRES_APP_PASSWORD");
  if (
    ownerPassword === undefined ||
    appPassword === undefined ||
    !/^[A-Za-z0-9_-]{43}$/u.test(ownerPassword) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(appPassword) ||
    ownerPassword === appPassword
  ) {
    throw new Error(".sutra/docker.env must contain distinct generated 256-bit owner and runtime passwords");
  }
  // Persist/reuse the background-job runner token. Older env files predate it, so
  // generate and append one on demand; reuse a present, valid token unchanged.
  let jobRunnerToken = values.get("SUTRA_JOB_RUNNER_TOKEN");
  if (jobRunnerToken === undefined) {
    jobRunnerToken = randomBytes(32).toString("hex");
    const separator = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
    await writeFile(environmentPath, `${separator}SUTRA_JOB_RUNNER_TOKEN=${jobRunnerToken}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
    await chmod(environmentPath, 0o600);
    values.set("SUTRA_JOB_RUNNER_TOKEN", jobRunnerToken);
  } else if (!/^[a-f0-9]{64}$/u.test(jobRunnerToken)) {
    throw new Error(".sutra/docker.env must contain a generated 256-bit hex SUTRA_JOB_RUNNER_TOKEN");
  }
  return { environmentPath, ownerPassword, appPassword, jobRunnerToken };
}
