import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ensureDockerLocalEnvironment } from "./docker-local-env.mjs";

if (!process.argv.includes("--confirm-reset")) {
  throw new Error("PostgreSQL reset is destructive. Re-run with --confirm-reset");
}

const root = resolve(import.meta.dirname, "..");
const { environmentPath } = await ensureDockerLocalEnvironment(root);

async function run(args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn("docker", ["compose", "--env-file", environmentPath, ...args], { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`docker compose ${args[0]} exited ${signal ?? code}`));
    });
  });
}

await run(["stop", "app"]);
await run([
  "exec", "-T", "postgres", "psql", "--username", "sutra_owner", "--dbname", "postgres",
  "--set", "ON_ERROR_STOP=1",
  "--command", "DROP DATABASE IF EXISTS sutra WITH (FORCE)",
  "--command", "CREATE DATABASE sutra OWNER sutra_owner",
]);
// The long-running app intentionally has no owner credential. Recreate the
// schema through the one-shot owner-only migration service before it starts.
await run(["run", "--rm", "--no-deps", "migrate"]);
await run([
  "run", "--rm", "--no-deps", "--entrypoint", "node", "app",
  "scripts/reset-docker-app-state.mjs",
]);
await run(["up", "-d", "--wait", "app"]);
process.stdout.write("Reset Sutra PostgreSQL and collector/application state, then restarted the application.\n");
