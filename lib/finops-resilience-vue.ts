/**
 * Evidence-honest AWS Resilience Hub projection for Sutra ResilienceVue.
 *
 * This source slice is deliberately pure. The credential-owning collector and
 * durable store sit outside this module. A trusted server supplies the tenant
 * boundary, an authenticated broker returns a bounded capture, and this module
 * validates and projects that evidence without I/O or global tenant state.
 */
import type {
  FinopsSourceEvidence,
  FinopsSourceScope,
} from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u;
const CAPTURE_ID = /^resilience_[a-f0-9]{64}$/u;
const TOKEN = /^\S{1,2000}$/u;
const APP_ARN = /^arn:(aws|aws-cn|aws-us-gov):resiliencehub:([a-z0-9-]+):(\d{12}):app\/[A-Za-z0-9/_+.-]{1,1024}$/u;
const ASSESSMENT_ARN = /^arn:(aws|aws-cn|aws-us-gov):resiliencehub:([a-z0-9-]+):(\d{12}):app-assessment\/[A-Za-z0-9/_+.-]{1,1024}$/u;
const POLICY_ARN = /^arn:(aws|aws-cn|aws-us-gov):resiliencehub:([a-z0-9-]+):(\d{12}):resiliency-policy\/[A-Za-z0-9/_+.-]{1,1024}$/u;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const RESILIENCE_VUE_COLLECTION_BOUNDS = Object.freeze({
  apiPageSize: 100,
  maximumConcurrency: 4,
  maximumDurationMs: 15 * 60 * 1_000,
  maximumCaptureBytes: 48 * 1_024 * 1_024,
  maximumPages: 20_000,
  maximumCaptureRecords: 500_000,
  maximumApplications: 1_000,
  maximumPolicies: 1_000,
  maximumAssessments: 20_000,
  maximumAssessmentHistoryPerApplication: 36,
  maximumComponentCompliances: 100_000,
  maximumRecommendations: 200_000,
  maximumResources: 200_000,
  maximumDrifts: 100_000,
  maximumTextCharacters: 8_192,
  maximumSuggestedChangesPerRecommendation: 50,
  maximumComponentsPerResource: 100,
  maximumDashboardInputBytes: 64 * 1_024 * 1_024,
  maximumDashboardApplications: 500,
  maximumDashboardRecommendations: 1_000,
  maximumDashboardResources: 2_000,
  maximumDashboardHistoryRecords: 5_000,
  sourceFreshnessSlaHours: 168,
} as const);

/** The complete read-only API surface required by this v1 capture contract. */
export const RESILIENCE_VUE_READ_OPERATIONS = Object.freeze([
  "resiliencehub:DescribeApp",
  "resiliencehub:DescribeAppAssessment",
  "resiliencehub:DescribeResiliencyPolicy",
  "resiliencehub:ListAlarmRecommendations",
  "resiliencehub:ListAppAssessmentComplianceDrifts",
  "resiliencehub:ListAppAssessmentResourceDrifts",
  "resiliencehub:ListAppAssessments",
  "resiliencehub:ListAppComponentCompliances",
  "resiliencehub:ListAppComponentRecommendations",
  "resiliencehub:ListAppVersionResources",
  "resiliencehub:ListApps",
  "resiliencehub:ListResiliencyPolicies",
  "resiliencehub:ListSopRecommendations",
  "resiliencehub:ListTestRecommendations",
] as const);

export type ResilienceVuePartition = "aws" | "aws-cn" | "aws-us-gov";
export type ResilienceComplianceStatus =
  | "PolicyBreached"
  | "PolicyMet"
  | "NotApplicable"
  | "MissingPolicy";
export type ResilienceDriftStatus = "NotChecked" | "NotDetected" | "Detected";
export type ResilienceAssessmentStatus =
  | "Pending"
  | "InProgress"
  | "Failed"
  | "Success";
export type ResilienceRecommendationStatus =
  | "Implemented"
  | "Inactive"
  | "NotImplemented"
  | "Excluded";
export type ResilienceRecommendationKind = "CONFIG" | "ALARM" | "SOP" | "TEST";
export type ResilienceDisruptionType =
  | "Software"
  | "Hardware"
  | "AZ"
  | "Region";
export type ResilienceDiffType = "Added" | "Removed";

export interface ResilienceVueScope extends FinopsSourceScope {
  readonly accountId: string;
  readonly partition: ResilienceVuePartition;
  readonly region: string;
}

export interface ResilienceVuePrerequisites {
  readonly serviceConfigured: boolean;
  readonly readPermissionsValidated: boolean;
  readonly collectorRegionEnabled: boolean;
}

export interface ResilienceApp {
  readonly appArn: string;
  readonly name: string;
  readonly description: string | null;
  readonly policyArn: string | null;
  readonly status: string;
  readonly complianceStatus: ResilienceComplianceStatus | null;
  readonly driftStatus: ResilienceDriftStatus | null;
  readonly resiliencyScore: number | null;
  readonly rpoInSecs: number | null;
  readonly rtoInSecs: number | null;
  readonly creationTime: string;
  readonly lastAssessmentTime: string | null;
}

export interface ResiliencePolicyObjective {
  readonly disruptionType: ResilienceDisruptionType;
  readonly rpoInSecs: number;
  readonly rtoInSecs: number;
}

export interface ResiliencePolicy {
  readonly policyArn: string;
  readonly policyName: string;
  readonly description: string | null;
  readonly tier: string;
  readonly creationTime: string;
  readonly objectives: readonly ResiliencePolicyObjective[];
}

export interface ResilienceObjectivePosture {
  readonly disruptionType: ResilienceDisruptionType;
  readonly complianceStatus: ResilienceComplianceStatus;
  readonly currentRpoInSecs: number | null;
  readonly currentRtoInSecs: number | null;
  readonly achievableRpoInSecs: number | null;
  readonly achievableRtoInSecs: number | null;
  readonly message: string | null;
}

export interface ResilienceRiskRecommendation {
  readonly appComponents: readonly string[];
  readonly risk: string;
  readonly recommendation: string;
}

