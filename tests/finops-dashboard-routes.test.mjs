import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const vite = await createServer({
  root,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
const presentation = await vite.ssrLoadModule("/app/costs/dashboards/dashboard-catalog-presentation.ts");
const catalog = await vite.ssrLoadModule("/lib/finops-dashboard-catalog.ts");
const slugPage = await vite.ssrLoadModule("/app/costs/dashboards/[slug]/page.tsx");
after(async () => vite.close());

const [slugSource, indexSource, railSource, viewSource] = await Promise.all([
  readFile(path.join(root, "app/costs/dashboards/[slug]/page.tsx"), "utf8"),
  readFile(path.join(root, "app/costs/dashboards/page.tsx"), "utf8"),
  readFile(path.join(root, "app/costs/dashboards/finops-dashboard-rail.tsx"), "utf8"),
  readFile(path.join(root, "app/costs/dashboards/[slug]/finops-dashboard-route-view.tsx"), "utf8"),
]);

test("the route set is exactly the catalog, with one URL per dashboard", () => {
  const params = slugPage.generateStaticParams();
  assert.equal(params.length, 29);
  const slugs = params.map(({ slug }) => slug);
  assert.deepEqual(
    [...slugs].sort(),
    catalog.FINOPS_DASHBOARD_CATALOG.map(({ slug }) => slug).sort(),
  );
  assert.equal(new Set(slugs).size, 29, "slugs must be unique so a URL is unambiguous");
  for (const slug of slugs) {
    assert.match(slug, /^[a-z][a-z0-9-]*$/u, slug);
  }
});

test("hrefs are derived from the catalog slug", () => {
  assert.equal(presentation.finopsDashboardHref("cudos"), "/costs/dashboards/cudos");
  for (const dashboard of catalog.FINOPS_DASHBOARD_CATALOG) {
    assert.equal(
      presentation.finopsDashboardHref(dashboard.slug),
      `/costs/dashboards/${dashboard.slug}`,
    );
  }
});

test("an unknown or non-canonical slug is a 404 rather than a partial render", async () => {
  // notFound() throws a Next.js control-flow error; the important contract is
  // that the page refuses to resolve rather than rendering an empty shell.
  for (const slug of ["unknown", "", "../secrets", "cudos-extra"]) {
    await assert.rejects(
      async () => slugPage.default({ params: Promise.resolve({ slug }) }),
      (error) => error instanceof Error,
      slug,
    );
  }

  // An entry id is not a URL: only the canonical slug may resolve, so each
  // dashboard has exactly one address.
  const idOnly = catalog.FINOPS_DASHBOARD_CATALOG
    .filter((entry) => entry.id !== entry.slug)
    .map((entry) => entry.id);
  assert.ok(idOnly.length > 0, "expected at least one id that differs from its slug");
  for (const id of idOnly.slice(0, 5)) {
    await assert.rejects(
      async () => slugPage.default({ params: Promise.resolve({ slug: id }) }),
      (error) => error instanceof Error,
      id,
    );
  }
});

test("metadata comes from the catalog and degrades safely for an unknown slug", async () => {
  const known = await slugPage.generateMetadata({ params: Promise.resolve({ slug: "cudos" }) });
  assert.equal(known.title, "CUDOS Dashboard");
  assert.ok(typeof known.description === "string" && known.description.length > 20);

  const unknown = await slugPage.generateMetadata({ params: Promise.resolve({ slug: "nope" }) });
  assert.equal(unknown.title, "Cloud Intelligence dashboards");
  assert.equal(unknown.description, undefined);
});

test("maturity tallies are ordered, complete and carry an honest meaning", () => {
  const tallies = presentation.tallyMaturity(catalog.FINOPS_DASHBOARD_CATALOG);
  assert.equal(tallies.reduce((sum, tally) => sum + tally.count, 0), 29);
  // Only maturities actually present are listed, in proven-to-absent order.
  assert.deepEqual(
    tallies.map(({ maturity }) => maturity),
    ["LOCAL_VERTICAL_CANDIDATE", "PARTIAL_PIPELINE"],
  );
  assert.deepEqual(tallies.map(({ count }) => count), [15, 14]);
  assert.equal(presentation.tallyMaturity([]).length, 0);

  // A candidate badge must never read as production-ready.
  const meaning = presentation.FINOPS_MATURITY_MEANING.LOCAL_VERTICAL_CANDIDATE;
  assert.match(meaning, /Not production-ready and not live-accepted/u);
});

test("level grouping preserves the official three levels and their counts", () => {
  const groups = presentation.groupFinopsDashboardsByLevel();
  assert.deepEqual(groups.map(({ level }) => level), ["foundational", "advanced", "additional"]);
  assert.deepEqual(groups.map(({ dashboards }) => dashboards.length), [3, 13, 13]);
  for (const group of groups) {
    assert.ok(group.summary.length > 30, group.level);
    assert.equal(group.tallies.reduce((sum, t) => sum + t.count, 0), group.dashboards.length);
  }
});

test("routes are catalog-driven and never take a connection id from the URL", () => {
  // The dynamic segment is the dashboard slug only. A connection or tenant
  // identifier in the URL would let a caller choose someone else's scope.
  assert.match(slugSource, /params: Promise<\{ readonly slug: string \}>/u);
  assert.equal(/params[^)]*connectionId/u.test(slugSource), false);
  assert.equal(slugSource.includes("searchParams"), false);
  // The connection is resolved from the signed-in workspace state instead.
  assert.match(viewSource, /usePilotState\(\)/u);
  assert.match(viewSource, /state\?\.connection\?\.id \?\? null/u);
});

test("the index and rail render real links so dashboards are bookmarkable", () => {
  for (const source of [indexSource, railSource]) {
    assert.match(source, /from "next\/link"/u);
    assert.match(source, /finopsDashboardHref\(dashboard\.slug\)/u);
  }
  // The rail marks the current page for assistive technology.
  assert.match(railSource, /aria-current=\{active \? "page" : undefined\}/u);
  // Both are server components: no client directive, so no JS ships for them.
  assert.equal(indexSource.includes('"use client"'), false);
  assert.equal(railSource.includes('"use client"'), false);
});

test("the index uses the chart kit rather than a hand-rolled bar", () => {
  assert.match(indexSource, /from "\.\.\/\.\.\/components\/charts"/u);
  assert.match(indexSource, /<DonutChart/u);
  assert.match(indexSource, /<ShareBar/u);
  // Charts are labelled with what they measure, so a reader cannot mistake
  // delivery maturity for spend or source health.
  assert.match(indexSource, /Delivery maturity across/u);
  assert.match(indexSource, /delivery maturity/u);
});

test("every dashboard page states its official identifier and audience", () => {
  assert.match(slugSource, /dashboard\.catalogId/u);
  assert.match(slugSource, /dashboard\.targetAudience\.map/u);
  assert.match(slugSource, /FINOPS_MATURITY_MEANING\[dashboard\.currentMaturity\]/u);
  // Breadcrumbs place the dashboard in its official level.
  assert.match(slugSource, /FINOPS_DASHBOARD_LEVEL_LABEL\[dashboard\.level\]/u);
  assert.match(slugSource, /aria-label="Breadcrumb"/u);
});
