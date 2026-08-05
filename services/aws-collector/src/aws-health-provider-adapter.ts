/** Bounded credential-owning provider adapter for ADV-06 AWS Health. */
import { AWS_HEALTH_SESSION_ACTIONS } from "./aws-health-permission-contract.js";
export const AWS_HEALTH_PROVIDER_BOUNDS = Object.freeze({
  apiPageSize: 100, apiDetailBatchSize: 10, maximumConcurrency: 4,
  maximumDurationMs: 15 * 60 * 1_000, maximumCaptureBytes: 48 * 1_024 * 1_024,
  maximumPages: 20_000, maximumEvents: 10_000, maximumAffectedAccounts: 100_000,
  maximumAffectedEntities: 200_000, maximumDescriptionCharacters: 16_384,
  maximumMetadataEntries: 50, maximumMetadataKeyCharacters: 1_024,
  maximumMetadataValueCharacters: 4_096, maximumDashboardInputBytes: 64 * 1_024 * 1_024,
  maximumDashboardEvents: 500, sourceFreshnessSlaHours: 72, providerRetentionDays: 90,
} as const);
export type AwsHealthProviderFailureCode = "ACCESS_DENIED" | "SUBSCRIPTION_REQUIRED" | "ORGANIZATION_VIEW_DISABLED" | "INVALID_PAGINATION" | "THROTTLED" | "TIMEOUT" | "BOUND_REACHED" | "PROVIDER_UNAVAILABLE" | "UNKNOWN";
export interface AwsHealthProviderScope { readonly orgId: string; readonly customerId: string; readonly connectionId: string; readonly accountId: string; readonly partition: "aws" | "aws-us-gov"; readonly endpointRegion: "us-east-1" | "us-gov-west-1"; }
export interface AwsHealthProviderPrerequisites { readonly organizationsAllFeaturesEnabled: boolean; readonly organizationViewStatus: "ENABLED" | "DISABLED" | "PENDING" | "UNKNOWN"; readonly organizationViewStatusEvidence: "management_status_api" | "management_verified_delegation" | "unverified"; readonly supportPlan: "business_support_plus" | "enterprise" | "unified_operations" | "business" | "enterprise_on_ramp" | "unknown" | "not_qualifying"; readonly apiEntitlementValidated: boolean; readonly collectorAccountType: "management" | "delegated_administrator" | "member" | "unknown"; readonly delegatedAdministratorRegistered: boolean; readonly readPermissionsValidated: boolean; readonly initialLoadState: "COMPLETE" | "PENDING" | "UNKNOWN"; }
interface EventPage { readonly request: { readonly filter: null; readonly locale: "en"; readonly maxResults: 100; readonly nextToken: string | null }; readonly response: { readonly events: readonly unknown[]; readonly nextToken: string | null } }
interface AccountSequence { readonly eventArn: string; readonly exhausted: boolean; readonly pages: readonly { readonly request: { readonly eventArn: string; readonly maxResults: 100; readonly nextToken: string | null }; readonly response: { readonly affectedAccounts: readonly string[]; readonly eventScopeCode: "PUBLIC" | "ACCOUNT_SPECIFIC"; readonly nextToken: string | null } }[] }
interface EntitySequence { readonly eventArn: string; readonly awsAccountId: string | null; readonly exhausted: boolean; readonly pages: readonly { readonly request: { readonly locale: "en"; readonly maxResults: 100; readonly nextToken: string | null; readonly organizationEntityAccountFilters: null; readonly organizationEntityFilters: readonly [{ readonly eventArn: string; readonly awsAccountId: string | null }] }; readonly response: { readonly entities: readonly unknown[]; readonly failedSet: readonly { readonly eventArn: string; readonly awsAccountId: string | null; readonly code: AwsHealthProviderFailureCode }[]; readonly nextToken: string | null } }[] }
interface DetailResult { readonly eventArn: string; readonly awsAccountId: string | null; readonly detail: null | { readonly eventArn: string; readonly awsAccountId: string | null; readonly description: string | null; readonly metadata: Readonly<Record<string, string>> }; readonly failureCode: AwsHealthProviderFailureCode | null }
export interface AwsHealthProviderCapture { readonly schemaVersion: "sutra.aws-health-organization.v1"; readonly scope: AwsHealthProviderScope; readonly captureId: string; readonly startedAtIso: string; readonly completedAtIso: string; readonly execution: { readonly concurrencyLimit: 4; readonly eventDetailBatchSize: 10; readonly observedPeakConcurrency: number }; readonly prerequisites: AwsHealthProviderPrerequisites; readonly events: { readonly pages: readonly EventPage[]; readonly exhausted: boolean }; readonly affectedAccounts: readonly AccountSequence[]; readonly affectedEntities: readonly EntitySequence[]; readonly eventDetails: readonly DetailResult[]; }

