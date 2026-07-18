import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Sutra public product site", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Sutra<\/title>/i);
  assert.match(html, /Every cloud and cluster risk/i);
  assert.match(html, /Read-only access/i);
  assert.match(html, /Evidence-backed security graph/i);
  assert.match(html, /Runtime-informed issues/i);
  assert.match(html, /View demo workspace/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("server-renders an authentication gate without leaking protected route data", async () => {
  const routes = ["/dashboard", "/customers", "/cmdb", "/cmdb/resource?key=demo", "/changes", "/findings", "/security-events", "/cases", "/compliance", "/costs", "/reports", "/controls", "/roadmap", "/onboard", "/kubernetes/fleet", "/kubernetes/attack-paths", "/kubernetes/issues", "/kubernetes/permissions", "/kubernetes/trends", "/kubernetes/vulnerability-updates", "/kubernetes/drift", "/settings"];

  for (const pathname of routes) {
    const response = await render(pathname);
    assert.equal(response.status, 200, pathname);
    const html = await response.text();
    assert.match(html, /Opening your protected workspace/i, pathname);
    assert.doesNotMatch(html, /Your AWS pilot workspace|AWS resource inventory|Onboard one AWS account/i, pathname);
  }
});

test("server-renders the local login and MFA entry routes", async () => {
  const login = await render("/login");
  assert.equal(login.status, 200);
  assert.match(await login.text(), /Checking your local workspace/i);

  const mfa = await render("/mfa/setup");
  assert.equal(mfa.status, 200);
  assert.match(await mfa.text(), /Protecting your session/i);
});

test("removes starter-only preview infrastructure", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
  assert.match(layout, /Sutra/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});
