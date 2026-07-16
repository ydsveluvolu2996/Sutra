export type CollectorCleanupState = "completed" | "pending";

export interface ControlPlaneFirstLifecycleResult<T> {
  readonly connection: T;
  readonly collectorCleanup: CollectorCleanupState;
}

/**
 * Role registration is a control-plane-first reconciliation. A collector
 * failure still propagates to the caller, but the durable pending role remains
 * authoritative and a retry reconciles the same state without reopening the
 * one-time ExternalId handoff.
 */
export async function commitRoleThenRegisterCollector<T>(input: {
  readonly commitControlPlaneRole: () => Promise<T>;
  readonly registerCollector: () => Promise<unknown>;
}): Promise<T> {
  const connection = await input.commitControlPlaneRole();
  await input.registerCollector();
  return connection;
}

/**
 * Make the durable control-plane state authoritative before attempting the
 * local collector cleanup. Collector cleanup is deliberately best-effort: the
 * same lifecycle request can be repeated after an offline collector returns.
 */
export async function applyControlPlaneLifecycleThenReconcileCollector<T>(input: {
  readonly transitionControlPlane: () => Promise<T>;
  readonly reconcileCollector: () => Promise<void>;
}): Promise<ControlPlaneFirstLifecycleResult<T>> {
  const connection = await input.transitionControlPlane();
  try {
    await input.reconcileCollector();
    return { connection, collectorCleanup: "completed" };
  } catch {
    return { connection, collectorCleanup: "pending" };
  }
}
