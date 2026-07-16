import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const forbiddenPaths = [
  /^\.dev\.vars$/u,
  /^\.env$/u,
  /^\.env\.(?!example$)/u,
  /^\.sutra\//u,
  /(?:^|\/)docker\.env$/u,
  /(?:^|\/)(?:id_rsa|id_ed25519)$/u,
];
const forbiddenExtensions = new Set([".key", ".p12", ".pfx", ".pem"]);
const patterns = [
  { label: "AWS access key identifier", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { label: "private key material", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { label: "GitHub personal access token", pattern: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})\b/u },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u },
  { label: "OpenAI API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/u },
];

const { stdout } = await execFileAsync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  },
);
const paths = stdout.toString("utf8").split("\0").filter(Boolean);
const failures = [];

for (const path of paths) {
  if (forbiddenPaths.some((pattern) => pattern.test(path)) || forbiddenExtensions.has(extname(path))) {
    failures.push(`${path}: forbidden secret-bearing path`);
    continue;
  }
  const contents = await readFile(resolve(root, path));
  if (contents.length > 4 * 1024 * 1024 || contents.includes(0)) continue;
  const text = contents.toString("utf8");
  for (const candidate of patterns) {
    if (candidate.pattern.test(text)) failures.push(`${path}: ${candidate.label}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Repository secret scan failed:\n${failures.map((value) => `- ${value}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Repository secret scan passed for ${paths.length} source files.\n`);
}
