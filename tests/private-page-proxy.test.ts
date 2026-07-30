import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { register } from "node:module";
import { join, relative, resolve } from "node:path";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const {
  default: proxy,
  isPublicBrowserPath,
  PUBLIC_ASSET_PATHS,
  PUBLIC_PAGE_PATHS,
} = await import("../proxy.ts");

const root = resolve(import.meta.dirname, "..");

async function pageFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return pageFiles(path);
    return entry.isFile() && entry.name === "page.tsx" ? [path] : [];
  }));
  return nested.flat();
}

function routeFor(file: string): string {
  const route = relative(join(root, "app"), file)
    .replace(/\/page\.tsx$/u, "")
    .replace(/^page\.tsx$/u, "")
    .replace(/\[([^\]]+)\]/gu, "generated-$1");
  return route === "" ? "/" : `/${route}`;
}

test("every page route is generated into either the explicit public set or the private server gate", async () => {
  const pages = await pageFiles(join(root, "app"));
  assert.ok(pages.length > 50, "route discovery must not silently return a partial set");
  const discoveredPublic = new Set<string>();
  for (const file of pages) {
    const route = routeFor(file);
    const source = await readFile(file, "utf8");
    const appShellProtected = /<AppShell(?:\s|>)/u.test(source);
    assert.equal(
      isPublicBrowserPath(route),
      !appShellProtected,
      `${route} must be explicitly public iff it does not use AppShell`,
    );
    if (!appShellProtected) discoveredPublic.add(route);
  }
  assert.deepEqual(
    [...PUBLIC_PAGE_PATHS].sort(),
    [...discoveredPublic].sort(),
    "the public allowlist and generated page inventory must stay identical",
  );
});

test("the public asset allowlist exactly matches root public files and never uses an extension bypass", async () => {
  const publicEntries = await readdir(join(root, "public"), { withFileTypes: true });
  const rootAssets = publicEntries
    .filter((entry) => entry.isFile())
    .map((entry) => `/${entry.name}`)
    .sort();
  assert.deepEqual([...PUBLIC_ASSET_PATHS].sort(), rootAssets);
  assert.equal(isPublicBrowserPath("/kubernetes/workload/tenant-secret.txt"), false);
  assert.equal(isPublicBrowserPath("/cmdb/resource/tenant.json"), false);
});

test("an anonymous private page is redirected before rendering and cannot be cached", async () => {
  const response = await proxy(new Request(
    "https://app.sutracmdb.com/cmdb/resource?key=tenant-secret-resource",
    {
      headers: {
        accept: "text/html",
        "x-org-id": "org_should_never_render",
        "x-customer-id": "cust_should_never_render",
      },
    },
  ));
  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get("location"),
    "https://app.sutracmdb.com/login?next=%2Fcmdb%2Fresource%3Fkey%3Dtenant-secret-resource",
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.match(response.headers.get("vary") ?? "", /cookie/iu);
  const body = await response.text();
  assert.equal(body, "");
  assert.doesNotMatch(body, /org_should_never_render|cust_should_never_render|tenant-secret-resource/u);
});

test("public/auth pages and API callbacks pass through while forged session cookies do not", async () => {
  for (const pathname of [
    "/",
    "/login",
    "/accept-invite",
    "/contact",
    "/api/auth/saml/callback",
    "/api/v1/itsm/inbound/itc_callback",
    "/favicon.svg",
  ]) {
    assert.equal((await proxy(new Request(`https://app.sutracmdb.com${pathname}`))).status, 200, pathname);
  }
  const malformed = await proxy(new Request("https://app.sutracmdb.com/dashboard", {
    headers: { cookie: "sutra_session=short" },
  }));
  assert.equal(malformed.status, 307);
  const shaped = await proxy(new Request("https://app.sutracmdb.com/dashboard", {
    headers: { cookie: `sutra_session=${"A".repeat(43)}` },
  }));
  assert.equal(shaped.status, 307, "token shape alone is never authentication");
  assert.equal(
    (await proxy(new Request("https://app.sutracmdb.com/kubernetes/workload/tenant-secret.txt"))).status,
    307,
    "a private dynamic value containing a filename extension cannot bypass the gate",
  );
});
