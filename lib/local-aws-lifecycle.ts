export type CollectorCleanupState = "completed" | "pending";

export interface ControlPlaneFirstLifecycleResult<T> {
  readonly connection: T;
  readonly collectorCleanup: CollectorCleanupState;
}

export interface VerifiedRoleRegistrationResult<TConnection, TVerification> {
  readonly connection: TConnection;
  readonly verification: TVerification;
}

/**
 * The one-time trust handoff remains recoverable until the collector has
 * positively proved the complete customer-role contract. Verification leaves
 * the candidate non-runnable in the collector. The durable control-plane
 * commit is deliberately first among the two activation writes; only after it
 * succeeds may the collector make the candidate runnable.
 *
 * Callers provide a best-effort compensation that removes an initial staged
 * candidate or restores the previously committed collector material when
 * verification or the database commit fails. Compensation must not create an
 * offboarding tombstone, so the same registration remains retryable. Once the control
 * plane commits, activation failures deliberately leave the collector staged:
 * a retry can finish activation without contradicting durable state.
 */
export async function stageVerifyThenCommitRole<TConnection, TVerification>(input: {
  readonly stageCollector: () => Promise<unknown>;
  readonly verifyCollector: () => Promise<TVerification>;
  readonly commitVerifiedControlPlaneRole: (
    verification: TVerification,
  ) => Promise<TConnection>;
  readonly activateCollector: () => Promise<unknown>;
  readonly finalizeControlPlaneActivation?: (
    connection: TConnection,
  ) => Promise<TConnection>;
  readonly compensateStagedCollector: () => Promise<unknown>;
  readonly onActivationFailure?: (error: unknown) => Promise<unknown>;
}): Promise<VerifiedRoleRegistrationResult<TConnection, TVerification>> {
  let controlPlaneCommitted = false;
  try {
    await input.stageCollector();
    const verification = await input.verifyCollector();
    let connection = await input.commitVerifiedControlPlaneRole(verification);
    controlPlaneCommitted = true;
    await input.activateCollector();
    if (input.finalizeControlPlaneActivation !== undefined) {
      connection = await input.finalizeControlPlaneActivation(connection);
    }
    return { connection, verification };
  } catch (error) {
    if (!controlPlaneCommitted) {
      try {
        await input.compensateStagedCollector();
      } catch {
        // Preserve the candidate/commit error. A failed compensation leaves a
        // non-runnable staged candidate; a later registration retry can safely
        // reconcile it because no offboarding tombstone was written.
      }
    } else if (input.onActivationFailure !== undefined) {
      try {
        await input.onActivationFailure(error);
      } catch {
        // Preserve the activation error. The reconciliation marker must never
        // hide the broker failure that left this exact version non-runnable.
      }
    }
    throw error;
  }
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
