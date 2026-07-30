import { scimRepository } from "../../../../../lib/scim-api";
import { SCIM_LIST_SCHEMA, scimErrorResponse, scimResponse } from "../../../../../lib/scim-protocol";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    await scimRepository(request);
    const base = new URL("/api/scim/v2", request.url);
    return scimResponse({
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: 2,
      startIndex: 1,
      itemsPerPage: 2,
      Resources: [
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "User",
          name: "User",
          endpoint: "/Users",
          schema: "urn:ietf:params:scim:schemas:core:2.0:User",
          meta: { resourceType: "ResourceType", location: new URL(`${base.pathname}/ResourceTypes/User`, request.url).toString() },
        },
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "Group",
          name: "Group",
          endpoint: "/Groups",
          schema: "urn:ietf:params:scim:schemas:core:2.0:Group",
          meta: { resourceType: "ResourceType", location: new URL(`${base.pathname}/ResourceTypes/Group`, request.url).toString() },
        },
      ],
    });
  } catch (error) {
    return scimErrorResponse(error);
  }
}
