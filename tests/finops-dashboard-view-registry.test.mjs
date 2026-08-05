import assert from "node:assert/strict";
import { after, test } from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
const registry = await vite.ssrLoadModule("/app/costs/finops-dashboard-views.tsx");
const catalog = await vite.ssrLoadModule("/lib/finops-dashboard-catalog.ts");
after(async () => vite.close());

const CATALOG_IDS = new Set(catalog.FINOPS_DASHBOARD_CATALOG.map(({ id }) => id));

/**
 * Dashboards deliberately without a dedicated view, presented through the shared
 * capability shell instead. Now empty: every catalogued dashboard has its own
 * view. Growing this list is a regression, so the shell is a fallback for a
 * future catalog addition rather than a standing gap.
 */
const SHELL_ONLY = [];

test("every registered view maps to a real catalog dashboard", () => {
  assert.ok(registry.FINOPS_DASHBOARD_VIEW_IDS.length > 0);
  for (const id of registry.FINOPS_DASHBOARD_VIEW_IDS) {
    assert.equal(CATALOG_IDS.has(id), true, id);
    assert.equal(typeof registry.getFinopsDashboardView(id), "function", id);
  }
  assert.equal(
    new Set(registry.FINOPS_DASHBOARD_VIEW_IDS).size,
    registry.FINOPS_DASHBOARD_VIEW_IDS.length,
  );
});

test("the registry and the shared shell together cover all 29 catalog rows", () => {
  const registered = new Set(registry.FINOPS_DASHBOARD_VIEW_IDS);
  const uncovered = [...CATALOG_IDS].filter((id) => !registered.has(id));
  assert.deepEqual(uncovered.sort(), [...SHELL_ONLY].sort());
  assert.equal(registered.size + uncovered.length, 29);
  assert.equal(registered.size, 29);
});

test("all three Foundational dashboards have a dedicated view", () => {
  // AWS recommends starting with the Foundational level, so these three must
  // never fall back to the generic capability shell.
  for (const id of ["cudos", "cost_intelligence_dashboard", "kpi_dashboard"]) {
    assert.equal(typeof registry.getFinopsDashboardView(id), "function", id);
  }
  const foundational = catalog.FINOPS_DASHBOARD_CATALOG
    .filter(({ level }) => level === "foundational")
    .map(({ id }) => id);
  assert.equal(foundational.length, 3);
  for (const id of foundational) {
    assert.notEqual(registry.getFinopsDashboardView(id), null, id);
  }
});

test("view lookup fails closed for unknown and inherited names", () => {
  assert.equal(registry.getFinopsDashboardView("unknown_dashboard"), null);
  assert.equal(registry.getFinopsDashboardView(""), null);
  // An inherited member name must never resolve to a view.
  for (const inherited of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
    assert.equal(registry.getFinopsDashboardView(inherited), null, inherited);
  }
});

test("the exported view id list is frozen", () => {
  assert.equal(Object.isFrozen(registry.FINOPS_DASHBOARD_VIEW_IDS), true);
});
