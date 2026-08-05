import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
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
  // services/aws-collector is a NodeNext package that compiles to dist/, so its sources import each
  // other with the post-compilation `./x.js` specifier. A root test importing collector source
  // directly reads the raw .ts, where that specifier does not exist. Map it to the sibling .ts only
  // when the .js genuinely is not there, so a real emitted .js still wins.
  if (
    context.parentURL !== undefined &&
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.endsWith(".js")
  ) {
    const asJs = new URL(specifier, context.parentURL);
    const asTs = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (
      asJs.protocol === "file:" && !existsSync(fileURLToPath(asJs))
      && existsSync(fileURLToPath(asTs))
    ) {
      return { url: asTs.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const parsed = new URL(url);
  if (parsed.protocol === "file:" && parsed.pathname.endsWith(".ts")) {
    const source = await readFile(fileURLToPath(parsed), "utf8");
    return {
      format: "module",
      source: stripTypeScriptTypes(source, { mode: "transform" }),
      shortCircuit: true,
    };
  }
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