export interface ResilienceAssessment {
  readonly assessmentArn: string;
  readonly appArn: string;
  readonly appVersion: string;
  readonly name: string;
  readonly assessmentStatus: ResilienceAssessmentStatus;
  readonly complianceStatus: ResilienceComplianceStatus | null;
  readonly driftStatus: ResilienceDriftStatus | null;
  readonly resiliencyScore: number | null;
  readonly startTime: string;
  readonly endTime: string | null;
  readonly message: string | null;
  readonly objectivePosture: readonly ResilienceObjectivePosture[];
  readonly riskRecommendations: readonly ResilienceRiskRecommendation[];
}

export interface ResilienceComponentCompliance {
  readonly assessmentArn: string;
  readonly appComponentName: string;
  readonly status: string;
  readonly resiliencyScore: number | null;
  readonly objectivePosture: readonly ResilienceObjectivePosture[];
}

export interface ResilienceRecommendation {
  readonly assessmentArn: string;
  readonly kind: ResilienceRecommendationKind;
  readonly recommendationId: string;
  readonly appComponentName: string;
  readonly name: string;
  readonly description: string;
  readonly status: ResilienceRecommendationStatus;
  readonly risk: string | null;
  readonly resourceId: string | null;
  readonly targetAccountId: string | null;
  readonly targetRegion: string | null;
  readonly alreadyImplemented: boolean | null;
  readonly excluded: boolean | null;
  readonly expectedRpoInSecs: number | null;
  readonly expectedRtoInSecs: number | null;
  readonly suggestedChanges: readonly string[];
}

export interface ResilienceResource {
  readonly appArn: string;
  readonly appVersion: string;
  readonly resourceName: string;
  readonly resourceType: string;
  readonly accountId: string;
  readonly region: string;
  readonly resourceId: string;
  readonly excluded: boolean;
  readonly appComponents: readonly string[];
}

export interface ResilienceDrift {
  readonly assessmentArn: string;
  readonly kind: "COMPLIANCE" | "RESOURCE";
  readonly referenceId: string;
  readonly diffType: ResilienceDiffType;
  readonly appComponentName: string | null;
  readonly resourceId: string | null;
}

interface ResiliencePage<T> {
  readonly request: { readonly maxResults: 100; readonly nextToken: string | null };
  readonly response: { readonly items: readonly T[]; readonly nextToken: string | null };
}

export interface ResiliencePageSequence<T> {
  readonly pages: readonly ResiliencePage<T>[];
  /** False means collection stopped at a declared Sutra bound. */
  readonly exhausted: boolean;
}

export interface ResilienceAssessmentEvidence {
  readonly assessment: ResilienceAssessment;
  readonly componentCompliances: ResiliencePageSequence<ResilienceComponentCompliance>;
  readonly recommendations: ResiliencePageSequence<ResilienceRecommendation>;
  readonly drifts: ResiliencePageSequence<ResilienceDrift>;
}

export interface ResilienceResourceInventory {
  readonly appArn: string;
  readonly appVersion: string;
  readonly resources: ResiliencePageSequence<ResilienceResource>;
}

export interface ResilienceVueCapture {
  readonly schemaVersion: "sutra.resilience-vue.v1";
  readonly scope: ResilienceVueScope;
  readonly captureId: string;
  readonly startedAtIso: string;
  readonly completedAtIso: string;
  readonly execution: {
    readonly concurrencyLimit: 4;
    readonly observedPeakConcurrency: number;
  };
  readonly prerequisites: ResilienceVuePrerequisites;
  readonly applications: ResiliencePageSequence<ResilienceApp>;
  /** One DescribeApp result for every listed application. */
  readonly applicationDetails: readonly ResilienceApp[];
  readonly policies: ResiliencePageSequence<ResiliencePolicy>;
  /** One DescribeResiliencyPolicy result for every listed policy. */
  readonly policyDetails: readonly ResiliencePolicy[];
  /** ListAppAssessments is collected independently for each listed app. */
  readonly assessmentHistories: readonly ({
    readonly appArn: string;
    readonly history: ResiliencePageSequence<ResilienceAssessment>;
  })[];
  readonly assessmentEvidence: readonly ResilienceAssessmentEvidence[];
  /** ListAppVersionResources is collected for each assessed app version. */
  readonly resourceInventories: readonly ResilienceResourceInventory[];
}

export type ResilienceVueState =
  | "configuration_required"
  | "no_apps"
  | "no_assessments"
  | "partial"
  | "stale"
  | "current";

export interface ResilienceVueSnapshot {
  readonly schemaVersion: "sutra.resilience-vue-snapshot.v1";
  readonly scope: ResilienceVueScope;
  readonly captureId: string;
  readonly completedAtIso: string;
  readonly state: ResilienceVueState;
  readonly applications: readonly ResilienceApp[];
  readonly policies: readonly ResiliencePolicy[];
  readonly assessments: readonly ResilienceAssessment[];
  readonly componentCompliances: readonly ResilienceComponentCompliance[];
  readonly recommendations: readonly ResilienceRecommendation[];
  readonly resources: readonly ResilienceResource[];
  readonly drifts: readonly ResilienceDrift[];
  readonly complete: boolean;
  readonly limitations: readonly string[];
}

export type ResilienceVueErrorCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "BOUND_REACHED"
  | "INVALID_PAGINATION"
  | "CONFLICTING_DUPLICATE";

export class ResilienceVueError extends Error {
  public readonly code: ResilienceVueErrorCode;

  public constructor(code: ResilienceVueErrorCode) {
    super("The AWS Resilience Hub evidence is invalid");
    this.name = "ResilienceVueError";
    this.code = code;
  }
}

function reject(code: ResilienceVueErrorCode): never {
  throw new ResilienceVueError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function exact(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) reject("INVALID_INPUT");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) reject("INVALID_INPUT");
  return value;
}

function text(value: unknown, maximum = 256): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) reject("INVALID_INPUT");
  return value;
}

function nullableText(value: unknown, maximum = 256): string | null {
  return value === null ? null : text(value, maximum);
}

function timestamp(value: unknown, maximumMs: number): string {
  const result = text(value, 40);
  const milliseconds = Date.parse(result);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== result
    || milliseconds > maximumMs
  ) reject("INVALID_INPUT");
  return result;
}

function nullableTimestamp(value: unknown, maximumMs: number): string | null {
  return value === null ? null : timestamp(value, maximumMs);
}

function nullableMetric(value: unknown, maximum = 31_536_000): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    reject("INVALID_INPUT");
  }
  return value;
}

function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) reject("INVALID_INPUT");
  return value as T;
}

