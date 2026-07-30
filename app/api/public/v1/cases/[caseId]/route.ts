import { getLatestConnectionForCustomer } from "../../../../../../db/pilot-repository";
import { transitionFindingCase } from "../../../../../../db/case-repository";
import { ApiTokenRepository } from "../../../../../../db/api-token-repository";
import { authenticatePublicRequest, publicError, PublicApiError, sha256HexOf } from "../../../../../../lib/public-api";

export const dynamic = "force-dynamic";

const CASE_ID = /^case_[a-f0-9]{32}$/u;
const STATUSES = new Set(["open", "investigating", "resolved", "accepted_risk"]);

export async function PATCH(request: Request, context: { params: Promise<{ caseId: string }> }): Promise<Response> {
  try {
    const repository = new ApiTokenRepository();
    const token = await authenticatePublicRequest(request, "write:cases", repository);
    const { caseId } = await context.params;
    const idempotencyKey = request.headers.get("idempotency-key");
    if (idempotencyKey === null || idempotencyKey.length === 0) {
      throw new PublicApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Writes require an Idempotency-Key header");
    }
    const bodyText = await request.text();
    let body: unknown = null;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new PublicApiError(400, "INVALID_BODY", "The request body must be JSON");
    }
    const status = (body as { status?: unknown }).status;
    if (!CASE_ID.test(caseId) || typeof status !== "string" || !STATUSES.has(status)) {
      throw new PublicApiError(400, "INVALID_BODY", "Provide a valid caseId and a status of open, investigating, resolved or accepted_risk");
    }
    const requestSha256 = await sha256HexOf(`PATCH /cases/${caseId} ${bodyText}`);
    const replay = await repository.findIdempotentReplay(token, idempotencyKey, requestSha256);
    if (replay === "conflict") {
      throw new PublicApiError(409, "IDEMPOTENCY_CONFLICT", "This Idempotency-Key was already used with a different request");
    }
    if (replay !== null) {
      return new Response(replay.body, {
        status: replay.status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "idempotency-replayed": "true" },
      });
    }
    const connection = await getLatestConnectionForCustomer(token.orgId, token.customerId);
    if (connection === null) {
      throw new PublicApiError(404, "NOT_FOUND", "No cloud connection is available to this token");
    }
    let updated;
    try {
      // Actor attribution: public-API writes attribute to the user who minted
      // the token — the accountable human for this credential.
      updated = await transitionFindingCase({
        orgId: token.orgId,
        customerId: token.customerId,
        connectionId: connection.id,
        caseId,
        actorUserId: token.createdBy,
        status: status as "open",
      });
    } catch (caught) {
      const code = (caught as { code?: string }).code;
      if (code === "NOT_FOUND") throw new PublicApiError(404, "NOT_FOUND", "The case does not exist in this workspace");
      if (code === "INVALID_TRANSITION" || code === "INVALID_INPUT") {
        throw new PublicApiError(422, "INVALID_TRANSITION", "The case cannot move to that status from its current state");
      }
      throw caught;
    }
    const responseBody = JSON.stringify({ data: updated });
    await repository.storeIdempotentResponse(token, idempotencyKey, requestSha256, 200, responseBody);
    return new Response(responseBody, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (error) {
    return publicError(error);
  }
}
