import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResilienceVueDashboard,
  createResilienceVueQueryService,
  normalizeResilienceVueCapture,
  RESILIENCE_VUE_COLLECTION_BOUNDS,
  RESILIENCE_VUE_READ_OPERATIONS,
  resilienceVueSourceEvidence,
  ResilienceVueError,
  ResilienceVueQueryError,
  type ResilienceAssessment,
  type ResilienceVueCapture,
  type ResilienceVueScope,
} from "../lib/finops-resilience-vue.ts";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const APP_ARN = "arn:aws:resiliencehub:us-east-1:123456789012:app/app-abc";
const POLICY_ARN = "arn:aws:resiliencehub:us-east-1:123456789012:resiliency-policy/policy-abc";
const ASSESSMENT_ARN = "arn:aws:resiliencehub:us-east-1:123456789012:app-assessment/assessment-abc";
const SCOPE: ResilienceVueScope = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: `conn_${"a".repeat(32)}`,
  accountId: "123456789012",
  partition: "aws",
  region: "us-east-1",
};

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T[Key] extends object
      ? Mutable<T[Key]>
      : T[Key];
};

function page<T>(items: T[], exhausted = true) {
  return {
    pages: [{
      request: { maxResults: 100 as const, nextToken: null },
      response: { items, nextToken: exhausted ? null : "next-token" },
    }],
    exhausted,
  };
}

function emptyPage<T>() {
  return page<T>([]);
}

function assessment(overrides: Partial<ResilienceAssessment> = {}): ResilienceAssessment {
  return {
    assessmentArn: ASSESSMENT_ARN,
    appArn: APP_ARN,
    appVersion: "release-7",
    name: "production-assessment",
    assessmentStatus: "Success",
    complianceStatus: "PolicyBreached",
    driftStatus: "Detected",
    resiliencyScore: 62,
    startTime: "2026-07-31T10:00:00.000Z",
    endTime: "2026-07-31T10:05:00.000Z",
    message: null,
    objectivePosture: [{
      disruptionType: "AZ",
      complianceStatus: "PolicyBreached",
      currentRpoInSecs: 7200,
      currentRtoInSecs: 3600,
      achievableRpoInSecs: 1800,
      achievableRtoInSecs: 900,
      message: "Recovery objectives exceed policy.",
    }],
    riskRecommendations: [{
      appComponents: ["database"],
      risk: "Single-AZ database",
      recommendation: "Add a standby in a second Availability Zone.",
    }],
    ...overrides,
  };
}

