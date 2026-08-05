"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { postAuth, readAuthResponse } from "../components/use-session";

interface IdentityProvider {
  readonly kind: "oidc" | "saml";
  readonly id: string;
  readonly label: string;
}

interface ScimConnectorSummary {
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly identityIssuer: string;
  readonly subjectSource: "userName" | "externalId";
  readonly roleMappings: Readonly<Record<string, "viewer" | "analyst">>;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly rotatedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

interface ConnectorList {
  readonly connectors: readonly ScimConnectorSummary[];
  readonly identityProviders: readonly IdentityProvider[];
}

interface MintResult {
  readonly minted: ScimConnectorSummary & { readonly token: string };
  readonly connectors: readonly ScimConnectorSummary[];
}

interface OneTimeToken {
  readonly connectorName: string;
  readonly operation: "created" | "rotated";
  readonly token: string;
}

function providerKey(provider: IdentityProvider): string {
  return `${provider.kind}:${provider.id}`;
}

function connectorStatus(connector: ScimConnectorSummary): string {
  if (connector.revokedAt !== null) return "Revoked";
  if (connector.expiresAt !== null && Date.parse(connector.expiresAt) <= Date.now()) return "Expired";
  return "Active";
}

function timestamp(value: string | null): string {
  return value === null ? "Never" : new Date(value).toLocaleString();
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
  });
  return readAuthResponse<T>(response);
}

