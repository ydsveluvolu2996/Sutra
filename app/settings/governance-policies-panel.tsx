"use client";

import { useCallback, useEffect, useState } from "react";

// Governance policies + the approval queue. Two honesty rules drive this UI:
//   * every action is labelled with WHO performs it. Sutra holds read-only
//     access to customer accounts, so an action either happens inside Sutra or
//     produces something the customer applies themselves — the panel never
//     implies Sutra stops, patches or deletes a customer resource.
//   * a policy that did not decide is shown as "signal unavailable" with the
//     reason, never as a pass.
// Approve / Reject are two-step: the first click arms the decision, the second
// (with a mandatory reason) sends it.

interface EvidenceEntry {
  readonly signal: string;
  readonly label: string;
  readonly observed: number | string | null;
  readonly comparator: string | null;
  readonly threshold: number | null;
  readonly truth: "true" | "false" | "unknown";
  readonly basis: string;
}

interface ProposedAction {
  readonly kind: string;
  readonly label: string;
  readonly performedBy: "sutra" | "customer";
  readonly description: string;
  readonly target: string | null;
  readonly expiresInDays: number | null;
}

interface Decision {
  readonly policyId: string;
  readonly policyName: string;
  readonly priority: number;
  readonly requiresApproval: boolean;
  readonly state: "matched" | "not-matched" | "signal-unavailable" | "disabled" | "out-of-scope";
  readonly matched: boolean;
  readonly reason: string;
  readonly evidence: readonly EvidenceEntry[];
  readonly proposedAction: ProposedAction | null;
  readonly pendingApproval: boolean;
  readonly approvalRequestKey: string | null;
}

interface PolicySummary {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly requiresApproval: boolean;
  readonly action: { readonly kind: string; readonly target: string | null; readonly expiresInDays: number | null };
}

interface PendingApproval {
  readonly id: string;
  readonly requestId: string;
  readonly policyId: string;
  readonly policyName: string | null;
  readonly actionKind: string;
  readonly targetRef: string | null;
  readonly reason: string;
  readonly actorUserId: string;
  readonly createdAt: string;
}

interface ActionDescriptor {
  readonly kind: string;
  readonly label: string;
  readonly performedBy: "sutra" | "customer";
  readonly description: string;
}

interface PoliciesPayload {
  readonly period: string | null;
  readonly policies: readonly PolicySummary[];
  readonly evaluation: { readonly decisions: readonly Decision[]; readonly disclaimer: string } | null;
  readonly pendingApprovals: readonly PendingApproval[];
  readonly actions: readonly ActionDescriptor[];
}

const STATE_LABEL: Readonly<Record<Decision["state"], string>> = {
  matched: "Matched",
  "not-matched": "Not matched",
  "signal-unavailable": "Signal unavailable",
  disabled: "Disabled",
  "out-of-scope": "Out of scope",
};

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { cache: "no-store", credentials: "same-origin", ...init });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload
      ? String((payload as { error: { message?: string } }).error?.message ?? "Request rejected")
      : "Request rejected";
    throw new Error(message);
  }
  return payload as T;
}

