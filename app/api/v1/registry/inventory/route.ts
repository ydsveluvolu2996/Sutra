import { KubernetesRepository } from "../../../../../db/kubernetes-repository";
import { KubernetesSupplyChainRepository } from "../../../../../db/kubernetes-supply-chain-repository";
import { getConnectionForOrg } from "../../../../../db/pilot-repository";
import { assertSessionCapability, requireApiSession } from "../../../../../lib/api-auth";
import { inventoryRegistry } from "../../../../../lib/registry-inventory";
import { buildRegistryInventoryInput, evidenceToObservedImage, type ObservedContainerImage } from "../../../../../lib/registry-inventory-inputs";
import { errorResponse, jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const EVIDENCE_PER_CLUSTER = 500;

function invalid(): never {
  throw Object.assign(new Error("Registry inventory query rejected"), { code: "INVALID_INPUT" });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "connectionId")) invalid();
    const connectionId = url.searchParams.get("connectionId");
    if (connectionId === null || !CONNECTION_ID.test(connectionId)) invalid();

    const authenticated = await requireApiSession(request);
    const connection = await getConnectionForOrg(authenticated.subject.orgId, connectionId);
    if (connection === null) throw Object.assign(new Error("Cloud connection not found"), { code: "NOT_FOUND" });
    assertSessionCapability(authenticated, "connection:read", connection.customerId);

    // Real, already-collected source: the observed container images carried by
    // Kubernetes supply-chain evidence across this connection's active clusters.
    // No new collection is performed. Tenant scope is derived from the resolved
    // connection, never the caller.
    const scope = { orgId: authenticated.subject.orgId, customerId: connection.customerId };
    const clusters = await new KubernetesRepository().listClusters(scope);
    const supplyChain = new KubernetesSupplyChainRepository();
    const images: ObservedContainerImage[] = [];
    for (const cluster of clusters) {
      const evidence = await supplyChain.list({ ...scope, clusterId: cluster.id }, EVIDENCE_PER_CLUSTER);
      for (const record of evidence) images.push(evidenceToObservedImage(record));
    }

    // fetchedAt is the most recent observation time when images exist; otherwise
    // the request clock (used only to stamp an honest unknown-coverage report).
    const latestObserved = images.reduce<string | null>(
      (latest, image) => (latest === null || image.collectedAt > latest ? image.collectedAt : latest),
      null,
    );
    const input = buildRegistryInventoryInput(images, {
      sourceCollected: clusters.length > 0,
      fetchedAt: latestObserved ?? new Date().toISOString(),
    });
    const inventory = inventoryRegistry(input);

    return jsonResponse({
      inventory,
      inputs: {
        clusters: clusters.length,
        observedImages: images.length,
        repositoriesRepresented: input.repositories.length,
      },
      connectionId,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
