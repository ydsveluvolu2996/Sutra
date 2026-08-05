import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * The left navigation must expose the whole AWS Cloud Intelligence dashboard
 * catalog as level-grouped subsections of the FinOps group, without widening
 * capability gating and without inventing routes.
 */

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
after(async () => vite.close());

const [navigation, icons, catalog, presentation, shellSource] = await Promise.all([
  vite.ssrLoadModule("/app/components/navigation-config.ts"),
  vite.ssrLoadModule("/app/components/nav-icon.tsx"),
  vite.ssrLoadModule("/lib/finops-dashboard-catalog.ts"),
  vite.ssrLoadModule("/app/costs/dashboards/dashboard-catalog-presentation.ts"),
  readFile(new URL("../app/components/app-shell.tsx", import.meta.url), "utf8"),
]);

const { navGroups, visibleNavigation, groupContainsActiveItem, resolveActiveNavKey, finopsDashboardNavKey } = navigation;
const { FINOPS_DASHBOARD_CATALOG } = catalog;
const finops = navGroups.find((group) => group.key === "finops");
const dashboardItems = finops.items.filter((item) => item.href.startsWith("/costs/dashboards/"));

test("every catalog dashboard is a FinOps navigation destination on its existing route", () => {
  assert.equal(FINOPS_DASHBOARD_CATALOG.length, 29);
  assert.equal(dashboardItems.length, 29);

  for (const entry of FINOPS_DASHBOARD_CATALOG) {
    const item = finops.items.find((candidate) => candidate.key === finopsDashboardNavKey(entry.catalogId));
    assert.ok(item, `${entry.catalogId} has a navigation item`);
    assert.equal(item.href, presentation.finopsDashboardHref(entry.slug));
    assert.equal(item.href, `/costs/dashboards/${entry.slug}`);
    assert.equal(item.label, entry.shortName);
  }

  // The existing destinations keep their keys, labels and routes.
  assert.deepEqual(
    finops.items.slice(0, 3).map((item) => [item.key, item.label, item.href]),
    [
      ["costs", "AWS costs", "/costs"],
      ["showback", "Customer showback", "/costs/showback"],
      ["finops_dashboards", "All dashboards", "/costs/dashboards"],
    ],
  );
});

test("dashboards are grouped in the three official levels and nothing is hidden", () => {
  const labels = finops.sections.map((section) => section.label);
  assert.deepEqual(labels, ["Cost workspace", "Foundational", "Advanced", "Additional"]);

  // Level sections are collapsible; the workspace links stay always visible.
  assert.deepEqual(
    finops.sections.map((section) => section.collapsible === true),
    [false, true, true, true],
  );

  for (const level of presentation.FINOPS_DASHBOARD_LEVEL_ORDER) {
    const section = finops.sections.find((candidate) =>
      candidate.label === presentation.FINOPS_DASHBOARD_LEVEL_LABEL[level]);
    assert.deepEqual(
      section.keys,
      catalog.listFinopsDashboardsByLevel(level).map((entry) => finopsDashboardNavKey(entry.catalogId)),
      `${level} section lists exactly its catalog dashboards in catalog order`,
    );
  }

  // Every item is placed in exactly one section, so the group hides nothing.
  const sectionKeys = finops.sections.flatMap((section) => section.keys);
  assert.equal(sectionKeys.length, new Set(sectionKeys).size);
  assert.deepEqual([...sectionKeys].sort(), [...finops.items.map((item) => item.key)].sort());
});

test("each dashboard renders its catalog glyph in a tone-coloured chip", () => {
  for (const entry of FINOPS_DASHBOARD_CATALOG) {
    const navKey = finopsDashboardNavKey(entry.catalogId);
    const html = renderToStaticMarkup(createElement(icons.NavIcon, { navKey }));
    assert.match(html, /^<svg /u, `${entry.catalogId} renders an inline svg glyph`);
    assert.match(html, /viewBox="0 0 24 24"/u);
    assert.match(html, /aria-hidden="true"/u);
    // The glyph is the catalog's own icon, not a second hard-coded map.
    assert.equal(
      html,
      renderToStaticMarkup(createElement(icons.GlyphIcon, { name: entry.icon })),
      `${entry.catalogId} uses the catalog icon "${entry.icon}"`,
    );
    assert.equal(icons.navTone(navKey), entry.tone, `${entry.catalogId} uses the catalog tone`);
  }

  assert.match(shellSource, /className="nav-glyph-chip" data-tone=\{navTone\(item\.key\)\}/u);
});

test("the open dashboard is the item marked aria-current, gating untouched", () => {
  for (const entry of FINOPS_DASHBOARD_CATALOG) {
    assert.equal(
      resolveActiveNavKey("costs", `/costs/dashboards/${entry.slug}`),
      finopsDashboardNavKey(entry.catalogId),
    );
  }
  assert.equal(resolveActiveNavKey("costs", "/costs/dashboards"), "finops_dashboards");
  assert.equal(resolveActiveNavKey("costs", "/costs"), "costs");
  assert.equal(resolveActiveNavKey("showback", "/costs/dashboards/cudos"), "showback");
  assert.equal(resolveActiveNavKey("overview", "/costs/dashboards/cudos"), "overview");
  assert.equal(resolveActiveNavKey("costs", null), "costs");
  assert.equal(groupContainsActiveItem(finops, finopsDashboardNavKey("ADV-05")), true);

  // The rail marks the resolved destination, and the group opens for it.
  assert.match(shellSource, /resolveActiveNavKey\(active, usePathname\(\)\)/u);
  assert.match(shellSource, /aria-current=\{isActive \? "page" : undefined\}/u);
  assert.match(shellSource, /aria-current=\{activeKey === item\.key \? "page" : undefined\}/u);
  // Native details/summary keeps the subsections keyboard operable.
  assert.match(shellSource, /<summary className="nav-subsection-label">/u);
});

test("dashboard destinations are gated no more permissively than /costs", () => {
  const costs = finops.items.find((item) => item.key === "costs");
  for (const item of [...dashboardItems, finops.items.find((entry) => entry.key === "finops_dashboards")]) {
    assert.deepEqual([...item.capabilities], [...costs.capabilities]);
  }

  const withoutConnectionRead = visibleNavigation(new Set(["workspace:read"]));
  assert.equal(withoutConnectionRead.some((group) => group.key === "finops"), false);

  const reader = visibleNavigation(new Set(["workspace:read", "connection:read"]))
    .find((group) => group.key === "finops");
  assert.equal(reader.items.length, 32);
});

test("the rail does not present delivery maturity as production readiness", () => {
  const serialised = JSON.stringify(navGroups);
  for (const maturity of Object.keys(presentation.FINOPS_MATURITY_LABEL)) {
    assert.doesNotMatch(serialised, new RegExp(maturity, "u"));
  }
  assert.doesNotMatch(shellSource, /currentMaturity|production ready|LIVE_ACCEPTED/u);
});
