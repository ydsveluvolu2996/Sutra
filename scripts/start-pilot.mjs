import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const variablesPath = resolve(root, ".dev.vars");

function parseVariables(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(".dev.vars contains an invalid line");
    const key = line.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) throw new Error(".dev.vars contains an invalid key");
    result[key] = line.slice(separator + 1);
  }
  return result;
}

const variables = parseVariables(await readFile(variablesPath, "utf8"));
const environment = { ...process.env, ...variables };
const webHost = environment.SUTRA_WEB_HOST ?? "127.0.0.1";

const collector = spawn(process.execPath, [resolve(root, "services/aws-collector/dist/src/local-server.js")], {
  cwd: root,
  env: environment,
  stdio: "inherit",
});
const web = spawn(resolve(root, "node_modules/.bin/wrangler"), [
  "dev",
  "--config", resolve(root, "dist/server/wrangler.json"),
  "--env-file", variablesPath,
  "--ip", webHost,
  "--port", "3000",
  "--show-interactive-dev-session", "false",
], {
  cwd: root,
  env: { ...environment, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
  stdio: "inherit",
});

let closing = false;
function stop(signal = "SIGTERM") {
  if (closing) return;
  closing = true;
  collector.kill(signal);
  web.kill(signal);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stop(signal));

const exit = await Promise.race([
  new Promise((resolvePromise) => collector.once("exit", (code, signal) => resolvePromise({ name: "collector", code, signal }))),
  new Promise((resolvePromise) => web.once("exit", (code, signal) => resolvePromise({ name: "web", code, signal }))),
]);
stop();
await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
if (exit.code !== 0 && exit.signal === null) {
  process.stderr.write(`${exit.name} stopped unexpectedly (${exit.code}).\n`);
  process.exitCode = 1;
}
