import assert from "node:assert/strict";
import { after, test } from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * Pins `formatCurRationalPercentExact`, which renders the exact rational
 * percentages shown on the Trends report: month-over-month, rolling comparison,
 * contributor movement share and signal observed percent.
 *
 * It previously scaled non-terminating rationals by 10,000 instead of 100, so
 * every such percentage was overstated by 100x — 100/3 rendered as 3333.33%
 * rather than 33.33%. No test covered its output, so the defect was invisible.
 */

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
const panels = await vite.ssrLoadModule("/app/costs/finops-cur-intelligence-panels.tsx");
after(async () => vite.close());

const percent = (numerator, denominator) =>
  panels.formatCurRationalPercentExact({ numerator, denominator });

test("a non-terminating percent rational is not scaled by 100", () => {
  const third = percent("100", "3");
  assert.ok(third.startsWith("33.33%"), third);
  assert.equal(third.includes("3333.33"), false, "the 100x overstatement must not return");
  // The exact rational travels with the truncated decimal.
  assert.ok(third.includes("exact 100/3%"), third);

  assert.ok(percent("1", "3").startsWith("0.33%"));
  assert.ok(percent("2", "3").startsWith("0.66%"), "truncated, never rounded up");
  assert.ok(percent("1000", "3").startsWith("333.33%"));
});

test("an exactly divisible rational renders as a whole percent", () => {
  assert.equal(percent("50", "1"), "50%");
  assert.equal(percent("100", "2"), "50%");
  assert.equal(percent("0", "5"), "0%", "a measured zero is a value, not an absence");
  assert.equal(percent("-25", "1"), "-25%");
});

test("a negative non-terminating percentage keeps the unicode minus", () => {
  const value = percent("-100", "3");
  assert.ok(value.startsWith("−33.33%"), value);
  assert.equal(value.includes("−3333"), false);
});

test("a malformed or absent rational reports unavailability rather than zero", () => {
  assert.equal(panels.formatCurRationalPercentExact(null), "Not available");
  assert.equal(percent("100", "0"), "Not available", "a zero denominator is not a percentage");
  assert.equal(percent("abc", "3"), "Not available");
  assert.equal(percent("100", "-3"), "Not available");
  assert.equal(percent("1.5", "3"), "Not available", "only integer rationals are exact");
});

test("percentages stay exact well beyond double precision", () => {
  // A denominator this large would lose precision through a float path.
  const value = percent("100000000000000000000", "3");
  assert.ok(value.startsWith("33333333333333333333.33%"), value);
  assert.ok(value.includes("exact 100000000000000000000/3%"));
});
