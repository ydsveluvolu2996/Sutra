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
const kit = await vite.ssrLoadModule("/app/components/charts/index.ts");
after(async () => vite.close());

const money = (value) => `$${value.toFixed(2)}`;
const render = (component, props) => renderToStaticMarkup(createElement(component, props));

test("a trend chart renders an accessible figure with axes and exact values", () => {
  const html = render(kit.TimeSeriesChart, {
    ariaLabel: "Daily amortized cost for the last four days",
    formatValue: money,
    caption: "Amortized cost by UTC day.",
    series: [{
      id: "amortized",
      label: "Amortized",
      points: [
        { label: "Aug 1", value: 1200 },
        { label: "Aug 2", value: 1350 },
        { label: "Aug 3", value: 1180 },
        { label: "Aug 4", value: 1410 },
      ],
    }],
  });

  assert.match(html, /role="img"/u);
  assert.match(html, /aria-label="Daily amortized cost for the last four days"/u);
  assert.match(html, /<title>Daily amortized cost for the last four days<\/title>/u);
  assert.match(html, /<figcaption[^>]*>Amortized cost by UTC day\.<\/figcaption>/u);
  // The line is a real path, not a stack of divs.
  assert.match(html, /<path[^>]*d="M[\d.]+ [\d.]+ L/u);
  // Every exact value is available as text, not only as a picture.
  assert.match(html, /Show the exact values/u);
  for (const value of ["$1200.00", "$1350.00", "$1180.00", "$1410.00"]) {
    assert.ok(html.includes(value), value);
  }
  assert.ok(html.includes("Aug 1") && html.includes("Aug 4"));
});

test("missing observations break the line instead of being drawn as zero", () => {
  const html = render(kit.TimeSeriesChart, {
    ariaLabel: "Cost with an uncollected day",
    formatValue: money,
    series: [{
      id: "s",
      label: "Cost",
      points: [
        { label: "d1", value: 100 },
        { label: "d2", value: 110 },
        { label: "d3", value: null },
        { label: "d4", value: 120 },
        { label: "d5", value: 130 },
      ],
    }],
  });

  // Two separate line segments, so nothing is interpolated across the gap.
  assert.equal((html.match(/class="[^"]*line[^"]*"/gu) ?? []).length, 2);
  // The gap is reported honestly in the values table.
  assert.match(html, /Not collected/u);
  // A zero must not be introduced for the missing day.
  assert.equal(html.includes("$0.00"), false);
});

test("an isolated observation between gaps is marked so it cannot vanish", () => {
  const html = render(kit.TimeSeriesChart, {
    ariaLabel: "One collected day between gaps",
    formatValue: money,
    series: [{
      id: "s",
      label: "Cost",
      points: [
        { label: "d1", value: 5 },
        { label: "d2", value: null },
        { label: "d3", value: 50 },
        { label: "d4", value: null },
        { label: "d5", value: 9 },
      ],
    }],
  });
  assert.match(html, /<circle[^>]*r="2\.75"/u);
});

test("charts refuse to plot absent or insufficient evidence", () => {
  const empty = render(kit.TimeSeriesChart, {
    ariaLabel: "No evidence",
    formatValue: money,
    series: [],
  });
  assert.match(empty, /role="status"/u);
  assert.match(empty, /No plottable evidence/u);
  // The state must say an empty axis is not a zero.
  assert.match(empty, /not a measured zero/u);
  assert.equal(empty.includes("<svg"), false);

  const single = render(kit.TimeSeriesChart, {
    ariaLabel: "One period only",
    formatValue: money,
    series: [{ id: "s", label: "Cost", points: [{ label: "d1", value: 10 }] }],
  });
  assert.match(single, /Only one observation is available/u);
  assert.equal(single.includes("<svg"), false);
});

test("bar charts include the zero baseline and keep negative amounts signed", () => {
  const html = render(kit.BarChart, {
    ariaLabel: "Monthly net cost including credits",
    categories: ["Jun", "Jul", "Aug"],
    formatValue: money,
    series: [{ id: "net", label: "Net", values: [900, -150, 1200] }],
  });

  assert.match(html, /role="img"/u);
  assert.match(html, /<rect[^>]*class="[^"]*bar/u);
  // A credit is shown as a negative figure, never as an absolute value.
  assert.ok(html.includes("$-150.00"), "negative amount must retain its sign");
  // Bars are measured from zero, so a zero tick label must exist.
  assert.ok(html.includes(">$0.00<"), "expected a zero axis label");
  // Native tooltips carry the category and the value.
  assert.match(html, /<title>Jul · Net: \$-150\.00<\/title>/u);
});

test("stacking is refused for data containing negatives and falls back to grouped", () => {
  const stacked = render(kit.BarChart, {
    ariaLabel: "Stacked with a credit",
    categories: ["Jun", "Jul"],
    formatValue: money,
    layout: "stacked",
    series: [
      { id: "a", label: "Usage", values: [100, 200] },
      { id: "b", label: "Credits", values: [-40, -10] },
    ],
  });
  // A stack of mixed signs would produce a column height that means nothing, so
  // the chart must not claim a stacked total.
  assert.ok(stacked.includes("$-40.00"));
  assert.match(stacked, /<title>Jun · Credits: \$-40\.00<\/title>/u);

  const validStack = render(kit.BarChart, {
    ariaLabel: "Stacked service cost",
    categories: ["Jun", "Jul"],
    formatValue: money,
    layout: "stacked",
    series: [
      { id: "a", label: "EC2", values: [100, 200] },
      { id: "b", label: "S3", values: [50, 60] },
    ],
  });
  assert.equal((validStack.match(/<rect[^>]*class="[^"]*bar/gu) ?? []).length, 4);
});

