import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

// `"use client"` only takes effect as the FIRST statement of a module. An import
// placed above it makes the directive inert, so the component is treated as a
// server component -- and every one of these calls useState or useEffect, which
// throws in the browser.
//
// This is not hypothetical. A codemod that prepended an import to three client
// components shipped exactly that break to main: the FinOps costs browser, the
// security-events browser and the operations browser all had the directive
// demoted to line 2. Typecheck, lint, the full test suite and the production
// build all passed, because none of them execute the client entry point.

async function tsxFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith(".tsx") || entry.name.endsWith(".ts") ? [path] : [];
  }));
  return found.flat();
}

test("every 'use client' directive is the first statement in its module", async () => {
  const files = await tsxFiles(new URL("../app", import.meta.url).pathname);
  assert.ok(files.length > 100, "the app tree must actually be walked");

  const offenders = [];
  for (const path of files) {
    const source = await readFile(path, "utf8");
    if (!source.includes("\"use client\"") && !source.includes("'use client'")) continue;
    // Skip comments and blank lines; the directive must be the first thing that
    // is not one of those.
    const firstStatement = source
      .replace(/^﻿/u, "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "" && !line.startsWith("//") && !line.startsWith("/*") && !line.startsWith("*"));
    if (firstStatement !== "\"use client\";" && firstStatement !== "'use client';") {
      offenders.push(`${path.split("/app/")[1]}: first statement is ${firstStatement}`);
    }
  }
  assert.deepEqual(offenders, []);
});