function sortedUniqueTexts(value: unknown, maximumItems: number, maximumText = 256): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) reject("BOUND_REACHED");
  const result = value.map((entry) => text(entry, maximumText));
  const sorted = [...new Set(result)].sort();
  if (sorted.length !== result.length || JSON.stringify(sorted) !== JSON.stringify(result)) {
    reject("INVALID_INPUT");
  }
  return sorted;
}

function arnScope(value: string, pattern: RegExp, scope: ResilienceVueScope): void {
  const match = pattern.exec(value);
  if (!match || match[1] !== scope.partition || match[2] !== scope.region || match[3] !== scope.accountId) {
    reject("SCOPE_MISMATCH");
  }
}

function scope(value: unknown): ResilienceVueScope {
  const record = exact(value, ["orgId", "customerId", "connectionId", "accountId", "partition", "region"]);
  const orgId = text(record.orgId);
  const customerId = text(record.customerId);
  const connectionId = text(record.connectionId, 37);
  const accountId = text(record.accountId, 12);
  const partition = choice(record.partition, ["aws", "aws-cn", "aws-us-gov"] as const);
  const region = text(record.region, 32);
  if (!IDENTIFIER.test(orgId) || !IDENTIFIER.test(customerId) || !CONNECTION_ID.test(connectionId)
    || !ACCOUNT_ID.test(accountId) || !REGION.test(region)) reject("INVALID_INPUT");
  return { orgId, customerId, connectionId, accountId, partition, region };
}

function sameScope(left: ResilienceVueScope, right: ResilienceVueScope): boolean {
  return left.orgId === right.orgId && left.customerId === right.customerId
    && left.connectionId === right.connectionId && left.accountId === right.accountId
    && left.partition === right.partition && left.region === right.region;
}

function stableAdd<T>(map: Map<string, T>, key: string, value: T): void {
  const previous = map.get(key);
  if (previous === undefined) map.set(key, value);
  else if (JSON.stringify(previous) !== JSON.stringify(value)) reject("CONFLICTING_DUPLICATE");
}

function app(value: unknown, expectedScope: ResilienceVueScope, maximumMs: number): ResilienceApp {
  const record = exact(value, ["appArn", "name", "description", "policyArn", "status", "complianceStatus", "driftStatus", "resiliencyScore", "rpoInSecs", "rtoInSecs", "creationTime", "lastAssessmentTime"]);
  const appArn = text(record.appArn, 1200);
  arnScope(appArn, APP_ARN, expectedScope);
  const policyArn = nullableText(record.policyArn, 1200);
  if (policyArn !== null) arnScope(policyArn, POLICY_ARN, expectedScope);
  return {
    appArn,
    name: text(record.name, 60),
    description: nullableText(record.description, RESILIENCE_VUE_COLLECTION_BOUNDS.maximumTextCharacters),
    policyArn,
    status: text(record.status, 64),
    complianceStatus: record.complianceStatus === null ? null : choice(record.complianceStatus, ["PolicyBreached", "PolicyMet", "NotApplicable", "MissingPolicy"] as const),
    driftStatus: record.driftStatus === null ? null : choice(record.driftStatus, ["NotChecked", "NotDetected", "Detected"] as const),
    resiliencyScore: nullableMetric(record.resiliencyScore, 100),
    rpoInSecs: nullableMetric(record.rpoInSecs),
    rtoInSecs: nullableMetric(record.rtoInSecs),
    creationTime: timestamp(record.creationTime, maximumMs),
    lastAssessmentTime: nullableTimestamp(record.lastAssessmentTime, maximumMs),
  };
}

function objective(value: unknown): ResiliencePolicyObjective {
  const record = exact(value, ["disruptionType", "rpoInSecs", "rtoInSecs"]);
  const rpoInSecs = nullableMetric(record.rpoInSecs);
  const rtoInSecs = nullableMetric(record.rtoInSecs);
  if (rpoInSecs === null || rtoInSecs === null) reject("INVALID_INPUT");
  return { disruptionType: choice(record.disruptionType, ["Software", "Hardware", "AZ", "Region"] as const), rpoInSecs, rtoInSecs };
}

function policy(value: unknown, expectedScope: ResilienceVueScope, maximumMs: number): ResiliencePolicy {
  const record = exact(value, ["policyArn", "policyName", "description", "tier", "creationTime", "objectives"]);
  const policyArn = text(record.policyArn, 1200);
  arnScope(policyArn, POLICY_ARN, expectedScope);
  if (!Array.isArray(record.objectives) || record.objectives.length < 1 || record.objectives.length > 4) reject("INVALID_INPUT");
  const objectives = record.objectives.map(objective).sort((a, b) => a.disruptionType.localeCompare(b.disruptionType));
  if (new Set(objectives.map((item) => item.disruptionType)).size !== objectives.length) reject("CONFLICTING_DUPLICATE");
  return {
    policyArn,
    policyName: text(record.policyName, 60),
    description: nullableText(record.description, RESILIENCE_VUE_COLLECTION_BOUNDS.maximumTextCharacters),
    tier: text(record.tier, 64),
    creationTime: timestamp(record.creationTime, maximumMs),
    objectives,
  };
}

function posture(value: unknown): ResilienceObjectivePosture {
  const record = exact(value, ["disruptionType", "complianceStatus", "currentRpoInSecs", "currentRtoInSecs", "achievableRpoInSecs", "achievableRtoInSecs", "message"]);
  return {
    disruptionType: choice(record.disruptionType, ["Software", "Hardware", "AZ", "Region"] as const),
    complianceStatus: choice(record.complianceStatus, ["PolicyBreached", "PolicyMet", "NotApplicable", "MissingPolicy"] as const),
    currentRpoInSecs: nullableMetric(record.currentRpoInSecs),
    currentRtoInSecs: nullableMetric(record.currentRtoInSecs),
    achievableRpoInSecs: nullableMetric(record.achievableRpoInSecs),
    achievableRtoInSecs: nullableMetric(record.achievableRtoInSecs),
    message: nullableText(record.message, RESILIENCE_VUE_COLLECTION_BOUNDS.maximumTextCharacters),
  };
}

function postures(value: unknown): readonly ResilienceObjectivePosture[] {
  if (!Array.isArray(value) || value.length > 4) reject("INVALID_INPUT");
  const result = value.map(posture).sort((a, b) => a.disruptionType.localeCompare(b.disruptionType));
  if (new Set(result.map((item) => item.disruptionType)).size !== result.length) reject("CONFLICTING_DUPLICATE");
  return result;
}