const ACCOUNT = /^\d{12}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const REQUEST = /^hrr_[a-f0-9]{64}$/u;
const TOKEN = /^[a-zA-Z0-9=/+_.-]{4,10000}$/u;
const EVENT_ARN = /^arn:(aws|aws-us-gov):health:[^:]*:[^:]*:event(?:\/[\w-]+){3}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const INITIAL_LOAD_WAIT_MS = 24 * 60 * 60 * 1_000;

export const AWS_HEALTH_PROVIDER_SESSION_ACTIONS = AWS_HEALTH_SESSION_ACTIONS;

export interface AwsHealthProviderTarget {
  readonly accountId: string;
  readonly connectionId: string;
}

export interface AwsHealthProviderRequest {
  readonly schemaVersion: "sutra.aws-health-provider-request.v1";
  readonly requestId: string;
  readonly scheduledWindow: string;
  readonly scope: AwsHealthProviderScope;
  readonly candidateAccounts: readonly AwsHealthProviderTarget[];
  readonly enabledObservedSince: string | null;
  readonly healthOperations: readonly [
    "health:DescribeAffectedAccountsForOrganization",
    "health:DescribeAffectedEntitiesForOrganization",
    "health:DescribeEventDetailsForOrganization",
    "health:DescribeEventsForOrganization",
  ];
  readonly configurationOperation: "health:DescribeHealthServiceStatusForOrganization";
  readonly prerequisiteOperations: readonly [
    "organizations:DescribeOrganization",
    "organizations:ListDelegatedAdministrators",
  ];
  readonly bounds: typeof AWS_HEALTH_PROVIDER_BOUNDS;
  readonly locale: "en";
  readonly unfilteredAvailableEvents: true;
  readonly credentials: "SERVER_OWNED_TRUST_ROLE_SESSIONS";
  readonly deadlineAtIso: string;
}

export interface AwsHealthProviderReader {
  describeOrganization(target: AwsHealthProviderTarget, signal: AbortSignal): Promise<unknown>;
  listDelegatedAdministrators(
    target: AwsHealthProviderTarget,
    input: { readonly servicePrincipal: "health.amazonaws.com"; readonly nextToken: string | null },
    signal: AbortSignal,
  ): Promise<unknown>;
  describeOrganizationViewStatus(target: AwsHealthProviderTarget, signal: AbortSignal): Promise<unknown>;
  describeEvents(
    target: AwsHealthProviderTarget,
    input: { readonly filter: null; readonly locale: "en"; readonly maxResults: 100; readonly nextToken: string | null },
    signal: AbortSignal,
  ): Promise<unknown>;
  describeAffectedAccounts(
    target: AwsHealthProviderTarget,
    input: { readonly eventArn: string; readonly maxResults: 100; readonly nextToken: string | null },
    signal: AbortSignal,
  ): Promise<unknown>;
  describeAffectedEntities(
    target: AwsHealthProviderTarget,
    input: {
      readonly locale: "en";
      readonly maxResults: 100;
      readonly nextToken: string | null;
      readonly organizationEntityAccountFilters: null;
      readonly organizationEntityFilters: readonly [{ readonly eventArn: string; readonly awsAccountId: string | null }];
    },
    signal: AbortSignal,
  ): Promise<unknown>;
  describeEventDetails(
    target: AwsHealthProviderTarget,
    input: {
      readonly locale: "en";
      readonly organizationEventDetailFilters: readonly [{ readonly eventArn: string; readonly awsAccountId: string | null }];
    },
    signal: AbortSignal,
  ): Promise<unknown>;
}

