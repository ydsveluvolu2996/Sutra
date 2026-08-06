import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = new URL("..", import.meta.url).pathname;
const vite = await createServer({
  root,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
after(async () => vite.close());

const { FinopsDashboardIdentity } = await vite.ssrLoadModule("/app/costs/finops-dashboard-identity.tsx");
const { FINOPS_DASHBOARD_CATALOG } = await vite.ssrLoadModule("/lib/finops-dashboard-catalog.ts");

const navIconSource = readFileSync(`${root}/app/components/nav-icon.tsx`, "utf8");
const render = (dashboard) => renderToStaticMarkup(createElement(FinopsDashboardIdentity, { dashboard }));

test("every catalog dashboard renders its glyph, catalog id, name and tone", () => {
  assert.equal(FINOPS_DASHBOARD_CATALOG.length, 29);
  for (const dashboard of FINOPS_DASHBOARD_CATALOG) {
    const html = render(dashboard);
    assert.match(html, /<svg/u, `${dashboard.catalogId} drew no glyph`);
    assert.ok(
      html.includes(`data-tone="${dashboard.tone}"`),
      `${dashboard.catalogId} lost its tone`,
    );
    assert.ok(html.includes(dashboard.catalogId), `${dashboard.catalogId} is not shown`);
    assert.ok(html.includes(`id="finops-dashboard-${dashboard.slug}"`),
      `${dashboard.catalogId} does not own the heading id the capability shell labels against`);
  }
});

test("the glyph chip is decorative, so the name carries the accessible identity", () => {
  const [first] = FINOPS_DASHBOARD_CATALOG;
  const html = render(first);
  // The chip repeats what the heading already says; announcing it twice is noise.
  assert.match(html, /aria-hidden="true"[^>]*nav-glyph-chip|nav-glyph-chip[^>]*aria-hidden="true"/u);
});

test("every icon the catalog names has a drawn glyph in the shared icon system", () => {
  for (const dashboard of FINOPS_DASHBOARD_CATALOG) {
    assert.ok(
      new RegExp(`^\\s{2}${dashboard.icon}:`, "mu").test(navIconSource),
      `${dashboard.catalogId} names icon "${dashboard.icon}", which has no drawn glyph`,
    );
  }
});

test("identity is rendered for every dashboard, not only those without a view", () => {
  const nav = readFileSync(`${root}/app/costs/finops-dashboard-catalog-nav.tsx`, "utf8");
  const identity = nav.indexOf("<FinopsDashboardIdentity");
  const branch = nav.indexOf("selectedView === null");
  assert.ok(identity > 0, "the catalog nav does not render the identity header");
  assert.ok(
    identity < branch,
    "identity must render above the view branch so a dashboard with a dedicated view still shows its icon and name",
  );
});

test("the capability shell no longer renders a second copy of the name", () => {
  const shell = readFileSync(`${root}/app/costs/finops-capability-shell.tsx`, "utf8");
  assert.ok(!shell.includes("{dashboard.name}"), "the shell still prints the dashboard name");
  assert.ok(
    shell.includes('aria-labelledby={`finops-dashboard-${dashboard.slug}`}'),
    "the shell must stay labelled by the identity heading",
  );
});
