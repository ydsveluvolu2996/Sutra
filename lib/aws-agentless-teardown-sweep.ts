/**
 * Reconciles the resources an agentless scan left behind.
 *
 * Two kinds of debt exist, and they are NOT interchangeable:
 *
 *   sutra-scan-account — a scan volume or re-encrypted snapshot copy that Sutra
 *     owns and failed to delete. Sutra can retry this, so the sweeper does.
 *
 *   customer — the source snapshot in the customer's account. Sutra holds an
 *     explicit IAM deny on DeleteSnapshot and CANNOT remove it; the customer's
 *     own lifecycle policy reaps it. The sweeper therefore never retries these.
 *     It only asks AWS whether the snapshot is gone yet, and settles the row
 *     when it is.
 *
 * That distinction is the whole point. A sweeper that "retried" a customer-side
 * delete would fail forever against the deny, burn API calls, and — worse —
 * imply Sutra had a capability it deliberately gave up. And a sweeper that
 * ignored customer-side rows would let real spend accumulate unseen.
 *
 * Pure over an injected prober: no AWS SDK, no database. Fully fixture-testable.
 */

export type DebtAccountScope = "sutra-scan-account" | "customer";

export interface OutstandingResource {
  readonly resourceId: string;
  readonly resourceKind: "snapshot" | "volume" | "instance";
  readonly region: string;
  readonly accountScope: string;
  readonly attempts: number;
  readonly firstSeenAt: string;
}

/**
 * Injected AWS seam. `stillExists` must return false ONLY on positive evidence
 * of absence — a describe that reports NotFound. An error, a throttle or an
 * ambiguous answer must surface as `unknown`, because settling debt on a failed
 * lookup would silently under-report live customer spend.
 */
export interface TeardownProber {
  stillExists(input: {
    readonly resourceId: string;
    readonly resourceKind: "snapshot" | "volume" | "instance";
    readonly region: string;
    readonly accountScope: string;
  }): Promise<boolean | "unknown">;
  /** Delete a SCAN-ACCOUNT resource. Never called for customer-scoped rows. */
  deleteScanAccountResource(input: {
    readonly resourceId: string;
    readonly resourceKind: "snapshot" | "volume" | "instance";
    readonly region: string;
  }): Promise<void>;
}

export type SweepDisposition =
  /** Proven gone; the debt row should be settled. */
  | "settled"
  /** Sutra deleted it on this pass; settled. */
  | "deleted"
  /** Still present and Sutra cannot act — awaiting the customer's policy. */
  | "awaiting-customer"
  /** Still present, Sutra tried to delete, delete failed. Retry later. */
  | "retry-failed"
  /** Existence could not be determined. Never settled on ambiguity. */
  | "unknown";

export interface SweepOutcome {
  readonly resourceId: string;
  readonly disposition: SweepDisposition;
  readonly detail: string;
}

export interface SweepResult {
  readonly schema: "sutra.aws-agentless-teardown-sweep.v1";
  readonly outcomes: readonly SweepOutcome[];
  readonly summary: {
    readonly considered: number;
    readonly settled: number;
    readonly deleted: number;
    readonly awaitingCustomer: number;
    readonly retryFailed: number;
    readonly unknown: number;
    /** Rows still costing money after this pass. */
    readonly stillOutstanding: number;
  };
}

/** Bounded so one sweep cannot fan out unboundedly across a large backlog. */
export const MAX_SWEEP_RESOURCES = 200;

function isCustomerScoped(accountScope: string): boolean {
  return accountScope === "customer";
}

export async function sweepAgentlessTeardownDebt(
  resources: readonly OutstandingResource[],
  prober: TeardownProber,
  limit = MAX_SWEEP_RESOURCES,
): Promise<SweepResult> {
  const bounded = resources.slice(0, Math.max(0, Math.min(MAX_SWEEP_RESOURCES, limit)));
  const outcomes: SweepOutcome[] = [];

  for (const resource of bounded) {
    let exists: boolean | "unknown";
    try {
      exists = await prober.stillExists({
        resourceId: resource.resourceId,
        resourceKind: resource.resourceKind,
        region: resource.region,
        accountScope: resource.accountScope,
      });
    } catch (error) {
      // A failed lookup is not evidence of absence.
      outcomes.push({
        resourceId: resource.resourceId,
        disposition: "unknown",
        detail: `existence check failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    if (exists === "unknown") {
      outcomes.push({ resourceId: resource.resourceId, disposition: "unknown", detail: "AWS did not give a definite answer" });
      continue;
    }
    if (exists === false) {
      outcomes.push({ resourceId: resource.resourceId, disposition: "settled", detail: "no longer present in AWS" });
      continue;
    }

    // It still exists. Whether Sutra may act depends on whose account it is in.
    if (isCustomerScoped(resource.accountScope)) {
      outcomes.push({
        resourceId: resource.resourceId,
        disposition: "awaiting-customer",
        detail: "Sutra holds an explicit deny on delete; the customer-owned lifecycle policy reaps this",
      });
      continue;
    }

    try {
      await prober.deleteScanAccountResource({
        resourceId: resource.resourceId,
        resourceKind: resource.resourceKind,
        region: resource.region,
      });
      outcomes.push({ resourceId: resource.resourceId, disposition: "deleted", detail: "deleted from Sutra's scan account" });
    } catch (error) {
      outcomes.push({
        resourceId: resource.resourceId,
        disposition: "retry-failed",
        detail: `delete failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const count = (disposition: SweepDisposition): number => outcomes.filter((entry) => entry.disposition === disposition).length;
  const settled = count("settled");
  const deleted = count("deleted");
  const awaitingCustomer = count("awaiting-customer");
  const retryFailed = count("retry-failed");
  const unknown = count("unknown");
  return {
    schema: "sutra.aws-agentless-teardown-sweep.v1",
    outcomes,
    summary: {
      considered: bounded.length,
      settled,
      deleted,
      awaitingCustomer,
      retryFailed,
      unknown,
      // Anything not proven gone is still billable. Unknown counts as
      // outstanding on purpose — optimism here would under-report spend.
      stillOutstanding: awaitingCustomer + retryFailed + unknown,
    },
  };
}

/** Resource ids whose debt rows may be settled after this sweep. */
export function settledResourceIds(result: SweepResult): readonly string[] {
  return result.outcomes
    .filter((outcome) => outcome.disposition === "settled" || outcome.disposition === "deleted")
    .map((outcome) => outcome.resourceId);
}