export class AwsHealthProviderAdapterError extends Error {
  public readonly code: "INVALID_REQUEST" | "PROVIDER_RESPONSE_INVALID" | "BOUND_REACHED" | "ABORTED" | "PROVIDER_UNAVAILABLE";
  public constructor(code: AwsHealthProviderAdapterError["code"]) {
    super("AWS Health provider collection did not complete");
    this.name = "AwsHealthProviderAdapterError";
    this.code = code;
  }
}

function reject(code: AwsHealthProviderAdapterError["code"]): never {
  throw new AwsHealthProviderAdapterError(code);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject("PROVIDER_RESPONSE_INVALID");
  return value as Readonly<Record<string, unknown>>;
}

function canonicalIso(value: unknown): string {
  const milliseconds = value instanceof Date ? value.getTime()
    : typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds)) reject("PROVIDER_RESPONSE_INVALID");
  return new Date(milliseconds).toISOString();
}

function optionalIso(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : canonicalIso(value);
}

function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0) || value.length > maximum || value.includes("\0")) {
    reject("PROVIDER_RESPONSE_INVALID");
  }
  return value;
}

function nextToken(value: unknown, previous: string | null, seen: Set<string>): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !TOKEN.test(value) || value === previous || seen.has(value)) {
    reject("PROVIDER_RESPONSE_INVALID");
  }
  seen.add(value);
  return value;
}

function failure(error: unknown, signal: AbortSignal): AwsHealthProviderFailureCode {
  if (signal.aborted) return "TIMEOUT";
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { readonly name: unknown }).name) : "";
  if (/subscriptionrequired/iu.test(name)) return "SUBSCRIPTION_REQUIRED";
  if (/accessdenied|unauthorized|notauthorized/iu.test(name)) return "ACCESS_DENIED";
  if (/invalidpagination/iu.test(name)) return "INVALID_PAGINATION";
  if (/throttl|toomanyrequest|requestlimit/iu.test(name)) return "THROTTLED";
  if (/timeout|abort/iu.test(name)) return "TIMEOUT";
  if (/serviceunavailable|internal|network|socket/iu.test(name)) return "PROVIDER_UNAVAILABLE";
  return "UNKNOWN";
}

function validRequest(request: AwsHealthProviderRequest): boolean {
  const endpoint = request.scope.partition === "aws" ? "us-east-1" : "us-gov-west-1";
  return request.schemaVersion === "sutra.aws-health-provider-request.v1"
    && REQUEST.test(request.requestId)
    && /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u.test(request.scheduledWindow)
    && request.scope.endpointRegion === endpoint
    && IDENTIFIER.test(request.scope.orgId) && IDENTIFIER.test(request.scope.customerId)
    && ACCOUNT.test(request.scope.accountId)
    && CONNECTION.test(request.scope.connectionId)
    && request.candidateAccounts.length >= 1 && request.candidateAccounts.length <= 200
    && request.candidateAccounts.some((target) => target.accountId === request.scope.accountId && target.connectionId === request.scope.connectionId)
    && request.candidateAccounts.every((target) => ACCOUNT.test(target.accountId) && CONNECTION.test(target.connectionId))
    && JSON.stringify(request.candidateAccounts) === JSON.stringify([...request.candidateAccounts].sort((a, b) => a.accountId.localeCompare(b.accountId)))
    && new Set(request.candidateAccounts.map((target) => target.accountId)).size === request.candidateAccounts.length
    && new Set(request.candidateAccounts.map((target) => target.connectionId)).size === request.candidateAccounts.length
    && request.locale === "en" && request.unfilteredAvailableEvents === true
    && request.credentials === "SERVER_OWNED_TRUST_ROLE_SESSIONS"
    && JSON.stringify(request.healthOperations) === JSON.stringify([
      "health:DescribeAffectedAccountsForOrganization", "health:DescribeAffectedEntitiesForOrganization",
      "health:DescribeEventDetailsForOrganization", "health:DescribeEventsForOrganization",
    ])
    && request.configurationOperation === "health:DescribeHealthServiceStatusForOrganization"
    && JSON.stringify(request.prerequisiteOperations) === JSON.stringify([
      "organizations:DescribeOrganization", "organizations:ListDelegatedAdministrators",
    ])
    && JSON.stringify(request.bounds) === JSON.stringify(AWS_HEALTH_PROVIDER_BOUNDS)
    && Number.isFinite(Date.parse(request.deadlineAtIso))
    && new Date(Date.parse(request.deadlineAtIso)).toISOString() === request.deadlineAtIso
    && (request.enabledObservedSince === null || (Number.isFinite(Date.parse(request.enabledObservedSince))
      && new Date(Date.parse(request.enabledObservedSince)).toISOString() === request.enabledObservedSince));
}

