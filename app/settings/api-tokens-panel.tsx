"use client";

import { useCallback, useEffect, useState } from "react";

/* Service-account token management for the public API. The full secret is
 * shown exactly once, immediately after minting — it is never retrievable
 * again, and revocation is immediate. */

const ALL_SCOPES = ["read:resources", "read:findings", "read:cases", "read:snapshots", "read:compliance", "read:vulnerabilities", "write:cases"];

interface TokenSummary {
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

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

export function ApiTokensPanel({ connectionId }: { readonly connectionId: string | null }) {
  const [tokens, setTokens] = useState<TokenSummary[]>([]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read:resources"]);
  const [minted, setMinted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (connectionId === null) {
      setTokens([]);
      return;
    }
    try {
      const payload = await requestJson<{ tokens: TokenSummary[] }>(
        `/api/v1/api-tokens?connectionId=${encodeURIComponent(connectionId)}`,
      );
      setTokens(payload.tokens);
    } catch {
      setTokens([]);
    }
  }, [connectionId]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function mint() {
    if (connectionId === null) return;
    setBusy(true);
    setError(null);
    setMinted(null);
    try {
      const payload = await requestJson<{ minted: { token: string }; tokens: TokenSummary[] }>(
        `/api/v1/api-tokens?connectionId=${encodeURIComponent(connectionId)}`,
        {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), scopes }),
        },
      );
      setMinted(payload.minted.token);
      setTokens(payload.tokens);
      setName("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Mint rejected");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (connectionId === null) return;
    try {
      const payload = await requestJson<{ tokens: TokenSummary[] }>(
        `/api/v1/api-tokens?connectionId=${encodeURIComponent(connectionId)}&id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      setTokens(payload.tokens);
    } catch {
      await load();
    }
  }

  function toggleScope(scope: string) {
    setScopes((current) => (current.includes(scope) ? current.filter((entry) => entry !== scope) : [...current, scope]));
  }

  return (
    <section className="panel" aria-label="Public API tokens">
      <div className="panel-heading"><div><h2>Public API tokens</h2><p>Service-account tokens for /api/public/v1. The secret is shown once at creation and stored only as a hash — copy it immediately. 120 requests/minute per token.</p></div></div>
      <div className="cmdbq-row">
        <input aria-label="Token name" placeholder="token name (e.g. ci-reader)" value={name} onChange={(event) => setName(event.target.value)} />
        <button type="button" className="button button-primary" disabled={connectionId === null || busy || name.trim().length === 0 || scopes.length === 0} onClick={() => void mint()}>{busy ? "Minting…" : "Create token"}</button>
      </div>
      <div className="cmdbq-row" role="group" aria-label="Scopes">
        {ALL_SCOPES.map((scope) => (
          <label key={scope} className="apitok-scope">
            <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} /> {scope}
          </label>
        ))}
      </div>
      {minted ? <p className="panel-footnote apitok-secret">Copy this token now — it will not be shown again: <code>{minted}</code></p> : null}
      {error ? <p className="cmdbq-error" role="alert">{error}</p> : null}
      {tokens.length > 0 ? (
        <table><thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Last used</th><th>Status</th><th /></tr></thead>
          <tbody>{tokens.map((token) => (
            <tr key={token.id}>
              <td>{token.name}</td>
              <td><code>{token.tokenPrefix}…</code></td>
              <td>{token.scopes.join(", ")}</td>
              <td>{token.lastUsedAt ?? "never"}</td>
              <td>{token.revokedAt ? "revoked" : token.expiresAt ? `expires ${token.expiresAt}` : "active"}</td>
              <td>{token.revokedAt ? null : <button type="button" className="button button-secondary" onClick={() => void revoke(token.id)}>Revoke</button>}</td>
            </tr>
          ))}</tbody></table>
      ) : <p className="panel-footnote">No tokens yet. The API reference lives at <code>/api/public/v1/openapi.json</code>.</p>}
    </section>
  );
}
