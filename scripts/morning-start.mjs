#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { ensureDockerLocalEnvironment } from "./docker-local-env.mjs";

const root = resolve(import.meta.dirname, "..");
const argumentsSet = new Set(process.argv.slice(2));
const supportedArguments = new Set(["--rebuild"]);
for (const argument of argumentsSet) {
  if (!supportedArguments.has(argument)) {
    throw new Error("Use morning-start.mjs with no arguments or with --rebuild");
  }
}

function run(command, args, { capture = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        if (stdout.length < 16_384) stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        if (stderr.length < 16_384) stderr += chunk;
      });
    }
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise(stdout.trim());
      else {
        rejectPromise(new Error(
          `${command} exited ${signal ?? code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        ));
      }
    });
  });
}

async function imageExists(name) {
  try {
    await run("docker", ["image", "inspect", name], { capture: true });
    return true;
  } catch {
    return false;
  }
}

async function waitForHealth(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      const body = await response.json();
      if (response.ok && body?.ok === true) return body;
    } catch {
      // Docker Compose performs its own health wait; tolerate the short gap
      // between a healthy container and the loopback listener becoming visible.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Sutra did not become healthy at ${url} within 60 seconds`);
}

await run("docker", ["info", "--format", "{{.ServerVersion}}"], { capture: true });
const { environmentPath } = await ensureDockerLocalEnvironment(root);
const rebuildRequested = argumentsSet.has("--rebuild");
const localImageExists = await imageExists("sutra-local-app:latest");
const rebuild = rebuildRequested || !localImageExists;

process.stdout.write(
  rebuild
    ? "Starting Sutra and rebuilding the application image...\n"
    : "Starting Sutra with the existing validated application image...\n",
);

await run("docker", [
  "compose",
  "--env-file", environmentPath,
  "up",
  "--detach",
  "--wait",
  ...(rebuild ? ["--build"] : ["--no-build"]),
]);

const health = await waitForHealth("http://127.0.0.1:3000/api/healthz");
process.stdout.write([
  "",
  "Sutra is ready.",
  "Open: http://127.0.0.1:3000/login",
  `Health: ${health.ok === true ? "healthy" : "unknown"}`,
  "Stop later: pnpm morning:stop",
  "",
].join("\n"));
