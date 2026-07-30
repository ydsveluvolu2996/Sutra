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
  assert.match(html, /<title>Sutra — AWS CMDB &amp; Kubernetes Security for MSPs<\/title>/i);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.sutracmdb\.com\/"\/>/i);
  assert.match(html, /type="application\/ld\+json"[^>]*>[^<]*"SoftwareApplication"/i);
  assert.match(html, /See every risk/i);
  // The access posture is a product claim, not decoration, so the landing page has
  // to state it and state it accurately. "By default" is load-bearing: agentless
  // disk scanning is an opt-in that can create snapshots, so an unqualified
  // "read-only" would be false for any customer who enables it.
  assert.match(html, /Read-only by default/i);
  // The stronger promise, and the one a prospect actually cares about: enabling
  // that opt-in still cannot cost them a resource. If this disappears from the
  // page, the page is no longer making the commitment the IAM template enforces.
  assert.match(html, /never able to delete anything|explicit deny on all deletes/i);
  assert.match(html, /Cloud security, woven together/i);
  assert.match(html, /Runtime-informed issues/i);
  assert.match(html, /Book a walkthrough/i);
  assert.match(html, /Prove every path/i);
  assert.match(html, /Why teams choose Sutra/i);
  assert.doesNotMatch(html, /private beta/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("server-renders an authentication gate without leaking protected route data", async () => {
  const routes = ["/dashboard", "/customers", "/cmdb", "/cmdb/resource?key=demo", "/changes", "/findings", "/network-exposure", "/iac-scan", "/security-events", "/cases", "/cases/routing", "/compliance", "/compliance-frameworks", "/costs", "/reports", "/controls", "/roadmap", "/onboard", "/kubernetes/fleet", "/kubernetes/attack-paths", "/kubernetes/issues", "/kubernetes/permissions", "/kubernetes/iam", "/kubernetes/trends", "/kubernetes/vulnerability-updates", "/kubernetes/vulnerability-management", "/kubernetes/drift", "/settings"];

  for (const pathname of routes) {
    const response = await render(pathname);
    assert.equal(response.status, 200, pathname);
    const html = await response.text();
    assert.match(html, /Opening your protected workspace/i, pathname);
    assert.doesNotMatch(html, /Your AWS pilot workspace|AWS resource inventory|Onboard one AWS account/i, pathname);
  }
});

test("server-renders the authentication and MFA entry routes", async () => {
  const login = await render("/login");
  assert.equal(login.status, 200);
  assert.match(await login.text(), /Checking your workspace/i);

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
