/** Concrete AWS SDK v3 reader for the strict ADV-06 provider adapter. */
import {
  DescribeAffectedAccountsForOrganizationCommand,
  DescribeAffectedEntitiesForOrganizationCommand,
  DescribeEventDetailsForOrganizationCommand,
  DescribeEventsForOrganizationCommand,
  DescribeHealthServiceStatusForOrganizationCommand,
  HealthClient,
} from "@aws-sdk/client-health";
import {
  DescribeOrganizationCommand,
  ListDelegatedAdministratorsCommand,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";
import { workloadIdentityAwsClientConfig } from "./role-broker.js";
import type { AwsTemporaryCredentials } from "./types.js";
import type {
  AwsHealthProviderReader,
  AwsHealthProviderRequest,
  AwsHealthProviderTarget,
} from "./aws-health-provider-adapter.js";

interface AwsSdkClient {
  send(command: unknown, options: { readonly abortSignal: AbortSignal }): Promise<unknown>;
  destroy?(): void;
}
export interface AwsHealthSdkReaderOptions {
  readonly request: AwsHealthProviderRequest;
  readonly sessionForTarget: (
    target: AwsHealthProviderTarget,
    signal: AbortSignal,
  ) => Promise<AwsTemporaryCredentials>;
  readonly clientFactory?: (input: {
    readonly region: "us-east-1" | "us-gov-west-1";
    readonly credentials: AwsTemporaryCredentials;
  }) => { readonly health: AwsSdkClient; readonly organizations: AwsSdkClient };
}

function clients(input: {
  readonly region: "us-east-1" | "us-gov-west-1";
  readonly credentials: AwsTemporaryCredentials;
}) {
  const configuration = {
    ...workloadIdentityAwsClientConfig(input.region, 4),
    credentials: input.credentials,
  };
  return {
    health: new HealthClient(configuration) as unknown as AwsSdkClient,
    organizations: new OrganizationsClient(configuration) as unknown as AwsSdkClient,
  };
}
function key(target: AwsHealthProviderTarget): string {
  return `${target.accountId}\u0000${target.connectionId}`;
}

/**
 * Sessions and clients are cached only for this one signed provider request.
 * No tenant identity, pagination token or credential crosses requests.
 */
export function createAwsHealthSdkReader(
  options: AwsHealthSdkReaderOptions,
): AwsHealthProviderReader {
  const factory = options.clientFactory ?? clients;
  const cache = new Map<string, Promise<ReturnType<typeof factory>>>();
  const forTarget = (
    target: AwsHealthProviderTarget,
    signal: AbortSignal,
  ): Promise<ReturnType<typeof factory>> => {
    if (!options.request.candidateAccounts.some((candidate) =>
      candidate.accountId === target.accountId
      && candidate.connectionId === target.connectionId
    ) || signal.aborted) throw new Error("AWS_HEALTH_SDK_TARGET_REJECTED");
    const identity = key(target);
    let pending = cache.get(identity);
    if (pending === undefined) {
      pending = options.sessionForTarget(target, signal).then((credentials) =>
        factory({ region: options.request.scope.endpointRegion, credentials })
      );
      cache.set(identity, pending);
    }
    return pending;
  };
  return Object.freeze({
    describeOrganization: async (
      target: AwsHealthProviderTarget,
      signal: AbortSignal,
    ) =>
      (await forTarget(target, signal)).organizations.send(
        new DescribeOrganizationCommand({}), { abortSignal: signal },
      ),
    listDelegatedAdministrators: async (
      target: AwsHealthProviderTarget,
      input: Parameters<AwsHealthProviderReader["listDelegatedAdministrators"]>[1],
      signal: AbortSignal,
    ) =>
      (await forTarget(target, signal)).organizations.send(
        new ListDelegatedAdministratorsCommand({
          ServicePrincipal: input.servicePrincipal,
          MaxResults: 20,
          ...(input.nextToken === null ? {} : { NextToken: input.nextToken }),
        }),
        { abortSignal: signal },
      ),
    describeOrganizationViewStatus: async (
      target: AwsHealthProviderTarget,
      signal: AbortSignal,
    ) =>
      (await forTarget(target, signal)).health.send(
        new DescribeHealthServiceStatusForOrganizationCommand({}),
        { abortSignal: signal },
      ),
    describeEvents: async (
      target: AwsHealthProviderTarget,
      input: Parameters<AwsHealthProviderReader["describeEvents"]>[1],
      signal: AbortSignal,
    ) =>
      (await forTarget(target, signal)).health.send(
        new DescribeEventsForOrganizationCommand({
          locale: input.locale,
          maxResults: input.maxResults,
          ...(input.nextToken === null ? {} : { nextToken: input.nextToken }),
        }),
        { abortSignal: signal },
      ),
    describeAffectedAccounts: async (
      target: AwsHealthProviderTarget,
      input: Parameters<AwsHealthProviderReader["describeAffectedAccounts"]>[1],
      signal: AbortSignal,
    ) =>
      (await forTarget(target, signal)).health.send(
        new DescribeAffectedAccountsForOrganizationCommand({
          eventArn: input.eventArn,
          maxResults: input.maxResults,
          ...(input.nextToken === null ? {} : { nextToken: input.nextToken }),
        }),
        { abortSignal: signal },
      ),
    describeAffectedEntities: async (
      target: AwsHealthProviderTarget,
      input: Parameters<AwsHealthProviderReader["describeAffectedEntities"]>[1],
      signal: AbortSignal,
    ) => {
      const filter = input.organizationEntityFilters[0];
      return (await forTarget(target, signal)).health.send(
        new DescribeAffectedEntitiesForOrganizationCommand({
          locale: input.locale,
          maxResults: input.maxResults,
          organizationEntityFilters: [{
            eventArn: filter.eventArn,
            ...(filter.awsAccountId === null ? {} : {
              awsAccountId: filter.awsAccountId,
            }),
          }],
          ...(input.nextToken === null ? {} : { nextToken: input.nextToken }),
        }),
        { abortSignal: signal },
      );
    },
    describeEventDetails: async (
      target: AwsHealthProviderTarget,
      input: Parameters<AwsHealthProviderReader["describeEventDetails"]>[1],
      signal: AbortSignal,
    ) => {
      const filter = input.organizationEventDetailFilters[0];
      return (await forTarget(target, signal)).health.send(
        new DescribeEventDetailsForOrganizationCommand({
          locale: input.locale,
          organizationEventDetailFilters: [{
            eventArn: filter.eventArn,
            ...(filter.awsAccountId === null ? {} : {
              awsAccountId: filter.awsAccountId,
            }),
          }],
        }),
        { abortSignal: signal },
      );
    },
  });
}
