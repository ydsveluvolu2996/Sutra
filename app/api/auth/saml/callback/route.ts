import { loginHostedUser } from "../../../../../db/auth-repository";
import { consumeSamlAssertion } from "../../../../../db/hosted-saml-replay-repository";
import { acceptIdentityInvitation } from "../../../../../db/identity-invitation-repository";
import { sessionCookie } from "../../../../../lib/api-auth";
import { decodeSamlResponse, verifySamlAssertion } from "../../../../../lib/saml-assertion";
import {
  expiredSamlTransactionCookie,
  hostedSamlTransactionKey,
  resolveHostedSamlProvider,
  SAML_TRANSACTION_COOKIE,
} from "../../../../../lib/hosted-saml-runtime";
import {
  constantTimeSamlValue,
  openSamlTransaction,
} from "../../../../../lib/saml-transaction";
import { requestCookie } from "../../../../../lib/hosted-oidc-runtime";

export const dynamic = "force-dynamic";
const MAX_FORM_BYTES = 384 * 1024;

async function readSamlForm(request: Request): Promise<{ readonly response: string; readonly relayState: string }> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US");
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (
    request.method !== "POST"
    || contentType !== "application/x-www-form-urlencoded"
    || (Number.isFinite(declaredLength) && declaredLength > MAX_FORM_BYTES)
  ) throw new Error("SAML callback request is invalid");
  const source = await request.text();
  if (new TextEncoder().encode(source).length > MAX_FORM_BYTES) throw new Error("SAML callback request is too large");
  const form = new URLSearchParams(source);
  if (
    [...form.keys()].sort().join("\0") !== ["RelayState", "SAMLResponse"].join("\0")
    || form.getAll("RelayState").length !== 1
    || form.getAll("SAMLResponse").length !== 1
  ) throw new Error("SAML callback form is invalid");
  const response = form.get("SAMLResponse") ?? "";
  const relayState = form.get("RelayState") ?? "";
  if (response.length < 4 || relayState.length !== 43) throw new Error("SAML callback form is invalid");
  return { response, relayState };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const transactionKey = hostedSamlTransactionKey(request);
    const sealed = requestCookie(request, SAML_TRANSACTION_COOKIE);
    if (sealed === null) throw new Error("SAML transaction is missing");
    const transaction = await openSamlTransaction(sealed, transactionKey);
    const form = await readSamlForm(request);
    if (!constantTimeSamlValue(form.relayState, transaction.relayState)) throw new Error("SAML RelayState is invalid");
    const resolved = resolveHostedSamlProvider(request, transaction.provider);
    const verified = await verifySamlAssertion(decodeSamlResponse(form.response), {
      provider: resolved.provider,
      identityIssuer: resolved.identityIssuer,
      audience: resolved.spEntityId,
      acsUrl: resolved.acsUrl,
      requestId: transaction.requestId,
    });
    await consumeSamlAssertion(
      resolved.identityIssuer,
      verified.assertionId,
      verified.replayExpiresAt,
    );
    const result = transaction.invitationToken === null
      ? await loginHostedUser(verified.identity)
      : await acceptIdentityInvitation(verified.identity, transaction.invitationToken);
    const headers = new Headers({
      "cache-control": "no-store",
      location: transaction.returnTo,
    });
    headers.append("set-cookie", expiredSamlTransactionCookie());
    headers.append("set-cookie", sessionCookie(request, result.token));
    return new Response(null, { status: 302, headers });
  } catch {
    return Response.json(
      { error: { code: "AUTH_REQUEST_FAILED", message: "Sutra could not complete enterprise SAML sign-in" } },
      {
        status: 401,
        headers: {
          "cache-control": "no-store",
          "set-cookie": expiredSamlTransactionCookie(),
        },
      },
    );
  }
}

export async function GET(): Promise<Response> {
  return Response.json(
    { error: { code: "AUTH_REQUEST_FAILED", message: "SAML assertions must use HTTP POST" } },
    { status: 405, headers: { allow: "POST", "cache-control": "no-store" } },
  );
}
