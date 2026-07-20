// Persistence for CUSTOM / EXTERNAL CMDB assets — the operator-supplied SaaS
// apps, network devices, and on-prem/non-cloud items that broaden coverage past
// what AWS discovery can see. These rows are NEVER written back to AWS and are
// never presented as discovered evidence: each carries a `source` label
// ("imported" from a bulk import, "manual" from a single create) so its origin
// is always visible.
//
// Every row is tenant-scoped (org_id + customer_id) and every write is gated to
// an owned, active customer via an INSERT ... SELECT FROM customers guard — a
// write against a customer the acting org does not own affects zero rows. The
// unique key (org_id, asset_type, name) makes a repeat import an UPSERT (the
// asset is corrected in place, never duplicated). The dual D1/Postgres access
// mirrors the other workspace repositories: one D1Database interface, the
// Postgres adapter translates placeholders and ON CONFLICT.
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import {
  isValidAssetType,
  MAX_FIELDS,
  MAX_FIELD_KEY_LENGTH,
  MAX_FIELD_VALUE_LENGTH,
  type CustomAssetSource,
  type NormalizedCustomAsset,
} from "../lib/cmdb-custom-assets.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const ASSET_ID = /^cas_[a-f0-9]{32}$/u;
const MAX_READ_ROWS = 5_000;

export interface CmdbCustomAssetScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface StoredCustomAsset {
  readonly id: string;
  readonly assetType: string;
  readonly name: string;
  readonly source: CustomAssetSource;
  readonly externalId: string | null;
  readonly fields: Readonly<Record<string, string>>;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface CustomAssetRow {
  id: string;
  asset_type: string;
  name: string;
  source: string;
  external_id: string | null;
  fields_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export class CmdbCustomAssetRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND";

  public constructor(code: CmdbCustomAssetRepositoryError["code"]) {
    super("CMDB custom-asset operation rejected");
    this.name = "CmdbCustomAssetRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new CmdbCustomAssetRepositoryError("INVALID_INPUT");
}

function assertScope(scope: CmdbCustomAssetScope): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId)) invalid();
}

/** Re-validate an asset at the persistence boundary so a caller cannot smuggle
 * an unnormalized asset past the pure layer. */
function assertAsset(asset: NormalizedCustomAsset, createdBy: string): void {
  if (!IDENTIFIER.test(createdBy)) invalid();
  if (!isValidAssetType(asset.assetType)) invalid();
  if (typeof asset.name !== "string" || asset.name.length === 0 || asset.name.length > 200) invalid();
  if (asset.source !== "imported" && asset.source !== "manual") invalid();
  if (asset.externalId !== null && (typeof asset.externalId !== "string" || asset.externalId.length > 128)) invalid();
  if (typeof asset.fields !== "object" || asset.fields === null || Array.isArray(asset.fields)) invalid();
  const entries = Object.entries(asset.fields);
  if (entries.length > MAX_FIELDS) invalid();
  for (const [key, value] of entries) {
    if (typeof value !== "string" || key.length === 0 || key.length > MAX_FIELD_KEY_LENGTH || value.length > MAX_FIELD_VALUE_LENGTH) invalid();
  }
}

