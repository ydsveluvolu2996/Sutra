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

const { DimensionBars, CostBreakdownChart } = await vite.ssrLoadModule(
  "/app/costs/finops-end-user-computing-dashboard.tsx",
);
const render = (component, props) => renderToStaticMarkup(createElement(component, props));

const dimension = (rows) => render(DimensionBars, {
  title: "WorkSpaces by running mode",
  rows,
  empty: "No WorkSpaces running-mode evidence for this selection.",
});

const breakdown = (rows) => render(CostBreakdownChart, { title: "Canonical cost by Region", rows });

const costRow = (over) => ({
  service: "WORKSPACES",
  currency: "USD",
  value: "us-east-1",
  lineCount: 4,
  displayTotal: { basis: "AMORTIZED", totalMicros: "2500000", coverage: "COMPLETE" },
  totals: [],
  ...over,
});

test("a measured zero stays plotted and keeps its exact value", () => {
  const html = dimension([
    { value: "ALWAYS_ON", count: 12 },
    { value: "AUTO_STOP", count: 0 },
  ]);
  assert.match(html, /AUTO_STOP|AUTO STOP/u);
  assert.ok(html.includes(">0<") || /\b0\b/u.test(html), "the measured zero lost its value");
});

test("an all-zero set is still a rendered measurement, not an empty panel", () => {
  const html = dimension([
    { value: "ALWAYS_ON", count: 0 },
    { value: "AUTO_STOP", count: 0 },
  ]);
  assert.doesNotMatch(html, /No WorkSpaces running-mode evidence/u);
  assert.match(html, /<svg/u, "measured zeros must still draw a figure");
});

test("absence stays a worded state rather than an empty chart", () => {
  const html = dimension([]);
  assert.match(html, /No WorkSpaces running-mode evidence/u);
  assert.doesNotMatch(html, /<svg/u);
});

test("each currency is charted separately and never shares an axis", () => {
  const html = breakdown([
    costRow({ currency: "USD", value: "us-east-1" }),
    costRow({ currency: "EUR", value: "eu-west-1", displayTotal: { basis: "AMORTIZED", totalMicros: "9000000", coverage: "COMPLETE" } }),
  ]);
  assert.ok(html.includes("EUR only"), "EUR is not isolated to its own chart");
  assert.ok(html.includes("USD only"), "USD is not isolated to its own chart");
});

test("a row with no canonical total is excluded and counted, never drawn as zero", () => {
  const html = breakdown([
    costRow({ value: "us-east-1" }),
    costRow({ value: "eu-west-1", displayTotal: null }),
  ]);
  assert.match(html, /1 row has no canonical total/u);
  assert.ok(!html.includes("eu-west-1"), "an unavailable row must not be plotted");
});

test("a total beyond exact double range is dropped rather than silently rounded", () => {
  const html = breakdown([
    costRow({ value: "huge", displayTotal: { basis: "AMORTIZED", totalMicros: "99999999999999999999", coverage: "COMPLETE" } }),
  ]);
  assert.doesNotMatch(html, /<svg/u, "an unplottable amount must not be charted");
});

test("the figure beside each bar is formatted from the original micros", () => {
  const html = breakdown([costRow({ displayTotal: { basis: "AMORTIZED", totalMicros: "2500000", coverage: "COMPLETE" } })]);
  assert.ok(html.includes("USD 2.50"), "the exact micros-derived amount is missing");
});
