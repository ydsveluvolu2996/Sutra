import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
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

async function productionSourceFiles(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["dist", "fixtures", "node_modules", "test", "tests"].includes(entry.name)) {
      continue;
    }
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await productionSourceFiles(candidate));
    else if (/\.(?:mjs|ts|tsx)$/u.test(entry.name)) files.push(candidate);
  }
  return files;
}

describe("hosted live UI contract", () => {
  it("never emits links for the retired app.sutracmdb.com host", async () => {
    const files = (
      await Promise.all(
        ["app", "db", "lib", "services"].map((directory) =>
          productionSourceFiles(path.join(root, directory))),
      )
    ).flat();
    for (const file of files) {
      const source = await readFile(file, "utf8");
      assert.equal(
        source.includes("https://app.sutracmdb.com"),
        false,
        `${path.relative(root, file)} emits the retired production origin`,
      );
    }
  });

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
    assert.doesNotMatch(operations, /SimulatedOperationsBrowser/u);
    assert.doesNotMatch(operations, /health\?\.mode === "fixture"/u);
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
      "app/api/v1/collection-schedule/status/route.ts",
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

  it("does not claim a clean dashboard posture before evidence is published", async () => {
    const dashboard = await readFile(path.join(root, "app/dashboard/page.tsx"), "utf8");
    assert.match(dashboard, /const hasPublishedSnapshot =/u);
    assert.match(dashboard, /Score unavailable/u);
    assert.match(dashboard, /No finding snapshot published/u);
    assert.match(dashboard, /does not infer a clean posture before the first complete collection/u);
  });

  it("rejects simulated workspace evidence from hosted API responses", async () => {
    const [stateRoute, portfolioRoute, pilotServer] = await Promise.all([
      readFile(path.join(root, "app/api/pilot/state/route.ts"), "utf8"),
      readFile(path.join(root, "app/api/v1/portfolio/route.ts"), "utf8"),
      readFile(path.join(root, "lib/pilot-server.ts"), "utf8"),
    ]);
    assert.match(stateRoute, /allowSimulatedEvidence = isLocalSimulationRuntime\(\)/u);
    assert.match(stateRoute, /connection\.sourceKind === "simulated_fixture"/u);
    assert.match(portfolioRoute, /portfolioForRuntime\(portfolio, isLocalSimulationRuntime\(\)\)/u);
    assert.match(pilotServer, /!isLocalSimulationRuntime\(\) && health\.mode !== "live"/u);
  });

  it("does not publish social icons with placeholder destinations", async () => {
    const landing = await readFile(path.join(root, "app/components/landing-zone.tsx"), "utf8");
    assert.doesNotMatch(landing, /href="#top" aria-label="(?:X|LinkedIn|RSS)"/u);
  });

  it("starts enterprise AWS onboarding without pilot labels or sample account data", async () => {
    const onboarding = await readFile(path.join(root, "app/onboard/onboard-account.tsx"), "utf8");
    assert.match(onboarding, /useState\(""\)/u);
    assert.doesNotMatch(onboarding, /useState\("Pilot Customer"\)/u);
    assert.doesNotMatch(onboarding, /useState\("123456789012"\)/u);
    assert.doesNotMatch(onboarding, /Checking the local pilot workspace/u);
    assert.doesNotMatch(onboarding, /This local pilot supports/u);
    assert.match(onboarding, /Each connection is bound to one approved customer workspace and one AWS account/u);
  });

  it("gives custom assets a professional page-level heading", async () => {
    const assets = await readFile(path.join(root, "app/cmdb/custom-assets-panel.tsx"), "utf8");
    assert.match(assets, /<h1>Custom &amp; external assets<\/h1>/u);
    assert.match(assets, /<h2>Import assets<\/h2>/u);
  });

  it("preserves the validated customer connection across desktop and mobile navigation", async () => {
    const shell = await readFile(path.join(root, "app/components/app-shell.tsx"), "utf8");
    assert.match(shell, /function scopedWorkspaceHref\(href: string, connectionId: string \| null\)/u);
    assert.match(shell, /url\.searchParams\.set\("connectionId", connectionId\)/u);
    assert.ok(shell.includes('href={scopedWorkspaceHref("/dashboard", selectedConnectionId)}'));
    assert.ok(shell.includes("href={scopedWorkspaceHref(item.href, selectedConnectionId)}"));
    assert.ok(shell.includes("href={scopedWorkspaceHref(item.href, connectionId)}"));
  });

  it("pins the EC2 runtime to live AWS collection and disables local mode", async () => {
    const compose = await readFile(path.join(root, "deploy/ec2/compose.prod.yaml"), "utf8");
    assert.match(compose, /SUTRA_LOCAL_MODE: "false"/u);
    assert.match(compose, /SUTRA_COLLECTOR_MODE: live/u);
    assert.match(compose, /SUTRA_ALLOW_LIVE_AWS: "true"/u);
  });
});
