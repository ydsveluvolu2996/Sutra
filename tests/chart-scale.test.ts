import assert from "node:assert/strict";
import test from "node:test";
import {
  ChartGeometryError,
  areaPath,
  bandScale,
  domainOf,
  donutSegmentPath,
  fractionsOf,
  linePath,
  niceTicks,
  padDegenerateDomain,
  plotArea,
  projectValue,
  roundCoordinate,
} from "../app/components/charts/chart-scale.ts";

test("domainOf reports the exact extent and never invents a zero baseline", () => {
  assert.deepEqual(domainOf([1200, 1250, 1180]), { min: 1180, max: 1250 });
  // Narrowly varying large costs must not be flattened against zero unless asked.
  assert.deepEqual(domainOf([1200, 1250], { includeZero: true }), { min: 0, max: 1250 });
  assert.deepEqual(domainOf([-40, -10]), { min: -40, max: -10 });
  assert.deepEqual(domainOf([-40, 10], { includeZero: true }), { min: -40, max: 10 });
  assert.equal(domainOf([]), null);
  assert.equal(domainOf([Number.NaN, Number.POSITIVE_INFINITY]), null);
  // Non-finite entries are dropped rather than poisoning the domain.
  assert.deepEqual(domainOf([5, Number.NaN, 9]), { min: 5, max: 9 });
});

test("a flat or single-value domain is padded instead of dividing by zero", () => {
  assert.deepEqual(padDegenerateDomain({ min: 100, max: 100 }), { min: 90, max: 110 });
  assert.deepEqual(padDegenerateDomain({ min: 0, max: 0 }), { min: -1, max: 1 });
  // An already-valid domain is returned untouched.
  assert.deepEqual(padDegenerateDomain({ min: 1, max: 2 }), { min: 1, max: 2 });
});

test("projectValue maps a domain onto an inverted pixel range", () => {
  const domain = { min: 0, max: 100 };
  const range = { start: 200, end: 0 };
  assert.equal(projectValue(0, domain, range), 200);
  assert.equal(projectValue(100, domain, range), 0);
  assert.equal(projectValue(50, domain, range), 100);
  // Out-of-domain values project outside the range rather than being clamped,
  // so overflow is detectable by the caller.
  assert.equal(projectValue(150, domain, range), -100);
  // A zero-span domain centres rather than throwing.
  assert.equal(projectValue(5, { min: 5, max: 5 }, range), 100);
  assert.throws(() => projectValue(Number.NaN, domain, range), ChartGeometryError);
});

test("bandScale evenly divides a range and centres each band", () => {
  const bands = bandScale(4, { start: 0, end: 400 }, { padding: 0 });
  assert.equal(bands.length, 4);
  assert.deepEqual(bands[0], { start: 0, center: 50, width: 100 });
  assert.deepEqual(bands[3], { start: 300, center: 350, width: 100 });

  const padded = bandScale(2, { start: 0, end: 100 }, { padding: 0.2 });
  assert.equal(padded[0]!.width, 40);
  assert.equal(padded[0]!.center, 25);
  assert.equal(padded[1]!.center, 75);

  assert.deepEqual(bandScale(0, { start: 0, end: 10 }), []);
  assert.equal(Object.isFrozen(bands), true);
  assert.throws(() => bandScale(-1, { start: 0, end: 1 }), ChartGeometryError);
  assert.throws(() => bandScale(2, { start: 0, end: 1 }, { padding: 1 }), ChartGeometryError);
});