function capture(): Mutable<ResilienceVueCapture> {
  const application = {
    appArn: APP_ARN,
    name: "payments",
    description: "Payments production workload",
    policyArn: POLICY_ARN,
    status: "Active",
    complianceStatus: "PolicyBreached" as const,
    driftStatus: "Detected" as const,
    resiliencyScore: 62,
    rpoInSecs: 3600,
    rtoInSecs: 1800,
    creationTime: "2026-01-01T00:00:00.000Z",
    lastAssessmentTime: "2026-07-31T10:05:00.000Z",
  };
  const policy = {
    policyArn: POLICY_ARN,
    policyName: "tier-1",
    description: "Tier one recovery policy",
    tier: "MissionCritical",
    creationTime: "2026-01-01T00:00:00.000Z",
    objectives: [{ disruptionType: "AZ" as const, rpoInSecs: 3600, rtoInSecs: 1800 }],
  };
  const assessmentValue = assessment();
  return {
    schemaVersion: "sutra.resilience-vue.v1",
    scope: { ...SCOPE },
    captureId: `resilience_${"b".repeat(64)}`,
    startedAtIso: "2026-07-31T10:00:00.000Z",
    completedAtIso: "2026-07-31T10:10:00.000Z",
    execution: { concurrencyLimit: 4, observedPeakConcurrency: 3 },
    prerequisites: {
      serviceConfigured: true,
      readPermissionsValidated: true,
      collectorRegionEnabled: true,
    },
    applications: page([application]),
    applicationDetails: [application],
    policies: page([policy]),
    policyDetails: [policy],
    assessmentHistories: [{ appArn: APP_ARN, history: page([assessmentValue]) }],
    assessmentEvidence: [{
      assessment: assessmentValue,
      componentCompliances: page([{
        assessmentArn: ASSESSMENT_ARN,
        appComponentName: "database",
        status: "Breached",
        resiliencyScore: 45,
        objectivePosture: assessmentValue.objectivePosture,
      }]),
      recommendations: page([{
        assessmentArn: ASSESSMENT_ARN,
        kind: "CONFIG",
        recommendationId: "config-001",
        appComponentName: "database",
        name: "Multi-AZ database",
        description: "Configure a standby in a second Availability Zone.",
        status: "NotImplemented",
        risk: "Availability Zone failure",
        resourceId: "arn:aws:rds:us-east-1:123456789012:db:payments",
        targetAccountId: "123456789012",
        targetRegion: "us-east-1",
        alreadyImplemented: false,
        excluded: false,
        expectedRpoInSecs: 1800,
        expectedRtoInSecs: 900,
        suggestedChanges: ["Enable Multi-AZ"],
      }, {
        assessmentArn: ASSESSMENT_ARN,
        kind: "ALARM",
        recommendationId: "alarm-001",
        appComponentName: "database",
        name: "Replication lag alarm",
        description: "Alert when replica lag threatens the recovery objective.",
        status: "Implemented",
        risk: null,
        resourceId: null,
        targetAccountId: null,
        targetRegion: null,
        alreadyImplemented: true,
        excluded: false,
        expectedRpoInSecs: null,
        expectedRtoInSecs: null,
        suggestedChanges: [],
      }]),
      drifts: page([{
        assessmentArn: ASSESSMENT_ARN,
        kind: "RESOURCE",
        referenceId: "drift-001",
        diffType: "Removed",
        appComponentName: "database",
        resourceId: "db-standby",
      }]),
    }],
    resourceInventories: [{
      appArn: APP_ARN,
      appVersion: "release-7",
      resources: page([{
        appArn: APP_ARN,
        appVersion: "release-7",
        resourceName: "payments-db",
        resourceType: "AWS::RDS::DBInstance",
        accountId: "123456789012",
        region: "us-east-1",
        resourceId: "arn:aws:rds:us-east-1:123456789012:db:payments",
        excluded: false,
        appComponents: ["database"],
      }]),
    }],
  } as Mutable<ResilienceVueCapture>;
}

test("declares only the exact read/list Resilience Hub operations", () => {
  assert.deepEqual(RESILIENCE_VUE_READ_OPERATIONS, [...RESILIENCE_VUE_READ_OPERATIONS].sort());
  assert.equal(RESILIENCE_VUE_READ_OPERATIONS.length, 14);
  assert.equal(RESILIENCE_VUE_READ_OPERATIONS.every((operation) =>
    /^resiliencehub:(Describe|List)/u.test(operation)), true);
  assert.equal(RESILIENCE_VUE_READ_OPERATIONS.some((operation) =>
    /(Start|Create|Update|Delete|Batch|Publish|Import|Resolve)/u.test(operation)), false);
});

test("normalizes provider evidence and keeps inferred prioritization visibly separate", () => {
  const snapshot = normalizeResilienceVueCapture(capture(), SCOPE, NOW.getTime());
  assert.equal(snapshot.state, "current");
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.applications.length, 1);
  assert.equal(snapshot.assessments.length, 1);
  assert.equal(snapshot.recommendations.length, 2);
  assert.equal(snapshot.resources.length, 1);

  const dashboard = buildResilienceVueDashboard(snapshot, NOW.getTime());
  assert.equal(dashboard.observedAwsEvidence.applicationCount, 1);
  assert.equal(dashboard.observedAwsEvidence.assessedApplicationCount, 1);
  assert.equal(dashboard.observedAwsEvidence.policyBreachedApplicationCount, 1);
  assert.equal(dashboard.observedAwsEvidence.driftedApplicationCount, 1);
  assert.equal(dashboard.observedAwsEvidence.openRecommendationCount, 1);
  assert.equal(dashboard.observedAwsEvidence.recommendationBacklog[0]?.recommendationId, "config-001");
  assert.deepEqual(dashboard.inferredPrioritization[0], {
    label: "SUTRA_INFERRED_PRIORITY_NOT_AWS_FINDING",
    assessmentArn: ASSESSMENT_ARN,
    recommendationId: "config-001",
    kind: "CONFIG",
    appComponentName: "database",
    priorityScore: 100,
    reasons: [
      "latest captured assessment breaches its policy",
      "latest captured assessment reports drift",
      "configuration recommendation can change recovery posture",
      "AWS supplied risk context",
      "recommendation is linked to an observed resource",
    ],
  });
});

