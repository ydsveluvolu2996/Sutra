import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCpuRequestMillicores,
  parseKubernetesQuantity,
  parseMemoryRequestBytes,
} from "../services/kubernetes-collector/src/quantity.ts";

test("parses bare numbers and scientific notation in base units", () => {
  assert.equal(parseKubernetesQuantity("1"), 1);
  assert.equal(parseKubernetesQuantity("2"), 2);
  assert.equal(parseKubernetesQuantity("0.5"), 0.5);
  assert.equal(parseKubernetesQuantity("+3"), 3);
  assert.equal(parseKubernetesQuantity(".25"), 0.25);
  assert.equal(parseKubernetesQuantity("1e9"), 1_000_000_000);
  assert.equal(parseKubernetesQuantity("1.5e6"), 1_500_000);
  assert.equal(parseKubernetesQuantity("1E9"), 1_000_000_000); // scientific, not exa
  assert.equal(parseKubernetesQuantity(536_870_912), 536_870_912); // numeric input
  assert.equal(parseKubernetesQuantity(0), 0);
});

test("parses decimal SI suffixes as powers of 1000", () => {
  assert.equal(parseKubernetesQuantity("1k"), 1_000);
  assert.equal(parseKubernetesQuantity("1M"), 1_000_000);
  assert.equal(parseKubernetesQuantity("1G"), 1_000_000_000);
  assert.equal(parseKubernetesQuantity("1T"), 1_000_000_000_000);
  assert.equal(parseKubernetesQuantity("1P"), 1_000_000_000_000_000);
  assert.equal(parseKubernetesQuantity("1E"), 1e18); // exa suffix (no exponent digits)
  assert.equal(parseKubernetesQuantity("1n"), 1e-9);
  assert.equal(parseKubernetesQuantity("1u"), 1e-6);
  assert.equal(parseKubernetesQuantity("250m"), 0.25);
  assert.equal(parseKubernetesQuantity("100M"), 100_000_000);
});

test("parses binary suffixes as powers of 1024", () => {
  assert.equal(parseKubernetesQuantity("1Ki"), 1_024);
  assert.equal(parseKubernetesQuantity("512Mi"), 536_870_912);
  assert.equal(parseKubernetesQuantity("1Gi"), 1_073_741_824);
  assert.equal(parseKubernetesQuantity("1.5Gi"), 1_610_612_736);
  assert.equal(parseKubernetesQuantity("1Ti"), 1_099_511_627_776);
  assert.equal(parseKubernetesQuantity("1Pi"), 1_125_899_906_842_624);
});

test("returns null for every garbage form", () => {
  for (const bad of [
    "", "   ", "abc", "1e", "e9", "Ki", "Mi", "m", "1..2", "1.2.3", "0x10",
    "1Gi500m", "1 2", "--5", "1,000", "NaN", "Infinity", "1x", "z",
    null, undefined, {}, [], true, false, NaN, Infinity, -Infinity,
  ]) {
    assert.equal(parseKubernetesQuantity(bad as unknown), null, `expected null for ${String(bad)}`);
  }
});

test("parses negative quantities as negative scalars (rejected downstream)", () => {
  assert.equal(parseKubernetesQuantity("-5"), -5);
  assert.equal(parseKubernetesQuantity("-500m"), -0.5);
});

test("cpu quantities become integer millicores", () => {
  assert.equal(parseCpuRequestMillicores("500m"), 500);
  assert.equal(parseCpuRequestMillicores("1"), 1_000);
  assert.equal(parseCpuRequestMillicores("2"), 2_000);
  assert.equal(parseCpuRequestMillicores("100m"), 100);
  assert.equal(parseCpuRequestMillicores("1500m"), 1_500);
  assert.equal(parseCpuRequestMillicores("0.25"), 250);
  assert.equal(parseCpuRequestMillicores("0.1"), 100);
  assert.equal(parseCpuRequestMillicores("4"), 4_000); // node allocatable
  assert.equal(parseCpuRequestMillicores("100000000n"), 100); // 1e8 nanocores = 0.1 core
  assert.equal(parseCpuRequestMillicores("0"), 0);
});

test("cpu parser rejects garbage and negatives", () => {
  assert.equal(parseCpuRequestMillicores("-5"), null);
  assert.equal(parseCpuRequestMillicores("-100m"), null);
  assert.equal(parseCpuRequestMillicores("abc"), null);
  assert.equal(parseCpuRequestMillicores(""), null);
  assert.equal(parseCpuRequestMillicores(null), null);
  assert.equal(parseCpuRequestMillicores(undefined), null);
});

test("memory quantities become integer bytes", () => {
  assert.equal(parseMemoryRequestBytes("512Mi"), 536_870_912);
  assert.equal(parseMemoryRequestBytes("1Gi"), 1_073_741_824);
  assert.equal(parseMemoryRequestBytes("536870912"), 536_870_912);
  assert.equal(parseMemoryRequestBytes("1e9"), 1_000_000_000);
  assert.equal(parseMemoryRequestBytes("64Mi"), 67_108_864);
  assert.equal(parseMemoryRequestBytes("16Gi"), 17_179_869_184);
  assert.equal(parseMemoryRequestBytes("1G"), 1_000_000_000);
  assert.equal(parseMemoryRequestBytes("0"), 0);
});

test("memory parser rejects garbage, negatives and unsafe integers", () => {
  assert.equal(parseMemoryRequestBytes("-1"), null);
  assert.equal(parseMemoryRequestBytes("abc"), null);
  assert.equal(parseMemoryRequestBytes(""), null);
  assert.equal(parseMemoryRequestBytes("1Ei"), null); // 1024^6 exceeds MAX_SAFE_INTEGER
  assert.equal(parseMemoryRequestBytes(null), null);
});
