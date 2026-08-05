import { locatedScimResource, scimRepository, scimResourceResponse } from "../../../../../lib/scim-api";
import { groupInputFromBody } from "../../../../../lib/scim-resource-input";
import {
  listResponse,
  parseScimFilter,
  parseScimPagination,
  readScimJson,
  scimErrorResponse,
  scimResponse,
} from "../../../../../lib/scim-protocol";

export const dynamic = "force-dynamic";
const FILTERS = new Set(["id", "displayName", "externalId"] as const);

export async function GET(request: Request): Promise<Response> {
  try {
    const repository = await scimRepository(request);
    const url = new URL(request.url);
    const pagination = parseScimPagination(url);
    const result = await repository.listGroups(pagination, parseScimFilter(url, FILTERS));
    return scimResponse(listResponse(
      result.resources.map((resource) => locatedScimResource(request, resource, "Groups")),
      result.total,
      pagination,
    ));
  } catch (error) {
    return scimErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const repository = await scimRepository(request);
    const resource = await repository.createGroup(groupInputFromBody(await readScimJson(request)));
    const location = new URL(`/api/scim/v2/Groups/${String(resource.id)}`, request.url).toString();
    return scimResourceResponse(request, resource, "Groups", {
      status: 201,
      headers: { location },
    });
  } catch (error) {
    return scimErrorResponse(error);
  }
}
