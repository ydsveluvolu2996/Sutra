import { bootstrapLocalAdmin, isLocalBootstrapRequired } from "../../../../db/auth-repository";
import {
  assertBootstrapToken,
  assertLocalAuthRequest,
  isManagedPasswordRuntime,
  sessionCookie,
} from "../../../../lib/api-auth";
import {
  assertLocalAuthMutation,
  authErrorResponse,
  boundedInputString,
  exactInputObject,
  readAuthJson,
} from "../../../../lib/auth-http";
import { jsonResponse } from "../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    assertLocalAuthRequest(request);
    return jsonResponse({
      bootstrapRequired: await isLocalBootstrapRequired(),
      identityMode: isManagedPasswordRuntime() ? "password" : "local",
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalAuthMutation(request);
    await assertBootstrapToken(request);
    const body = exactInputObject(
      await readAuthJson(request, 4 * 1024),
      ["email", "password", "displayName", "organizationName"],
    );
    const created = await bootstrapLocalAdmin({
      email: boundedInputString(body.email, { label: "email address", maximum: 254 }),
      password: boundedInputString(body.password, {
        label: "password",
        minimum: 14,
        maximum: 128,
        trim: false,
      }),
      displayName: boundedInputString(body.displayName, {
        label: "display name",
        minimum: 2,
        maximum: 80,
      }),
      organizationName: boundedInputString(body.organizationName, {
        label: "organization name",
        minimum: 2,
        maximum: 100,
      }),
    });
    return jsonResponse(
      { session: created.session.session },
      {
        status: 201,
        headers: {
          "set-cookie": sessionCookie(request, created.token),
        },
      },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
