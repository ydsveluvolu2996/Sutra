import { scimRepository } from "../../../../../lib/scim-api";
import {
  SCIM_GROUP_SCHEMA,
  SCIM_LIST_SCHEMA,
  SCIM_USER_SCHEMA,
  scimErrorResponse,
  scimResponse,
} from "../../../../../lib/scim-protocol";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    await scimRepository(request);
    return scimResponse({
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: 2,
      startIndex: 1,
      itemsPerPage: 2,
      Resources: [
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
          id: SCIM_USER_SCHEMA,
          name: "User",
          description: "Sutra enterprise identity",
          attributes: [
            { name: "userName", type: "string", multiValued: false, required: true, caseExact: false, mutability: "readWrite", returned: "default", uniqueness: "server" },
            { name: "displayName", type: "string", multiValued: false, required: false, caseExact: false, mutability: "readWrite", returned: "default", uniqueness: "none" },
            { name: "active", type: "boolean", multiValued: false, required: false, mutability: "readWrite", returned: "default" },
            { name: "emails", type: "complex", multiValued: true, required: false, mutability: "readWrite", returned: "default" },
            { name: "groups", type: "complex", multiValued: true, required: false, mutability: "readOnly", returned: "default" },
          ],
        },
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
          id: SCIM_GROUP_SCHEMA,
          name: "Group",
          description: "Sutra enterprise group",
          attributes: [
            { name: "displayName", type: "string", multiValued: false, required: true, caseExact: false, mutability: "readWrite", returned: "default", uniqueness: "none" },
            { name: "members", type: "complex", multiValued: true, required: false, mutability: "readWrite", returned: "default" },
          ],
        },
      ],
    });
  } catch (error) {
    return scimErrorResponse(error);
  }
}
