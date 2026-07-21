import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appRoot = new URL("../app/", import.meta.url);
const page = readFileSync(new URL("docs/page.tsx", appRoot), "utf8");
const browser = readFileSync(new URL("docs/docs-browser.tsx", appRoot), "utf8");
const content = readFileSync(new URL("docs/docs-content.ts", appRoot), "utf8");
const kubernetesSections = readFileSync(new URL("kubernetes/kubernetes-sections.ts", appRoot), "utf8");

test("docs page renders inside AppShell and is static in-repo content", () => {
  assert.match(page, /import \{ AppShell \} from "\.\.\/components\/app-shell"/u);
  assert.match(page, /<AppShell active="[a-z_]+">/u);
  assert.match(page, /<DocsBrowser \/>/u);
  assert.match(page, /export const metadata/u);
  // The help center is static content, so it must NOT opt into force-dynamic.
  assert.doesNotMatch(page, /force-dynamic/u);
});

test("docs browser is a client component with in-page search + anchors", () => {
  assert.match(browser, /^"use client";/u);
  assert.match(browser, /type="search"/u);
  // In-page navigation uses hash anchors into the section ids.
  assert.match(browser, /href=\{`#\$\{section\.id\}`\}/u);
  assert.match(browser, /id=\{section\.id\}/u);
});

test("docs content never fetches or links anything external", () => {
  for (const [name, source] of [
    ["docs-browser", browser],
    ["docs-content", content],
    ["page", page],
  ]) {
    assert.doesNotMatch(source, /\bfetch\s*\(/u, `${name} must not call fetch`);
    assert.doesNotMatch(source, /https?:\/\//u, `${name} must not reference an external URL`);
  }
});

test("all documented sections are present", () => {
  const expected = [
    "getting-started",
    "core-concepts",
    "trust-read-only",
    "cmdb",
    "finops",
    "vulnerabilities",
    "detections-cases",
    "compliance",
    "kubernetes",
    "alerts",
    "patch",
    "operations",
    "public-api",
  ];
  for (const id of expected) {
    assert.match(content, new RegExp(`id:\\s*"${id}"`, "u"), `missing section ${id}`);
  }
});

test("every documented href resolves to a real in-app route", () => {
  const hrefs = [...content.matchAll(/href:\s*"([^"]+)"/gu)].map((match) => match[1]);
  assert.ok(hrefs.length >= 20, "expected the docs to link many routes");

  const validKubernetesSections = new Set(
    [...kubernetesSections.matchAll(/"([a-z0-9-]+)"/gu)].map((match) => match[1]),
  );

  for (const href of hrefs) {
    assert.ok(href.startsWith("/"), `href must be an internal route: ${href}`);
    // Strip any query/hash — only the path resolves to a page.
    const path = href.split(/[?#]/u)[0].replace(/^\//u, "");

    // A concrete page directory always wins.
    const pagePath = fileURLToPath(new URL(`${path}/page.tsx`, appRoot));
    if (existsSync(pagePath)) continue;

    // Otherwise Kubernetes uses a dynamic [section] route: /kubernetes/<section>
    // is valid when <section> is in the section allowlist.
    const kubeMatch = /^kubernetes\/([a-z0-9-]+)$/u.exec(path);
    assert.ok(
      kubeMatch !== null && validKubernetesSections.has(kubeMatch[1]),
      `href points to a nonexistent route: ${href}`,
    );
  }
});