function assessment(value: unknown, expectedScope: ResilienceVueScope, maximumMs: number): ResilienceAssessment {
  const record = exact(value, ["assessmentArn", "appArn", "appVersion", "name", "assessmentStatus", "complianceStatus", "driftStatus", "resiliencyScore", "startTime", "endTime", "message", "objectivePosture", "riskRecommendations"]);
  const assessmentArn = text(record.assessmentArn, 1200);
  const appArn = text(record.appArn, 1200);
  arnScope(assessmentArn, ASSESSMENT_ARN, expectedScope);
  arnScope(appArn, APP_ARN, expectedScope);
  if (!Array.isArray(record.riskRecommendations) || record.riskRecommendations.length > 100) reject("BOUND_REACHED");
  const riskRecommendations = record.riskRecommendations.map((entry) => {
    const risk = exact(entry, ["appComponents", "risk", "recommendation"]);
    return {
      appComponents: sortedUniqueTexts(risk.appComponents, 100),
      risk: text(risk.risk, 256),
      recommendation: text(risk.recommendation, RESILIENCE_VUE_COLLECTION_BOUNDS.maximumTextCharacters),
    };
  });
  const startTime = timestamp(record.startTime, maximumMs);
  const endTime = nullableTimestamp(record.endTime, maximumMs);
  if (endTime !== null && Date.parse(endTime) < Date.parse(startTime)) reject("INVALID_INPUT");
  return {
    assessmentArn, appArn,
    appVersion: text(record.appVersion, 50),
    name: text(record.name, 60),
    assessmentStatus: choice(record.assessmentStatus, ["Pending", "InProgress", "Failed", "Success"] as const),
    complianceStatus: record.complianceStatus === null ? null : choice(record.complianceStatus, ["PolicyBreached", "PolicyMet", "NotApplicable", "MissingPolicy"] as const),
    driftStatus: record.driftStatus === null ? null : choice(record.driftStatus, ["NotChecked", "NotDetected", "Detected"] as const),
    resiliencyScore: nullableMetric(record.resiliencyScore, 100), startTime, endTime,
    message: nullableText(record.message, RESILIENCE_VUE_COLLECTION_BOUNDS.maximumTextCharacters),
    objectivePosture: postures(record.objectivePosture), riskRecommendations,
  };
}

function component(value: unknown, expectedScope: ResilienceVueScope): ResilienceComponentCompliance {
  const record = exact(value, ["assessmentArn", "appComponentName", "status", "resiliencyScore", "objectivePosture"]);
  const assessmentArn = text(record.assessmentArn, 1200);
  arnScope(assessmentArn, ASSESSMENT_ARN, expectedScope);
  return { assessmentArn, appComponentName: text(record.appComponentName, 256), status: text(record.status, 64), resiliencyScore: nullableMetric(record.resiliencyScore, 100), objectivePosture: postures(record.objectivePosture) };
}

function recommendation(value: unknown, expectedScope: ResilienceVueScope): ResilienceRecommendation {
  const record = exact(value, ["assessmentArn", "kind", "recommendationId", "appComponentName", "name", "description", "status", "risk", "resourceId", "targetAccountId", "targetRegion", "alreadyImplemented", "excluded", "expectedRpoInSecs", "expectedRtoInSecs", "suggestedChanges"]);
  const assessmentArn = text(record.assessmentArn, 1200);
  arnScope(assessmentArn, ASSESSMENT_ARN, expectedScope);
  const targetAccountId = nullableText(record.targetAccountId, 12);
  const targetRegion = nullableText(record.targetRegion, 32);
  if (targetAccountId !== null && !ACCOUNT_ID.test(targetAccountId)) reject("INVALID_INPUT");
  if (targetRegion !== null && !REGION.test(targetRegion)) reject("INVALID_INPUT");
  if (typeof record.alreadyImplemented !== "boolean" && record.alreadyImplemented !== null) reject("INVALID_INPUT");
  if (typeof record.excluded !== "boolean" && record.excluded !== null) reject("INVALID_INPUT");
  return {
    assessmentArn,
    kind: choice(record.kind, ["CONFIG", "ALARM", "SOP", "TEST"] as const),
    recommendationId: text(record.recommendationId, 256),
    appComponentName: text(record.appComponentName, 256),
    name: text(record.name, 512),
    description: text(record.description, RESILIENCE_VUE_COLLECTION_BOUNDS.maximumTextCharacters),
    status: choice(record.status, ["Implemented", "Inactive", "NotImplemented", "Excluded"] as const),
    risk: nullableText(record.risk, 256), resourceId: nullableText(record.resourceId, 1024),
    targetAccountId, targetRegion,
    alreadyImplemented: record.alreadyImplemented as boolean | null,
    excluded: record.excluded as boolean | null,
    expectedRpoInSecs: nullableMetric(record.expectedRpoInSecs),
    expectedRtoInSecs: nullableMetric(record.expectedRtoInSecs),
    suggestedChanges: sortedUniqueTexts(record.suggestedChanges, RESILIENCE_VUE_COLLECTION_BOUNDS.maximumSuggestedChangesPerRecommendation, RESILIENCE_VUE_COLLECTION_BOUNDS.maximumTextCharacters),
  };
}

function resource(value: unknown, expectedScope: ResilienceVueScope): ResilienceResource {
  const record = exact(value, ["appArn", "appVersion", "resourceName", "resourceType", "accountId", "region", "resourceId", "excluded", "appComponents"]);
  const appArn = text(record.appArn, 1200);
  arnScope(appArn, APP_ARN, expectedScope);
  const accountId = text(record.accountId, 12);
  const region = text(record.region, 32);
  if (!ACCOUNT_ID.test(accountId) || !REGION.test(region) || typeof record.excluded !== "boolean") reject("INVALID_INPUT");
  return { appArn, appVersion: text(record.appVersion, 50), resourceName: text(record.resourceName, 512), resourceType: text(record.resourceType, 256), accountId, region, resourceId: text(record.resourceId, 1200), excluded: record.excluded, appComponents: sortedUniqueTexts(record.appComponents, RESILIENCE_VUE_COLLECTION_BOUNDS.maximumComponentsPerResource) };
}

