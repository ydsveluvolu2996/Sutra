"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { postAuth, readAuthResponse } from "../components/use-session";

type CustomerRole = "customer_admin" | "analyst" | "viewer" | "customer_viewer";
type ScopeMode = "all_customers" | "assigned_customers";

interface AssignmentGrant {
  readonly customerId: string;
  readonly role: CustomerRole;
}

interface AssignmentMember {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: string;
  readonly scopeMode: ScopeMode;
  readonly status: "active" | "suspended";
  readonly grants: readonly AssignmentGrant[];
  readonly editable: boolean;
}

interface AssignableCustomer {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

interface AssignmentDirectory {
  readonly members: readonly AssignmentMember[];
  readonly customers: readonly AssignableCustomer[];
}

const roleOptions: readonly { readonly value: CustomerRole; readonly label: string }[] = [
  { value: "customer_admin", label: "Customer admin" },
  { value: "analyst", label: "Analyst" },
  { value: "viewer", label: "Viewer" },
  { value: "customer_viewer", label: "Customer viewer" },
];

function roleLabel(role: string): string {
  return role.replaceAll("_", " ").replace(/\b\w/gu, (value) => value.toLocaleUpperCase("en-US"));
}

export function CustomerAssignments() {
  const [directory, setDirectory] = useState<AssignmentDirectory | null>(null);
  const [membershipId, setMembershipId] = useState("");
  const [scopeMode, setScopeMode] = useState<ScopeMode>("assigned_customers");
  const [grantRoles, setGrantRoles] = useState<Readonly<Record<string, CustomerRole>>>({});
  const [totpCode, setTotpCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<AssignmentDirectory> => {
    const response = await fetch("/api/v1/customer-assignments", {
      cache: "no-store",
      credentials: "same-origin",
    });
    return readAuthResponse<AssignmentDirectory>(response);
  }, []);

  function selectMember(member: AssignmentMember): void {
    setMembershipId(member.membershipId);
    setScopeMode(member.scopeMode);
    setGrantRoles(Object.fromEntries(member.grants.map((grant) => [grant.customerId, grant.role])));
    setNotice(null);
  }

  useEffect(() => {
    let active = true;
    void load()
      .then((loaded) => {
        if (!active) return;
        setDirectory(loaded);
        const initial = loaded.members.find((member) => member.editable);
        if (initial !== undefined) selectMember(initial);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Sutra could not load customer assignments");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [load]);

  const selectedMember = useMemo(
    () => directory?.members.find((member) => member.membershipId === membershipId) ?? null,
    [directory, membershipId],
  );

  function toggleCustomer(customerId: string, enabled: boolean): void {
    setGrantRoles((current) => {
      const next = { ...current };
      if (enabled) next[customerId] = next[customerId] ?? "viewer";
      else delete next[customerId];
      return next;
    });
  }

  function changeGrantRole(customerId: string, role: CustomerRole): void {
    setGrantRoles((current) => ({ ...current, [customerId]: role }));
  }

  async function save(): Promise<void> {
    if (selectedMember === null || totpCode.length !== 6) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await postAuth("/api/auth/mfa/step-up", { code: totpCode });
      const grants = scopeMode === "assigned_customers"
        ? Object.entries(grantRoles).map(([customerId, role]) => ({ customerId, role }))
        : [];
      const response = await fetch("/api/v1/customer-assignments", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ membershipId: selectedMember.membershipId, scopeMode, grants }),
      });
      const result = await readAuthResponse<{ readonly member: AssignmentMember }>(response);
      const refreshed = await load();
      setDirectory(refreshed);
      const updated = refreshed.members.find((member) => member.membershipId === result.member.membershipId);
      if (updated !== undefined) selectMember(updated);
      setTotpCode("");
      setNotice(`Customer access updated for ${result.member.displayName}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not update customer assignments");
    } finally {
      setSaving(false);
    }
  }

  const editableMembers = directory?.members.filter((member) => member.editable) ?? [];

  return (
    <section className="panel assignment-admin" aria-labelledby="customer-assignment-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Tenant access administration</p>
          <h2 id="customer-assignment-title">Customer assignments</h2>
          <p className="page-subtitle">Grant an active membership access to every customer or to an explicit, role-bound customer list.</p>
        </div>
        <span className="status-pill status-positive">Org scoped · audited</span>
      </div>

      {error ? <div className="page-alert page-alert-error" role="alert"><strong>Assignment action failed</strong><span>{error}</span></div> : null}
      {notice ? <div className="page-alert" role="status"><strong>Assignment saved</strong><span>{notice}</span></div> : null}
      {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading organization memberships and customers…</div> : null}

      {!loading && directory !== null ? (
        <div className="assignment-layout">
          <div className="assignment-member-list" aria-label="Organization memberships">
            {directory.members.map((member) => (
              <article className={`assignment-member${member.membershipId === membershipId ? " selected" : ""}`} key={member.membershipId}>
                <div><strong>{member.displayName}</strong><small>{member.email}</small></div>
                <span>{roleLabel(member.role)}</span>
                <span>{member.scopeMode === "all_customers" ? "All customers" : `${member.grants.length} assigned`}</span>
                {member.editable ? (
                  <button className="button button-secondary button-small" onClick={() => selectMember(member)} type="button">
                    {member.membershipId === membershipId ? "Editing" : "Edit scope"}
                  </button>
                ) : <small className="assignment-locked">{member.status === "suspended" ? "Suspended" : "Protected"}</small>}
              </article>
            ))}
          </div>

          <form className="assignment-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            {selectedMember !== null ? (
              <>
                <div className="assignment-editor-heading">
                  <div><span>Editing membership</span><strong>{selectedMember.displayName}</strong><small>{selectedMember.email}</small></div>
                  <span className="status-pill">{roleLabel(selectedMember.role)}</span>
                </div>
                <fieldset>
                  <legend>Customer visibility</legend>
                  <label className="assignment-choice">
                    <input checked={scopeMode === "all_customers"} name="scopeMode" onChange={() => setScopeMode("all_customers")} type="radio" />
                    <span><strong>All customers</strong><small>Automatically includes current and newly onboarded customers.</small></span>
                  </label>
                  <label className="assignment-choice">
                    <input checked={scopeMode === "assigned_customers"} name="scopeMode" onChange={() => setScopeMode("assigned_customers")} type="radio" />
                    <span><strong>Assigned customers only</strong><small>Every permitted customer is stored as an explicit tenant grant.</small></span>
                  </label>
                </fieldset>

                {scopeMode === "assigned_customers" ? (
                  <fieldset>
                    <legend>Explicit customer grants</legend>
                    <div className="assignment-customer-list">
                      {directory.customers.map((customer) => {
                        const enabled = grantRoles[customer.id] !== undefined;
                        return (
                          <div className="assignment-customer" key={customer.id}>
                            <label>
                              <input checked={enabled} onChange={(event) => toggleCustomer(customer.id, event.target.checked)} type="checkbox" />
                              <span><strong>{customer.name}</strong><small>{customer.slug}</small></span>
                            </label>
                            <select
                              aria-label={`${customer.name} customer role`}
                              disabled={!enabled}
                              value={grantRoles[customer.id] ?? "viewer"}
                              onChange={(event) => changeGrantRole(customer.id, event.target.value as CustomerRole)}
                            >
                              {roleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                            </select>
                          </div>
                        );
                      })}
                      {directory.customers.length === 0 ? <p className="panel-footnote">Onboard a customer before creating an explicit assignment.</p> : null}
                    </div>
                  </fieldset>
                ) : null}

                <label className="assignment-mfa">
                  <span>Fresh authenticator code</span>
                  <input
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={6}
                    pattern="[0-9]{6}"
                    required
                    value={totpCode}
                    onChange={(event) => setTotpCode(event.target.value.replace(/\D/gu, "").slice(0, 6))}
                  />
                  <small>Every scope change requires a new MFA step-up and creates tamper-evident audit evidence.</small>
                </label>
                <button className="button button-primary" disabled={saving || totpCode.length !== 6} type="submit">
                  {saving ? "Saving customer access…" : "Verify MFA & save access"}
                </button>
              </>
            ) : (
              <div className="empty-workspace compact-empty">
                <h2>No editable membership</h2>
                <p>{editableMembers.length === 0 ? "Invite another organization member before assigning customer access." : "Select a membership to edit."}</p>
              </div>
            )}
          </form>
        </div>
      ) : null}
    </section>
  );
}