test("ranking bars state their scale and truncate visibly", () => {
  const items = Array.from({ length: 20 }, (_unused, index) => ({
    id: `i${index}`,
    label: `Account ${index}`,
    value: 1000 - index * 10,
  }));
  const html = render(kit.RankingBars, {
    ariaLabel: "Top accounts by cost",
    items,
    formatValue: money,
    sort: true,
    maxItems: 5,
  });

  // The reader is told what a full-width bar means.
  assert.match(html, /Bar length is relative to the largest value shown, \$1000\.00\./u);
  // Truncation is disclosed rather than silent.
  assert.match(html, /15 further rows not drawn/u);
  // All 20 values remain available exactly.
  assert.ok(html.includes("$810.00"));
});

test("composition charts refuse negative parts and non-positive totals", () => {
  const negative = render(kit.DonutChart, {
    ariaLabel: "Composition with a credit",
    formatValue: money,
    slices: [{ id: "a", label: "Usage", value: 100 }, { id: "b", label: "Credit", value: -20 }],
  });
  assert.match(negative, /Composition cannot include negative parts/u);
  assert.match(negative, /Use a bar chart/u);
  assert.equal(negative.includes("<svg"), false);

  const zero = render(kit.DonutChart, {
    ariaLabel: "Zero total",
    formatValue: money,
    slices: [{ id: "a", label: "A", value: 0 }],
  });
  assert.match(zero, /No proportional evidence/u);

  const valid = render(kit.DonutChart, {
    ariaLabel: "Cost by service family",
    formatValue: money,
    centerLabel: "Total",
    slices: [
      { id: "ec2", label: "EC2", value: 750 },
      { id: "s3", label: "S3", value: 250 },
    ],
  });
  assert.match(valid, /role="img"/u);
  // Exact percentages appear so nothing is estimated from arc length.
  assert.ok(valid.includes("75.0%") && valid.includes("25.0%"));
  assert.ok(valid.includes("$1000.00"), "centre shows the total");
  assert.equal((valid.match(/<path/gu) ?? []).length, 2);
});

test("a sparkline is labelled and omitted when it would say nothing", () => {
  assert.equal(render(kit.Sparkline, { ariaLabel: "x", values: [1] }), "");
  assert.equal(render(kit.Sparkline, { ariaLabel: "x", values: [] }), "");
  const html = render(kit.Sparkline, {
    ariaLabel: "Seven day cost trend, rising",
    values: [1, 2, 3, 2, 4],
  });
  assert.match(html, /role="img"/u);
  assert.match(html, /aria-label="Seven day cost trend, rising"/u);
});

test("a share bar renders contiguous segments covering the full width", () => {
  const html = render(kit.ShareBar, {
    ariaLabel: "On-demand versus committed coverage",
    formatValue: money,
    segments: [
      { id: "od", label: "On-demand", value: 40 },
      { id: "sp", label: "Savings Plans", value: 60 },
    ],
  });
  assert.match(html, /role="img"/u);
  assert.match(html, /width="40"/u);
  assert.match(html, /width="60"/u);
  assert.match(html, /<title>On-demand: \$40\.00 \(40\.0%\)<\/title>/u);
});

test("series colours are deterministic and paired with a non-colour cue", () => {
  assert.equal(kit.chartToneAt(0), "blue");
  assert.equal(kit.chartToneAt(1), kit.CHART_TONE_SEQUENCE[1]);
  // Past the sequence the tone is the reserved neutral, not a second series
  // wearing the first series' colour. This assertion previously required
  // cycling back to blue, which meant series 1 and series 10 were painted
  // identically and the chart silently lied about identity.
  assert.equal(kit.chartToneAt(kit.CHART_TONE_SEQUENCE.length), "slate");
  assert.equal(kit.chartToneAt(-1), "slate");
  // The neutral is never issued as a categorical identity.
  assert.ok(!kit.CHART_TONE_SEQUENCE.includes("slate"));
  // Hue is never the only cue: the first series is solid and later ones dash.
  assert.equal(kit.chartDashAt(0), undefined);
  assert.notEqual(kit.chartDashAt(1), undefined);
  assert.equal(kit.chartToneColor("teal"), "var(--chart-teal)");
});

test("charts render without hooks so they are usable from server components", () => {
  // renderToStaticMarkup would throw on a hook outside a client boundary; these
  // components must stay pure presentational functions.
  for (const [component, props] of [
    [kit.TimeSeriesChart, {
      ariaLabel: "a", formatValue: money,
      series: [{ id: "s", label: "s", points: [{ label: "1", value: 1 }, { label: "2", value: 2 }] }],
    }],
    [kit.BarChart, { ariaLabel: "b", categories: ["a"], formatValue: money, series: [{ id: "s", label: "s", values: [1] }] }],
    [kit.RankingBars, { ariaLabel: "c", items: [{ id: "1", label: "l", value: 1 }], formatValue: money }],
    [kit.DonutChart, { ariaLabel: "d", slices: [{ id: "1", label: "l", value: 1 }], formatValue: money }],
  ]) {
    assert.doesNotThrow(() => render(component, props));
  }
});
