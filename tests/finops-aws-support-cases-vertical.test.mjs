import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

test("Support case migrations make snapshots immutable and head complete-only and monotonic", async () => {
  const files = await Promise.all([
    readFile(new URL("../drizzle/0092_finops_aws_support_cases.sql", import.meta.url), "utf8"),
    readFile(new URL("../postgres/migrations/0087_finops_aws_support_cases.sql", import.meta.url), "utf8"),
  ]);
  for (const sql of files) {
    assert.match(sql, /FINOPS_SUPPORT_CASE_SNAPSHOT_IMMUTABLE/u);
    assert.match(sql, /configuration_state[^\n]*ready|configuration_state` = 'ready'/u);
    assert.match(sql, /collection_state[^\n]*complete|collection_state` = 'complete'/u);
    assert.match(sql, /candidate\.?`?data_through_at`? > active\.?`?data_through_at`?/u);
    assert.match(sql, /support_[a-f0-9]/u);
  }
});

test("repository validates engine evidence, tenant ownership and immutable accepted heads", async () => {
  const source = await readFile(new URL("../db/finops-aws-support-cases-repository.ts", import.meta.url), "utf8");
  assert.match(source, /awsSupportCasesSourceEvidence\(snapshot\)/u);
  assert.match(source, /aws_account_id = \? AND partition = \?/u);
  assert.match(source, /source_kind = 'aws_trust_role' AND status = 'active'/u);
  assert.match(source, /snapshot\.configurationState === "ready" && snapshot\.collectionState === "complete"/u);
  assert.match(source, /ON CONFLICT DO NOTHING/u);
});

