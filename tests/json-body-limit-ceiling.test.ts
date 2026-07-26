import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  MAX_CONFIGURABLE_JSON_BODY_LIMIT,
  PilotSecurityError,
  readBoundedJson,
} from "../lib/aws-pilot-security.ts";

function isPilotError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof PilotSecurityError && error.code === code;
}

function jsonRequest(body: string): Request {
  return new Request("https://sutra.example/api/v1/kubernetes/scans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

/**
 * The browser upload path (app/kubernetes/kubernetes-onboarding.tsx) rejects files
 * over 2.75 MiB before POSTing, so the route's 3 MiB bound must be a limit the
 * reader actually accepts rather than one it refuses before reading the body.
 */
const KUBERNETES_SCAN_BODY_BYTES = 3 * 1024 * 1024;

test("the configurable ceiling admits the Kubernetes scan route's declared bound", async () => {
  const parsed = await readBoundedJson(
    jsonRequest(JSON.stringify({ artifact: "ok" })),
    KUBERNETES_SCAN_BODY_BYTES,
  );
  assert.deepEqual(parsed, { artifact: "ok" });
  assert.ok(KUBERNETES_SCAN_BODY_BYTES <= MAX_CONFIGURABLE_JSON_BODY_LIMIT);
});

test("a limit above the configurable ceiling is rejected before the body is read", async () => {
  await assert.rejects(
    readBoundedJson(jsonRequest("{}"), MAX_CONFIGURABLE_JSON_BODY_LIMIT + 1),
    isPilotError("INVALID_INPUT"),
  );
  await assert.rejects(
    readBoundedJson(jsonRequest("{}"), 8 * 1024 * 1024),
    isPilotError("INVALID_INPUT"),
  );
  await assert.rejects(readBoundedJson(jsonRequest("{}"), 0), isPilotError("INVALID_INPUT"));
  await assert.rejects(readBoundedJson(jsonRequest("{}"), 1.5), isPilotError("INVALID_INPUT"));
});

test("the ceiling still bounds a body that exceeds the caller's own limit", async () => {
  await assert.rejects(
    readBoundedJson(
      jsonRequest(JSON.stringify({ padding: "x".repeat(4096) })),
      1024,
    ),
    isPilotError("INVALID_INPUT"),
  );
});

const ROOTS = ["app", "lib", "services"] as const;
const READER_CALL = /\b(?:readBoundedJson|readAuthJson)\(\s*[A-Za-z_$][\w$]*\s*,\s*([^),]+)\)/gu;

async function sourceFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * The single documented pass-through: readAuthJson forwards its caller's bound
 * verbatim, and those call sites are checked where they appear. Any other
 * unresolvable limit must fail the test rather than be silently skipped.
 */
const PASS_THROUGH = new Set([`${path.join("lib", "auth-http.ts")}: maximumBytes`]);

function byteCount(literal: string): number {
  return literal
    .split("*")
    .reduce((total, part) => total * Number(part.replaceAll("_", "").trim()), 1);
}

/** Resolves `4096`, `8 * 1024`, `1_024` and named constants to a byte count. */
function resolveLimit(expression: string, constants: ReadonlyMap<string, number>): number | null {
  const trimmed = expression.trim();
  if (/^[\d_\s*]+$/u.test(trimmed)) return byteCount(trimmed);
  return constants.get(trimmed) ?? null;
}

test("no bounded-JSON caller may request a limit above the configurable ceiling", async () => {
  const offenders: string[] = [];
  let inspected = 0;
  const unresolved: string[] = [];

  const sources = new Map<string, string>();
  for (const root of ROOTS) {
    for (const file of await sourceFiles(root)) {
      sources.set(file, await readFile(file, "utf8"));
    }
  }

  // Byte constants are declared beside their route or exported from lib; one map
  // covers both because the names are unique across the tree.
  const constants = new Map<string, number>();
  for (const source of sources.values()) {
    for (const declaration of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([\d_\s*]+);/gu)) {
      constants.set(declaration[1], byteCount(declaration[2]));
    }
  }

  for (const [file, source] of sources) {
    for (const match of source.matchAll(READER_CALL)) {
      const expression = match[1].trim();
      const limit = resolveLimit(expression, constants);
      if (limit === null) {
        if (!PASS_THROUGH.has(`${file}: ${expression}`)) unresolved.push(`${file}: ${expression}`);
        continue;
      }
      inspected += 1;
      if (limit > MAX_CONFIGURABLE_JSON_BODY_LIMIT) {
        offenders.push(`${file}: ${expression} = ${limit} bytes`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `readBoundedJson rejects any limit above ${MAX_CONFIGURABLE_JSON_BODY_LIMIT} bytes before reading the body, ` +
      `so these call sites would fail every request:\n${offenders.join("\n")}`,
  );
  // A regex that stops matching call sites would make this test vacuously green.
  assert.ok(inspected >= 20, `expected to resolve at least 20 call sites, resolved ${inspected}`);
  assert.deepEqual(
    unresolved,
    [],
    `these bounded-JSON limits could not be resolved to a byte count and so went unchecked:\n${unresolved.join("\n")}`,
  );
});