function providerCode(value: unknown): AwsHealthProviderFailureCode {
  const name = typeof value === "string" ? value : "";
  if (/subscriptionrequired/iu.test(name)) return "SUBSCRIPTION_REQUIRED";
  if (/accessdenied|unauthorized|notauthorized/iu.test(name)) return "ACCESS_DENIED";
  if (/invalidpagination/iu.test(name)) return "INVALID_PAGINATION";
  if (/throttl|toomanyrequest|requestlimit/iu.test(name)) return "THROTTLED";
  if (/timeout/iu.test(name)) return "TIMEOUT";
  return "UNKNOWN";
}

function captureForUnavailable(input: {
  readonly request: AwsHealthProviderRequest;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly prerequisites: AwsHealthProviderPrerequisites;
}): AwsHealthProviderCapture {
  const capture: AwsHealthProviderCapture = {
    schemaVersion: "sutra.aws-health-organization.v1",
    scope: input.request.scope,
    captureId: `health_${input.request.requestId.slice(4)}`,
    startedAtIso: input.startedAt,
    completedAtIso: input.completedAt,
    execution: { concurrencyLimit: 4 as const, eventDetailBatchSize: 10 as const, observedPeakConcurrency: 1 },
    prerequisites: input.prerequisites,
    events: { exhausted: true, pages: [{ request: { filter: null, locale: "en", maxResults: 100, nextToken: null }, response: { events: [], nextToken: null } }] },
    affectedAccounts: [], affectedEntities: [], eventDetails: [],
  };
  return Object.freeze(capture);
}

/**
 * Collects the complete organization event graph. Initial-load completion is
 * proven only after an uninterrupted ENABLED observation has aged 24 hours.
 */
