import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [panel, css] = await Promise.all([
  readFile(new URL("../app/costs/finops-wave3-panels.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/costs/costs.module.css", import.meta.url), "utf8"),
]);

test("Budgets workspace renders the live AWS Cost Anomaly panel", () => {
  assert.match(panel, /<AwsCostAnomalyPanel connectionId=\{connectionId\} \/>/u);
  assert.match(panel, /\/api\/v1\/finops\/cost-anomaly\?connectionId=\$\{encodeURIComponent\(connectionId\)\}/u);
  assert.match(panel, /credentials: "same-origin"/u);
  assert.match(panel, /cache: "no-store"/u);
  assert.match(panel, /Refresh AWS findings/u);
});

test("AWS provider findings remain visibly separate from Sutra statistics", () => {
  assert.match(panel, /Authoritative AWS provider findings/u);
  assert.match(panel, /AWS provider engine/u);
  assert.match(panel, /Sutra statistical engine/u);
  assert.match(panel, /independent from Sutra statistical alerts/u);
  assert.match(panel, /This is not proof that spend is correct or optimized/u);
  assert.match(panel, /no billing lines were available/u);
  assert.doesNotMatch(panel, /demo anomaly|fixture anomaly/iu);
});

test("panel renders honest empty, partial, stale, and failed states", () => {
  for (const state of ["empty", "ready", "partial", "stale", "failed"]) {
    assert.match(panel, new RegExp(`"${state}"`, "u"));
  }
  assert.match(panel, /No persisted AWS Cost Anomaly collection yet/u);
  assert.match(panel, /Partial AWS coverage/u);
  assert.match(panel, /Provider evidence is stale/u);
  assert.match(panel, /The latest AWS collection failed/u);
  assert.match(panel, /never substitutes sample findings or zero spend/u);
});

test("enterprise layout has responsive provider and Sutra evidence cards", () => {
  assert.match(css, /\.costAnomalyKpis \{ display: grid; grid-template-columns: repeat\(4/u);
  assert.match(css, /\.costAnomalySources \{ display: grid; grid-template-columns: repeat\(2/u);
  assert.match(css, /@media screen and \(max-width: 860px\)[\s\S]*\.costAnomalySources \{ grid-template-columns: 1fr;/u);
  assert.match(css, /@media screen and \(max-width: 520px\)[\s\S]*\.costAnomalyKpis \{ grid-template-columns: 1fr;/u);
  assert.match(panel, /aria-label="AWS Cost Anomaly summary"/u);
  assert.match(panel, /aria-label="AWS provider anomaly findings"/u);
  assert.match(panel, /aria-label="Sutra statistical anomaly signals"/u);
});
