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

const { RecommendationTrend, ResiliencyScoreTrend } = await vite.ssrLoadModule(
  "/app/costs/finops-resilience-vue-dashboard.tsx",
);

const gen = (over) => ({
  generationId: "g1", accountId: "111122223333", region: "us-east-1",
  completedAtIso: "2026-08-01T00:00:00Z", state: "COMPLETE", complete: true,
  applicationCount: 2, assessmentCount: 3, recommendationCount: 4, contentSha256: "abc",
  ...over,
});
const row = ({ assessment, ...over } = {}) => ({
  assessment: {
    assessmentArn: "arn:a", appArn: "arn:app", startTime: "2026-08-01T00:00:00Z",
    assessmentStatus: "Success", complianceStatus: "PolicyMet", resiliencyScore: 82,
    ...(assessment ?? {}),
  },
  target: { generationId: "g1", region: "us-east-1" },
  application: { name: "checkout" },
  ...over,
});

const trend = (history) => renderToStaticMarkup(createElement(RecommendationTrend, { history }));
const scores = (rows) => renderToStaticMarkup(createElement(ResiliencyScoreTrend, { rows }));

test("a generation with zero open recommendations is drawn as zero, not a stub", () => {
  const html = trend([gen({ generationId: "a", recommendationCount: 0 }), gen({ generationId: "b", recommendationCount: 9 })]);
  assert.match(html, /<svg/u);
  assert.ok(html.includes("0"), "the measured zero lost its value");
});

test("an all-zero window still renders a figure", () => {
  const html = trend([gen({ generationId: "a", recommendationCount: 0 }), gen({ generationId: "b", recommendationCount: 0 })]);
  assert.match(html, /<svg/u);
  assert.doesNotMatch(html, /No retained generation/u);
});

test("no retained generation is absence and stays a worded state", () => {
  assert.match(trend([]), /No retained generation has been accepted yet/u);
});

test("rows stay in recency order rather than being ranked by size", () => {
  const html = trend([
    gen({ generationId: "new", completedAtIso: "2026-08-09T00:00:00Z", recommendationCount: 1 }),
    gen({ generationId: "old", completedAtIso: "2026-08-01T00:00:00Z", recommendationCount: 99 }),
  ]);
  assert.ok(html.indexOf("2026-08-01") < html.indexOf("2026-08-09"), "recency order was not preserved");
});

test("an assessment with no supplied score is excluded and counted, never plotted as zero", () => {
  const html = scores([
    row({}),
    row({ assessment: { resiliencyScore: null, assessmentArn: "arn:b" } }),
  ]);
  assert.match(html, /1 of 2 assessments carry\s+no provider resiliency score/u);
});

test("a genuine score of zero is still plotted, unlike an absent score", () => {
  const html = scores([row({ assessment: { resiliencyScore: 0 } })]);
  assert.match(html, /<svg/u, "a measured zero score must still be charted");
  assert.doesNotMatch(html, /carry\s+no provider resiliency score/u);
});

test("a window with no scored assessment states that rather than drawing an empty axis", () => {
  const html = scores([row({ assessment: { resiliencyScore: null } })]);
  assert.match(html, /No assessment in this window carries a provider resiliency score/u);
  assert.doesNotMatch(html, /<svg/u);
});
