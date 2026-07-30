import { scimRepository } from "../../../../../lib/scim-api";
import { scimErrorResponse, scimResponse } from "../../../../../lib/scim-protocol";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    await scimRepository(request);
    return scimResponse({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      documentationUri: new URL("/docs/customer-onboarding-runbook", request.url).toString(),
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 100 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: true },
      authenticationSchemes: [{
        type: "oauthbearertoken",
        name: "Tenant-bound bearer token",
        description: "A one-time-shown Sutra SCIM connector token",
        specUri: "https://www.rfc-editor.org/rfc/rfc6750",
        primary: true,
      }],
      meta: {
        resourceType: "ServiceProviderConfig",
        location: new URL("/api/scim/v2/ServiceProviderConfig", request.url).toString(),
      },
    });
  } catch (error) {
    return scimErrorResponse(error);
  }
}
