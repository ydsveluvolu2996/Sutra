import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const vite = await createServer({ root: new URL("..", import.meta.url).pathname, configFile: false, logLevel: "silent", plugins: [react()], server: { middlewareMode: true } });
const ui = await vite.ssrLoadModule("/app/costs/finops-health-events-dashboard.tsx");
const official = await vite.ssrLoadModule("/lib/finops-aws-health-official-definition.ts");
after(async () => vite.close());
const FILTERS = { status: null, category: null, service: null, accountId: null, region: null, actionability: null, search: null };
function report(state, reason) {
  return {
    connectionId: `conn_${"a".repeat(32)}`, sourceState: state,
    availability: { eligibleSupport: true, supportPlan: "unknown", organizationsAllFeaturesEnabled: true, organizationViewStatus: "ENABLED", collectorAccountType: "management", initialLoadState: "COMPLETE" },
    officialDefinition: official.FINOPS_AWS_HEALTH_OFFICIAL_DEFINITION,
    collection: { available: state === "ready", state, reason, lastAttemptAt: "2026-08-02T12:00:00.000Z" },
    filterOptions: { statuses: [], categories: [], services: [], accounts: [], regions: [], actionabilities: [] },
    summary: { pastCount: 0, currentCount: 0, upcomingCount: 0, actionRequiredCount: 0, affectedAccountCount: 0, affectedEntityCount: 0, historyGenerationCount: 0 },
    upcomingTimeline: [], upcomingTimelineTruncated: false,
    deprecatingVersions: { status: "unavailable", items: [] },
    events: [], eventsTruncated: false, eventHistory: [],
    planningSemantics: { notRealTime: true }, freshness: {}, lineage: {}, evidence: {}, limitations: [],
  };
}

test("UI distinguishes unavailable, collecting, failed and ready without relabeling accepted history", () => {
  const render = (state, reason) => renderToStaticMarkup(createElement(ui.HealthEventsReportView, { report: report(state, reason), filters: FILTERS, onFiltersChange: () => undefined }));
  assert.match(render("unavailable", "AWS_HEALTH_ORGANIZATION_JOB_HANDLER_NOT_REGISTERED"), /Scheduled collection unavailable/u);
  assert.match(render("collecting", "AWS_HEALTH_COLLECTION_IN_PROGRESS"), /Collection in progress[\s\S]*not relabeled as current/u);
  assert.match(render("failed", "ADAPTER_UNAVAILABLE"), /Latest collection failed[\s\S]*Accepted history remains visible[\s\S]*ADAPTER_UNAVAILABLE/u);
  const ready = render("ready", "AWS_HEALTH_COLLECTION_READY");
  assert.match(ready, /AWS Health Events planning dashboard/u);
  assert.doesNotMatch(ready, /Latest collection failed|Scheduled collection unavailable/u);
});