function drift(value: unknown, expectedScope: ResilienceVueScope): ResilienceDrift {
  const record = exact(value, ["assessmentArn", "kind", "referenceId", "diffType", "appComponentName", "resourceId"]);
  const assessmentArn = text(record.assessmentArn, 1200);
  arnScope(assessmentArn, ASSESSMENT_ARN, expectedScope);
  return { assessmentArn, kind: choice(record.kind, ["COMPLIANCE", "RESOURCE"] as const), referenceId: text(record.referenceId, 256), diffType: choice(record.diffType, ["Added", "Removed"] as const), appComponentName: nullableText(record.appComponentName, 256), resourceId: nullableText(record.resourceId, 1200) };
}

function pageSequence<T>(
  value: unknown,
  itemParser: (entry: unknown) => T,
  maximumItems: number,
  counters: { pages: number; items: number },
): { sequence: ResiliencePageSequence<T>; items: readonly T[] } {
  const sequenceRecord = exact(value, ["pages", "exhausted"]);
  if (!Array.isArray(sequenceRecord.pages) || typeof sequenceRecord.exhausted !== "boolean") reject("INVALID_INPUT");
  const tokens = new Set<string>();
  let expectedToken: string | null = null;
  const output: T[] = [];
  for (const pageValue of sequenceRecord.pages) {
    counters.pages += 1;
    if (counters.pages > RESILIENCE_VUE_COLLECTION_BOUNDS.maximumPages) reject("BOUND_REACHED");
    const page = exact(pageValue, ["request", "response"]);
    const request = exact(page.request, ["maxResults", "nextToken"]);
    const response = exact(page.response, ["items", "nextToken"]);
    if (request.maxResults !== 100 || request.nextToken !== expectedToken || !Array.isArray(response.items) || response.items.length > 100) reject("INVALID_PAGINATION");
    if (request.nextToken !== null && (!TOKEN.test(request.nextToken as string) || tokens.has(request.nextToken as string))) reject("INVALID_PAGINATION");
    if (request.nextToken !== null) tokens.add(request.nextToken as string);
    const nextToken = response.nextToken;
    if (nextToken !== null && (typeof nextToken !== "string" || !TOKEN.test(nextToken) || tokens.has(nextToken))) reject("INVALID_PAGINATION");
    output.push(...response.items.map(itemParser));
    counters.items += response.items.length;
    if (output.length > maximumItems || counters.items > RESILIENCE_VUE_COLLECTION_BOUNDS.maximumCaptureRecords) reject("BOUND_REACHED");
    expectedToken = nextToken as string | null;
  }
  if ((sequenceRecord.exhausted && expectedToken !== null) || (!sequenceRecord.exhausted && expectedToken === null && sequenceRecord.pages.length > 0)) reject("INVALID_PAGINATION");
  if (sequenceRecord.pages.length === 0 && !sequenceRecord.exhausted) reject("INVALID_PAGINATION");
  return { sequence: value as ResiliencePageSequence<T>, items: output };
}

function completedAndFresh(completedAtIso: string, nowMs: number): boolean {
  return nowMs - Date.parse(completedAtIso) <= RESILIENCE_VUE_COLLECTION_BOUNDS.sourceFreshnessSlaHours * 3_600_000;
}