function toStored(row: CustomAssetRow): StoredCustomAsset {
  let fields: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(row.fields_json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") fields[key] = value;
    }
  } catch {
    fields = {};
  }
  return {
    id: row.id,
    assetType: row.asset_type,
    name: row.name,
    source: row.source === "imported" ? "imported" : "manual",
    externalId: row.external_id,
    fields,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CmdbCustomAssetRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  private upsertStatement(
    db: D1Database,
    scope: CmdbCustomAssetScope,
    asset: NormalizedCustomAsset,
    createdBy: string,
    timestamp: string,
  ): D1PreparedStatement {
    // The INSERT ... SELECT FROM customers guard writes only when the acting org
    // owns an active/trial customer of that id; otherwise zero rows change and
    // the caller learns the scope was not found.
    return db.prepare(
      `INSERT INTO cmdb_custom_assets
         (id, org_id, customer_id, asset_type, name, source, external_id, fields_json, created_by, created_at, updated_at)
       SELECT ?, c.org_id, c.id, ?, ?, ?, ?, ?, ?, ?, ?
         FROM customers c
        WHERE c.id = ? AND c.org_id = ? AND c.status IN ('active', 'trial')
       ON CONFLICT (org_id, asset_type, name) DO UPDATE SET
         source = excluded.source,
         external_id = excluded.external_id,
         fields_json = excluded.fields_json,
         updated_at = excluded.updated_at`,
    ).bind(
      `cas_${crypto.randomUUID().replaceAll("-", "")}`,
      asset.assetType,
      asset.name,
      asset.source,
      asset.externalId,
      JSON.stringify(asset.fields),
      createdBy,
      timestamp,
      timestamp,
      scope.customerId,
      scope.orgId,
    );
  }

  /**
   * Store (or replace) a single custom asset. Gated to an owned active customer;
   * a repeat of the same (org, asset_type, name) updates in place rather than
   * inserting a duplicate.
   */
  public async upsert(
    scope: CmdbCustomAssetScope,
    asset: NormalizedCustomAsset,
    createdBy: string,
    now = Date.now(),
  ): Promise<StoredCustomAsset> {
    assertScope(scope);
    assertAsset(asset, createdBy);
    const db = await this.ready();
    const timestamp = new Date(now).toISOString();
    const result = await this.upsertStatement(db, scope, asset, createdBy, timestamp).run();
    if (Number(result.meta?.changes ?? 0) === 0) throw new CmdbCustomAssetRepositoryError("SCOPE_NOT_FOUND");
    const stored = await this.get(scope, { assetType: asset.assetType, name: asset.name });
    if (stored === null) throw new CmdbCustomAssetRepositoryError("SCOPE_NOT_FOUND");
    return stored;
  }

  /**
   * Store (or replace) many assets in one batch. Returns the number of rows
   * written. If none of the writes affect a row (the customer is not owned) the
   * operation is rejected as SCOPE_NOT_FOUND rather than silently reporting
   * zero, so a mis-scoped import cannot look like a successful empty import.
   */
  public async bulkUpsert(
    scope: CmdbCustomAssetScope,
    assets: readonly NormalizedCustomAsset[],
    createdBy: string,
    now = Date.now(),
  ): Promise<number> {
    assertScope(scope);
    if (assets.length === 0) return 0;
    for (const asset of assets) assertAsset(asset, createdBy);
    const db = await this.ready();
    const timestamp = new Date(now).toISOString();
    const statements = assets.map((asset) => this.upsertStatement(db, scope, asset, createdBy, timestamp));
    const results = await db.batch(statements);
    const written = results.reduce((total, result) => total + Number(result.meta?.changes ?? 0), 0);
    if (written === 0) throw new CmdbCustomAssetRepositoryError("SCOPE_NOT_FOUND");
    return written;
  }

  /** List the tenant's custom assets, optionally filtered to one asset type. */
  public async list(
    scope: CmdbCustomAssetScope,
    options: { readonly assetType?: string } = {},
  ): Promise<readonly StoredCustomAsset[]> {
    assertScope(scope);
    if (options.assetType !== undefined && !isValidAssetType(options.assetType)) invalid();
    const db = await this.ready();
    const rows = options.assetType === undefined
      ? await db.prepare(
        `SELECT id, asset_type, name, source, external_id, fields_json, created_by, created_at, updated_at
           FROM cmdb_custom_assets
          WHERE org_id = ? AND customer_id = ?
          ORDER BY asset_type ASC, name ASC LIMIT ?`,
      ).bind(scope.orgId, scope.customerId, MAX_READ_ROWS).all<CustomAssetRow>()
      : await db.prepare(
        `SELECT id, asset_type, name, source, external_id, fields_json, created_by, created_at, updated_at
           FROM cmdb_custom_assets
          WHERE org_id = ? AND customer_id = ? AND asset_type = ?
          ORDER BY name ASC LIMIT ?`,
      ).bind(scope.orgId, scope.customerId, options.assetType, MAX_READ_ROWS).all<CustomAssetRow>();
    return (rows.results ?? []).map(toStored);
  }

  /** Fetch one asset by id, or by its (asset_type, name) natural key. */
  public async get(
    scope: CmdbCustomAssetScope,
    selector: { readonly id: string } | { readonly assetType: string; readonly name: string },
  ): Promise<StoredCustomAsset | null> {
    assertScope(scope);
    const db = await this.ready();
    let row: CustomAssetRow | null;
    if ("id" in selector) {
      if (!ASSET_ID.test(selector.id)) invalid();
      row = await db.prepare(
        `SELECT id, asset_type, name, source, external_id, fields_json, created_by, created_at, updated_at
           FROM cmdb_custom_assets
          WHERE id = ? AND org_id = ? AND customer_id = ? LIMIT 1`,
      ).bind(selector.id, scope.orgId, scope.customerId).first<CustomAssetRow>();
    } else {
      if (!isValidAssetType(selector.assetType) || selector.name.length === 0) invalid();
      row = await db.prepare(
        `SELECT id, asset_type, name, source, external_id, fields_json, created_by, created_at, updated_at
           FROM cmdb_custom_assets
          WHERE org_id = ? AND customer_id = ? AND asset_type = ? AND name = ? LIMIT 1`,
      ).bind(scope.orgId, scope.customerId, selector.assetType, selector.name).first<CustomAssetRow>();
    }
    return row === null || row === undefined ? null : toStored(row);
  }

  /** Delete one asset by id. Returns whether a row was removed. */
  public async delete(scope: CmdbCustomAssetScope, id: string): Promise<boolean> {
    assertScope(scope);
    if (!ASSET_ID.test(id)) invalid();
    const db = await this.ready();
    const result = await db.prepare(
      `DELETE FROM cmdb_custom_assets WHERE id = ? AND org_id = ? AND customer_id = ?`,
    ).bind(id, scope.orgId, scope.customerId).run();
    return Number(result.meta?.changes ?? 0) > 0;
  }
}
