import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { inventoryRegistry } from "../lib/registry-inventory.ts";

const container = `sutra-registry-validation-${Date.now()}`;
let registry = "127.0.0.1:5001";

async function run(command, args, options = {}) {
  let output = "";
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${signal ?? code}: ${output}`)));
  });
  return output;
}

async function registryJson(path, headers = {}) {
  const response = await fetch(`http://${registry}${path}`, { headers });
  if (!response.ok) throw new Error(`Registry ${path} returned ${response.status}`);
  return { json: await response.json(), headers: response.headers };
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function seedOciManifest(name, tags) {
  const config = Buffer.from(JSON.stringify({
    architecture: "amd64", os: "linux",
    config: {}, rootfs: { type: "layers", diff_ids: [] },
  }));
  const configDigest = sha256(config);
  const startedUpload = await fetch(`http://${registry}/v2/${name}/blobs/uploads/`, { method: "POST" });
  if (startedUpload.status !== 202) throw new Error(`Blob upload start returned ${startedUpload.status}`);
  const location = startedUpload.headers.get("location");
  if (location === null) throw new Error("Registry blob upload omitted Location");
  const uploadUrl = new URL(location, `http://${registry}`);
  uploadUrl.searchParams.set("digest", configDigest);
  const uploaded = await fetch(uploadUrl, { method: "PUT", body: config });
  if (uploaded.status !== 201) throw new Error(`Blob upload returned ${uploaded.status}`);
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: config.length },
    layers: [],
  });
  for (const tag of tags) {
    const response = await fetch(`http://${registry}/v2/${name}/manifests/${tag}`, {
      method: "PUT",
      headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
      body: manifest,
    });
    if (response.status !== 201) throw new Error(`Manifest ${tag} upload returned ${response.status}`);
  }
}

let started = false;
try {
  await run("docker", ["run", "-d", "--rm", "--name", container, "-p", "127.0.0.1::5000", "registry:2"]);
  started = true;
  const portMapping = (await run("docker", ["port", container, "5000/tcp"])).trim();
  const port = /:(\d+)$/u.exec(portMapping)?.[1];
  if (port === undefined) throw new Error(`Docker did not publish the registry port: ${portMapping}`);
  registry = `127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`http://${registry}/v2/`);
      if (response.ok) break;
    } catch {
      if (attempt === 19) throw new Error("Local registry did not become ready");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  // Seed through the Registry v2 API. This exercises the same catalog/tag/
  // manifest evidence surface without weakening Docker Desktop's daemon-wide
  // TLS policy by adding an insecure-registry exception.
  await seedOciManifest("demo/app", ["v1", "latest"]);

  const catalog = await registryJson("/v2/_catalog");
  const repositories = [];
  for (const name of catalog.json.repositories ?? []) {
    const tagsResult = await registryJson(`/v2/${name}/tags/list`);
    const tags = [];
    for (const tag of tagsResult.json.tags ?? []) {
      const manifest = await registryJson(`/v2/${name}/manifests/${tag}`, {
        accept: [
          "application/vnd.oci.image.manifest.v1+json",
          "application/vnd.docker.distribution.manifest.v2+json",
          "application/vnd.docker.distribution.manifest.list.v2+json",
        ].join(", "),
      });
      tags.push({
        tag,
        digest: manifest.headers.get("docker-content-digest"),
        mediaType: manifest.headers.get("content-type"),
      });
    }
    repositories.push({ name, tags });
  }
  const result = inventoryRegistry({ repositories, fetchedAt: new Date().toISOString() });
  if (result.coverage !== "complete") throw new Error("Registry validation unexpectedly has unknown coverage");
  if (!result.findings.some((finding) => finding.kind === "latest-tag-in-use" && finding.repository === "demo/app")) {
    throw new Error("The latest-tag policy finding was not produced");
  }
  if (!result.digests.some((entry) => entry.repository === "demo/app" && entry.tag === "v1" && entry.digest.startsWith("sha256:"))) {
    throw new Error("The v1 digest inventory was not produced");
  }
  process.stdout.write(`Validated ${result.repositoriesObserved} repository, ${result.digests.length} digest observations, and ${result.findings.length} policy findings against a live registry:2 container.\n`);
  process.stdout.write("Inventory and tag/digest policy are proven. Image CVE scanning remains gated on a verified Trivy runtime.\n");
} finally {
  if (started) await run("docker", ["rm", "-f", container]).catch(() => undefined);
}
