/**
 * Server-owned orchestration boundary for one Support Cases Radar collection.
 * Durable queue and credential brokerage are injected so neither an HTTP body
 * nor a browser can choose tenant/account scope. The transport returns only the
 * privacy-minimized capture accepted by the engine.
 */
import {
  createAwsSupportCasesQueryService,
  type AwsSupportCasesBoundary,
  type AwsSupportCasesSnapshot,
  type AwsSupportCasesTransport,
  type AwsSupportCollectionWindow,
  type AwsSupportIntendedAccount,
  type AwsSupportPartition,
} from "./finops-aws-support-cases-radar.ts";

export interface AwsSupportCasesJobScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly parentConnectionId: string;
  readonly partition: AwsSupportPartition;
}

export interface AwsSupportCasesTargetResolver {
  /** Trusted database discovery only; never implement this from request JSON. */
  resolve(scope: AwsSupportCasesJobScope): Promise<readonly AwsSupportIntendedAccount[]>;
}

export interface AwsSupportCasesSnapshotWriter {
  record(scope: AwsSupportCasesJobScope, snapshot: AwsSupportCasesSnapshot): Promise<void>;
}

export function createAwsSupportCasesCollectionJob(dependencies: {
  readonly targets: AwsSupportCasesTargetResolver;
  readonly transport: AwsSupportCasesTransport;
  readonly snapshots: AwsSupportCasesSnapshotWriter;
  readonly now?: () => Date;
  readonly createJobId?: () => string;
}): { run(scope: AwsSupportCasesJobScope, window: AwsSupportCollectionWindow): Promise<AwsSupportCasesSnapshot> } {
  return { async run(scope, window) {
    const intendedAccounts = await dependencies.targets.resolve(scope);
    const endpointRegion = scope.partition === "aws" ? "us-east-1" : "us-gov-west-1";
    const boundary: AwsSupportCasesBoundary = {
      scope: { orgId: scope.organizationId, customerId: scope.customerId,
        connectionId: scope.parentConnectionId, partition: scope.partition, endpointRegion },
      binding: "SERVER_RESOLVED_CONNECTIONS", intendedAccounts,
    };
    const snapshot = await createAwsSupportCasesQueryService(boundary, dependencies.transport, {
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.createJobId === undefined ? {} : { createJobId: dependencies.createJobId }),
    }).query(window);
    await dependencies.snapshots.record(scope, snapshot);
    return snapshot;
  } };
}
