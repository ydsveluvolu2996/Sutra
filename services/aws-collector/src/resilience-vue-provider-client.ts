/** AWS SDK v3 mapper for the versioned ADV-10 ResilienceVue capture. */
import {
  DescribeAppAssessmentCommand, DescribeAppCommand, DescribeResiliencyPolicyCommand,
  ListAlarmRecommendationsCommand, ListAppAssessmentComplianceDriftsCommand,
  ListAppAssessmentResourceDriftsCommand, ListAppAssessmentsCommand,
  ListAppComponentCompliancesCommand, ListAppComponentRecommendationsCommand,
  ListAppVersionResourcesCommand, ListAppsCommand, ListResiliencyPoliciesCommand,
  ListSopRecommendationsCommand, ListTestRecommendationsCommand, ResiliencehubClient,
} from "@aws-sdk/client-resiliencehub";
import { workloadIdentityAwsClientConfig } from "./role-broker.js";
import type { ResilienceVueProviderClient, ResilienceVueProviderClientFactory,
  ResilienceVueProviderRequest } from "./resilience-vue-provider-adapter.js";

type RecordValue = Record<string, unknown>;
type Page<T> = { readonly request: { readonly maxResults: 100; readonly nextToken: string | null };
  readonly response: { readonly items: readonly T[]; readonly nextToken: string | null } };

const MAX_PAGES = 20_000;
function object(value: unknown): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("RESILIENCE_VUE_PROVIDER_SHAPE_INVALID");
  return value as RecordValue;
}
function required(value: unknown, maximum = 8_192): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("RESILIENCE_VUE_PROVIDER_SHAPE_INVALID");
  return value;
}
function optional(value: unknown, maximum = 8_192): string | null {
  return value === undefined || value === null || value === "" ? null : required(value, maximum);
}
function date(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("RESILIENCE_VUE_PROVIDER_SHAPE_INVALID");
  return value.toISOString();
}
function optionalDate(value: unknown): string | null { return value === undefined || value === null ? null : date(value); }
function metric(value: unknown, maximum = 31_536_000): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) throw new Error("RESILIENCE_VUE_PROVIDER_SHAPE_INVALID");
  return value;
}
function bool(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new Error("RESILIENCE_VUE_PROVIDER_SHAPE_INVALID");
  return value;
}
function strings(value: unknown, maximum = 100): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximum) throw new Error("RESILIENCE_VUE_PROVIDER_SHAPE_INVALID");
  return [...new Set(value.map((item) => required(item, 8_192)))].sort();
}
function compliance(value: unknown): "PolicyBreached" | "PolicyMet" | "NotApplicable" | "MissingPolicy" | null {
  return ["PolicyBreached", "PolicyMet", "NotApplicable", "MissingPolicy"].includes(String(value))
    ? value as "PolicyBreached" | "PolicyMet" | "NotApplicable" | "MissingPolicy" : null;
}
function drift(value: unknown): "NotChecked" | "NotDetected" | "Detected" | null {
  return ["NotChecked", "NotDetected", "Detected"].includes(String(value))
    ? value as "NotChecked" | "NotDetected" | "Detected" : null;
}
function status(value: unknown): "Pending" | "InProgress" | "Failed" | "Success" {
  if (!["Pending", "InProgress", "Failed", "Success"].includes(String(value))) throw new Error("RESILIENCE_VUE_PROVIDER_SHAPE_INVALID");
  return value as "Pending" | "InProgress" | "Failed" | "Success";
}
function disruption(value: string): "Software" | "Hardware" | "AZ" | "Region" {
  if (!["Software", "Hardware", "AZ", "Region"].includes(value)) throw new Error("RESILIENCE_VUE_PROVIDER_SHAPE_INVALID");
  return value as "Software" | "Hardware" | "AZ" | "Region";
}
function objectivePosture(value: unknown): readonly RecordValue[] {
  const source = value === undefined || value === null ? {} : object(value);
  return Object.entries(source).map(([key, raw]) => {
    const item = object(raw);
    const posture = compliance(item.complianceStatus);
    if (posture === null) throw new Error("RESILIENCE_VUE_PROVIDER_SHAPE_INVALID");
    return { disruptionType: disruption(key), complianceStatus: posture,
      currentRpoInSecs: metric(item.currentRpoInSecs), currentRtoInSecs: metric(item.currentRtoInSecs),
      achievableRpoInSecs: metric(item.achievableRpoInSecs), achievableRtoInSecs: metric(item.achievableRtoInSecs),
      message: optional(item.message) };
  }).sort((left, right) => String(left.disruptionType).localeCompare(String(right.disruptionType)));
}
function normalizedPages<T>(
  items: readonly T[],
  exhausted = true,
): { readonly pages: readonly Page<T>[]; readonly exhausted: boolean } {
  const pages: Page<T>[] = [];
  for (let offset = 0; offset < items.length; offset += 100) {
    const pageIndex = offset / 100;
    pages.push({ request: { maxResults: 100, nextToken: pageIndex === 0 ? null : `sutra-normalized-${pageIndex}` },
      response: { items: items.slice(offset, offset + 100),
        nextToken: offset + 100 < items.length
          ? `sutra-normalized-${pageIndex + 1}`
          : exhausted ? null : "sutra-bounded" } });
  }
  return { pages, exhausted };
}