export function normalizeResilienceVueCapture(
  input: ResilienceVueCapture,
  expectedScope: ResilienceVueScope,
  nowMs = Date.now(),
): ResilienceVueSnapshot {
  if (!Number.isFinite(nowMs)) reject("INVALID_INPUT");
  if (jsonBytes(input) > RESILIENCE_VUE_COLLECTION_BOUNDS.maximumCaptureBytes) reject("BOUND_REACHED");
  const root = exact(input, ["schemaVersion", "scope", "captureId", "startedAtIso", "completedAtIso", "execution", "prerequisites", "applications", "applicationDetails", "policies", "policyDetails", "assessmentHistories", "assessmentEvidence", "resourceInventories"]);
  if (root.schemaVersion !== "sutra.resilience-vue.v1" || typeof root.captureId !== "string" || !CAPTURE_ID.test(root.captureId)) reject("INVALID_INPUT");
  const parsedScope = scope(root.scope);
  const trustedScope = scope(expectedScope);
  if (!sameScope(parsedScope, trustedScope)) reject("SCOPE_MISMATCH");
  const startedAtIso = timestamp(root.startedAtIso, nowMs + MAX_CLOCK_SKEW_MS);
  const completedAtIso = timestamp(root.completedAtIso, nowMs + MAX_CLOCK_SKEW_MS);
  const duration = Date.parse(completedAtIso) - Date.parse(startedAtIso);
  if (duration < 0 || duration > RESILIENCE_VUE_COLLECTION_BOUNDS.maximumDurationMs) reject("BOUND_REACHED");
  const execution = exact(root.execution, ["concurrencyLimit", "observedPeakConcurrency"]);
  if (execution.concurrencyLimit !== 4 || !Number.isInteger(execution.observedPeakConcurrency) || (execution.observedPeakConcurrency as number) < 0 || (execution.observedPeakConcurrency as number) > 4) reject("BOUND_REACHED");
  const prerequisites = exact(root.prerequisites, ["serviceConfigured", "readPermissionsValidated", "collectorRegionEnabled"]);
  if (![prerequisites.serviceConfigured, prerequisites.readPermissionsValidated, prerequisites.collectorRegionEnabled].every((entry) => typeof entry === "boolean")) reject("INVALID_INPUT");

  const counters = { pages: 0, items: 0 };
  const applications = pageSequence(root.applications, (entry) => app(entry, trustedScope, Date.parse(completedAtIso)), RESILIENCE_VUE_COLLECTION_BOUNDS.maximumApplications, counters);
  const appMap = new Map<string, ResilienceApp>();
  for (const item of applications.items) stableAdd(appMap, item.appArn, item);
  if (!Array.isArray(root.applicationDetails) || root.applicationDetails.length > RESILIENCE_VUE_COLLECTION_BOUNDS.maximumApplications) reject("BOUND_REACHED");
  const details = new Map<string, ResilienceApp>();
  for (const entry of root.applicationDetails) {
    const item = app(entry, trustedScope, Date.parse(completedAtIso));
    stableAdd(details, item.appArn, item);
  }
  if (details.size !== appMap.size || [...appMap.keys()].some((key) => !details.has(key))) reject("INVALID_INPUT");
  for (const [key, item] of appMap) if (JSON.stringify(item) !== JSON.stringify(details.get(key))) reject("CONFLICTING_DUPLICATE");

  const policies = pageSequence(root.policies, (entry) => policy(entry, trustedScope, Date.parse(completedAtIso)), RESILIENCE_VUE_COLLECTION_BOUNDS.maximumPolicies, counters);
  const policyMap = new Map<string, ResiliencePolicy>();
  for (const item of policies.items) stableAdd(policyMap, item.policyArn, item);
  if (!Array.isArray(root.policyDetails) || root.policyDetails.length > RESILIENCE_VUE_COLLECTION_BOUNDS.maximumPolicies) reject("BOUND_REACHED");
  const policyDetails = new Map<string, ResiliencePolicy>();
  for (const entry of root.policyDetails) {
    const item = policy(entry, trustedScope, Date.parse(completedAtIso));
    stableAdd(policyDetails, item.policyArn, item);
  }
  if (policyDetails.size !== policyMap.size || [...policyMap.keys()].some((key) => !policyDetails.has(key))) reject("INVALID_INPUT");
  for (const [key, item] of policyMap) if (JSON.stringify(item) !== JSON.stringify(policyDetails.get(key))) reject("CONFLICTING_DUPLICATE");
  for (const item of details.values()) if (item.policyArn !== null && !policyMap.has(item.policyArn)) reject("INVALID_INPUT");

  if (!Array.isArray(root.assessmentHistories) || root.assessmentHistories.length > RESILIENCE_VUE_COLLECTION_BOUNDS.maximumApplications) reject("BOUND_REACHED");
  const assessmentMap = new Map<string, ResilienceAssessment>();
  const historyApps = new Set<string>();
  let historiesExhausted = true;
  for (const entry of root.assessmentHistories) {
    const history = exact(entry, ["appArn", "history"]);
    const appArn = text(history.appArn, 1200);
    arnScope(appArn, APP_ARN, trustedScope);
    if (!appMap.has(appArn) || historyApps.has(appArn)) reject("CONFLICTING_DUPLICATE");
    historyApps.add(appArn);
    const result = pageSequence(history.history, (item) => assessment(item, trustedScope, Date.parse(completedAtIso)), RESILIENCE_VUE_COLLECTION_BOUNDS.maximumAssessmentHistoryPerApplication, counters);
    historiesExhausted = historiesExhausted && result.sequence.exhausted;
    if (result.items.some((item) => item.appArn !== appArn)) reject("SCOPE_MISMATCH");
    for (const item of result.items) stableAdd(assessmentMap, item.assessmentArn, item);
  }
  if (historyApps.size !== appMap.size) reject("INVALID_INPUT");
  if (assessmentMap.size > RESILIENCE_VUE_COLLECTION_BOUNDS.maximumAssessments) reject("BOUND_REACHED");

  if (!Array.isArray(root.assessmentEvidence) || root.assessmentEvidence.length > RESILIENCE_VUE_COLLECTION_BOUNDS.maximumAssessments) reject("BOUND_REACHED");
  const evidenceAssessments = new Set<string>();
  const componentMap = new Map<string, ResilienceComponentCompliance>();
  const recommendationMap = new Map<string, ResilienceRecommendation>();
  const driftMap = new Map<string, ResilienceDrift>();
  let evidenceExhausted = true;
  for (const entry of root.assessmentEvidence) {
    const evidence = exact(entry, ["assessment", "componentCompliances", "recommendations", "drifts"]);
    const detail = assessment(evidence.assessment, trustedScope, Date.parse(completedAtIso));
    const summary = assessmentMap.get(detail.assessmentArn);
    if (!summary || evidenceAssessments.has(detail.assessmentArn)) reject("CONFLICTING_DUPLICATE");
    if (JSON.stringify(summary) !== JSON.stringify(detail)) reject("CONFLICTING_DUPLICATE");
    evidenceAssessments.add(detail.assessmentArn);
    const components = pageSequence(evidence.componentCompliances, (item) => component(item, trustedScope), RESILIENCE_VUE_COLLECTION_BOUNDS.maximumComponentCompliances, counters);
    const recommendations = pageSequence(evidence.recommendations, (item) => recommendation(item, trustedScope), RESILIENCE_VUE_COLLECTION_BOUNDS.maximumRecommendations, counters);
    const drifts = pageSequence(evidence.drifts, (item) => drift(item, trustedScope), RESILIENCE_VUE_COLLECTION_BOUNDS.maximumDrifts, counters);
    for (const item of [...components.items, ...recommendations.items, ...drifts.items]) if (item.assessmentArn !== detail.assessmentArn) reject("SCOPE_MISMATCH");
    for (const item of components.items) stableAdd(componentMap, `${item.assessmentArn}|${item.appComponentName}`, item);
    for (const item of recommendations.items) stableAdd(recommendationMap, `${item.assessmentArn}|${item.kind}|${item.recommendationId}`, item);
    for (const item of drifts.items) stableAdd(driftMap, `${item.assessmentArn}|${item.kind}|${item.referenceId}`, item);
    evidenceExhausted = evidenceExhausted && components.sequence.exhausted && recommendations.sequence.exhausted && drifts.sequence.exhausted;
  }
  if (evidenceAssessments.size !== assessmentMap.size) reject("INVALID_INPUT");

  if (!Array.isArray(root.resourceInventories) || root.resourceInventories.length > RESILIENCE_VUE_COLLECTION_BOUNDS.maximumAssessments) reject("BOUND_REACHED");
  const resourceMap = new Map<string, ResilienceResource>();
  const expectedAppVersions = new Set([...assessmentMap.values()].map((item) => `${item.appArn}|${item.appVersion}`));
  const resourceInventoryKeys = new Set<string>();
  let resourcesExhausted = true;
  for (const entry of root.resourceInventories) {
    const inventory = exact(entry, ["appArn", "appVersion", "resources"]);
    const appArn = text(inventory.appArn, 1200);
    const appVersion = text(inventory.appVersion, 50);
    arnScope(appArn, APP_ARN, trustedScope);
    const inventoryKey = `${appArn}|${appVersion}`;
    if (!expectedAppVersions.has(inventoryKey) || resourceInventoryKeys.has(inventoryKey)) reject("CONFLICTING_DUPLICATE");
    resourceInventoryKeys.add(inventoryKey);
    const resources = pageSequence(inventory.resources, (item) => resource(item, trustedScope), RESILIENCE_VUE_COLLECTION_BOUNDS.maximumResources, counters);
    resourcesExhausted = resourcesExhausted && resources.sequence.exhausted;
    for (const item of resources.items) {
      if (item.appArn !== appArn || item.appVersion !== appVersion) reject("SCOPE_MISMATCH");
      stableAdd(resourceMap, `${item.appArn}|${item.appVersion}|${item.accountId}|${item.region}|${item.resourceId}`, item);
    }
  }
  if (resourceInventoryKeys.size !== expectedAppVersions.size) reject("INVALID_INPUT");

  const configurationReady = prerequisites.serviceConfigured === true
    && prerequisites.readPermissionsValidated === true
    && prerequisites.collectorRegionEnabled === true;
  const exhaustive = applications.sequence.exhausted && policies.sequence.exhausted && historiesExhausted && evidenceExhausted && resourcesExhausted;
  const limitations: string[] = [];
  if (!configurationReady) limitations.push("AWS Resilience Hub configuration, Region availability, and read permissions are not fully validated.");
  if (!exhaustive) limitations.push("One or more provider result sets stopped at a declared collection bound.");
  if (appMap.size === 0) limitations.push("No AWS Resilience Hub applications were observed; this is not evidence that workloads are resilient.");
  if (appMap.size > 0 && assessmentMap.size === 0) limitations.push("No assessments were observed; application resilience has not been established.");
  if (!completedAndFresh(completedAtIso, nowMs)) limitations.push("The latest retained AWS Resilience Hub capture is stale.");
  if ([...assessmentMap.values()].some((item) => item.assessmentStatus !== "Success")) limitations.push("Pending, in-progress, or failed assessments are retained and are not treated as successful resilience evidence.");

  let state: ResilienceVueState;
  if (!configurationReady) state = "configuration_required";
  else if (!exhaustive) state = "partial";
  else if (appMap.size === 0) state = "no_apps";
  else if (assessmentMap.size === 0) state = "no_assessments";
  else if (!completedAndFresh(completedAtIso, nowMs)) state = "stale";
  else state = "current";
  return {
    schemaVersion: "sutra.resilience-vue-snapshot.v1", scope: trustedScope,
    captureId: root.captureId, completedAtIso, state,
    applications: [...details.values()].sort((a, b) => a.appArn.localeCompare(b.appArn)),
    policies: [...policyDetails.values()].sort((a, b) => a.policyArn.localeCompare(b.policyArn)),
    assessments: [...assessmentMap.values()].sort((a, b) => b.startTime.localeCompare(a.startTime) || a.assessmentArn.localeCompare(b.assessmentArn)),
    componentCompliances: [...componentMap.values()].sort((a, b) => a.appComponentName.localeCompare(b.appComponentName)),
    recommendations: [...recommendationMap.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.recommendationId.localeCompare(b.recommendationId)),
    resources: [...resourceMap.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
    drifts: [...driftMap.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.referenceId.localeCompare(b.referenceId)),
    complete: configurationReady && exhaustive, limitations,
  };
}

export function resilienceVueSourceEvidence(snapshot: ResilienceVueSnapshot): FinopsSourceEvidence {
  const acceptedRecords = snapshot.applications.length + snapshot.policies.length + snapshot.assessments.length
    + snapshot.componentCompliances.length + snapshot.recommendations.length + snapshot.resources.length + snapshot.drifts.length;
  const configured = snapshot.state !== "configuration_required";
  return {
    scope: snapshot.scope,
    sourceId: "aws_resilience_hub",
    configured,
    deliveryObserved: true,
    lastAttemptAt: snapshot.completedAtIso,
    lastAttemptOutcome: snapshot.complete ? "succeeded" : "partial",
    lastSuccessAt: snapshot.complete ? snapshot.completedAtIso : null,
    dataThroughAt: snapshot.completedAtIso,
    coverage: { assessment: snapshot.complete ? "complete" : "partial", acceptedRecords, expectedRecords: snapshot.complete ? acceptedRecords : null, rejectedRecords: 0 },
    lastError: null,
    evidenceBasis: "Persisted, tenant-scoped AWS Resilience Hub read API capture normalized by sutra.resilience-vue.v1.",
    limitations: snapshot.limitations,
  };
}

export interface ResilienceVueObservedDashboard {
  readonly state: ResilienceVueState;
  readonly applicationCount: number;
  readonly assessedApplicationCount: number;
  readonly policyBreachedApplicationCount: number;
  readonly driftedApplicationCount: number;
  readonly openRecommendationCount: number;
  readonly applicationPosture: readonly ({
    readonly appArn: string;
    readonly name: string;
    readonly policyName: string | null;
    readonly latestAssessmentArn: string | null;
    readonly latestAssessmentStatus: ResilienceAssessmentStatus | null;
    readonly complianceStatus: ResilienceComplianceStatus | null;
    readonly driftStatus: ResilienceDriftStatus | null;
    readonly resiliencyScore: number | null;
    readonly rpoInSecs: number | null;
    readonly rtoInSecs: number | null;
    readonly observedAssessmentCount: number;
  })[];
  readonly assessmentHistory: readonly ResilienceAssessment[];
  readonly componentPosture: readonly ResilienceComponentCompliance[];
  readonly recommendationBacklog: readonly ResilienceRecommendation[];
  readonly resourceInventory: readonly ResilienceResource[];
  readonly driftEvidence: readonly ResilienceDrift[];
  readonly limitations: readonly string[];
}

export interface ResilienceVueInferredPriority {
  readonly label: "SUTRA_INFERRED_PRIORITY_NOT_AWS_FINDING";
  readonly assessmentArn: string;
  readonly recommendationId: string;
  readonly kind: ResilienceRecommendationKind;
  readonly appComponentName: string;
  readonly priorityScore: number;
  readonly reasons: readonly string[];
}

export interface ResilienceVueDashboard {
  readonly schemaVersion: "sutra.resilience-vue-dashboard.v1";
  readonly scope: ResilienceVueScope;
  readonly generatedAtIso: string;
  readonly observedAwsEvidence: ResilienceVueObservedDashboard;
  readonly inferredPrioritization: readonly ResilienceVueInferredPriority[];
}

export function buildResilienceVueDashboard(
  snapshot: ResilienceVueSnapshot,
  nowMs = Date.now(),
): ResilienceVueDashboard {
  if (!Number.isFinite(nowMs) || jsonBytes(snapshot) > RESILIENCE_VUE_COLLECTION_BOUNDS.maximumDashboardInputBytes) reject("BOUND_REACHED");
  if (snapshot.applications.length > RESILIENCE_VUE_COLLECTION_BOUNDS.maximumDashboardApplications) reject("BOUND_REACHED");
  const assessmentsByApp = new Map<string, ResilienceAssessment[]>();
  for (const item of snapshot.assessments) {
    const values = assessmentsByApp.get(item.appArn) ?? [];
    values.push(item);
    assessmentsByApp.set(item.appArn, values);
  }
  const policyNames = new Map(snapshot.policies.map((item) => [item.policyArn, item.policyName]));
  const applicationPosture = snapshot.applications.map((item) => {
    const history = (assessmentsByApp.get(item.appArn) ?? []).sort((a, b) => b.startTime.localeCompare(a.startTime));
    const latest = history[0] ?? null;
    return {
      appArn: item.appArn, name: item.name,
      policyName: item.policyArn === null ? null : policyNames.get(item.policyArn) ?? null,
      latestAssessmentArn: latest?.assessmentArn ?? null,
      latestAssessmentStatus: latest?.assessmentStatus ?? null,
      complianceStatus: latest?.complianceStatus ?? item.complianceStatus,
      driftStatus: latest?.driftStatus ?? item.driftStatus,
      resiliencyScore: latest?.resiliencyScore ?? item.resiliencyScore,
      rpoInSecs: item.rpoInSecs, rtoInSecs: item.rtoInSecs,
      observedAssessmentCount: history.length,
    };
  });
  const recommendationBacklog = snapshot.recommendations.filter((item) => item.status === "NotImplemented" && item.excluded !== true).slice(0, RESILIENCE_VUE_COLLECTION_BOUNDS.maximumDashboardRecommendations);
  const inferredPrioritization = recommendationBacklog.map((item) => {
    const assessmentItem = snapshot.assessments.find((assessmentValue) => assessmentValue.assessmentArn === item.assessmentArn);
    const reasons: string[] = [];
    let score = 0;
    if (assessmentItem?.complianceStatus === "PolicyBreached") { score += 50; reasons.push("latest captured assessment breaches its policy"); }
    if (assessmentItem?.driftStatus === "Detected") { score += 20; reasons.push("latest captured assessment reports drift"); }
    if (item.kind === "CONFIG") { score += 15; reasons.push("configuration recommendation can change recovery posture"); }
    if (item.risk !== null) { score += 10; reasons.push("AWS supplied risk context"); }
    if (item.resourceId !== null) { score += 5; reasons.push("recommendation is linked to an observed resource"); }
    return { label: "SUTRA_INFERRED_PRIORITY_NOT_AWS_FINDING" as const, assessmentArn: item.assessmentArn, recommendationId: item.recommendationId, kind: item.kind, appComponentName: item.appComponentName, priorityScore: score, reasons };
  }).sort((a, b) => b.priorityScore - a.priorityScore || a.recommendationId.localeCompare(b.recommendationId));
  return {
    schemaVersion: "sutra.resilience-vue-dashboard.v1", scope: snapshot.scope,
    generatedAtIso: new Date(nowMs).toISOString(),
    observedAwsEvidence: {
      state: snapshot.state,
      applicationCount: snapshot.applications.length,
      assessedApplicationCount: applicationPosture.filter((item) => item.latestAssessmentArn !== null).length,
      policyBreachedApplicationCount: applicationPosture.filter((item) => item.complianceStatus === "PolicyBreached").length,
      driftedApplicationCount: applicationPosture.filter((item) => item.driftStatus === "Detected").length,
      openRecommendationCount: recommendationBacklog.length,
      applicationPosture,
      assessmentHistory: snapshot.assessments.slice(0, RESILIENCE_VUE_COLLECTION_BOUNDS.maximumDashboardHistoryRecords),
      componentPosture: snapshot.componentCompliances.slice(0, RESILIENCE_VUE_COLLECTION_BOUNDS.maximumDashboardResources),
      recommendationBacklog,
      resourceInventory: snapshot.resources.slice(0, RESILIENCE_VUE_COLLECTION_BOUNDS.maximumDashboardResources),
      driftEvidence: snapshot.drifts.slice(0, RESILIENCE_VUE_COLLECTION_BOUNDS.maximumDashboardResources),
      limitations: snapshot.limitations,
    },
    inferredPrioritization,
  };
}

export interface ResilienceVueBrokerRequest {
  readonly schemaVersion: "sutra.resilience-vue-query.v1";
  readonly scope: ResilienceVueScope;
  readonly operations: typeof RESILIENCE_VUE_READ_OPERATIONS;
  readonly bounds: typeof RESILIENCE_VUE_COLLECTION_BOUNDS;
}

export interface ResilienceVueTransport {
  readonly collect: (request: ResilienceVueBrokerRequest) => Promise<ResilienceVueCapture>;
}

export class ResilienceVueQueryError extends Error {
  public readonly code: "SOURCE_UNAVAILABLE" | "INVALID_EVIDENCE";
  public constructor(code: "SOURCE_UNAVAILABLE" | "INVALID_EVIDENCE") {
    super("AWS Resilience Hub evidence is unavailable");
    this.name = "ResilienceVueQueryError";
    this.code = code;
  }
}

export function createResilienceVueQueryService(
  configuredScope: ResilienceVueScope,
  transport: ResilienceVueTransport,
  now: () => number = Date.now,
): { readonly query: () => Promise<ResilienceVueDashboard> } {
  const trustedScope = scope(configuredScope);
  return {
    async query(): Promise<ResilienceVueDashboard> {
      let capture: ResilienceVueCapture;
      try {
        capture = await transport.collect({ schemaVersion: "sutra.resilience-vue-query.v1", scope: trustedScope, operations: RESILIENCE_VUE_READ_OPERATIONS, bounds: RESILIENCE_VUE_COLLECTION_BOUNDS });
      } catch {
        throw new ResilienceVueQueryError("SOURCE_UNAVAILABLE");
      }
      try {
        const currentTime = now();
        return buildResilienceVueDashboard(normalizeResilienceVueCapture(capture, trustedScope, currentTime), currentTime);
      } catch {
        throw new ResilienceVueQueryError("INVALID_EVIDENCE");
      }
    },
  };
}
