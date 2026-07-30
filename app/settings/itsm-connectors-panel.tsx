"use client";

import { useCallback, useEffect, useState } from "react";

interface ConnectorSummary {
  readonly id: string;
  readonly name: string;
  readonly connectorType: "jira" | "servicenow";
  readonly baseUrl: string;
  readonly projectKey: string | null;
  readonly secretPreview: string;
  readonly enabled: boolean;
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

export function ItsmConnectorsPanel({ connectionId }: { readonly connectionId: string | null }) {
  const [connectors, setConnectors] = useState<ConnectorSummary[]>([]);
  const [name, setName] = useState("");
  const [connectorType, setConnectorType] = useState<"jira" | "servicenow">("jira");
  const [baseUrl, setBaseUrl] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [sharedSecret, setSharedSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (connectionId === null) {
      setConnectors([]);
      return;
    }
    try {
      const payload = await requestJson<{ connectors: ConnectorSummary[] }>(
        `/api/v1/itsm/connectors?connectionId=${encodeURIComponent(connectionId)}`,
      );
      setConnectors(payload.connectors);
    } catch {
      setConnectors([]);
    }
  }, [connectionId]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function save(): Promise<void> {
    if (connectionId === null) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await requestJson<{ connectors: ConnectorSummary[] }>(
        `/api/v1/itsm/connectors?connectionId=${encodeURIComponent(connectionId)}`,
        {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(), connectorType, baseUrl: baseUrl.trim(),
          projectKey: projectKey.trim() || null, sharedSecret,
        }),
        },
      );
      setConnectors(payload.connectors);
      setName("");
      setBaseUrl("");
      setProjectKey("");
      setSharedSecret("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Connector rejected");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    if (connectionId === null) return;
    try {
      const payload = await requestJson<{ connectors: ConnectorSummary[] }>(
        `/api/v1/itsm/connectors?connectionId=${encodeURIComponent(connectionId)}&id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      setConnectors(payload.connectors);
    } catch {
      await load();
    }
  }

  return (
    <section className="panel" aria-label="ITSM connectors">
      <div className="panel-heading"><div><h2>Jira and ServiceNow connectors</h2><p>Signed, bidirectional case synchronization. Unknown remote states remain unmapped and visible.</p></div></div>
      <div className="cmdbq-row">
        <input aria-label="Connector name" placeholder="connector name" value={name} onChange={(event) => setName(event.target.value)} />
        <select aria-label="Connector type" value={connectorType} onChange={(event) => setConnectorType(event.target.value as "jira" | "servicenow")}>
          <option value="jira">Jira</option>
          <option value="servicenow">ServiceNow</option>
        </select>
        <input aria-label="ITSM endpoint URL" placeholder="https://itsm.example/api/tickets" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
      </div>
      <div className="cmdbq-row">
        <input aria-label="Project key" placeholder="project key (Jira only)" value={projectKey} onChange={(event) => setProjectKey(event.target.value)} />
        <input aria-label="Shared HMAC secret" type="password" autoComplete="new-password" placeholder="shared HMAC secret (16+ characters)" value={sharedSecret} onChange={(event) => setSharedSecret(event.target.value)} />
        <button type="button" className="button button-primary" disabled={connectionId === null || busy || !name.trim() || !baseUrl.trim() || sharedSecret.length < 16} onClick={() => void save()}>
          {busy ? "Saving…" : "Save connector"}
        </button>
      </div>
      <p className="panel-footnote">Private-beta secrets are stored locally. Hosted production requires migration to the managed secret service.</p>
      {error ? <p className="cmdbq-error" role="alert">{error}</p> : null}
      {connectors.length === 0 ? <p className="panel-footnote">No ITSM connectors configured.</p> : (
        <table>
          <thead><tr><th>Name</th><th>Type</th><th>Endpoint</th><th>Secret</th><th>Inbound webhook</th><th>Status</th><th /></tr></thead>
          <tbody>{connectors.map((connector) => (
            <tr key={connector.id}>
              <td>{connector.name}{connector.projectKey ? ` · ${connector.projectKey}` : ""}</td>
              <td>{connector.connectorType === "jira" ? "Jira" : "ServiceNow"}</td>
              <td><code>{connector.baseUrl}</code></td>
              <td><code>{connector.secretPreview}</code></td>
              <td><code>/api/v1/itsm/inbound/{connector.id}</code></td>
              <td>{connector.enabled ? "Enabled" : "Disabled"}</td>
              <td><button type="button" className="button button-secondary" onClick={() => void remove(connector.id)}>Delete</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}
