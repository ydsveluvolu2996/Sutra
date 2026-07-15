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

async function run(command, args, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited ${signal ?? code}`));
    });
  });
}

try {
  await readFile(variablesPath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  await run(process.execPath, [resolve(root, "scripts/setup-local-pilot.mjs")]);
}

const variables = parseVariables(await readFile(variablesPath, "utf8"));
const environment = { ...process.env, ...variables };
await run(resolve(root, "node_modules/.bin/tsc"), ["-p", "services/aws-collector/tsconfig.json"], { env: environment });

const collector = spawn(process.execPath, [resolve(root, "services/aws-collector/dist/src/local-server.js")], {
  cwd: root,
  env: environment,
  stdio: "inherit",
});
const web = spawn(resolve(root, "node_modules/.bin/vinext"), ["dev"], {
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
