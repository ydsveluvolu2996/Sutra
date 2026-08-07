import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The chrome is shared by every dashboard, so a regression here is a regression
// on all of them. These lock the properties that are easy to erode: reserved
// status colours staying out of the categorical palette, colour never being the
// only cue, and wide tables scrolling inside their own container.

const chrome = await readFile(new URL("../app/components/dashboard-chrome.tsx", import.meta.url), "utf8");
const chromeCss = await readFile(new URL("../app/components/dashboard-chrome.module.css", import.meta.url), "utf8");
const chartsCss = await readFile(new URL("../app/components/charts/charts.module.css", import.meta.url), "utf8");
const frame = await readFile(new URL("../app/components/charts/chart-frame.tsx", import.meta.url), "utf8");
const globals = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

function hexes(source) {
  return [...source.matchAll(/#[0-9a-f]{6}\b/gu)].map((match) => match[0].toLowerCase());
}

test("the categorical palette clears every validator check", () => {
  // The values are validated by scripts/validate_palette.js; this asserts the
  // recorded outcome stays recorded, so a later edit cannot quietly drop it.
  assert.match(chartsCss, /Validated against the #ffffff chart surface/u);
  assert.match(chartsCss, /dE 13\.3 \(deuteranopia\)/u);
});

test("reserved status colours never collide with the categorical series palette", () => {
  const categorical = new Set(
    [...chartsCss.matchAll(/--chart-(?!slate)[a-z]+:\s*(#[0-9a-f]{6})/gu)].map((m) => m[1].toLowerCase()),
  );
  assert.ok(categorical.size >= 8, "the categorical palette must actually be found");
  const status = hexes(
    chromeCss.slice(chromeCss.indexOf("Reserved status ramp")),
  );
  for (const colour of status) {
    assert.ok(
      !categorical.has(colour),
      `${colour} is used as both a status colour and a categorical series colour`,
    );
  }
});

test("the neutral tone is never issued as a categorical identity", () => {
  const sequence = /CHART_TONE_SEQUENCE: readonly ChartTone\[\] = Object\.freeze\(\[([\s\S]*?)\]\)/u
    .exec(frame);
  assert.ok(sequence !== null);
  assert.ok(!sequence[1].includes("slate"), "slate is the reserved neutral, not series 10");
  // Past the sequence the tone must not wrap back onto an in-use hue.
  assert.match(frame, /if \(!Number\.isInteger\(index\) \|\| index < 0 \|\| index >= sequence\.length\) return "slate";/u);
});

test("severity and state are always rendered with a text label", () => {
  // Both pills take a `label` and render it, so the colour is a second cue and
  // never the only one.
  assert.match(chrome, /function SeverityPill\(\{ severity, label \}[\s\S]*?\{label\}<\/span>/u);
  assert.match(chrome, /function StatePill\(\{ state, label \}[\s\S]*?\{label\}<\/span>/u);
});

test("the severity legend labels every row rather than relying on swatches", () => {
  const start = chrome.indexOf("export function SeverityLegend(");
  const body = chrome.slice(start, chrome.indexOf("\nexport ", start + 1));
  assert.match(body, /<span>\{entry\.label\}<\/span>/u);
  assert.match(body, /<b>\{entry\.count/u);
  assert.match(body, /aria-hidden="true" data-severity=/u, "the swatch itself is decorative");
});

test("delta separates direction from sentiment", () => {
  // A fall in spend is good and a fall in coverage is bad; conflating them
  // colours a win red.
  assert.match(chrome, /readonly direction: "up" \| "down" \| "flat";/u);
  assert.match(chrome, /readonly sentiment: "good" \| "bad" \| "neutral";/u);
  assert.match(chromeCss, /\.delta\[data-sentiment="good"\]/u);
});

test("wide tables scroll inside their own container", () => {
  assert.match(chromeCss, /\.tableScroll \{\s*overflow-x: auto;\s*\}/u);
  assert.match(chrome, /className=\{styles\.tableScroll\}/u);
});

test("the table header stays readable while scrolling and numbers align", () => {
  assert.match(chromeCss, /\.table th \{[\s\S]*?position: sticky;/u);
  assert.match(chromeCss, /\[data-numeric="true"\] \{ text-align: right; font-variant-numeric: tabular-nums; \}/u);
});

test("an empty table says so instead of rendering an empty body", () => {
  assert.match(chrome, /if \(rows\.length === 0 && empty !== undefined\)/u);
  assert.match(chrome, /role="status"/u);
});

test("the chrome stays presentational so server components can render it", () => {
  assert.doesNotMatch(chrome, /\buseState\b|\buseEffect\b|\buseMemo\b|"use client"/u);
});

test("the compact severity counts never rely on the letter alone", () => {
  const start = chrome.indexOf("export function SeverityCountGroup(");
  const body = chrome.slice(start, chrome.indexOf("\nexport ", start + 1));
  // The letter is an abbreviation; the full label must still reach a screen
  // reader and a hover, so the cell is readable without decoding "C" or seeing
  // the colour.
  assert.match(body, /title=\{`\$\{entry\.count\} \$\{entry\.label\}`\}/u);
  assert.match(body, /<span className="sr-only">\{entry\.label\}<\/span>/u);
  assert.match(body, /aria-hidden="true">\{entry\.label\.slice\(0, 1\)/u);
});

test("trend pills separate direction from sentiment", () => {
  const start = chrome.indexOf("export function TrendPill(");
  const body = chrome.slice(start, chrome.indexOf("\nexport ", start + 1));
  assert.match(body, /readonly direction: "up" \| "down" \| "flat";/u);
  assert.match(body, /readonly sentiment: "good" \| "bad" \| "neutral";/u);
  assert.match(chromeCss, /\.trendPill\[data-sentiment="bad"\]/u);
});

test("a ranked list numbers its ranks and says when it is empty", () => {
  const start = chrome.indexOf("export function RankedList(");
  const body = chrome.slice(start, chrome.indexOf("\nexport ", start + 1));
  assert.match(body, /if \(entries\.length === 0\)/u);
  assert.match(body, /role="status"/u);
  assert.match(body, /\{index \+ 1\}/u);
});

test("no dashboard module hardcodes its own table density", async () => {
  // Every FinOps dashboard used to set its own table font size and padding, so
  // the same table looked different on each one: .8rem / .82rem / 11px fonts and
  // .62rem / .65rem / "10px 12px" / "6px 10px 6px 0" padding. They now consume
  // shared tokens, and this keeps them consuming them.
  const directory = new URL("../app/costs/", import.meta.url);
  const { readdir } = await import("node:fs/promises");
  const modules = (await readdir(directory)).filter((file) => file.endsWith(".module.css"));
  assert.ok(modules.length > 10, "the dashboard modules must actually be found");

  const offenders = [];
  for (const file of modules) {
    const source = await readFile(new URL(file, directory), "utf8");
    for (const rule of source.matchAll(/^\.(?:table|tableWrap)[^{]*\{[^}]*\}/gmu)) {
      if (/font-size:\s*(?:\.[0-9]+rem|[0-9.]+px)/u.test(rule[0])) {
        offenders.push(`${file}: ${rule[0].slice(0, 70)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("the shared table tokens are defined once", () => {
  for (const token of [
    "--table-font", "--table-pad-y", "--table-pad-x",
    "--table-rule", "--table-head-font", "--table-head-ink",
  ]) {
    assert.ok(globals.includes(`${token}:`), `${token} must be defined in globals.css`);
  }
});
