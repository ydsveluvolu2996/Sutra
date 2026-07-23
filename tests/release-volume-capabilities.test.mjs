import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const releaseScript = readFileSync(
  new URL("../deploy/ec2/release-update.sh", import.meta.url),
  "utf8",
);
const helperImage = releaseScript.match(/^HELPER_IMAGE="([^"]+)"$/mu)?.[1];

function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("release volume helpers preserve restricted application state ownership", (t) => {
  assert.ok(helperImage, "release helper image must be pinned");
  try {
    docker(["info"]);
  } catch {
    t.skip("Docker is unavailable in this environment");
    return;
  }

  const volume = `sutra-release-capability-${process.pid}-${Date.now()}`;
  const stage = mkdtempSync(join(tmpdir(), "sutra-release-capability-"));
  // CI runs Node as an unprivileged user while the production snapshot stage
  // is created by root. Permit the isolated helper to create the test archive;
  // the capability boundary under test is the restricted named volume.
  chmodSync(stage, 0o733);
  t.after(() => {
    try {
      docker(["volume", "rm", "--force", volume]);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  docker(["volume", "create", volume]);
  docker([
    "run", "--rm", "--volume", `${volume}:/target`, helperImage,
    "sh", "-ec",
    "mkdir -p /target/private; printf evidence > /target/private/state; " +
      "chown -R 1000:1000 /target; chmod 0700 /target /target/private; " +
      "chmod 0600 /target/private/state",
  ]);

  docker([
    "run", "--rm", "--network", "none", "--read-only", "--user", "0:0",
    "--cap-drop", "ALL", "--cap-add", "DAC_READ_SEARCH",
    "--security-opt", "no-new-privileges:true",
    "--volume", `${volume}:/source:ro`, "--volume", `${stage}:/backup`, helperImage,
    "sh", "-ec", "tar -C /source -czf /backup/application-data.tar.gz .",
  ]);

  docker([
    "run", "--rm", "--network", "none", "--user", "0:0",
    "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--cap-add", "CHOWN",
    "--security-opt", "no-new-privileges:true",
    "--volume", `${volume}:/target`, "--volume", `${stage}:/backup:ro`, helperImage,
    "sh", "-ec",
    "find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; " +
      "tar -C /target -xzf /backup/application-data.tar.gz",
  ]);

  const result = docker([
    "run", "--rm", "--network", "none", "--read-only", "--user", "1000:1000",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--volume", `${volume}:/source:ro`, helperImage,
    "sh", "-ec",
    "test \"$(cat /source/private/state)\" = evidence; " +
      "stat -c '%u:%g:%a' /source/private /source/private/state",
  ]).trim().split("\n");

  assert.deepEqual(result, ["1000:1000:700", "1000:1000:600"]);
});
