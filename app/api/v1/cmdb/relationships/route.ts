import { getPilotStateForOrg } from "../../../../../db/pilot-repository";
import {
  CmdbRelationshipRepository,
  type CmdbRelationshipScope,
} from "../../../../../db/cmdb-relationship-repository";
import {
  buildDependencyGraph,
  deriveRelationships,
  type ManualRelationshipInput,
} from "../../../../../lib/cmdb-relationships";
import type { PilotConnection, PilotResource } from "../../../../../lib/pilot-types";
import { CmdbCustomAssetRepository, type StoredCustomAsset } from "../../../../../db/cmdb-custom-asset-repository";
import { toCmdbResource } from "../../../../../lib/cmdb-custom-assets";
import { assertSameOrigin, readBoundedJson } from "../../../../../lib/aws-pilot-security";
import { requireConnectionScope } from "../../../../../lib/api-connection-scope";
import type { requireApiSession } from "../../../../../lib/api-auth";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

// A manual edge is two resource keys, a short type and an optional note. Nothing
// larger is a real edge assertion.
const MAX_BODY_BYTES = 16 * 1024;
const RESOURCE_KEY = /^[A-Za-z0-9][A-Za-z0-9:._/@=+-]{0,511}$/u;
const RELATIONSHIP_ID = /^rel_[a-f0-9]{32}$/u;
const MODES = new Set(["neighbors", "dependencies", "dependents", "blast-radius"]);
// The picker only lists collected resources; a very large inventory is capped
// so the response stays bounded, and the cap is disclosed honestly.
const MAX_PICKER_NODES = 5_000;

interface ResolvedScope {
  readonly authenticated: Awaited<ReturnType<typeof requireApiSession>>;
  readonly connection: PilotConnection;
  readonly scope: CmdbRelationshipScope;
}

// Imported custom/external assets become first-class graph NODES so they can be
// linked (via manual edges) to collected AWS resources. They derive no edges of
// their own (they carry no AWS config), and are honestly source-labeled.
function customAssetsAsResources(assets: readonly StoredCustomAsset[]): PilotResource[] {
  return assets.map((asset) => {
    const resource = toCmdbResource(asset);
    return {
      resourceKey: resource.resourceKey,
      service: resource.service,
      resourceType: resource.resourceType,
      nativeId: resource.nativeId,
      arn: resource.arn,
      name: resource.name,
      region: resource.region,
      state: resource.state,
      tags: resource.tags,
      configuration: resource.configuration,
      source: { api: "custom-asset", accountId: "custom", collectedAt: asset.updatedAt },
      contentSha256: "",
    };
  });
}

/**
 * Resolve the tenant scope from the explicitly selected connection.
 */
async function resolveScope(
  request: Request,
  capability: "connection:read" | "connection:manage",
): Promise<ResolvedScope> {
  return requireConnectionScope(request, capability);
}

