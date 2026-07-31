import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TRUSTED_ADVISOR_ORGANIZATION_API_OPERATIONS,
  TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS,
  TrustedAdvisorOrganizationError,
  buildTrustedAdvisorOrganizationDashboard,
  normalizeTrustedAdvisorOrganizationCapture,
  trustedAdvisorOrganizationSourceEvidence,
  type AwsOrganizationRecommendation,
  type AwsOrganizationRecommendationSummary,
  type TrustedAdvisorOrganizationCapture,
} from "../lib/finops-trusted-advisor-organization.ts";
import {
  buildFinopsSourceReadiness,
} from "../lib/finops-source-health.ts";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const scope = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const recommendationArn =
  "arn:aws:trustedadvisor:::organization-recommendation/9534ec9b-bf3a-44e8-8213-2ed68b39d9d5";
const accountRecommendationArn =
  "arn:aws:trustedadvisor::123456789012:recommendation/9534ec9b-bf3a-44e8-8213-2ed68b39d9d5";
const resourceArn =
  "arn:aws:trustedadvisor::123456789012:recommendation-resource/9534ec9b-bf3a-44e8-8213-2ed68b39d9d5/resource-1";

function summary(
  overrides: Partial<AwsOrganizationRecommendationSummary> = {},
): AwsOrganizationRecommendationSummary {
  return {
    arn: recommendationArn,
    awsServices: ["lambda"],
    checkArn: "arn:aws:trustedadvisor:::check/L4dfs2Q4C5",
    createdAt: "2026-07-30T08:00:00.000Z",
    id: "9534ec9b-bf3a-44e8-8213-2ed68b39d9d5",
    lastUpdatedAt: "2026-07-31T10:00:00.000Z",
    lifecycleStage: "in_progress",
    name: "Lambda runtime deprecation warning",
    pillars: ["security", "cost_optimizing"],
    pillarSpecificAggregates: {
      costOptimizing: {
        estimatedMonthlySavings: 15.25,
        estimatedPercentMonthlySavings: 3.5,
      },
    },
    resourcesAggregates: {
      errorCount: 0,
      excludedCount: 0,
      okCount: 0,
      warningCount: 1,
    },
    source: "ta_check",
    status: "warning",
    type: "priority",
    ...overrides,
  };
}

function detail(
  overrides: Partial<AwsOrganizationRecommendation> = {},
): AwsOrganizationRecommendation {
  return {
    ...summary(),
    description: "One or more functions use a deprecated runtime.",
    createdBy: "AWS account team",
    updateReason: "Remediation is in progress.",
    ...overrides,
  };
}

function recommendationRequest(nextToken: string | null = null) {
  return {
    maxResults: 200,
    nextToken,
    afterLastUpdatedAt: null,
    awsService: null,
    beforeLastUpdatedAt: null,
    checkIdentifier: null,
    pillar: null,
    source: null,
    status: null,
    type: null,
  } as const;
}

function accountRequest(nextToken: string | null = null) {
  return {
    maxResults: 200,
    nextToken,
    affectedAccountId: null,
  } as const;
}

function resourceRequest(nextToken: string | null = null) {
  return {
    maxResults: 200,
    nextToken,
    affectedAccountId: null,
    exclusionStatus: null,
    regionCode: null,
    status: null,
  } as const;
}

function capture(
  overrides: Partial<TrustedAdvisorOrganizationCapture> = {},
): TrustedAdvisorOrganizationCapture {
  return {
    scope,
    captureId: `tac_${"a".repeat(64)}`,
    startedAtIso: "2026-07-31T10:00:00.000Z",
    completedAtIso: "2026-07-31T10:02:00.000Z",
    prerequisites: {
      supportPlan: "enterprise",
      organizationsAllFeaturesEnabled: true,
      trustedAdvisorTrustedAccessEnabled: true,
      trustedAdvisorPriorityEnabled: true,
      collectorAccountType: "delegated_administrator",
      readPermissionsValidated: true,
    },
    recommendations: {
      exhausted: true,
      pages: [{
        request: recommendationRequest(),
        response: {
          organizationRecommendationSummaries: [summary()],
          nextToken: null,
        },
      }],
    },
    recommendationDetails: [detail()],
    accounts: [{
      recommendationArn,
      exhausted: true,
      pages: [{
        request: accountRequest(),
        response: {
          accountRecommendationLifecycleSummaries: [{
            accountId: "123456789012",
            accountRecommendationArn,
            lastUpdatedAt: "2026-07-31T10:00:00.000Z",
            lifecycleStage: "in_progress",
            updateReason: "Remediation is in progress.",
          }],
          nextToken: null,
        },
      }],
    }],
    resources: [{
      recommendationArn,
      exhausted: true,
      pages: [{
        request: resourceRequest(),
        response: {
          organizationRecommendationResourceSummaries: [{
            accountId: "123456789012",
            arn: resourceArn,
            awsResourceId: "function-one",
            exclusionStatus: "included",
            id: "resource-1",
            lastUpdatedAt: "2026-07-31T09:59:00.000Z",
            metadata: {
              "2": "function-one",
              "0": "nodejs18.x",
            },
            recommendationArn,
            regionCode: "ap-south-1",
            status: "warning",
          }],
          nextToken: null,
        },
      }],
    }],
    ...overrides,
  };
}

