import { isCollectableAwsSourceKind } from "./aws-connection-source";
/** Compose a runtime-only .8.5 view without mutating generic connection state. */
import type { ComputeOptimizerMaterializationRuntimeConnection } from
  "./finops-compute-optimizer-materialization-runtime.ts";

type GenericConnection = ComputeOptimizerMaterializationRuntimeConnection;

interface SeparateCapability {
  readonly scope: {
    readonly organizationId: string;
    readonly customerId: string;
    readonly connectionId: string;
  };
  readonly accountId: string;
  readonly partition: string;
  readonly permissionPackVersion: string;
  readonly enabled: boolean;
}

export async function resolveComputeOptimizerMaterializationConnection(
  organizationId: string,
  connectionId: string,
  dependencies: {
    readonly getGenericConnection: (
      organizationId: string,
      connectionId: string,
    ) => Promise<GenericConnection | null>;
    readonly getCurrentCapability: (scope: {
      readonly organizationId: string;
      readonly customerId: string;
      readonly connectionId: string;
    }) => Promise<SeparateCapability | null>;
  },
): Promise<ComputeOptimizerMaterializationRuntimeConnection | null> {
  const connection = await dependencies.getGenericConnection(organizationId, connectionId);
  if (connection === null || connection.id !== connectionId
    || !isCollectableAwsSourceKind(connection.sourceKind) || connection.status !== "active") return null;
  const scope = Object.freeze({
    organizationId,
    customerId: connection.customerId,
    connectionId: connection.id,
  });
  const capability = await dependencies.getCurrentCapability(scope);
  if (capability === null || !capability.enabled
    || capability.permissionPackVersion !== "standard-2026-08.5"
    || capability.scope.organizationId !== scope.organizationId
    || capability.scope.customerId !== scope.customerId
    || capability.scope.connectionId !== scope.connectionId
    || capability.accountId !== connection.awsAccountId
    || capability.partition !== connection.partition) return null;
  return Object.freeze({ ...connection, permissionPackVersion: capability.permissionPackVersion });
}
