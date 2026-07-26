"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { postAuth, readAuthResponse, useSession } from "../components/use-session";

interface RecoveryMember {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: string;
  readonly scopeMode: string;
  readonly status: "active" | "suspended";
}

interface RecoveryDirectory {
  readonly members: readonly RecoveryMember[];
}

// The row-level recovery operations, in escalating consequence. Owner removal is
// deliberately NOT here: it lives in its own panel with a typed confirmation.
type RowOperation = "unlock" | "reset_member_mfa" | "provision_owner";

interface PendingRowAction {
  readonly operation: RowOperation;
  readonly membershipId: string;
}

function roleLabel(role: string): string {
  return role.replaceAll("_", " ").replace(/\b\w/gu, (value) => value.toLocaleUpperCase("en-US"));
}

// The recovery route pins its operation identifier to `rec_` + 32 lowercase hex
// characters. Anything else is rejected as invalid input before any work runs.
function recoveryOperationId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `rec_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function operationTitle(operation: RowOperation): string {
  switch (operation) {
    case "unlock": return "Clear the sign-in lockout";
    case "reset_member_mfa": return "Reset this member's MFA enrollment";
    case "provision_owner": return "Grant organization ownership";
  }
}

function operationEffect(operation: RowOperation, member: RecoveryMember): string {
  switch (operation) {
    case "unlock":
      return `${member.email} keeps their password and authenticator. Only the failed-attempt counter and the lockout window are cleared, so they can sign in again immediately.`;
    case "reset_member_mfa":
      return `${member.email} loses their authenticator enrollment and every signed-in session in this organization, and their sign-in lockout is cleared. They must re-enroll MFA on their next sign-in. Sutra never shows you their credentials — it only confirms the reset.`;
    case "provision_owner":
      return `${member.email} is promoted from ${roleLabel(member.role)} to Organization owner with organization-wide scope, and their explicit per-customer grants are removed. You keep your own ownership. Existing owners are unaffected.`;
  }
}

function operationVerb(operation: RowOperation): string {
  switch (operation) {
    case "unlock": return "Clear lockout";
    case "reset_member_mfa": return "Reset MFA";
    case "provision_owner": return "Make owner";
  }
}

export function AccountRecovery() {
  const { session } = useSession();
  const capabilities = new Set(session?.capabilities ?? []);
  // Truthful authorization mirror of the two routes:
  // - POST /api/v1/accounts/unlock requires the `membership:manage` capability
  //   (org_owner or org_admin), enforced inside unlockLocalUserAccount.
  // - POST /api/v1/access/recovery additionally requires role === "org_owner"
  //   (canAdministerRecovery), enforced in the recovery repository.
  const canUnlock = capabilities.has("membership:manage");
  const isOwner = session?.membership.role === "org_owner";
  const selfUserId = session?.user.id ?? null;
  const selfMembershipId = session?.membership.id ?? null;

  const [members, setMembers] = useState<readonly RecoveryMember[]>([]);
  const [totpCode, setTotpCode] = useState("");
  const [pending, setPending] = useState<PendingRowAction | null>(null);
  const [transferTargetId, setTransferTargetId] = useState("");
  const [transferConfirmation, setTransferConfirmation] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Which panel raised the current alert, so the result is announced next to the
  // control the operator actually used rather than only at the top of the page.
  const [alertSurface, setAlertSurface] = useState<"members" | "ownership">("members");
  // A recovery operation identifier is the route's audit request id. Keeping it
  // sticky per target+operation means an ambiguous transport failure can be
  // retried without recording a second, unrelated recovery event.
  const recoveryOperations = useRef(new Map<string, string>());

  const load = useCallback(async (): Promise<RecoveryDirectory> => {
    const response = await fetch("/api/v1/customer-assignments", { cache: "no-store", credentials: "same-origin" });
    return readAuthResponse<RecoveryDirectory>(response);
  }, []);

  useEffect(() => {
    let active = true;
    void load()
      .then((loaded) => {
        if (active) setMembers(loaded.members);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Sutra could not load organization memberships");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [load]);

  const pendingMember = useMemo(
    () => members.find((member) => member.membershipId === pending?.membershipId) ?? null,
    [members, pending],
  );
  // transfer_owner demotes an existing owner OTHER than the acting owner; the
  // server refuses the acting owner's own membership and refuses to remove the
  // last active owner, so neither is ever offered here.
  const removableOwners = useMemo(
    () => members.filter((member) => member.role === "org_owner" && member.status === "active" && member.membershipId !== selfMembershipId),
    [members, selfMembershipId],
  );
  const transferTarget = useMemo(
    () => removableOwners.find((member) => member.membershipId === transferTargetId) ?? null,
    [removableOwners, transferTargetId],
  );
  const transferConfirmed = transferTarget !== null
    && transferConfirmation.trim().toLocaleLowerCase("en-US") === transferTarget.email.toLocaleLowerCase("en-US");

  function reset(): void {
    setPending(null);
    setTransferTargetId("");
    setTransferConfirmation("");
  }

  async function stepUpIfProvided(): Promise<void> {
    if (totpCode.length === 6) await postAuth("/api/auth/mfa/step-up", { code: totpCode });
  }

  function stickyOperationId(key: string): string {
    const existing = recoveryOperations.current.get(key) ?? recoveryOperationId();
    recoveryOperations.current.set(key, existing);
    return existing;
  }

  async function runRowAction(operation: RowOperation, member: RecoveryMember): Promise<void> {
    setBusy(true);
    setAlertSurface("members");
    setError(null);
    setNotice(null);
    try {
      await stepUpIfProvided();
      // A verified TOTP value is single-use; clear it before the ambiguous
      // window so a retry replays the sticky operation without failing MFA.
      if (totpCode.length === 6) setTotpCode("");
      if (operation === "unlock") {
        const response = await fetch("/api/v1/accounts/unlock", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: member.userId }),
        });
        const result = await readAuthResponse<{ readonly unlocked: boolean }>(response);
        setNotice(result.unlocked
          ? `The sign-in lockout for ${member.email} was cleared. Their password and authenticator are unchanged.`
          : `${member.email} had no active lockout or failed-attempt count, so nothing was changed.`);
      } else {
        const key = `${operation}:${member.membershipId}`;
        const response = await fetch("/api/v1/access/recovery", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operation,
            operationId: stickyOperationId(key),
            target: operation === "reset_member_mfa" ? member.userId : member.membershipId,
          }),
        });
        await readAuthResponse<{ readonly ok: true }>(response);
        recoveryOperations.current.delete(key);
        setNotice(operation === "reset_member_mfa"
          ? `MFA enrollment was reset for ${member.email}. Their organization sessions were revoked and their lockout cleared. They must re-enroll an authenticator at their next sign-in — Sutra did not display or record any credential.`
          : `${member.email} is now an Organization owner with organization-wide scope.`);
      }
      reset();
      setMembers((await load()).members);
    } catch (caught) {
      setError(caught instanceof Error
        ? `${caught.message}. Nothing is reported as changed for ${member.email}; correct the problem and confirm again.`
        : `Sutra could not complete the recovery action for ${member.email}. Nothing is reported as changed.`);
    } finally {
      setBusy(false);
    }
  }

  async function removeOwner(member: RecoveryMember): Promise<void> {
    setBusy(true);
    setAlertSurface("ownership");
    setError(null);
    setNotice(null);
    try {
      await stepUpIfProvided();
      if (totpCode.length === 6) setTotpCode("");
      const key = `transfer_owner:${member.membershipId}`;
      const response = await fetch("/api/v1/access/recovery", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "transfer_owner",
          operationId: stickyOperationId(key),
          target: member.membershipId,
        }),
      });
      await readAuthResponse<{ readonly ok: true }>(response);
      recoveryOperations.current.delete(key);
      setNotice(`${member.email} is no longer an Organization owner and now holds Organization admin. Your own ownership is unchanged.`);
      reset();
      setMembers((await load()).members);
    } catch (caught) {
      setError(caught instanceof Error
        ? `${caught.message}. ${member.email} is not reported as changed and remains an Organization owner.`
        : `Sutra could not remove ownership from ${member.email}. They are not reported as changed.`);
    } finally {
      setBusy(false);
    }
  }

  function rowActionAvailability(operation: RowOperation, member: RecoveryMember): string | null {
    if (member.status !== "active") return "This membership is suspended. Recovery only applies to an active membership.";
    if (operation === "unlock") {
      return canUnlock ? null : "Clearing a lockout requires an organization owner or organization admin.";
    }
    if (!isOwner) return "Only an organization owner can run this recovery operation.";
    if (operation === "reset_member_mfa" && member.userId === selfUserId) {
      return "An owner cannot run recovery against their own account. Use the host-local platform recovery path instead.";
    }
    if (operation === "provision_owner" && member.role === "org_owner") {
      return "This membership is already an organization owner.";
    }
    return null;
  }

  if (!canUnlock && !isOwner) return null;

  const rowOperations: readonly RowOperation[] = ["unlock", "reset_member_mfa", "provision_owner"];
  const alerts = (
    <>
      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Recovery action failed</strong><span>{error}</span></div> : null}
      {notice ? <div className="page-alert" role="status"><strong>Recovery completed</strong><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Dismiss</button></div> : null}
    </>
  );

  return (
    <>
      <section className="panel access-table-panel" aria-labelledby="account-recovery-title">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Lockout &amp; credential recovery</p>
            <h2 id="account-recovery-title">Account recovery</h2>
            <p className="page-subtitle">The escape hatch for a locked-out or MFA-lost member of this organization. Every action names its exact target, requires a second confirmation, and is committed with hash-chained audit evidence.</p>
          </div>
          <span className="status-pill status-positive">{isOwner ? "Owner recovery" : "Lockout only"}</span>
        </div>

        {alertSurface === "members" ? alerts : null}

        <p className="limitation-note">Recovery applies only to accounts with a local Sutra password. An enterprise SSO member is recovered in your identity provider. Sutra never displays, emails or logs a password, authenticator secret or recovery code — an MFA reset only reports that the member must re-enroll.{isOwner ? "" : " Your role can clear a sign-in lockout; MFA reset and ownership changes require an organization owner."}</p>

        <label>
          <span>Authenticator code for these privileged actions</span>
          <input
            autoComplete="one-time-code"
            disabled={busy}
            inputMode="numeric"
            maxLength={6}
            pattern="[0-9]{6}"
            value={totpCode}
            onChange={(event) => setTotpCode(event.target.value.replace(/\D/gu, "").slice(0, 6))}
          />
          <small>Required when your last MFA verification is more than five minutes old.</small>
        </label>

        {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading organization memberships…</div> : (
          <div className="data-table access-data-table access-invitation-table" role="table" aria-label="Organization members available for recovery">
            <div className="data-row data-header access-invitation-row" role="row"><span role="columnheader">Member</span><span role="columnheader">Role / scope</span><span role="columnheader">Status</span><span role="columnheader">Account id</span><span role="columnheader">Membership id</span><span role="columnheader">Recovery actions</span></div>
            {members.map((member) => {
              const active = pending?.membershipId === member.membershipId ? pending.operation : null;
              // Each control is rendered only with its truthful availability: a
              // blocked operation stays visible but disabled, and its reason is
              // referenced by the button so it is never a silent dead end.
              const availability = rowOperations.map((operation) => ({
                operation,
                unavailable: rowActionAvailability(operation, member),
                reasonId: `recovery-${operation}-${member.membershipId}-reason`,
              }));
              return (
                <div className="data-row access-invitation-row" role="row" key={member.membershipId}>
                  <span className="primary-cell access-data-cell access-record-identity" data-label="Member" role="cell"><strong>{member.displayName}{member.userId === selfUserId ? " · You" : ""}</strong><small>{member.email}</small></span>
                  <span className="primary-cell access-data-cell" data-label="Role / scope" role="cell"><strong>{roleLabel(member.role)}</strong><small>{member.scopeMode.replaceAll("_", " ")}</small></span>
                  <span className="access-data-cell" data-label="Status" role="cell"><span className={`connection-status connection-${member.status === "active" ? "active" : "disabled"}`}>{member.status}</span></span>
                  <span className="access-data-cell" data-label="Account id" role="cell">{member.userId}</span>
                  <span className="access-data-cell" data-label="Membership id" role="cell">{member.membershipId}</span>
                  <span className="access-data-cell access-row-actions" data-label="Recovery actions" role="cell">
                    {availability.map(({ operation, unavailable, reasonId }) => (
                      <button
                        aria-describedby={unavailable === null ? undefined : reasonId}
                        aria-label={`${operationTitle(operation)} for ${member.email}`}
                        className={operation === "provision_owner" ? "button button-secondary button-small" : "button button-ghost button-small"}
                        disabled={busy || unavailable !== null || active === operation}
                        key={operation}
                        onClick={() => { setPending({ operation, membershipId: member.membershipId }); setNotice(null); }}
                        type="button"
                      >
                        {operationVerb(operation)}
                      </button>
                    ))}
                    {availability.map(({ operation, unavailable, reasonId }) => unavailable === null
                      ? null
                      : <small hidden id={reasonId} key={`${operation}-reason`}>{unavailable}</small>)}
                  </span>
                </div>
              );
            })}
            {members.length === 0 ? <div className="empty-row">No organization memberships were found.</div> : null}
          </div>
        )}

        {pending !== null && pendingMember !== null ? (
          <div className="inline-warning" role="alert">
            <strong>Confirm: {operationTitle(pending.operation)} for {pendingMember.email}</strong>
            <span>{operationEffect(pending.operation, pendingMember)}</span>
            <span>Target membership {pendingMember.membershipId} · account {pendingMember.userId}. This action is recorded and cannot be undone from this screen.</span>
            <div className="heading-actions">
              <button
                aria-label={`Confirm ${operationTitle(pending.operation).toLocaleLowerCase("en-US")} for ${pendingMember.email}`}
                className="button button-danger button-small"
                disabled={busy}
                onClick={() => void runRowAction(pending.operation, pendingMember)}
                type="button"
              >
                {busy ? "Working…" : `Confirm — ${operationVerb(pending.operation).toLocaleLowerCase("en-US")} for ${pendingMember.email}`}
              </button>
              <button className="button button-secondary button-small" disabled={busy} onClick={() => setPending(null)} type="button">Cancel</button>
            </div>
          </div>
        ) : null}
      </section>

      {isOwner ? (
        <section className="panel" aria-labelledby="owner-removal-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Danger zone · ownership</p>
              <h2 id="owner-removal-title">Remove organization ownership</h2>
              <p className="page-subtitle">The second half of an ownership handover. Grant ownership to the incoming owner above first, then remove it from the outgoing owner here.</p>
            </div>
            <span className="status-pill status-high">Irreversible here</span>
          </div>

          {alertSurface === "ownership" ? alerts : null}

          <p className="limitation-note">Exactly what changes: the selected owner is demoted to <strong>Organization admin</strong> and loses every owner-only power, including account recovery. Your own membership is <strong>not</strong> changed — Sutra refuses an owner&apos;s attempt to demote themselves, and refuses to remove the last active owner, so the organization can never be left unadministered. Type the outgoing owner&apos;s email to enable the confirmation.</p>

          {removableOwners.length === 0 ? (
            <p className="panel-footnote">This organization has no other active owner to remove. Grant ownership to a member above before an ownership handover.</p>
          ) : (
            <>
              <label>
                <span>Outgoing organization owner</span>
                <select
                  disabled={busy}
                  value={transferTargetId}
                  onChange={(event) => { setTransferTargetId(event.target.value); setTransferConfirmation(""); setNotice(null); }}
                >
                  <option value="">Select the owner to demote…</option>
                  {removableOwners.map((member) => <option key={member.membershipId} value={member.membershipId}>{member.displayName} · {member.email}</option>)}
                </select>
                <small>Only active organization owners other than you can be selected.</small>
              </label>

              {transferTarget !== null ? (
                <div className="inline-warning" role="alert">
                  <strong>Confirm: remove owner rights from {transferTarget.email}</strong>
                  <span>{transferTarget.displayName} ({transferTarget.email}, membership {transferTarget.membershipId}) becomes an Organization admin and can no longer administer recovery, ownership or organization-wide identity. Your ownership is unchanged.</span>
                  <label>
                    <span>Type {transferTarget.email} to confirm</span>
                    <input
                      aria-label={`Type the email address ${transferTarget.email} to confirm removing their organization ownership`}
                      autoComplete="off"
                      disabled={busy}
                      maxLength={254}
                      value={transferConfirmation}
                      onChange={(event) => setTransferConfirmation(event.target.value)}
                    />
                  </label>
                  <div className="heading-actions">
                    <button
                      aria-label={`Remove organization ownership from ${transferTarget.email}`}
                      className="button button-danger button-small"
                      disabled={busy || !transferConfirmed}
                      onClick={() => void removeOwner(transferTarget)}
                      type="button"
                    >
                      {busy ? "Removing ownership…" : `Remove ownership from ${transferTarget.email}`}
                    </button>
                    <button className="button button-secondary button-small" disabled={busy} onClick={() => { setTransferTargetId(""); setTransferConfirmation(""); }} type="button">Cancel</button>
                  </div>
                  <small role="status">{transferConfirmed ? "The typed email matches. The confirmation is enabled." : "The confirmation stays disabled until the typed email matches exactly."}</small>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}
    </>
  );
}