export function ScimConnectorsPanel() {
  const [connectors, setConnectors] = useState<readonly ScimConnectorSummary[]>([]);
  const [identityProviders, setIdentityProviders] = useState<readonly IdentityProvider[]>([]);
  const [name, setName] = useState("");
  const [identityProviderKey, setIdentityProviderKey] = useState("");
  const [subjectSource, setSubjectSource] = useState<"userName" | "externalId">("userName");
  const [viewerGroup, setViewerGroup] = useState("");
  const [analystGroup, setAnalystGroup] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [oneTimeToken, setOneTimeToken] = useState<OneTimeToken | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const selectedProvider = useMemo(
    () => identityProviders.find((provider) => providerKey(provider) === identityProviderKey),
    [identityProviderKey, identityProviders],
  );
  const scimBaseUrl = typeof window === "undefined"
    ? "/api/scim/v2"
    : `${window.location.origin}/api/scim/v2`;

  const load = useCallback(async () => {
    const payload = await requestJson<ConnectorList>("/api/v1/scim-connectors");
    setConnectors(payload.connectors);
    setIdentityProviders(payload.identityProviders);
    setIdentityProviderKey((current) => {
      if (payload.identityProviders.some((provider) => providerKey(provider) === current)) return current;
      const only = payload.identityProviders.length === 1 ? payload.identityProviders[0] : undefined;
      return only === undefined ? "" : providerKey(only);
    });
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await load();
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "Sutra could not load SCIM connectors");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [load]);

  async function stepUp(): Promise<void> {
    if (!/^\d{6}$/u.test(totpCode)) {
      throw new Error("Enter the current 6-digit authenticator code");
    }
    await postAuth("/api/auth/mfa/step-up", { code: totpCode });
  }

  function mappings(): Readonly<Record<string, "viewer" | "analyst">> {
    const viewer = viewerGroup.trim();
    const analyst = analystGroup.trim();
    if (viewer && analyst && viewer === analyst) {
      throw new Error("Viewer and analyst mappings must use different identity-provider groups");
    }
    return {
      ...(viewer ? { [viewer]: "viewer" as const } : {}),
      ...(analyst ? { [analyst]: "analyst" as const } : {}),
    };
  }

  async function createConnector(): Promise<void> {
    if (selectedProvider === undefined) {
      setError("Choose the configured sign-in provider SCIM will provision");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setOneTimeToken(null);
    try {
      await stepUp();
      const parsedExpiry = expiresAt ? new Date(expiresAt) : null;
      if (parsedExpiry !== null && Number.isNaN(parsedExpiry.getTime())) {
        throw new Error("Choose a valid future expiry");
      }
      const payload = await requestJson<MintResult>("/api/v1/scim-connectors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          identityProvider: { kind: selectedProvider.kind, id: selectedProvider.id },
          subjectSource,
          roleMappings: mappings(),
          expiresAt: parsedExpiry?.toISOString() ?? null,
        }),
      });
      setConnectors(payload.connectors);
      setOneTimeToken({
        connectorName: payload.minted.name,
        operation: "created",
        token: payload.minted.token,
      });
      setName("");
      setViewerGroup("");
      setAnalystGroup("");
      setExpiresAt("");
      setTotpCode("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The SCIM connector could not be created");
    } finally {
      setBusy(false);
    }
  }

  async function rotateConnector(connector: ScimConnectorSummary): Promise<void> {
    if (!window.confirm(`Rotate the token for ${connector.name}? Its current token will stop working immediately.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setOneTimeToken(null);
    try {
      await stepUp();
      const payload = await requestJson<MintResult>("/api/v1/scim-connectors", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectorId: connector.id, operation: "rotate" }),
      });
      setConnectors(payload.connectors);
      setOneTimeToken({
        connectorName: payload.minted.name,
        operation: "rotated",
        token: payload.minted.token,
      });
      setTotpCode("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The SCIM token could not be rotated");
    } finally {
      setBusy(false);
    }
  }

  async function revokeConnector(connector: ScimConnectorSummary): Promise<void> {
    if (!window.confirm(`Revoke ${connector.name}? Provisioning requests using its token will stop immediately.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setOneTimeToken(null);
    try {
      await stepUp();
      const payload = await requestJson<{ readonly revoked: boolean; readonly connectors: readonly ScimConnectorSummary[] }>(
        "/api/v1/scim-connectors",
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connectorId: connector.id }),
        },
      );
      setConnectors(payload.connectors);
      setTotpCode("");
      setNotice(payload.revoked ? "SCIM connector revoked." : "The SCIM connector was already revoked.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The SCIM connector could not be revoked");
    } finally {
      setBusy(false);
    }
  }

  async function copyOneTimeToken(): Promise<void> {
    if (oneTimeToken === null) return;
    try {
      await navigator.clipboard.writeText(oneTimeToken.token);
      setNotice("SCIM bearer token copied. Store it in the identity provider now.");
    } catch {
      setError("The browser could not copy the token. Select it and copy it manually.");
    }
  }

  return (
    <section className="panel" aria-label="SCIM provisioning connectors">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Enterprise identity</p>
          <h2>SCIM provisioning</h2>
          <p>Create tenant-bound connectors for your identity provider. Tokens are stored only as hashes and shown once.</p>
        </div>
      </div>

      <dl className="settings-list">
        <div><dt>SCIM base URL</dt><dd><code suppressHydrationWarning>{scimBaseUrl}</code></dd></div>
        <div><dt>Authentication</dt><dd>Bearer token</dd></div>
      </dl>

      {identityProviders.length === 0 && !loading ? (
        <p className="page-alert" role="status">Configure and enable an enterprise OIDC or SAML provider before creating a SCIM connector.</p>
      ) : (
        <div className="auth-form">
          <div className="auth-field-pair">
            <label>
              <span>Connector name</span>
              <input maxLength={64} placeholder="Microsoft Entra production" value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              <span>Sign-in provider</span>
              <select required value={identityProviderKey} onChange={(event) => setIdentityProviderKey(event.target.value)}>
                {identityProviders.length > 1 ? <option value="">Choose a provider</option> : null}
                {identityProviders.map((provider) => (
                  <option key={providerKey(provider)} value={providerKey(provider)}>
                    {provider.label} · {provider.kind.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="auth-field-pair">
            <label>
              <span>SCIM subject source</span>
              <select value={subjectSource} onChange={(event) => setSubjectSource(event.target.value as "userName" | "externalId")}>
                <option value="userName">userName</option>
                <option value="externalId">externalId</option>
              </select>
              <small>Use the immutable attribute that matches the provider&apos;s verified sign-in subject.</small>
            </label>
            <label>
              <span>Token expiry (optional)</span>
              <input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
            </label>
          </div>
          <div className="auth-field-pair">
            <label>
              <span>Viewer group (optional)</span>
              <input maxLength={128} placeholder="Cloud Security Viewers" value={viewerGroup} onChange={(event) => setViewerGroup(event.target.value)} />
            </label>
            <label>
              <span>Analyst group (optional)</span>
              <input maxLength={128} placeholder="Cloud Security Analysts" value={analystGroup} onChange={(event) => setAnalystGroup(event.target.value)} />
            </label>
          </div>
          <label>
            <span>Authenticator code</span>
            <input
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={6}
              pattern="[0-9]{6}"
              placeholder="000000"
              value={totpCode}
              onChange={(event) => setTotpCode(event.target.value.replace(/\D/gu, "").slice(0, 6))}
            />
            <small>A fresh MFA verification is required to create, rotate, or revoke a connector.</small>
          </label>
          <button
            className="button button-primary"
            disabled={busy || name.trim().length === 0 || selectedProvider === undefined || totpCode.length !== 6}
            onClick={() => void createConnector()}
            type="button"
          >
            {busy ? "Working…" : "Create SCIM connector"}
          </button>
        </div>
      )}

      {oneTimeToken !== null ? (
        <div className="inline-warning" role="status">
          <strong>{oneTimeToken.connectorName} token {oneTimeToken.operation}</strong>
          <span>Copy this bearer token now. Sutra cannot display it again after this panel is dismissed or the page is left.</span>
          <div className="copy-field">
            <code aria-label="One-time SCIM bearer token">{oneTimeToken.token}</code>
            <button disabled={busy} onClick={() => void copyOneTimeToken()} type="button">Copy token</button>
          </div>
          <button className="button button-secondary button-small" onClick={() => setOneTimeToken(null)} type="button">Dismiss token</button>
        </div>
      ) : null}
      {notice ? <p className="page-alert" role="status">{notice}</p> : null}
      {error ? <p className="page-alert page-alert-error" role="alert">{error}</p> : null}

      {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading SCIM connectors…</div> : null}
      {!loading && connectors.length === 0 ? <p className="panel-footnote">No SCIM connectors are configured.</p> : null}
      {connectors.length > 0 ? (
        <div className="data-table" role="table" aria-label="SCIM connectors">
          <div className="data-row data-header" role="row">
            <span role="columnheader">Connector</span>
            <span role="columnheader">Identity binding</span>
            <span role="columnheader">Usage</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Actions</span>
          </div>
          {connectors.map((connector) => {
            const status = connectorStatus(connector);
            const mappings = Object.entries(connector.roleMappings);
            return (
              <div className="data-row" role="row" key={connector.id}>
                <span className="primary-cell" role="cell"><strong>{connector.name}</strong><small><code>{connector.tokenPrefix}…</code> · created {timestamp(connector.createdAt)}</small></span>
                <span className="primary-cell" role="cell"><strong>{connector.subjectSource}</strong><small>{connector.identityIssuer}</small></span>
                <span className="primary-cell" role="cell"><strong>Last used {timestamp(connector.lastUsedAt)}</strong><small>{mappings.length === 0 ? "No group-role mappings" : mappings.map(([group, role]) => `${group} → ${role}`).join(", ")}</small></span>
                <span role="cell"><span className={`connection-status connection-${status === "Active" ? "active" : "disabled"}`}>{status}</span>{connector.expiresAt ? <small>Expires {timestamp(connector.expiresAt)}</small> : null}</span>
                <span className="access-row-actions" role="cell">
                  {status === "Active" ? (
                    <>
                      <button className="button button-secondary button-small" disabled={busy || totpCode.length !== 6} onClick={() => void rotateConnector(connector)} type="button">Rotate</button>
                      <button className="button button-danger button-small" disabled={busy || totpCode.length !== 6} onClick={() => void revokeConnector(connector)} type="button">Revoke</button>
                    </>
                  ) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
