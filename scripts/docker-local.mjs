import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ensureDockerLocalEnvironment } from "./docker-local-env.mjs";

const root = resolve(import.meta.dirname, "..");
const action = process.argv[2];
const supported = new Set(["up", "down", "logs"]);
if (!supported.has(action)) throw new Error("Use docker-local.mjs with up, down, or logs");

const { environmentPath } = await ensureDockerLocalEnvironment(root);
const actionArguments = action === "up"
  ? ["up", "--build", "-d", "--wait"]
  : action === "down"
    ? ["down"]
    : ["logs", "--follow", "app", "postgres"];

await new Promise((resolvePromise, reject) => {
  const child = spawn(
    "docker",
    ["compose", "--env-file", environmentPath, ...actionArguments],
    { cwd: root, stdio: "inherit" },
  );
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) resolvePromise();
    else reject(new Error(`docker compose ${action} exited ${signal ?? code}`));
  });
});
