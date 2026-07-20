"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BUILTIN_ASSET_TYPES } from "../../lib/cmdb-custom-assets";

/* Custom / external asset management: bring SaaS apps, network devices, and
 * on-prem/non-cloud items into the CMDB as first-class assets via CSV/JSON
 * import or a manual create. Everything is user-supplied — nothing here is
 * discovered from AWS. The UI is evidence-honest: every asset shows its source
 * ("imported"/"manual"), rejected import rows are listed with their reason and
 * never hidden, and empty states say plainly that nothing is present. */

interface CustomAsset {
  readonly id: string;
  readonly assetType: string;
  readonly name: string;
  readonly source: "imported" | "manual";
  readonly externalId: string | null;
  readonly fields: Readonly<Record<string, string>>;
}

interface RejectedRow {
  readonly row: number;
  readonly reason: string;
}

interface WriteResponse {
  readonly imported: number;
  readonly rejected: readonly RejectedRow[];
  readonly assets: CustomAsset[];
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { cache: "no-store", ...init });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload
      ? String((payload as { error: { message?: string } }).error?.message ?? "Request rejected")
      : "Request rejected";
    throw new Error(message);
  }
  return payload as T;
}

function fieldsSummary(fields: Readonly<Record<string, string>>): string {
  const entries = Object.entries(fields);
  if (entries.length === 0) return "—";
  return entries.slice(0, 6).map(([key, value]) => `${key}=${value}`).join(" · ") + (entries.length > 6 ? " · …" : "");
}

