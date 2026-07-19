"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComplianceExceptionWithActivity } from "../../lib/compliance-exception-types";
import type { ComplianceControlResult } from "../../lib/compliance-engine";
import styles from "./compliance-exceptions.module.css";

interface Owner { readonly userId: string; readonly displayName: string; readonly role: string }
interface Payload {
  readonly exceptions: readonly ComplianceExceptionWithActivity[];
  readonly owners: readonly Owner[];
  readonly permissions: { readonly canRequest: boolean; readonly canReview: boolean; readonly localSingleAdminReview: boolean };
  readonly error?: { readonly message?: string; readonly code?: string };
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init });
  const body = await response.json().catch(() => null) as (T & { error?: { message?: string } }) | null;
  if (!response.ok || body === null) throw new Error(body?.error?.message ?? "The exception workflow could not complete");
  return body;
}

function futureLocalDate(days: number): string {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function ComplianceExceptions({
  connectionId,
  results,
  onChanged,
}: {
  readonly connectionId: string;
  readonly results: readonly ComplianceControlResult[];
  readonly onChanged: () => Promise<void>;
}) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [owner, setOwner] = useState("");
  const [expiry, setExpiry] = useState(() => futureLocalDate(30));
  const [rationale, setRationale] = useState("");
  const [compensatingControl, setCompensatingControl] = useState("");
  const [reviewNote, setReviewNote] = useState<Record<string, string>>({});
  const [mfaCode, setMfaCode] = useState<Record<string, string>>({});

  const candidates = useMemo(() => results.flatMap((result) =>
    result.evidence.matchingFindings
      .filter((finding) => finding.status !== "resolved")
      .map((finding) => ({
        value: `${encodeURIComponent(result.controlKey)}|${encodeURIComponent(finding.fingerprint)}`,
        label: `${result.title} · ${finding.fingerprint}`,
      }))), [results]);

  const refresh = useCallback(async () => {
    try {
      const loaded = await api<Payload>(`/api/v1/compliance/exceptions?connectionId=${encodeURIComponent(connectionId)}`);
      setPayload(loaded);
      setOwner((current) => current || loaded.owners[0]?.userId || "");
      setSelected((current) => current || candidates[0]?.value || "");
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The exception register is unavailable");
    }
  }, [candidates, connectionId]);

  useEffect(() => { queueMicrotask(() => void refresh()); }, [refresh]);

  async function requestException() {
    const [encodedControlKey, encodedFingerprint] = selected.split("|");
    if (!encodedControlKey || !encodedFingerprint || !expiry) return;
    const controlKey = decodeURIComponent(encodedControlKey);
    const findingFingerprint = decodeURIComponent(encodedFingerprint);
    setBusy("request"); setError(null);
    try {
      await api("/api/v1/compliance/exceptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "request", connectionId, controlKey, findingFingerprint,
          ownerUserId: owner, rationale, compensatingControl,
          expiresAt: new Date(expiry).toISOString(),
        }),
      });
      setRationale(""); setCompensatingControl(""); setExpiry(futureLocalDate(30));
      await refresh(); await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The exception request failed");
    } finally { setBusy(null); }
  }

  async function review(exceptionId: string, operation: "approve" | "reject" | "revoke") {
    setBusy(`${operation}:${exceptionId}`); setError(null);
    try {
      const code = mfaCode[exceptionId] ?? "";
      if (!/^\d{6}$/u.test(code)) throw new Error("Enter the current six-digit authenticator code");
      await api("/api/auth/mfa/step-up", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
      });
      await api("/api/v1/compliance/exceptions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation, connectionId, exceptionId, reviewNote: reviewNote[exceptionId] ?? "" }),
      });
      setMfaCode((current) => ({ ...current, [exceptionId]: "" }));
      await refresh(); await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The exception review failed");
    } finally { setBusy(null); }
  }

  return (
    <section className={`panel ${styles.panel}`}>
      <div className="panel-heading">
        <div><p className="eyebrow">Governed risk acceptance</p><h2>Compliance exception register</h2></div>
        <span className="status-pill status-medium">MFA reviewed</span>
      </div>
      <p className={styles.intro}>An exception affects a result only after approval, only for its exact finding fingerprint, and only until its expiry. It never becomes a pass.</p>
      {payload?.permissions.localSingleAdminReview ? <div className={styles.notice}><strong>Local demo governance:</strong> this workspace has one active administrator, so self-review is recorded explicitly in the audit trail. Add a second administrator before production use.</div> : null}
      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Exception workflow needs attention</strong><span>{error}</span></div> : null}
      {payload?.permissions.canRequest && candidates.length > 0 ? (
        <div className={styles.requestGrid}>
          <label><span>Control finding</span><select value={selected} onChange={(event) => setSelected(event.target.value)}>{candidates.map((candidate) => <option key={candidate.value} value={candidate.value}>{candidate.label}</option>)}</select></label>
          <label><span>Risk owner</span><select value={owner} onChange={(event) => setOwner(event.target.value)}>{payload.owners.map((candidate) => <option key={candidate.userId} value={candidate.userId}>{candidate.displayName} · {candidate.role}</option>)}</select></label>
          <label><span>Expires</span><input type="datetime-local" value={expiry} onChange={(event) => setExpiry(event.target.value)} /></label>
          <label className={styles.wide}><span>Business rationale</span><textarea maxLength={1000} placeholder="Why the risk cannot be remediated now (minimum 20 characters)" value={rationale} onChange={(event) => setRationale(event.target.value)} /></label>
          <label className={styles.wide}><span>Compensating control</span><textarea maxLength={1000} placeholder="What reduces or monitors the accepted risk (minimum 20 characters)" value={compensatingControl} onChange={(event) => setCompensatingControl(event.target.value)} /></label>
          <button className="button button-primary" disabled={busy !== null || rationale.trim().length < 20 || compensatingControl.trim().length < 20 || !owner || !selected || !expiry} onClick={() => void requestException()} type="button">{busy === "request" ? "Submitting…" : "Submit for approval"}</button>
        </div>
      ) : null}
      <div className={styles.list}>
        {payload?.exceptions.map((item) => (
          <article key={item.id}>
            <div className={styles.exceptionHead}><div><strong>{item.controlKey}</strong><small>{item.findingFingerprint}</small></div><span className={`status-pill ${item.effectiveStatus === "approved" ? "status-positive" : item.effectiveStatus === "pending" ? "status-medium" : "status-risk"}`}>{item.effectiveStatus}</span></div>
            <dl><div><dt>Owner</dt><dd>{item.ownerDisplayName}</dd></div><div><dt>Expiry</dt><dd>{new Date(item.expiresAt).toLocaleString()}</dd></div><div><dt>Requested by</dt><dd>{item.requestedByDisplayName}</dd></div><div><dt>Reviewed by</dt><dd>{item.reviewedByDisplayName ?? "Pending"}</dd></div></dl>
            <p><strong>Rationale:</strong> {item.rationale}</p><p><strong>Compensating control:</strong> {item.compensatingControl}</p>
            {payload.permissions.canReview && (item.status === "pending" || item.status === "approved") ? (
              <div className={styles.review}>
                <input aria-label={`Review note for ${item.id}`} maxLength={500} placeholder="Review note" value={reviewNote[item.id] ?? ""} onChange={(event) => setReviewNote((current) => ({ ...current, [item.id]: event.target.value }))} />
                <input aria-label={`Authenticator code for ${item.id}`} autoComplete="one-time-code" inputMode="numeric" maxLength={6} placeholder="MFA code" value={mfaCode[item.id] ?? ""} onChange={(event) => setMfaCode((current) => ({ ...current, [item.id]: event.target.value.replace(/\D/gu, "") }))} />
                {item.status === "pending" ? <><button className="button button-primary button-small" disabled={busy !== null} onClick={() => void review(item.id, "approve")} type="button">Approve</button><button className="button button-secondary button-small" disabled={busy !== null} onClick={() => void review(item.id, "reject")} type="button">Reject</button></> : <button className="button button-secondary button-small" disabled={busy !== null} onClick={() => void review(item.id, "revoke")} type="button">Revoke</button>}
              </div>
            ) : null}
            <details><summary>{item.activity.length} audit event{item.activity.length === 1 ? "" : "s"}</summary><ol>{item.activity.map((event) => <li key={event.id}><strong>{event.action}</strong> by {event.actorDisplayName} · {new Date(event.occurredAt).toLocaleString()}{event.note ? ` — ${event.note}` : ""}</li>)}</ol></details>
          </article>
        ))}
        {payload && payload.exceptions.length === 0 ? <div className="empty-state"><strong>No exception requests</strong><span>Failed controls remain failed until an exact, time-bounded exception is approved.</span></div> : null}
      </div>
    </section>
  );
}
