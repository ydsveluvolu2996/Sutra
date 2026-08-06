import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
after(async () => vite.close());

const { CaseHistoryChart } = await vite.ssrLoadModule(
  "/app/costs/finops-aws-support-cases-radar-dashboard.tsx",
);

const point = (over) => ({
  generationId: "gen-1",
  observedAt: "2026-08-01T00:00:00Z",
  dataThroughAt: "2026-08-01T00:00:00Z",
  collectionState: "COMPLETE",
  intendedAccountCount: 3,
  completeAccountCount: 3,
  caseCount: 5,
  openCount: 2,
  highUrgentCriticalCount: 1,
  ...over,
});

const render = (history) => renderToStaticMarkup(createElement(CaseHistoryChart, { history }));

test("a generation that observed zero cases is plotted as zero, not as a stub", () => {
  const html = render([
    point({ generationId: "a", observedAt: "2026-08-02T00:00:00Z", caseCount: 0, openCount: 0 }),
    point({ generationId: "b", caseCount: 5, openCount: 2 }),
  ]);
  assert.match(html, /<svg/u);
  // The old floor guaranteed every point drew; a real zero must now reach the axis.
  assert.ok(html.includes("0"), "the measured zero lost its value");
});

test("an all-zero history still renders a figure rather than reading as absent", () => {
  const html = render([
    point({ generationId: "a", caseCount: 0, openCount: 0 }),
    point({ generationId: "b", observedAt: "2026-08-02T00:00:00Z", caseCount: 0, openCount: 0 }),
  ]);
  assert.match(html, /<svg/u);
  assert.doesNotMatch(html, /No accepted generation/u);
});

test("no accepted generation is absence, and stays a worded state", () => {
  const html = render([]);
  assert.match(html, /No accepted generation has been observed yet/u);
  assert.doesNotMatch(html, /<svg/u);
});

test("both retained and open counts are charted, and the irregular cadence is disclosed", () => {
  const html = render([
    point({ generationId: "a", observedAt: "2026-08-02T00:00:00Z" }),
    point({ generationId: "b" }),
  ]);
  assert.ok(html.includes("Retained cases"), "retained series missing");
  assert.ok(html.includes("Open cases"), "open series missing");
  assert.match(html, /spacing does not represent elapsed time/u);
});

test("a single observation is not drawn as a trend", () => {
  // One accepted generation is not a trend, and interpolating a line through it
  // would invent a slope the evidence does not support.
  const html = render([point({})]);
  assert.match(html, /Only one observation is available/u);
  assert.doesNotMatch(html, /<path/u, "a single point must not be drawn as a line");
});

test("points are ordered oldest first, matching the observation order the caption claims", () => {
  // report.history arrives newest first; the chart reverses it.
  const html = render([
    point({ generationId: "new", observedAt: "2026-08-09T00:00:00Z", caseCount: 9 }),
    point({ generationId: "old", observedAt: "2026-08-01T00:00:00Z", caseCount: 1 }),
  ]);
  assert.ok(
    html.indexOf("2026-08-01") < html.indexOf("2026-08-09"),
    "the oldest generation must be plotted first",
  );
});