export function CustomAssetsPanel() {
  const [assetType, setAssetType] = useState<string>(BUILTIN_ASSET_TYPES[0]);
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<{ imported: number; rejected: readonly RejectedRow[] } | null>(null);

  const [draft, setDraft] = useState({ name: "", externalId: "", fieldKey: "", fieldValue: "" });
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [assets, setAssets] = useState<CustomAsset[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const loadAssets = useCallback(async () => {
    try {
      const payload = await requestJson<{ assets: CustomAsset[] }>("/api/v1/cmdb/custom-assets");
      setAssets(payload.assets);
      setLoadError(null);
    } catch (caught) {
      setAssets([]);
      setLoadError(caught instanceof Error ? caught.message : "Custom assets unavailable");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadAssets();
    })();
  }, [loadAssets]);

  const typesPresent = useMemo(() => {
    return [...new Set(assets.map((asset) => asset.assetType))].sort();
  }, [assets]);

  const visibleAssets = useMemo(() => {
    return typeFilter === "all" ? assets : assets.filter((asset) => asset.assetType === typeFilter);
  }, [assets, typeFilter]);

  async function runImport() {
    if (importText.trim().length === 0) return;
    setImporting(true);
    setImportError(null);
    setLastImport(null);
    try {
      const payload = await requestJson<WriteResponse>("/api/v1/cmdb/custom-assets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format, data: importText, assetType }),
      });
      setLastImport({ imported: payload.imported, rejected: payload.rejected });
      setAssets(payload.assets);
      if (payload.imported > 0) setImportText("");
    } catch (caught) {
      setImportError(caught instanceof Error ? caught.message : "Import rejected");
    } finally {
      setImporting(false);
    }
  }

  async function addAsset() {
    if (draft.name.trim().length === 0) return;
    setAdding(true);
    setAddError(null);
    try {
      const fields: Record<string, string> = {};
      if (draft.fieldKey.trim().length > 0) fields[draft.fieldKey.trim()] = draft.fieldValue;
      const payload = await requestJson<WriteResponse>("/api/v1/cmdb/custom-assets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          asset: {
            assetType,
            name: draft.name.trim(),
            externalId: draft.externalId.trim() || undefined,
            fields,
          },
        }),
      });
      setAssets(payload.assets);
      setDraft({ name: "", externalId: "", fieldKey: "", fieldValue: "" });
    } catch (caught) {
      setAddError(caught instanceof Error ? caught.message : "Asset rejected");
    } finally {
      setAdding(false);
    }
  }

  async function deleteAsset(id: string) {
    try {
      const payload = await requestJson<{ assets: CustomAsset[] }>(
        `/api/v1/cmdb/custom-assets?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      setAssets(payload.assets);
    } catch {
      await loadAssets();
    }
  }

  const importPlaceholder = format === "csv"
    ? "name,external_id,vendor,environment\nOkta,okta-01,Okta,production\nDatadog,dd-77,Datadog,production"
    : '[\n  { "name": "Okta", "external_id": "okta-01", "vendor": "Okta", "environment": "production" }\n]';

  return (
    <>
      <section className="panel" aria-label="Import custom assets">
        <div className="panel-heading">
          <div>
            <h2>Custom &amp; external assets</h2>
            <p>Bring SaaS apps, network devices, and on-prem/non-cloud items into the CMDB as first-class assets. These are user-supplied — imported or entered by hand, never discovered from AWS, which stays read-only. Every asset is labeled by its source.</p>
          </div>
        </div>
        <div className="cmdbq-actions">
          <label>
            Asset type{" "}
            <input
              aria-label="Asset type"
              list="custom-asset-types"
              value={assetType}
              onChange={(event) => setAssetType(event.target.value.trim())}
              placeholder="e.g. saas-app"
            />
          </label>
          <datalist id="custom-asset-types">
            {BUILTIN_ASSET_TYPES.map((type) => <option key={type} value={type} />)}
          </datalist>
          <select aria-label="Import format" value={format} onChange={(event) => setFormat(event.target.value as "csv" | "json")}>
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
        </div>
        <textarea
          aria-label="Import data"
          className="cmdbq-import"
          rows={8}
          placeholder={importPlaceholder}
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
        />
        <div className="cmdbq-actions">
          <button type="button" className="button button-primary" disabled={importing || importText.trim().length === 0} onClick={() => void runImport()}>
            {importing ? "Importing…" : "Import assets"}
          </button>
          <span className="panel-footnote">A <code>name</code> column/key is required. <code>external_id</code> is optional; every other column becomes a field.</span>
        </div>
        {importError ? <p className="cmdbq-error" role="alert">{importError}</p> : null}
        {lastImport ? (
          <div className="cmdbq-results">
            <p className="cmdbq-summary">
              Imported {lastImport.imported} asset{lastImport.imported === 1 ? "" : "s"}
              {lastImport.rejected.length > 0 ? ` — ${lastImport.rejected.length} row${lastImport.rejected.length === 1 ? "" : "s"} rejected` : " — no rejected rows"}
            </p>
            {lastImport.rejected.length > 0 ? (
              <table>
                <thead><tr><th>Row</th><th>Reason it was rejected</th></tr></thead>
                <tbody>
                  {lastImport.rejected.map((rejected, index) => (
                    <tr key={`${rejected.row}-${index}`}>
                      <td>{rejected.row === 0 ? "import" : rejected.row}</td>
                      <td>{rejected.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="panel" aria-label="Add a single custom asset">
        <div className="panel-heading">
          <div>
            <h2>Add a single asset</h2>
            <p>Register one asset by hand. It is labeled <code>manual</code> and uses the asset type selected above.</p>
          </div>
        </div>
        <div className="cmdbq-row cmdbq-annotation">
          <input aria-label="Asset name" placeholder="name (required)" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
          <input aria-label="External id" placeholder="external id (optional)" value={draft.externalId} onChange={(event) => setDraft((current) => ({ ...current, externalId: event.target.value }))} />
          <input aria-label="Field key" placeholder="field (e.g. vendor)" value={draft.fieldKey} onChange={(event) => setDraft((current) => ({ ...current, fieldKey: event.target.value }))} />
          <input aria-label="Field value" placeholder="value" value={draft.fieldValue} onChange={(event) => setDraft((current) => ({ ...current, fieldValue: event.target.value }))} />
          <button type="button" className="button button-primary" disabled={adding || draft.name.trim().length === 0} onClick={() => void addAsset()}>
            {adding ? "Adding…" : "Add asset"}
          </button>
        </div>
        {addError ? <p className="cmdbq-error" role="alert">{addError}</p> : null}
      </section>

      <section className="panel" aria-label="Custom asset inventory">
        <div className="panel-heading">
          <div>
            <h2>Custom asset inventory</h2>
            <p>Every custom asset the tenant owns, with its source and key fields.</p>
          </div>
          {typesPresent.length > 0 ? (
            <select aria-label="Filter by asset type" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
              <option value="all">All types</option>
              {typesPresent.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          ) : null}
        </div>
        {loadError ? <p className="cmdbq-error" role="alert">{loadError}</p> : null}
        {!loaded ? (
          <p className="panel-footnote">Loading custom assets…</p>
        ) : visibleAssets.length === 0 ? (
          <p className="panel-footnote">{assets.length === 0 ? "No custom assets yet — import a CSV/JSON file or add one by hand above." : "No custom assets match this type filter."}</p>
        ) : (
          <table>
            <thead><tr><th>Type</th><th>Name</th><th>Source</th><th>External ID</th><th>Fields</th><th /></tr></thead>
            <tbody>
              {visibleAssets.map((asset) => (
                <tr key={asset.id}>
                  <td>{asset.assetType}</td>
                  <td>{asset.name}</td>
                  <td><span className={`cmdbq-chip cmdbq-source-${asset.source}`}>{asset.source}</span></td>
                  <td>{asset.externalId ?? "—"}</td>
                  <td>{fieldsSummary(asset.fields)}</td>
                  <td><button type="button" className="button button-secondary" onClick={() => void deleteAsset(asset.id)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