export async function collectAwsHealthProviderEvidence(input: {
  readonly request: AwsHealthProviderRequest;
  readonly reader: AwsHealthProviderReader;
  readonly signal: AbortSignal;
  readonly now?: () => number;
}): Promise<AwsHealthProviderCapture> {
  if (!validRequest(input.request) || !(input.signal instanceof AbortSignal) || input.signal.aborted) reject("INVALID_REQUEST");
  const now = input.now ?? Date.now;
  const startedMs = now();
  const deadlineMs = Date.parse(input.request.deadlineAtIso);
  if (!Number.isSafeInteger(startedMs) || startedMs < 0 || !Number.isFinite(deadlineMs)
    || deadlineMs <= startedMs || deadlineMs - startedMs > AWS_HEALTH_PROVIDER_BOUNDS.maximumDurationMs
    || (input.request.enabledObservedSince !== null && Date.parse(input.request.enabledObservedSince) > startedMs)) reject("INVALID_REQUEST");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(deadlineMs - startedMs)]);
  const collector = input.request.candidateAccounts.find((target) => target.accountId === input.request.scope.accountId)!;
  let organization: Readonly<Record<string, unknown>>;
  try { organization = record(await input.reader.describeOrganization(collector, signal)); }
  catch (error) { if (signal.aborted) reject("ABORTED"); throw error; }
  const organizationValue = record(organization.organization ?? organization.Organization);
  const managementAccountId = text(organizationValue.ManagementAccountId ?? organizationValue.MasterAccountId, 12);
  if (!ACCOUNT.test(managementAccountId)) reject("PROVIDER_RESPONSE_INVALID");
  const organizationsAllFeaturesEnabled = organizationValue.FeatureSet === "ALL";
  const management = input.request.candidateAccounts.find((target) => target.accountId === managementAccountId) ?? null;
  let collectorAccountType: AwsHealthProviderPrerequisites["collectorAccountType"] = collector.accountId === managementAccountId ? "management" : "member";
  let delegatedAdministratorRegistered = false;
  let organizationViewStatus: AwsHealthProviderPrerequisites["organizationViewStatus"] = "UNKNOWN";
  let organizationViewStatusEvidence: AwsHealthProviderPrerequisites["organizationViewStatusEvidence"] = "unverified";
  if (management !== null) {
    if (collector.accountId !== managementAccountId) {
      let tokenValue: string | null = null;
      const seen = new Set<string>();
      let pages = 0;
      do {
        if (++pages > 100) reject("BOUND_REACHED");
        const output = record(await input.reader.listDelegatedAdministrators(
          management, { servicePrincipal: "health.amazonaws.com", nextToken: tokenValue }, signal,
        ));
        const accounts = output.DelegatedAdministrators ?? output.delegatedAdministrators;
        if (!Array.isArray(accounts) || accounts.length > 100) reject("PROVIDER_RESPONSE_INVALID");
        delegatedAdministratorRegistered ||= accounts.some((entry) => {
          const value = record(entry);
          return (value.Id ?? value.id) === collector.accountId;
        });
        tokenValue = nextToken(output.NextToken ?? output.nextToken, tokenValue, seen);
      } while (tokenValue !== null);
      collectorAccountType = delegatedAdministratorRegistered ? "delegated_administrator" : "member";
    }
    try {
      const output = record(await input.reader.describeOrganizationViewStatus(management, signal));
      const raw = output.healthServiceAccessStatusForOrganization ?? output.HealthServiceAccessStatusForOrganization;
      if (raw === "ENABLED" || raw === "DISABLED" || raw === "PENDING") organizationViewStatus = raw;
      else reject("PROVIDER_RESPONSE_INVALID");
      organizationViewStatusEvidence = collectorAccountType === "management"
        ? "management_status_api" : delegatedAdministratorRegistered ? "management_verified_delegation" : "unverified";
    } catch (error) {
      if (failure(error, signal) === "SUBSCRIPTION_REQUIRED") {
        const completedAt = new Date(now()).toISOString();
        return captureForUnavailable({ request: input.request, startedAt: new Date(startedMs).toISOString(), completedAt, prerequisites: {
          organizationsAllFeaturesEnabled, organizationViewStatus, organizationViewStatusEvidence,
          supportPlan: "not_qualifying", apiEntitlementValidated: false, collectorAccountType,
          delegatedAdministratorRegistered, readPermissionsValidated: false, initialLoadState: "UNKNOWN",
        } });
      }
      if (signal.aborted) reject("ABORTED");
    }
  }
  const initialLoadState: AwsHealthProviderPrerequisites["initialLoadState"] = organizationViewStatus !== "ENABLED"
    ? organizationViewStatus === "PENDING" ? "PENDING" : "UNKNOWN"
    : input.request.enabledObservedSince !== null
      && startedMs - Date.parse(input.request.enabledObservedSince) >= INITIAL_LOAD_WAIT_MS ? "COMPLETE" : "PENDING";
  const basePrerequisites = {
    organizationsAllFeaturesEnabled, organizationViewStatus, organizationViewStatusEvidence,
    supportPlan: "unknown" as const, collectorAccountType, delegatedAdministratorRegistered, initialLoadState,
  };
  if (organizationViewStatus === "DISABLED" || collectorAccountType === "member") {
    return captureForUnavailable({ request: input.request, startedAt: new Date(startedMs).toISOString(), completedAt: new Date(now()).toISOString(), prerequisites: {
      ...basePrerequisites, apiEntitlementValidated: collectorAccountType !== "member", readPermissionsValidated: false,
    } });
  }

  const eventPages: EventPage[] = [];
  const events: Record<string, unknown>[] = [];
  let eventToken: string | null = null;
  const eventTokens = new Set<string>();
  try {
    do {
      if (eventPages.length >= AWS_HEALTH_PROVIDER_BOUNDS.maximumPages
        || events.length >= AWS_HEALTH_PROVIDER_BOUNDS.maximumEvents) reject("BOUND_REACHED");
      const request = { filter: null, locale: "en" as const, maxResults: 100 as const, nextToken: eventToken };
      const output = record(await input.reader.describeEvents(collector, request, signal));
      const rawEvents = output.events ?? output.Events;
      if (!Array.isArray(rawEvents) || rawEvents.length > 100) reject("PROVIDER_RESPONSE_INVALID");
      const sanitized = rawEvents.map((entry) => {
        const event = record(entry);
        const arn = text(event.arn ?? event.Arn, 1_600);
        if (!EVENT_ARN.test(arn) || !arn.startsWith(`arn:${input.request.scope.partition}:`)) reject("PROVIDER_RESPONSE_INVALID");
        const value: Record<string, unknown> = {
          arn,
          eventScopeCode: text(event.eventScopeCode ?? event.EventScopeCode, 32),
          eventTypeCategory: text(event.eventTypeCategory ?? event.EventTypeCategory, 64),
          eventTypeCode: text(event.eventTypeCode ?? event.EventTypeCode, 100),
          statusCode: text(event.statusCode ?? event.StatusCode, 32),
        };
        for (const [outputKey, sourceKey] of [["actionability", "actionability"], ["region", "region"], ["service", "service"]] as const) {
          const raw = event[sourceKey] ?? event[sourceKey[0]!.toUpperCase() + sourceKey.slice(1)];
          if (raw !== undefined) value[outputKey] = text(raw, 128);
        }
        for (const [outputKey, sourceKey] of [["startTime", "startTime"], ["endTime", "endTime"], ["lastUpdatedTime", "lastUpdatedTime"]] as const) {
          const raw = event[sourceKey] ?? event[sourceKey[0]!.toUpperCase() + sourceKey.slice(1)];
          const normalized = optionalIso(raw); if (normalized !== undefined) value[outputKey] = normalized;
        }
        const personas = event.personas ?? event.Personas;
        if (personas !== undefined) {
          if (!Array.isArray(personas) || personas.length > 3 || personas.some((item) => typeof item !== "string")) reject("PROVIDER_RESPONSE_INVALID");
          value.personas = personas;
        }
        return value;
      });
      events.push(...sanitized);
      if (events.length > AWS_HEALTH_PROVIDER_BOUNDS.maximumEvents) reject("BOUND_REACHED");
      const returned = nextToken(output.nextToken ?? output.NextToken, eventToken, eventTokens);
      eventPages.push({ request, response: { events: sanitized as never, nextToken: returned } });
      eventToken = returned;
    } while (eventToken !== null);
  } catch (error) {
    const code = failure(error, signal);
    if (code === "SUBSCRIPTION_REQUIRED") {
      return captureForUnavailable({ request: input.request, startedAt: new Date(startedMs).toISOString(), completedAt: new Date(now()).toISOString(), prerequisites: {
        ...basePrerequisites, supportPlan: "not_qualifying", apiEntitlementValidated: false, readPermissionsValidated: false,
      } });
    }
    if (signal.aborted) reject("ABORTED");
    throw error;
  }

  const affectedAccounts: AccountSequence[] = [];
  const affectedEntities: EntitySequence[] = [];
  const eventDetails: DetailResult[] = [];
  let totalAccounts = 0;
  let totalEntities = 0;
  let totalPages = eventPages.length;
  for (const rawEvent of events) {
    const eventArn = rawEvent.arn as string;
    const eventScopeCode = rawEvent.eventScopeCode as "PUBLIC" | "ACCOUNT_SPECIFIC";
    const accountPages: AccountSequence["pages"][number][] = [];
    const accountIds = new Set<string>();
    let tokenValue: string | null = null;
    const seen = new Set<string>();
    do {
      if (++totalPages > AWS_HEALTH_PROVIDER_BOUNDS.maximumPages) reject("BOUND_REACHED");
      const request = { eventArn, maxResults: 100 as const, nextToken: tokenValue };
      const output = record(await input.reader.describeAffectedAccounts(collector, request, signal));
      const rawAccounts = output.affectedAccounts ?? output.AffectedAccounts;
      if (!Array.isArray(rawAccounts) || rawAccounts.length > 100
        || rawAccounts.some((account) => typeof account !== "string" || !ACCOUNT.test(account))) reject("PROVIDER_RESPONSE_INVALID");
      rawAccounts.forEach((account) => accountIds.add(account as string));
      totalAccounts += rawAccounts.length;
      if (totalAccounts > AWS_HEALTH_PROVIDER_BOUNDS.maximumAffectedAccounts) reject("BOUND_REACHED");
      const returned = nextToken(output.nextToken ?? output.NextToken, tokenValue, seen);
      const scopeCode = output.eventScopeCode ?? output.EventScopeCode;
      if (scopeCode !== eventScopeCode) reject("PROVIDER_RESPONSE_INVALID");
      accountPages.push({ request, response: { affectedAccounts: rawAccounts as string[], eventScopeCode, nextToken: returned } });
      tokenValue = returned;
    } while (tokenValue !== null);
    affectedAccounts.push({ eventArn, exhausted: true, pages: accountPages });
    const pairs: (string | null)[] = eventScopeCode === "PUBLIC" ? [null] : [...accountIds].sort();
    for (const awsAccountId of pairs) {
      const entityPages: EntitySequence["pages"][number][] = [];
      let entityToken: string | null = null;
      const entityTokens = new Set<string>();
      do {
        if (++totalPages > AWS_HEALTH_PROVIDER_BOUNDS.maximumPages) reject("BOUND_REACHED");
        const request = { locale: "en" as const, maxResults: 100 as const, nextToken: entityToken, organizationEntityAccountFilters: null, organizationEntityFilters: [{ eventArn, awsAccountId }] as const };
        const output = record(await input.reader.describeAffectedEntities(collector, request, signal));
        const rawEntities = output.entities ?? output.Entities;
        const rawFailed = output.failedSet ?? output.FailedSet ?? [];
        if (!Array.isArray(rawEntities) || rawEntities.length > 100 || !Array.isArray(rawFailed) || rawFailed.length > 10) reject("PROVIDER_RESPONSE_INVALID");
        totalEntities += rawEntities.length;
        if (totalEntities > AWS_HEALTH_PROVIDER_BOUNDS.maximumAffectedEntities) reject("BOUND_REACHED");
        const entities = rawEntities.map((entry) => {
          const entity = record(entry);
          const value: Record<string, unknown> = { eventArn };
          const account = entity.awsAccountId ?? entity.AwsAccountId;
          if (account !== undefined) { if (account !== awsAccountId) reject("PROVIDER_RESPONSE_INVALID"); value.awsAccountId = account; }
          for (const [out, source, maximum] of [["entityArn", "entityArn", 1600], ["entityValue", "entityValue", 1224], ["statusCode", "statusCode", 32]] as const) {
            const raw = entity[source] ?? entity[source[0]!.toUpperCase() + source.slice(1)]; if (raw !== undefined) value[out] = text(raw, maximum, true);
          }
          const updated = optionalIso(entity.lastUpdatedTime ?? entity.LastUpdatedTime); if (updated !== undefined) value.lastUpdatedTime = updated;
          const metadata = entity.entityMetadata ?? entity.EntityMetadata ?? {};
          const metadataRecord = record(metadata);
          if (Object.keys(metadataRecord).length > AWS_HEALTH_PROVIDER_BOUNDS.maximumMetadataEntries) reject("BOUND_REACHED");
          value.entityMetadata = Object.fromEntries(Object.entries(metadataRecord).map(([key, item]) => [text(key, 1024, true), text(item, 4096, true)]));
          return value;
        });
        const failedSet = rawFailed.map((entry) => {
          const failed = record(entry); const failedArn = text(failed.eventArn ?? failed.EventArn, 1600);
          const failedAccount = failed.awsAccountId ?? failed.AwsAccountId ?? null;
          if (failedArn !== eventArn || failedAccount !== awsAccountId) reject("PROVIDER_RESPONSE_INVALID");
          return { eventArn, awsAccountId, code: providerCode(failed.errorName ?? failed.ErrorName) };
        });
        const returned = nextToken(output.nextToken ?? output.NextToken, entityToken, entityTokens);
        entityPages.push({ request, response: { entities: entities as never, failedSet, nextToken: returned } });
        entityToken = returned;
      } while (entityToken !== null);
      affectedEntities.push({ eventArn, awsAccountId, exhausted: true, pages: entityPages });
      try {
        const output = record(await input.reader.describeEventDetails(collector, { locale: "en", organizationEventDetailFilters: [{ eventArn, awsAccountId }] }, signal));
        const successes = output.successfulSet ?? output.SuccessfulSet ?? [];
        const failures = output.failedSet ?? output.FailedSet ?? [];
        if (!Array.isArray(successes) || !Array.isArray(failures) || successes.length + failures.length !== 1) reject("PROVIDER_RESPONSE_INVALID");
        if (successes.length === 1) {
          const success = record(successes[0]);
          const event = record(success.event ?? success.Event);
          if ((event.arn ?? event.Arn) !== eventArn) reject("PROVIDER_RESPONSE_INVALID");
          const description = record(success.eventDescription ?? success.EventDescription ?? {});
          const rawDescription = description.latestDescription ?? description.LatestDescription ?? null;
          const metadata = record(success.eventMetadata ?? success.EventMetadata ?? {});
          if (Object.keys(metadata).length > AWS_HEALTH_PROVIDER_BOUNDS.maximumMetadataEntries) reject("BOUND_REACHED");
          eventDetails.push({ eventArn, awsAccountId, detail: { eventArn, awsAccountId, description: rawDescription === null ? null : text(rawDescription, 16_384, true), metadata: Object.fromEntries(Object.entries(metadata).map(([key, value]) => [text(key, 1024, true), text(value, 4096, true)])) }, failureCode: null });
        } else {
          const failed = record(failures[0]);
          eventDetails.push({ eventArn, awsAccountId, detail: null, failureCode: providerCode(failed.errorName ?? failed.ErrorName) });
        }
      } catch (error) {
        if (signal.aborted) reject("ABORTED");
        eventDetails.push({ eventArn, awsAccountId, detail: null, failureCode: failure(error, signal) });
      }
    }
  }
  const completedMs = now();
  if (!Number.isSafeInteger(completedMs) || completedMs < startedMs || completedMs > deadlineMs) reject("ABORTED");
  const capture: AwsHealthProviderCapture = {
    schemaVersion: "sutra.aws-health-organization.v1", scope: input.request.scope,
    captureId: `health_${input.request.requestId.slice(4)}`,
    startedAtIso: new Date(startedMs).toISOString(), completedAtIso: new Date(completedMs).toISOString(),
    execution: { concurrencyLimit: 4 as const, eventDetailBatchSize: 10 as const, observedPeakConcurrency: 1 },
    prerequisites: { ...basePrerequisites, apiEntitlementValidated: true, readPermissionsValidated: true },
    events: { pages: eventPages, exhausted: true }, affectedAccounts, affectedEntities, eventDetails,
  };
  if (Buffer.byteLength(JSON.stringify(capture), "utf8") > AWS_HEALTH_PROVIDER_BOUNDS.maximumCaptureBytes) reject("BOUND_REACHED");
  return Object.freeze(capture);
}