describe("Trusted Advisor organization Priority normalization", () => {
  it("normalizes complete recommendation, account, and resource evidence deterministically", () => {
    const snapshot = normalizeTrustedAdvisorOrganizationCapture(
      capture(),
      NOW,
    );
    assert.equal(snapshot.coverage.assessment, "complete");
    assert.equal(snapshot.coverage.recommendationCount, 1);
    assert.equal(snapshot.coverage.accountLifecycleCount, 1);
    assert.equal(snapshot.coverage.resourceCount, 1);
    assert.equal(snapshot.collectionDurationMs, 120_000);
    assert.deepEqual(
      snapshot.evidence.apiOperations,
      TRUSTED_ADVISOR_ORGANIZATION_API_OPERATIONS,
    );
    assert.equal(
      snapshot.evidence.apiScope,
      "organization_priority_recommendations",
    );
    assert.match(snapshot.evidence.limitations[0] ?? "", /prioritized/u);
    const recommendation = snapshot.recommendations[0];
    assert.deepEqual(recommendation.resources[0]?.metadata, [
      { key: "0", value: "nodejs18.x" },
      { key: "2", value: "function-one" },
    ]);
    assert.deepEqual(recommendation.costOptimizing, {
      estimatedMonthlySavings: 15.25,
      estimatedPercentMonthlySavings: 3.5,
      currency: null,
      aggregationAllowed: false,
    });
    assert.equal(
      recommendation.drilldownEvidence.resourceAggregateReconciled,
      true,
    );
    const sourceEvidence =
      trustedAdvisorOrganizationSourceEvidence(snapshot);
    const readiness = buildFinopsSourceReadiness({
      scope,
      evidence: [sourceEvidence],
      nowMs: NOW,
    });
    assert.equal(
      readiness.sources.find((source) =>
        source.id === "trusted_advisor_organization"
      )?.state,
      "partial",
    );
    assert.equal(
      readiness.capabilities.find((capability) =>
        capability.id === "trusted_advisor_organizational"
      )?.ready,
      false,
    );
  });

  it("deduplicates identical page records but rejects conflicting duplicates", () => {
    const repeated = summary();
    const normalized = normalizeTrustedAdvisorOrganizationCapture(capture({
      recommendations: {
        exhausted: true,
        pages: [{
          request: recommendationRequest(),
          response: {
            organizationRecommendationSummaries: [repeated, repeated],
            nextToken: null,
          },
        }],
      },
    }), NOW);
    assert.equal(normalized.recommendations.length, 1);

    assert.throws(
      () => normalizeTrustedAdvisorOrganizationCapture(capture({
        recommendations: {
          exhausted: true,
          pages: [{
            request: recommendationRequest(),
            response: {
              organizationRecommendationSummaries: [
                summary(),
                summary({ status: "error" }),
              ],
              nextToken: null,
            },
          }],
        },
      }), NOW),
      (error) =>
        error instanceof TrustedAdvisorOrganizationError
        && error.code === "CONFLICTING_DUPLICATE"
        && !error.message.includes("customer_alpha"),
    );
  });

  it("fails closed on pagination gaps, replayed tokens, and filtered collection", () => {
    const pageTwo = {
      request: recommendationRequest("token-two"),
      response: {
        organizationRecommendationSummaries: [] as
          AwsOrganizationRecommendationSummary[],
        nextToken: null,
      },
    };
    assert.throws(
      () => normalizeTrustedAdvisorOrganizationCapture(capture({
        recommendations: {
          exhausted: true,
          pages: [{
            request: recommendationRequest(),
            response: {
              organizationRecommendationSummaries: [summary()],
              nextToken: "token-one",
            },
          }, pageTwo],
        },
      }), NOW),
      (error) =>
        error instanceof TrustedAdvisorOrganizationError
        && error.code === "INVALID_PAGINATION",
    );

    assert.throws(
      () => normalizeTrustedAdvisorOrganizationCapture(capture({
        recommendations: {
          exhausted: true,
          pages: [{
            request: {
              ...recommendationRequest(),
              pillar: "security" as never,
            },
            response: {
              organizationRecommendationSummaries: [summary()],
              nextToken: null,
            },
          }],
        },
      }), NOW),
      (error) =>
        error instanceof TrustedAdvisorOrganizationError
        && error.code === "INVALID_INPUT",
    );
  });

  it("keeps truncated collection and unmet prerequisites explicitly partial", () => {
    const partial = normalizeTrustedAdvisorOrganizationCapture(capture({
      prerequisites: {
        supportPlan: "business_support_plus",
        organizationsAllFeaturesEnabled: true,
        trustedAdvisorTrustedAccessEnabled: true,
        trustedAdvisorPriorityEnabled: false,
        collectorAccountType: "management",
        readPermissionsValidated: true,
      },
      recommendations: {
        exhausted: false,
        pages: [{
          request: recommendationRequest(),
          response: {
            organizationRecommendationSummaries: [summary()],
            nextToken: "next-page",
          },
        }],
      },
    }), NOW);
    assert.equal(partial.coverage.assessment, "partial");
    assert.match(
      partial.evidence.limitations.join(" "),
      /Priority entitlement requires Enterprise Support/u,
    );
    assert.match(
      partial.evidence.limitations.join(" "),
      /pagination stopped/u,
    );
    const evidence = trustedAdvisorOrganizationSourceEvidence(partial);
    assert.equal(evidence.configured, false);
    assert.equal(evidence.lastAttemptOutcome, "partial");
    assert.equal(evidence.lastSuccessAt, null);
    assert.equal(evidence.dataThroughAt, null);
    assert.equal(evidence.coverage.expectedRecords, null);
  });

  it("does not call an unreconciled resource drilldown complete", () => {
    const snapshot = normalizeTrustedAdvisorOrganizationCapture(capture({
      recommendationDetails: [detail({
        resourcesAggregates: {
          errorCount: 1,
          excludedCount: 0,
          okCount: 0,
          warningCount: 1,
        },
      })],
      recommendations: {
        exhausted: true,
        pages: [{
          request: recommendationRequest(),
          response: {
            organizationRecommendationSummaries: [summary({
              resourcesAggregates: {
                errorCount: 1,
                excludedCount: 0,
                okCount: 0,
                warningCount: 1,
              },
            })],
            nextToken: null,
          },
        }],
      },
    }), NOW);
    assert.equal(snapshot.coverage.assessment, "partial");
    assert.equal(
      snapshot.coverage.allResourceAggregatesReconciled,
      false,
    );
    assert.match(
      snapshot.evidence.limitations.join(" "),
      /does not reconcile/u,
    );
  });

  it("rejects foreign resource references and missing drilldown sequences", () => {
    assert.throws(
      () => normalizeTrustedAdvisorOrganizationCapture(capture({
        resources: [{
          recommendationArn,
          exhausted: true,
          pages: [{
            request: resourceRequest(),
            response: {
              organizationRecommendationResourceSummaries: [{
                ...capture().resources[0].pages[0].response
                  .organizationRecommendationResourceSummaries[0],
                recommendationArn:
                  "arn:aws:trustedadvisor:::organization-recommendation/foreign-recommendation",
              }],
              nextToken: null,
            },
          }],
        }],
      }), NOW),
      (error) =>
        error instanceof TrustedAdvisorOrganizationError
        && error.code === "SCOPE_MISMATCH",
    );
    assert.throws(
      () => normalizeTrustedAdvisorOrganizationCapture(
        capture({ accounts: [] }),
        NOW,
      ),
      (error) =>
        error instanceof TrustedAdvisorOrganizationError
        && error.code === "INCOMPLETE_DRILLDOWN",
    );
  });

  it("enforces page record and collection duration bounds", () => {
    assert.equal(
      TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS.apiPageSize,
      200,
    );
    assert.throws(
      () => normalizeTrustedAdvisorOrganizationCapture(capture({
        recommendations: {
          exhausted: true,
          pages: [{
            request: recommendationRequest(),
            response: {
              organizationRecommendationSummaries: Array.from(
                { length: 201 },
                () => summary(),
              ),
              nextToken: null,
            },
          }],
        },
      }), NOW),
      (error) =>
        error instanceof TrustedAdvisorOrganizationError
        && error.code === "INVALID_INPUT",
    );
    assert.throws(
      () => normalizeTrustedAdvisorOrganizationCapture(capture({
        startedAtIso: "2026-07-31T09:00:00.000Z",
        completedAtIso: "2026-07-31T10:00:01.000Z",
      }), NOW),
      (error) =>
        error instanceof TrustedAdvisorOrganizationError
        && error.code === "TIME_LIMIT_EXCEEDED",
    );
  });
});