test("fails closed on every tenant, account, partition, and Region substitution", () => {
  const scopes: ResilienceVueScope[] = [
    { ...SCOPE, orgId: "org_other" },
    { ...SCOPE, customerId: "customer_other" },
    { ...SCOPE, connectionId: `conn_${"c".repeat(32)}` },
    { ...SCOPE, accountId: "999988887777" },
    { ...SCOPE, partition: "aws-us-gov" },
    { ...SCOPE, region: "eu-west-1" },
  ];
  for (const expected of scopes) {
    assert.throws(() => normalizeResilienceVueCapture(capture(), expected, NOW.getTime()),
      (error) => error instanceof ResilienceVueError && error.code === "SCOPE_MISMATCH");
  }
});

test("rejects cross-account provider ARNs inside a correctly scoped capture", () => {
  const input = capture();
  input.applications.pages[0]!.response.items[0]!.appArn =
    "arn:aws:resiliencehub:us-east-1:999988887777:app/app-abc";
  assert.throws(() => normalizeResilienceVueCapture(input, SCOPE, NOW.getTime()),
    (error) => error instanceof ResilienceVueError && error.code === "SCOPE_MISMATCH");
});

test("rejects replayed pagination tokens and non-exhaustive token lies", () => {
  const replay = capture();
  replay.applications = {
    exhausted: false,
    pages: [{
      request: { maxResults: 100, nextToken: null },
      response: { items: replay.applications.pages[0]!.response.items, nextToken: "repeat" },
    }, {
      request: { maxResults: 100, nextToken: "repeat" },
      response: { items: [], nextToken: "repeat" },
    }],
  };
  assert.throws(() => normalizeResilienceVueCapture(replay, SCOPE, NOW.getTime()),
    (error) => error instanceof ResilienceVueError && error.code === "INVALID_PAGINATION");

  const falseExhaustion = capture();
  falseExhaustion.resourceInventories[0]!.resources.exhausted = true;
  falseExhaustion.resourceInventories[0]!.resources.pages[0]!.response.nextToken = "more";
  assert.throws(() => normalizeResilienceVueCapture(falseExhaustion, SCOPE, NOW.getTime()),
    (error) => error instanceof ResilienceVueError && error.code === "INVALID_PAGINATION");
});

test("deduplicates identical records but rejects conflicting duplicates", () => {
  const identical = capture();
  identical.resourceInventories[0]!.resources.pages[0]!.response.items.push({
    ...identical.resourceInventories[0]!.resources.pages[0]!.response.items[0]!,
    appComponents: [...identical.resourceInventories[0]!.resources.pages[0]!.response.items[0]!.appComponents],
  });
  assert.equal(normalizeResilienceVueCapture(identical, SCOPE, NOW.getTime()).resources.length, 1);

  const conflict = capture();
  conflict.resourceInventories[0]!.resources.pages[0]!.response.items.push({
    ...conflict.resourceInventories[0]!.resources.pages[0]!.response.items[0]!,
    resourceName: "different-name",
  });
  assert.throws(() => normalizeResilienceVueCapture(conflict, SCOPE, NOW.getTime()),
    (error) => error instanceof ResilienceVueError && error.code === "CONFLICTING_DUPLICATE");
});

test("represents configuration-required, no-app, no-assessment, partial, and stale states explicitly", () => {
  const configuration = capture();
  configuration.prerequisites.readPermissionsValidated = false;
  assert.equal(normalizeResilienceVueCapture(configuration, SCOPE, NOW.getTime()).state, "configuration_required");

  const noApps = capture();
  noApps.applications = emptyPage();
  noApps.applicationDetails = [];
  noApps.policies = emptyPage();
  noApps.policyDetails = [];
  noApps.assessmentHistories = [];
  noApps.assessmentEvidence = [];
  noApps.resourceInventories = [];
  const noAppsSnapshot = normalizeResilienceVueCapture(noApps, SCOPE, NOW.getTime());
  assert.equal(noAppsSnapshot.state, "no_apps");
  assert.match(noAppsSnapshot.limitations.join(" "), /not evidence that workloads are resilient/u);

  const noAssessments = capture();
  noAssessments.assessmentHistories[0]!.history = emptyPage();
  noAssessments.assessmentEvidence = [];
  noAssessments.resourceInventories = [];
  const noAssessmentSnapshot = normalizeResilienceVueCapture(noAssessments, SCOPE, NOW.getTime());
  assert.equal(noAssessmentSnapshot.state, "no_assessments");
  assert.match(noAssessmentSnapshot.limitations.join(" "), /has not been established/u);

  const partial = capture();
  partial.resourceInventories[0]!.resources = page(partial.resourceInventories[0]!.resources.pages[0]!.response.items, false);
  assert.equal(normalizeResilienceVueCapture(partial, SCOPE, NOW.getTime()).state, "partial");

  const stale = capture();
  assert.equal(normalizeResilienceVueCapture(stale, SCOPE, new Date("2026-08-10T12:00:00.000Z").getTime()).state, "stale");
});

