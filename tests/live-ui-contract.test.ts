import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { navGroups } from "../app/components/navigation-config.ts";
import { KUBERNETES_SECTION_KEYS } from "../app/kubernetes/kubernetes-sections.ts";

const root = path.resolve(import.meta.dirname, "..");

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

describe("hosted live UI contract", () => {
  it("backs every visible navigation destination with a real page", async () => {
    const dynamicKubernetesSections = new Set(KUBERNETES_SECTION_KEYS);
    for (const item of navGroups.flatMap((group) => group.items)) {
      const pathname = item.href.split(/[?#]/u, 1)[0] ?? "";
      const section = /^\/kubernetes\/([^/]+)$/u.exec(pathname)?.[1];
      const route = section !== undefined && dynamicKubernetesSections.has(section as never)
        ? path.join(root, "app/kubernetes/[section]/page.tsx")
        : path.join(root, "app", pathname.replace(/^\//u, ""), "page.tsx");
      assert.equal(await exists(route), true, `${item.label} points to missing route ${pathname}`);
    }
  });

  it("keeps the production operations destination on live APIs", async () => {
    const [operations, simulated, page] = await Promise.all([
      readFile(path.join(root, "app/operations/operations-browser.tsx"), "utf8"),
      readFile(path.join(root, "app/operations/simulated-operations-browser.tsx"), "utf8"),
      readFile(path.join(root, "app/operations/page.tsx"), "utf8"),
    ]);
    assert.match(operations, /health\?\.mode === "fixture"/u);
    assert.match(operations, /postPilot\("\/api\/pilot\/connections\/sync"/u);
    assert.doesNotMatch(operations, /fetch\("\/api\/local\//u);
    assert.match(simulated, /fetch\("\/api\/local\//u);
    assert.match(page, /title: "Collection runs"/u);
    assert.doesNotMatch(page, /Simulation runs/u);
  });

  it("server-gates every local fixture endpoint from hosted runtimes", async () => {
    const routes = [
      "app/api/local/fixtures/route.ts",
      "app/api/local/jobs/route.ts",
      "app/api/local/jobs/publish/route.ts",
      "app/api/local/jobs/simulated-sync/route.ts",
      "app/api/local/schedules/route.ts",
      "app/api/local/schedules/enabled/route.ts",
    ];
    for (const route of routes) {
      const source = await readFile(path.join(root, route), "utf8");
      const handlers = [...source.matchAll(/export async function (?:GET|POST|PUT|PATCH|DELETE)[^{]*\{([\s\S]*?)(?=export async function|$)/gu)];
      assert.ok(handlers.length > 0, `${route} has no route handler`);
      for (const handler of handlers) {
        assert.match(handler[1] ?? "", /try\s*\{\s*assertLocalSimulationRuntime\(\);/u, `${route} lacks the hosted-runtime gate`);
      }
    }
  });

  it("does not render sample metrics or fixture calls-to-action in live workspaces", async () => {
    const files = [
      "app/dashboard/page.tsx",
      "app/customers/customers-browser.tsx",
      "app/cmdb/inventory-browser.tsx",
      "app/findings/findings-browser.tsx",
      "app/compliance/compliance-browser.tsx",
    ];
    const source = (await Promise.all(files.map((file) => readFile(path.join(root, file), "utf8")))).join("\n");
    assert.doesNotMatch(source, /Run (?:another )?simulation/u);
    assert.doesNotMatch(source, /Preview — populated/u);
    assert.match(source, /No sample metrics/u);
  });

  it("pins the EC2 runtime to live AWS collection and disables local mode", async () => {
    const compose = await readFile(path.join(root, "deploy/ec2/compose.prod.yaml"), "utf8");
    assert.match(compose, /SUTRA_LOCAL_MODE: "false"/u);
    assert.match(compose, /SUTRA_COLLECTOR_MODE: live/u);
    assert.match(compose, /SUTRA_ALLOW_LIVE_AWS: "true"/u);
  });
});