describe("Trusted Advisor organization dashboard projection", () => {
  it("builds bounded organization, account, resource, freshness, and history views", () => {
    const current = normalizeTrustedAdvisorOrganizationCapture(capture(), NOW);
    const historicalSummary = summary({
      status: "error",
      resourcesAggregates: {
        errorCount: 1,
        excludedCount: 0,
        okCount: 0,
        warningCount: 0,
      },
    });
    const historical = normalizeTrustedAdvisorOrganizationCapture(capture({
      captureId: `tac_${"b".repeat(64)}`,
      startedAtIso: "2026-07-28T10:00:00.000Z",
      completedAtIso: "2026-07-28T10:02:00.000Z",
      recommendations: {
        exhausted: true,
        pages: [{
          request: recommendationRequest(),
          response: {
            organizationRecommendationSummaries: [historicalSummary],
            nextToken: null,
          },
        }],
      },
      recommendationDetails: [detail({
        status: "error",
        resourcesAggregates: historicalSummary.resourcesAggregates,
      })],
      resources: [{
        recommendationArn,
        exhausted: true,
        pages: [{
          request: resourceRequest(),
          response: {
            organizationRecommendationResourceSummaries: [{
              ...capture().resources[0].pages[0].response
                .organizationRecommendationResourceSummaries[0],
              status: "error",
            }],
            nextToken: null,
          },
        }],
      }],
    }), NOW);
    const dashboard = buildTrustedAdvisorOrganizationDashboard({
      scope,
      snapshots: [historical, current],
      options: {
        pillar: "security",
        accountId: "123456789012",
        recommendationLimit: 1,
        accountLimit: 1,
        resourceLimit: 1,
        historyLimit: 2,
      },
      nowMs: NOW,
    });
    assert.equal(dashboard.source.captureId, current.captureId);
    assert.equal(dashboard.source.fresh, true);
    assert.equal(dashboard.source.freshnessAgeHours, 1.97);
    assert.equal(dashboard.summary.recommendationCount, 1);
    assert.equal(dashboard.summary.accountCount, 1);
    assert.equal(dashboard.summary.resourceCount, 1);
    assert.deepEqual(dashboard.summary.recommendationStatusCounts, {
      ok: 0,
      warning: 1,
      error: 0,
    });
    assert.equal(dashboard.recommendations[0]?.accountsTruncated, false);
    assert.equal(dashboard.recommendations[0]?.resourcesTruncated, false);
    assert.deepEqual(
      dashboard.history.map((entry) =>
        entry.recommendationStatusCounts
      ),
      [
        { ok: 0, warning: 1, error: 0 },
        { ok: 0, warning: 0, error: 1 },
      ],
    );
    assert.match(dashboard.disclosure, /not evidence of complete/u);
  });

  it("rejects every cross-tenant snapshot instead of silently filtering it", () => {
    const snapshot = normalizeTrustedAdvisorOrganizationCapture(
      capture(),
      NOW,
    );
    assert.throws(
      () => buildTrustedAdvisorOrganizationDashboard({
        scope: {
          ...scope,
          customerId: "customer_bravo",
        },
        snapshots: [snapshot],
        nowMs: NOW,
      }),
      (error) =>
        error instanceof TrustedAdvisorOrganizationError
        && error.code === "SCOPE_MISMATCH",
    );
  });

  it("rejects malformed persisted snapshot state before projection", () => {
    const snapshot = normalizeTrustedAdvisorOrganizationCapture(
      capture(),
      NOW,
    );
    const malformed = {
      ...snapshot,
      recommendations: [{
        ...snapshot.recommendations[0],
        status: "invented_status",
      }],
    } as never;
    assert.throws(
      () => buildTrustedAdvisorOrganizationDashboard({
        scope,
        snapshots: [malformed],
        nowMs: NOW,
      }),
      (error) =>
        error instanceof TrustedAdvisorOrganizationError
        && error.code === "INVALID_INPUT"
        && error.message === "Trusted Advisor organization evidence rejected",
    );
  });

  it("reports stale source evidence and validates all response limits", () => {
    const old = normalizeTrustedAdvisorOrganizationCapture(capture({
      startedAtIso: "2026-07-27T10:00:00.000Z",
      completedAtIso: "2026-07-27T10:02:00.000Z",
    }), NOW);
    const dashboard = buildTrustedAdvisorOrganizationDashboard({
      scope,
      snapshots: [old],
      nowMs: NOW,
    });
    assert.equal(dashboard.source.fresh, false);
    assert.ok(dashboard.source.freshnessAgeHours > 48);
    assert.throws(
      () => buildTrustedAdvisorOrganizationDashboard({
        scope,
        snapshots: [old],
        options: {
          resourceLimit:
            TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS
              .maximumDashboardResources + 1,
        },
        nowMs: NOW,
      }),
      (error) =>
        error instanceof TrustedAdvisorOrganizationError
        && error.code === "INVALID_INPUT",
    );
  });
});