test("route authenticates, same-tenant scopes and minimizes the browser projection", async () => {
  const source = await readFile(new URL("../app/api/v1/finops/aws-support-cases-radar/route.ts", import.meta.url), "utf8");
  assert.match(source, /requireApiSession\(request\)/u);
  assert.match(source, /getConnectionForOrg\(authenticated\.subject\.orgId/u);
  assert.match(source, /assertSessionCapability\(authenticated, "connection:read", connection\.customerId\)/u);
  assert.match(source, /includeSafeSummaries: false/u);
  assert.match(source, /OPTIONAL_BEDROCK_SUMMARIZATION_NOT_CONFIGURED/u);
  assert.match(source, /organizationCoverageClaimed: false/u);
  for (const forbidden of ["subjectEvidenceHash:", "contactEvidenceHash:", "communications:", "caseId:"]) assert.equal(source.includes(forbidden), false);
});

test("native report renders plan states, filters, trends, provenance and privacy disclosure", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const vite = await createServer({ root, configFile: false, logLevel: "silent", plugins: [react()], server: { middlewareMode: true } });
  try {
    const dashboardModule = await vite.ssrLoadModule("/app/costs/finops-aws-support-cases-radar-dashboard.tsx");
    const report = {
      schema: "sutra.finops-aws-support-cases-radar.v1", connectionId: `conn_${"a".repeat(32)}`, sourceState: "partial", generatedAt: "2026-08-01T00:00:00.000Z",
      source: { latestObservedAt: "2026-08-01T00:00:00.000Z", freshness: "fresh", historyCoverage: "observed_snapshots_only", watermarkCoverage: "continuous", organizationCoverageClaimed: false,
        accountCoverage: [{ accountId: "111111111111", supportPlan: "business", entitlementState: "QUALIFYING", readPermissionsValidated: true, status: "complete", caseCount: 1, communicationCount: 2, failureCode: null }],
        limitations: ["AWS retains case data for 24 months."] },
      summary: { caseCount: 1, openCount: 1, resolvedCount: 0, pendingCustomerActionCount: 1, highUrgentCriticalCount: 1, communicationCount: 2, intendedAccountCount: 1, completeAccountCount: 1,
        communicationActorCounts: { AWS: 1, CUSTOMER: 1, UNKNOWN: 0 }, responseCadence: { awsResponseTransitions: 1, customerResponseTransitions: 1, averageAwsResponseMinutes: 75, averageCustomerResponseMinutes: 40 }, openAgeBands: { under7Days: 0, days7To30: 1, days31To90: 0, over90Days: 0 },
        statusCounts: { "pending-customer-action": 1 }, severityCounts: { high: 1 }, serviceCounts: [{ code: "amazon-ec2", count: 1 }], categoryCounts: [{ code: "performance", count: 1 }] },
      cases: [{ accountId: "111111111111", caseReference: "case-…1001", serviceCode: "amazon-ec2", categoryCode: "performance", severity: "high", status: "pending-customer-action", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", resolvedObservedAt: null, submittedByKind: "CUSTOMER", communicationCount: 2, attachmentCount: 0, observationCount: 2, communicationsComplete: true }],
      casesTruncated: false, disclosure: "Privacy minimized", history: [{ generationId: `supg_${"1".repeat(64)}`, observedAt: "2026-08-01T00:00:00.000Z", dataThroughAt: "2026-08-01T00:00:00.000Z", collectionState: "complete", intendedAccountCount: 1, completeAccountCount: 1, caseCount: 1, openCount: 1, highUrgentCriticalCount: 1 }],
      provenance: { activeGenerationId: `supg_${"1".repeat(64)}`, latestGenerationId: `supg_${"2".repeat(64)}`, newerIncomplete: true, contentSha256: "1".repeat(64), latestAttemptContentSha256: "2".repeat(64), captureId: `support_${"2".repeat(64)}`, observedAt: "2026-08-01T00:00:00.000Z", dataThroughAt: "2026-08-01T00:00:00.000Z", organizationCoverageClaimed: false },
      collection: { available: false, reason: "AWS_SUPPORT_CASES_SIGNED_BROKER_HANDLER_NOT_REGISTERED" }, summarization: { available: false, provider: null, reason: "OPTIONAL_BEDROCK_SUMMARIZATION_NOT_CONFIGURED" },
    };
    const html = renderToStaticMarkup(createElement(dashboardModule.AwsSupportCasesRadarReportView, { report, filters: { accountId: "", status: "", severity: "", serviceCode: "", categoryCode: "" }, onFiltersChange: () => undefined }));
    for (const text of ["Privacy-minimized", "Support-plan readiness", "Case history", "Open case age", "Response cadence", "Average AWS response", "Top case topics", "Severity and service signals", "Case metadata drilldown", "Optional Bedrock summaries", "Not claimed", "Account coverage"]) assert.match(html, new RegExp(text, "iu"));
    for (const forbidden of ["subjectEvidenceHash", "contactEvidenceHash", "bodyEvidenceHash"]) assert.doesNotMatch(html, new RegExp(forbidden, "u"));
  } finally { await vite.close(); }
});

test("job resolves targets server-side and persists only the normalized engine snapshot", async () => {
  const source = await readFile(new URL("../lib/finops-aws-support-cases-job.ts", import.meta.url), "utf8");
  assert.match(source, /targets\.resolve\(scope\)/u);
  assert.match(source, /SERVER_RESOLVED_CONNECTIONS/u);
  assert.match(source, /createAwsSupportCasesQueryService/u);
  assert.match(source, /snapshots\.record\(scope, snapshot\)/u);
});

test("production binding is signed, entitlement-aware, and honestly inactive", async () => {
  const [broker, runtime, route] = await Promise.all([
    readFile(new URL("../lib/finops-aws-support-cases-signed-broker.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/finops-aws-support-cases-runtime-binding.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v1/finops/aws-support-cases-radar/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(broker, /signHostedBrokerRequest/u);
  assert.match(broker, /verifyHostedBrokerResponse/u);
  assert.match(runtime, /registeredInSharedRuntime: false/u);
  assert.match(route, /AWS_SUPPORT_CASES_SIGNED_BROKER_HANDLER_NOT_REGISTERED/u);
});