test("does not label pending or failed assessments as successful resilience evidence", () => {
  for (const status of ["Pending", "InProgress", "Failed"] as const) {
    const input = capture();
    input.assessmentHistories[0]!.history.pages[0]!.response.items[0]!.assessmentStatus = status;
    input.assessmentEvidence[0]!.assessment.assessmentStatus = status;
    const snapshot = normalizeResilienceVueCapture(input, SCOPE, NOW.getTime());
    assert.equal(snapshot.state, "current");
    assert.match(snapshot.limitations.join(" "), /not treated as successful resilience evidence/u);
    assert.equal(buildResilienceVueDashboard(snapshot, NOW.getTime()).observedAwsEvidence.applicationPosture[0]?.latestAssessmentStatus, status);
  }
});

test("rejects history and text dimensions above declared bounds", () => {
  const history = capture();
  const base = history.assessmentHistories[0]!.history.pages[0]!.response.items[0]!;
  history.assessmentHistories[0]!.history.pages[0]!.response.items = Array.from({ length: 37 }, (_, index) => ({
    ...base,
    assessmentArn: `arn:aws:resiliencehub:us-east-1:123456789012:app-assessment/assessment-${index}`,
    name: `assessment-${index}`,
  }));
  assert.throws(() => normalizeResilienceVueCapture(history, SCOPE, NOW.getTime()),
    (error) => error instanceof ResilienceVueError && error.code === "BOUND_REACHED");

  const textBound = capture();
  textBound.assessmentEvidence[0]!.recommendations.pages[0]!.response.items[0]!.description = "x".repeat(8_193);
  assert.throws(() => normalizeResilienceVueCapture(textBound, SCOPE, NOW.getTime()),
    (error) => error instanceof ResilienceVueError && error.code === "INVALID_INPUT");
});

test("builds source health from retained evidence without turning absence into healthy resilience", () => {
  const input = capture();
  input.assessmentHistories[0]!.history = emptyPage();
  input.assessmentEvidence = [];
  input.resourceInventories = [];
  const evidence = resilienceVueSourceEvidence(normalizeResilienceVueCapture(input, SCOPE, NOW.getTime()));
  assert.equal(evidence.sourceId, "aws_resilience_hub");
  assert.equal(evidence.deliveryObserved, true);
  assert.equal(evidence.coverage.assessment, "complete");
  assert.match(evidence.limitations?.join(" ") ?? "", /has not been established/u);
});

test("query service sends only server-owned scope and declared bounds", async () => {
  let observedRequest: unknown;
  const service = createResilienceVueQueryService(SCOPE, {
    async collect(request) {
      observedRequest = request;
      return capture();
    },
  }, () => NOW.getTime());
  const result = await service.query();
  assert.equal(result.scope.customerId, "customer_alpha");
  assert.deepEqual(observedRequest, {
    schemaVersion: "sutra.resilience-vue-query.v1",
    scope: SCOPE,
    operations: RESILIENCE_VUE_READ_OPERATIONS,
    bounds: RESILIENCE_VUE_COLLECTION_BOUNDS,
  });
});

test("query service exposes only generic transport and evidence errors", async () => {
  const unavailable = createResilienceVueQueryService(SCOPE, {
    async collect() { throw new Error("credential detail must not escape"); },
  });
  await assert.rejects(unavailable.query(), (error) =>
    error instanceof ResilienceVueQueryError
    && error.code === "SOURCE_UNAVAILABLE"
    && !error.message.includes("credential"));

  const invalid = createResilienceVueQueryService(SCOPE, {
    async collect() {
      const input = capture();
      input.scope.customerId = "customer_other";
      return input;
    },
  }, () => NOW.getTime());
  await assert.rejects(invalid.query(), (error) =>
    error instanceof ResilienceVueQueryError
    && error.code === "INVALID_EVIDENCE"
    && !error.message.includes("customer_other"));
});