test("niceTicks lands on round numbers and always spans the domain", () => {
  const ticks = niceTicks({ min: 0, max: 100 }, 5);
  assert.deepEqual(ticks, [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks({ min: 0, max: 10 }, 5), [0, 2.5, 5, 7.5, 10]);

  // Float error must not leak into a label. Multiplying a step back out gives
  // 3 * 0.1 === 0.30000000000000004, which would render as a nonsense axis label.
  assert.deepEqual(niceTicks({ min: 0, max: 0.4 }, 5), [0, 0.1, 0.2, 0.3, 0.4]);
  // The 2.5 step keeps the extra decimal place it needs.
  assert.deepEqual(niceTicks({ min: 0, max: 10 }, 5), [0, 2.5, 5, 7.5, 10]);
  for (const tick of niceTicks({ min: 0, max: 0.7 }, 5)) {
    assert.equal(String(tick).replace("-", "").length <= 6, true, `noisy tick ${tick}`);
  }

  const crossing = niceTicks({ min: -40, max: 80 }, 5);
  assert.ok(crossing.includes(0), `expected a zero tick in ${crossing.join(",")}`);
  assert.ok(crossing[0]! <= -40);
  assert.ok(crossing[crossing.length - 1]! >= 80);

  // Every tick set covers the whole domain, so no mark can be clipped.
  for (const domain of [{ min: 3, max: 7 }, { min: 1180, max: 1250 }, { min: -5, max: -1 }]) {
    const result = niceTicks(domain, 5);
    assert.ok(result[0]! <= domain.min, `${result[0]} <= ${domain.min}`);
    assert.ok(result[result.length - 1]! >= domain.max);
  }
  assert.throws(() => niceTicks({ min: 0, max: 1 }, 1), ChartGeometryError);
});

test("niceTicks never emits negative zero as a label value", () => {
  for (const tick of niceTicks({ min: -10, max: 30 }, 5)) {
    assert.equal(Object.is(tick, -0), false);
  }
});

test("plotArea subtracts padding and refuses an impossible frame", () => {
  assert.deepEqual(
    plotArea(200, 100, { top: 10, right: 20, bottom: 30, left: 40 }),
    { left: 40, top: 10, width: 140, height: 60 },
  );
  assert.throws(
    () => plotArea(30, 100, { top: 0, right: 20, bottom: 0, left: 40 }),
    ChartGeometryError,
  );
});

test("path builders emit stable rounded coordinates", () => {
  assert.equal(linePath([]), "");
  assert.equal(linePath([{ x: 0, y: 1 }, { x: 2, y: 3 }]), "M0 1 L2 3");
  // A long float expansion is rounded so SSR output is a stable string.
  assert.equal(roundCoordinate(1 / 3), 0.333);
  assert.equal(linePath([{ x: 1 / 3, y: 2 / 3 }]), "M0.333 0.667");
  assert.equal(
    areaPath([{ x: 0, y: 10 }, { x: 5, y: 20 }], 50),
    "M0 10 L5 20 L5 50 L0 50 Z",
  );
  assert.equal(areaPath([], 10), "");
});

test("donut geometry rejects impossible radii and closes a full ring", () => {
  assert.throws(
    () => donutSegmentPath(0, 1, { cx: 0, cy: 0, outerRadius: 5, innerRadius: 5 }),
    ChartGeometryError,
  );
  assert.equal(donutSegmentPath(0.5, 0.5, { cx: 0, cy: 0, outerRadius: 5, innerRadius: 2 }), "");

  // A single slice covering the whole ring has no arc endpoints to join, so it
  // must be split rather than collapsing to nothing.
  const full = donutSegmentPath(0, 1, { cx: 50, cy: 50, outerRadius: 40, innerRadius: 20 });
  assert.equal(full.split("M").length - 1, 2);
  assert.ok(full.includes("A"));

  // A quarter sweep starts at 12 o'clock and ends at 3 o'clock.
  const quarter = donutSegmentPath(0, 0.25, { cx: 50, cy: 50, outerRadius: 40, innerRadius: 20 });
  assert.ok(quarter.startsWith("M50 10"), quarter);
  assert.ok(quarter.includes("90 50"), quarter);
});

test("fractionsOf refuses data that cannot express a proportion", () => {
  assert.equal(fractionsOf([]), null);
  assert.equal(fractionsOf([0, 0]), null, "a zero total is not a proportion");
  assert.equal(fractionsOf([-1, 5]), null, "a negative part is not a share of a whole");
  assert.equal(fractionsOf([Number.NaN, 1]), null);

  const fractions = fractionsOf([25, 75]);
  assert.notEqual(fractions, null);
  assert.equal(fractions![0]!.fraction, 0.25);
  assert.deepEqual(
    [fractions![0]!.startFraction, fractions![0]!.endFraction],
    [0, 0.25],
  );
  // Segments are contiguous and close exactly at 1.
  assert.equal(fractions![1]!.startFraction, 0.25);
  assert.equal(fractions![fractions!.length - 1]!.endFraction, 1);
  assert.equal(Object.isFrozen(fractions), true);
});
