import { CmdbCustomAssetRepository } from "../../../../../db/cmdb-custom-asset-repository";
import { normalizeCustomAsset, parseAssetImport, isValidAssetType } from "../../../../../lib/cmdb-custom-assets";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { requireConnectionScope } from "../../../../../lib/api-connection-scope";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

// An import body carries a pasted CSV/JSON blob, so the ceiling is larger than a
// single-field write but still firmly bounded — a real paste is not megabytes.
const MAX_BODY_BYTES = 256 * 1024;
const ASSET_ID = /^cas_[a-f0-9]{32}$/u;

function invalid(): never {
  throw Object.assign(new Error("The custom-asset request is invalid"), { code: "INVALID_INPUT" });
}

/**
 * Resolve the tenant scope from the explicitly selected connection.
 */
async function resolveScope(request: Request, capability: "connection:read" | "connection:manage") {
  return requireConnectionScope(request, capability);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const assetType = url.searchParams.get("assetType");
    if (assetType !== null && !isValidAssetType(assetType)) invalid();
    const { scope } = await resolveScope(request, "connection:read");
    const repository = new CmdbCustomAssetRepository();
    const assets = await repository.list(scope, assetType === null ? {} : { assetType });
    return jsonResponse({ assets });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readBoundedJson(request, MAX_BODY_BYTES);
    if (typeof body !== "object" || body === null || Array.isArray(body)) invalid();
    const record = body as Record<string, unknown>;

    // Bulk import: { format, data, assetType }. Rejected rows are DISCLOSED in
    // the 200 response — never silently dropped — alongside the imported count.
    if ("format" in record || "data" in record) {
      const { format, data, assetType } = record;
      if ((format !== "csv" && format !== "json") || typeof data !== "string" || typeof assetType !== "string") invalid();
      const parsed = parseAssetImport({ format, data, assetType });
      const { authenticated, scope } = await resolveScope(request, "connection:manage");
      const repository = new CmdbCustomAssetRepository();
      const imported = parsed.assets.length === 0
        ? 0
        : await repository.bulkUpsert(scope, parsed.assets, authenticated.subject.userId);
      return jsonResponse({ imported, rejected: parsed.rejected, assets: await repository.list(scope, {}) });
    }

    // Single manual create: { asset: { assetType, name, externalId?, fields? } }.
    const rawAsset = record.asset;
    if (typeof rawAsset !== "object" || rawAsset === null || Array.isArray(rawAsset)) invalid();
    const assetRecord = rawAsset as Record<string, unknown>;
    if (typeof assetRecord.assetType !== "string") invalid();
    const outcome = normalizeCustomAsset(
      {
        assetType: assetRecord.assetType,
        name: assetRecord.name,
        externalId: assetRecord.externalId,
        fields: assetRecord.fields,
      },
      "manual",
    );
    if (!outcome.ok) {
      throw Object.assign(new Error(`The custom asset is invalid: ${outcome.reason}`), { code: "INVALID_INPUT" });
    }
    const { authenticated, scope } = await resolveScope(request, "connection:manage");
    const repository = new CmdbCustomAssetRepository();
    const saved = await repository.upsert(scope, outcome.asset, authenticated.subject.userId);
    return jsonResponse({ imported: 1, rejected: [], saved, assets: await repository.list(scope, {}) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    if (!ASSET_ID.test(id)) invalid();
    const { scope } = await resolveScope(request, "connection:manage");
    const repository = new CmdbCustomAssetRepository();
    const deleted = await repository.delete(scope, id);
    return jsonResponse({ deleted, assets: await repository.list(scope, {}) });
  } catch (error) {
    return errorResponse(error);
  }
}
