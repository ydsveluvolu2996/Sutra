import { verifyTotpStepUp } from "../../../../../db/auth-repository";
import { localAuthSecrets, requireApiSession } from "../../../../../lib/api-auth";
import {
  assertLocalAuthMutation,
  authErrorResponse,
  boundedInputString,
  exactInputObject,
  readAuthJson,
} from "../../../../../lib/auth-http";
import { jsonResponse } from "../../../../../lib/pilot-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertLocalAuthMutation(request);
    const authenticated = await requireApiSession(request);
    const body = exactInputObject(await readAuthJson(request, 512), ["code"]);
    await verifyTotpStepUp(
      authenticated,
      boundedInputString(body.code, {
        label: "authenticator code",
        minimum: 6,
        maximum: 6,
        trim: false,
      }),
      localAuthSecrets(),
    );
    return jsonResponse({ verified: true, validForSeconds: 300 });
  } catch (error) {
    return authErrorResponse(error);
  }
}
