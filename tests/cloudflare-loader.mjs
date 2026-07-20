import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cloudflareWorkersStub = `data:text/javascript,${encodeURIComponent("export const env = {};")}`;

export function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: cloudflareWorkersStub, shortCircuit: true };
  }
  if (specifier.endsWith(".sql?raw") && context.parentURL !== undefined) {
    return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
  }
  if (
    context.parentURL !== undefined &&
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !/\.[A-Za-z0-9]+(?:\?.*)?$/u.test(specifier)
  ) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (candidate.protocol === "file:" && existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, shortCircuit: true };
    }
    // Directory (barrel) import: resolve `.../db` to `.../db/index.ts`.
    const indexCandidate = new URL(`${specifier}/index.ts`, context.parentURL);
    if (indexCandidate.protocol === "file:" && existsSync(fileURLToPath(indexCandidate))) {
      return { url: indexCandidate.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const parsed = new URL(url);
  if (parsed.protocol === "file:" && parsed.pathname.endsWith(".sql") && parsed.search === "?raw") {
    parsed.search = "";
    const source = await readFile(fileURLToPath(parsed), "utf8");
    return {
      format: "module",
      source: `export default ${JSON.stringify(source)};`,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