export default function GovernancePoliciesPanel() {
  const [payload, setPayload] = useState<PoliciesPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The armed decision: which request, and approve or reject. Null = nothing armed.
  const [armed, setArmed] = useState<{ requestId: string; intent: "approve" | "reject" } | null>(null);
  const [decisionReason, setDecisionReason] = useState("");

  const load = useCallback(async () => {
    try {
      const next = await requestJson<PoliciesPayload>("/api/v1/governance/policies");
      setPayload(next);
      setLoadError(null);
    } catch (caught) {
      setPayload(null);
      setLoadError(caught instanceof Error ? caught.message : "Governance policies could not be loaded");
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function decide(): Promise<void> {
    if (armed === null) return;
    setBusy(true);
    setError(null);
    try {
      await requestJson<{ pending: readonly PendingApproval[] }>("/api/v1/governance/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: armed.intent, requestId: armed.requestId, reason: decisionReason.trim() }),
      });
      setArmed(null);
      setDecisionReason("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The approval decision was rejected");
    } finally {
      setBusy(false);
    }
  }

  const decisions = payload?.evaluation?.decisions ?? [];
  const pending = payload?.pendingApprovals ?? [];
  const actions = payload?.actions ?? [];

  return (
    <section className="panel" aria-label="Governance policies and approvals">
      <div className="panel-heading">
        <div>
          <h2>Governance policies and approvals</h2>
          <p>
            A policy is a condition over cost and security state Sutra already computes, plus a governed action.
            Sutra&apos;s access to customer accounts is read-only: no policy can stop, patch, resize or delete a
            customer resource. Every action below names who performs it.
          </p>
        </div>
      </div>

      {loadError ? <p className="cmdbq-error" role="alert">{loadError}</p> : null}

      {actions.length > 0 ? (
        <ul className="panel-footnote">
          {actions.map((action) => (
            <li key={action.kind}>
              <strong>{action.label}</strong>{" "}
              — performed by {action.performedBy === "sutra" ? "Sutra" : "the customer"}. {action.description}
            </li>
          ))}
        </ul>
      ) : null}

      <h3>Pending approvals</h3>
      {pending.length === 0 ? (
        <p className="panel-footnote">No governance action is awaiting approval.</p>
      ) : (
        <div role="alert">
          <p>{pending.length} governance action(s) are held pending approval. Nothing has been performed yet.</p>
          <table>
            <thead>
              <tr><th>Policy</th><th>Action</th><th>Target</th><th>Requested by</th><th>Reason given</th><th>Requested</th><th /></tr>
            </thead>
            <tbody>
              {pending.map((entry) => {
                const isArmed = armed !== null && armed.requestId === entry.requestId;
                return (
                  <tr key={entry.id}>
                    <td>{entry.policyName ?? entry.policyId}</td>
                    <td>{entry.actionKind}</td>
                    <td>{entry.targetRef ?? "—"}</td>
                    <td><code>{entry.actorUserId}</code></td>
                    <td>{entry.reason}</td>
                    <td>{entry.createdAt}</td>
                    <td>
                      {isArmed ? (
                        <>
                          <input
                            aria-label={`Reason to ${armed.intent} ${entry.policyName ?? entry.policyId}`}
                            placeholder="reason (recorded permanently, 8+ characters)"
                            value={decisionReason}
                            onChange={(event) => setDecisionReason(event.target.value)}
                            style={{ minHeight: "44px" }}
                          />
                          <button
                            type="button"
                            className="button button-primary"
                            style={{ minHeight: "44px", minWidth: "44px" }}
                            disabled={busy || decisionReason.trim().length < 8}
                            onClick={() => void decide()}
                          >
                            {busy
                              ? "Recording…"
                              : `Confirm ${armed.intent} — ${armed.intent === "approve" ? "Sutra will perform this action" : "the request is refused"}`}
                          </button>
                          <button
                            type="button"
                            className="button button-secondary"
                            style={{ minHeight: "44px", minWidth: "44px" }}
                            disabled={busy}
                            onClick={() => { setArmed(null); setDecisionReason(""); }}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="button button-secondary"
                            style={{ minHeight: "44px", minWidth: "44px" }}
                            onClick={() => { setArmed({ requestId: entry.requestId, intent: "approve" }); setDecisionReason(""); setError(null); }}
                          >
                            Approve…
                          </button>
                          <button
                            type="button"
                            className="button button-secondary"
                            style={{ minHeight: "44px", minWidth: "44px" }}
                            onClick={() => { setArmed({ requestId: entry.requestId, intent: "reject" }); setDecisionReason(""); setError(null); }}
                          >
                            Reject…
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {error ? <p className="cmdbq-error" role="alert">{error}</p> : null}
      <p className="panel-footnote">
        The account that raised a request can never decide it, and a decision is appended to an immutable ledger with
        the deciding account and the reason.
      </p>

      <h3>Policies{payload?.period === null || payload?.period === undefined ? "" : ` · evaluated for ${payload.period}`}</h3>
      {decisions.length === 0 ? (
        <p className="panel-footnote">
          No governance policies are configured. Create one with POST /api/v1/governance/policies.
        </p>
      ) : (
        <table>
          <thead>
            <tr><th>Policy</th><th>Priority</th><th>State</th><th>Proposed action</th><th>Performed by</th><th>Matched evidence</th></tr>
          </thead>
          <tbody>
            {decisions.map((decision) => (
              <tr key={decision.policyId}>
                <td>{decision.policyName}{decision.requiresApproval ? " · approval required" : ""}</td>
                <td>{decision.priority}</td>
                <td>{STATE_LABEL[decision.state]}{decision.pendingApproval ? " · pending approval" : ""}</td>
                <td>{decision.proposedAction === null ? "—" : decision.proposedAction.label}</td>
                <td>
                  {decision.proposedAction === null
                    ? "—"
                    : decision.proposedAction.performedBy === "sutra"
                      ? "Sutra (inside Sutra)"
                      : "Customer (in their own account)"}
                </td>
                <td>
                  <p>{decision.reason}</p>
                  {decision.evidence.length === 0 ? null : (
                    <ul>
                      {decision.evidence.map((entry, index) => (
                        <li key={`${decision.policyId}-${entry.signal}-${index}`}>
                          <strong>{entry.label}</strong>: observed {entry.observed === null ? "unavailable" : String(entry.observed)}
                          {entry.comparator === null || entry.threshold === null ? "" : ` ${entry.comparator} ${entry.threshold}`}
                          {" — "}{entry.basis}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="panel-footnote">
        {payload?.evaluation?.disclaimer ??
          "Governance policies decide, they do not act: an approval-gated policy takes no action until a human approval is recorded."}
      </p>
    </section>
  );
}
