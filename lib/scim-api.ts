import { ScimConnectorRepository, ScimResourceRepository } from "../db/scim-repository";
import { scimBearerToken, scimEtag, scimResponse } from "./scim-protocol";

export async function scimRepository(request: Request): Promise<ScimResourceRepository> {
  const connector = await new ScimConnectorRepository().verify(scimBearerToken(request));
  return new ScimResourceRepository(connector);
}

export function scimVersion(resource: Record<string, unknown>): number {
  const meta =
    typeof resource.meta === "object" && resource.meta !== null && !Array.isArray(resource.meta)
      ? resource.meta as Record<string, unknown>
      : {};
  const match = /^W\/"([1-9][0-9]{0,9})"$/u.exec(String(meta.version ?? ""));
  return match === null ? 1 : Number(match[1]);
}

export function locatedScimResource(
  request: Request,
  resource: Record<string, unknown>,
  collection: "Users" | "Groups",
): Record<string, unknown> {
  const id = String(resource.id ?? "");
  const meta =
    typeof resource.meta === "object" && resource.meta !== null && !Array.isArray(resource.meta)
      ? resource.meta as Record<string, unknown>
      : {};
  return {
    ...resource,
    meta: {
      ...meta,
      location: new URL(`/api/scim/v2/${collection}/${encodeURIComponent(id)}`, request.url).toString(),
    },
  };
}

export function scimResourceResponse(
  request: Request,
  resource: Record<string, unknown>,
  collection: "Users" | "Groups",
  init: ResponseInit = {},
): Response {
  const version = scimVersion(resource);
  const headers = new Headers(init.headers);
  headers.set("etag", scimEtag(version));
  return scimResponse(locatedScimResource(request, resource, collection), { ...init, headers });
}