function manualInputs(records: readonly { fromKey: string; toKey: string; relType: string; note: string | null }[]): ManualRelationshipInput[] {
  return records.map((record) => ({
    fromKey: record.fromKey,
    toKey: record.toKey,
    type: record.relType,
    note: record.note,
  }));
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { scope, connection } = await resolveScope(request, "connection:read");
    const url = new URL(request.url);
    const resourceKey = url.searchParams.get("resourceKey");
    const mode = url.searchParams.get("mode") ?? "neighbors";
    if (resourceKey !== null && !RESOURCE_KEY.test(resourceKey)) {
      throw Object.assign(new Error("The relationship request is invalid"), { code: "INVALID_INPUT" });
    }
    if (resourceKey !== null && !MODES.has(mode)) {
      throw Object.assign(new Error("The relationship request is invalid"), { code: "INVALID_INPUT" });
    }
    const depthParam = url.searchParams.get("depth");
    const depth = depthParam === null ? undefined : Number.parseInt(depthParam, 10);
    if (depthParam !== null && (!Number.isFinite(depth) || (depth as number) < 1)) {
      throw Object.assign(new Error("The relationship request is invalid"), { code: "INVALID_INPUT" });
    }

    const state = await getPilotStateForOrg(scope.orgId, connection.id);
    const resources = [
      ...state.resources,
      ...customAssetsAsResources(await new CmdbCustomAssetRepository().list(scope)),
    ];
    const derived = deriveRelationships(resources);
    const repository = new CmdbRelationshipRepository();
    const manual = await repository.list(scope);
    const graph = buildDependencyGraph(resources, derived, manualInputs(manual));

    const summary = {
      resourceCount: resources.length,
      derivedEdgeCount: derived.length,
      manualEdgeCount: manual.length,
      externalNodeCount: graph.externalNodeKeys.length,
    };

    // With no resource selected, return the graph overview: the picker node list,
    // the manual-edge list (with ids for deletion) and the tallies.
    if (resourceKey === null) {
      const presentNodes = graph.allNodes.filter((node) => node.present);
      const nodes = presentNodes.slice(0, MAX_PICKER_NODES).map((node) => ({
        key: node.key,
        service: node.service,
        resourceType: node.resourceType,
        region: node.region,
        name: node.name,
      }));
      return jsonResponse({
        connection: { id: connection.id, customerName: connection.customerName },
        hasSnapshot: state.activeSnapshot !== null,
        summary,
        nodes,
        nodesTruncated: presentNodes.length > nodes.length,
        manualEdges: manual,
      });
    }

    if (!graph.hasNode(resourceKey)) {
      return jsonResponse({ resourceKey, mode, found: false, summary });
    }

    const traversal =
      mode === "dependencies"
        ? { mode, ...graph.dependencies(resourceKey) }
        : mode === "dependents"
          ? { mode, ...graph.dependents(resourceKey) }
          : mode === "blast-radius"
            ? { mode, ...graph.blastRadius(resourceKey, depth) }
            : { mode: "neighbors", ...graph.neighbors(resourceKey) };

    return jsonResponse({ resourceKey, found: true, summary, ...traversal });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await readBoundedJson(request, MAX_BODY_BYTES);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw Object.assign(new Error("The relationship request is invalid"), { code: "INVALID_INPUT" });
    }
    const { fromKey, toKey, relType, note } = body as {
      fromKey?: unknown;
      toKey?: unknown;
      relType?: unknown;
      note?: unknown;
    };
    if (
      typeof fromKey !== "string" ||
      typeof toKey !== "string" ||
      typeof relType !== "string" ||
      (note !== undefined && note !== null && typeof note !== "string")
    ) {
      throw Object.assign(new Error("The relationship request is invalid"), { code: "INVALID_INPUT" });
    }
    const { authenticated, scope, connection } = await resolveScope(request, "connection:manage");

    // A manual edge must connect two resources that are actually in the current
    // snapshot — an operator asserts intent over collected resources, never over
    // keys that do not exist.
    const state = await getPilotStateForOrg(scope.orgId, connection.id);
    const customAssets = customAssetsAsResources(await new CmdbCustomAssetRepository().list(scope));
    const keys = new Set([...state.resources, ...customAssets].map((resource) => resource.resourceKey));
    if (!keys.has(fromKey) || !keys.has(toKey)) {
      throw Object.assign(
        new Error("A manual relationship must connect two resources in the current snapshot"),
        { code: "INVALID_INPUT" },
      );
    }

    const repository = new CmdbRelationshipRepository();
    const saved = await repository.add(
      scope,
      { fromKey, toKey, relType, note: note ?? null },
      authenticated.subject.userId,
    );
    return jsonResponse({ saved, relationships: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "";
    if (!RELATIONSHIP_ID.test(id)) {
      throw Object.assign(new Error("The relationship request is invalid"), { code: "INVALID_INPUT" });
    }
    const { scope } = await resolveScope(request, "connection:manage");
    const repository = new CmdbRelationshipRepository();
    const deleted = await repository.delete(scope, id);
    return jsonResponse({ deleted, relationships: await repository.list(scope) });
  } catch (error) {
    return errorResponse(error);
  }
}