export class ResilienceVueSdkProviderClient implements ResilienceVueProviderClient {
  public constructor(private readonly client: ResiliencehubClient) {}
  private async pages<T>(signal: AbortSignal, send: (token: string | undefined) => Promise<{ readonly items: readonly T[]; readonly nextToken: string | undefined }>): Promise<readonly T[]> {
    const result: T[] = []; const seen = new Set<string>(); let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (signal.aborted) throw new Error("RESILIENCE_VUE_PROVIDER_ABORTED");
      const response = await send(token); result.push(...response.items);
      const next = response.nextToken;
      if (next === undefined || next === "") return result;
      if (next === token || seen.has(next)) throw new Error("RESILIENCE_VUE_PROVIDER_TOKEN_REPLAY");
      seen.add(next); token = next;
    }
    throw new Error("RESILIENCE_VUE_PROVIDER_PAGE_BOUND");
  }

  public async collect(request: ResilienceVueProviderRequest, signal: AbortSignal): Promise<unknown> {
    const startedAtIso = new Date().toISOString();
    const listApps = await this.pages(signal, async (nextToken) => {
      const output = await this.client.send(new ListAppsCommand({ maxResults: 100, nextToken }), { abortSignal: signal });
      return { items: output.appSummaries ?? [], nextToken: output.nextToken };
    });
    const applications: RecordValue[] = [];
    for (const summaryValue of listApps) {
      const summary = object(summaryValue); const appArn = required(summary.appArn, 1_200);
      const output = await this.client.send(new DescribeAppCommand({ appArn }), { abortSignal: signal });
      const item = object(output.app);
      applications.push({ appArn, name: required(item.name, 60), description: optional(item.description),
        policyArn: optional(item.policyArn, 1_200), status: required(item.status ?? summary.status, 64),
        complianceStatus: compliance(item.complianceStatus ?? summary.complianceStatus),
        driftStatus: drift(item.driftStatus ?? summary.driftStatus),
        resiliencyScore: metric(item.resiliencyScore ?? summary.resiliencyScore, 100),
        rpoInSecs: metric(summary.rpoInSecs), rtoInSecs: metric(summary.rtoInSecs),
        creationTime: date(item.creationTime ?? summary.creationTime),
        lastAssessmentTime: optionalDate(item.lastAppComplianceEvaluationTime ?? summary.lastAppComplianceEvaluationTime) });
    }
    applications.sort((left, right) => String(left.appArn).localeCompare(String(right.appArn)));

    const listPolicies = await this.pages(signal, async (nextToken) => {
      const output = await this.client.send(new ListResiliencyPoliciesCommand({ maxResults: 100, nextToken }), { abortSignal: signal });
      return { items: output.resiliencyPolicies ?? [], nextToken: output.nextToken };
    });
    const policies: RecordValue[] = [];
    for (const summaryValue of listPolicies) {
      const summary = object(summaryValue); const policyArn = required(summary.policyArn, 1_200);
      const output = await this.client.send(new DescribeResiliencyPolicyCommand({ policyArn }), { abortSignal: signal });
      const item = object(output.policy);
      const rawObjectives = object(item.policy);
      const objectives = Object.entries(rawObjectives).map(([key, raw]) => {
        const objective = object(raw);
        const rpoInSecs = metric(objective.rpoInSecs); const rtoInSecs = metric(objective.rtoInSecs);
        if (rpoInSecs === null || rtoInSecs === null) throw new Error("RESILIENCE_VUE_PROVIDER_SHAPE_INVALID");
        return { disruptionType: disruption(key), rpoInSecs, rtoInSecs };
      }).sort((left, right) => left.disruptionType.localeCompare(right.disruptionType));
      policies.push({ policyArn, policyName: required(item.policyName, 60),
        description: optional(item.policyDescription), tier: required(item.tier, 64),
        creationTime: date(item.creationTime), objectives });
    }
    policies.sort((left, right) => String(left.policyArn).localeCompare(String(right.policyArn)));

    const assessmentHistories: RecordValue[] = []; const assessmentEvidence: RecordValue[] = [];
    const inventoryKeys = new Map<string, { readonly appArn: string; readonly appVersion: string }>();
    for (const app of applications) {
      const appArn = String(app.appArn);
      const listed = await this.pages(signal, async (nextToken) => {
        const output = await this.client.send(new ListAppAssessmentsCommand({ appArn, maxResults: 100, nextToken,
          reverseOrder: true }), { abortSignal: signal });
        return { items: output.assessmentSummaries ?? [], nextToken: output.nextToken };
      });
      const assessments: RecordValue[] = [];
      for (const summaryValue of listed.slice(0, 36)) {
        const summary = object(summaryValue); const assessmentArn = required(summary.assessmentArn, 1_200);
        const output = await this.client.send(new DescribeAppAssessmentCommand({ assessmentArn }), { abortSignal: signal });
        const item = object(output.assessment);
        const appVersion = required(item.appVersion ?? summary.appVersion, 50);
        const mapped = { assessmentArn, appArn, appVersion,
          name: required(item.assessmentName ?? summary.assessmentName, 60),
          assessmentStatus: status(item.assessmentStatus ?? summary.assessmentStatus),
          complianceStatus: compliance(item.complianceStatus ?? summary.complianceStatus),
          driftStatus: drift(item.driftStatus ?? summary.driftStatus),
          resiliencyScore: metric(object(item.resiliencyScore ?? {}).score ?? summary.resiliencyScore, 100),
          startTime: date(item.startTime ?? summary.startTime), endTime: optionalDate(item.endTime ?? summary.endTime),
          message: optional(item.message ?? summary.message), objectivePosture: objectivePosture(item.compliance),
          riskRecommendations: Array.isArray(object(item.summary ?? {}).riskRecommendations)
            ? (object(item.summary ?? {}).riskRecommendations as unknown[]).map((raw) => {
              const risk = object(raw); return { appComponents: strings(risk.appComponents),
                risk: required(risk.risk, 256), recommendation: required(risk.recommendation) };
            }) : [] };
        assessments.push(mapped); inventoryKeys.set(`${appArn}|${appVersion}`, { appArn, appVersion });

        const components = await this.pages(signal, async (nextToken) => {
          const response = await this.client.send(new ListAppComponentCompliancesCommand({ assessmentArn,
            maxResults: 100, nextToken }), { abortSignal: signal });
          return { items: response.componentCompliances ?? [], nextToken: response.nextToken };
        });
        const componentCompliances = components.map((raw) => { const component = object(raw); return {
          assessmentArn, appComponentName: required(component.appComponentName, 256),
          status: required(component.status, 64), resiliencyScore: metric(object(component.resiliencyScore ?? {}).score, 100),
          objectivePosture: objectivePosture(component.compliance) }; });

        const recommendations: RecordValue[] = [];
        const configGroups = await this.pages(signal, async (nextToken) => {
          const response = await this.client.send(new ListAppComponentRecommendationsCommand({ assessmentArn,
            maxResults: 100, nextToken }), { abortSignal: signal });
          return { items: response.componentRecommendations ?? [], nextToken: response.nextToken };
        });
        for (const raw of configGroups) {
          const group = object(raw); const appComponentName = required(group.appComponentName, 256);
          for (const configRaw of Array.isArray(group.configRecommendations) ? group.configRecommendations : []) {
            const config = object(configRaw); const recommendationCompliance = object(config.recommendationCompliance ?? {});
            const first = Object.values(recommendationCompliance).map(object)[0] ?? {};
            recommendations.push({ assessmentArn, kind: "CONFIG", recommendationId: required(config.referenceId, 256),
              appComponentName, name: required(config.name, 512), description: optional(config.description) ?? "AWS Resilience Hub configuration recommendation",
              status: "NotImplemented", risk: null, resourceId: null, targetAccountId: null, targetRegion: null,
              alreadyImplemented: null, excluded: null, expectedRpoInSecs: metric(first.expectedRpoInSecs),
              expectedRtoInSecs: metric(first.expectedRtoInSecs), suggestedChanges: strings(config.suggestedChanges, 50) });
          }
        }
        const operational = async (kind: "ALARM" | "SOP" | "TEST", command: (token: string | undefined) => Promise<{ readonly items: readonly unknown[]; readonly nextToken: string | undefined }>) => {
          for (const raw of await this.pages(signal, command)) {
            const rec = object(raw); const items = Array.isArray(rec.items) && rec.items.length > 0 ? rec.items : [null];
            for (const [index, rawItem] of items.entries()) {
              const itemValue = rawItem === null ? {} : object(rawItem);
              recommendations.push({ assessmentArn, kind,
                recommendationId: `${required(rec.recommendationId, 220)}:${index}`,
                appComponentName: optional(rec.appComponentName, 256) ?? strings(rec.appComponentNames, 100)[0] ?? "Application",
                name: required(rec.name, 512), description: optional(rec.description) ?? "AWS Resilience Hub operational recommendation",
                status: required(rec.recommendationStatus, 64), risk: optional(rec.prerequisite, 256),
                resourceId: optional(itemValue.resourceId, 1_024), targetAccountId: optional(itemValue.targetAccountId, 12),
                targetRegion: optional(itemValue.targetRegion, 32), alreadyImplemented: bool(itemValue.alreadyImplemented),
                excluded: bool(itemValue.excluded), expectedRpoInSecs: null, expectedRtoInSecs: null,
                suggestedChanges: [] });
            }
          }
        };
        await operational("ALARM", async (nextToken) => { const response = await this.client.send(
          new ListAlarmRecommendationsCommand({ assessmentArn, maxResults: 100, nextToken }), { abortSignal: signal });
          return { items: response.alarmRecommendations ?? [], nextToken: response.nextToken }; });
        await operational("SOP", async (nextToken) => { const response = await this.client.send(
          new ListSopRecommendationsCommand({ assessmentArn, maxResults: 100, nextToken }), { abortSignal: signal });
          return { items: response.sopRecommendations ?? [], nextToken: response.nextToken }; });
        await operational("TEST", async (nextToken) => { const response = await this.client.send(
          new ListTestRecommendationsCommand({ assessmentArn, maxResults: 100, nextToken }), { abortSignal: signal });
          return { items: response.testRecommendations ?? [], nextToken: response.nextToken }; });

        const complianceDrifts = await this.pages(signal, async (nextToken) => { const response = await this.client.send(
          new ListAppAssessmentComplianceDriftsCommand({ assessmentArn, maxResults: 100, nextToken }), { abortSignal: signal });
          return { items: response.complianceDrifts ?? [], nextToken: response.nextToken }; });
        const resourceDrifts = await this.pages(signal, async (nextToken) => { const response = await this.client.send(
          new ListAppAssessmentResourceDriftsCommand({ assessmentArn, maxResults: 100, nextToken }), { abortSignal: signal });
          return { items: response.resourceDrifts ?? [], nextToken: response.nextToken }; });
        const drifts = [
          ...complianceDrifts.map((raw) => { const itemValue = object(raw); return { assessmentArn, kind: "COMPLIANCE",
            referenceId: required(itemValue.entityId ?? itemValue.actualReferenceId ?? itemValue.expectedReferenceId, 256),
            diffType: itemValue.diffType === "Removed" ? "Removed" : "Added",
            appComponentName: optional(itemValue.entityId, 256), resourceId: null }; }),
          ...resourceDrifts.map((raw) => { const itemValue = object(raw); const identifier = object(itemValue.resourceIdentifier ?? {});
            return { assessmentArn, kind: "RESOURCE", referenceId: required(itemValue.referenceId, 256),
              diffType: itemValue.diffType === "Removed" ? "Removed" : "Added", appComponentName: null,
              resourceId: optional(object(identifier.logicalResourceId ?? {}).identifier, 1_200) }; }),
        ];
        assessmentEvidence.push({ assessment: mapped, componentCompliances: normalizedPages(componentCompliances),
          recommendations: normalizedPages(recommendations), drifts: normalizedPages(drifts) });
      }
      assessmentHistories.push({ appArn,
        history: normalizedPages(assessments, listed.length <= 36) });
    }

    const resourceInventories: RecordValue[] = [];
    for (const { appArn, appVersion } of inventoryKeys.values()) {
      const resources = await this.pages(signal, async (nextToken) => { const response = await this.client.send(
        new ListAppVersionResourcesCommand({ appArn, appVersion, maxResults: 100, nextToken }), { abortSignal: signal });
        return { items: response.physicalResources ?? [], nextToken: response.nextToken }; });
      resourceInventories.push({ appArn, appVersion, resources: normalizedPages(resources.map((raw) => {
        const item = object(raw); const physical = object(item.physicalResourceId);
        return { appArn, appVersion, resourceName: optional(item.resourceName, 512) ?? required(physical.identifier, 512),
          resourceType: required(item.resourceType, 256), accountId: required(physical.awsAccountId, 12),
          region: required(physical.awsRegion, 32), resourceId: required(physical.identifier, 1_200),
          excluded: item.excluded === true, appComponents: (Array.isArray(item.appComponents) ? item.appComponents : [])
            .map((component) => required(object(component).name, 256)).sort() };
      })) });
    }
    const completedAtIso = new Date().toISOString();
    return { schemaVersion: "sutra.resilience-vue.v1", scope: request.scope,
      captureId: request.expectedCaptureId, startedAtIso, completedAtIso,
      execution: { concurrencyLimit: 4, observedPeakConcurrency: 1 },
      prerequisites: { serviceConfigured: true, readPermissionsValidated: true, collectorRegionEnabled: true },
      applications: normalizedPages(applications), applicationDetails: applications,
      policies: normalizedPages(policies), policyDetails: policies,
      assessmentHistories, assessmentEvidence, resourceInventories };
  }
}

export const createResilienceVueProviderClient: ResilienceVueProviderClientFactory = (input) =>
  new ResilienceVueSdkProviderClient(new ResiliencehubClient({
    ...workloadIdentityAwsClientConfig(input.region, 4), credentials: input.credentials,
  }));
