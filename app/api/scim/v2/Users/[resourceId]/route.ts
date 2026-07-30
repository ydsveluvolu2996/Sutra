import {
  scimRepository,
  scimResourceResponse,
  scimVersion,
} from "../../../../../../lib/scim-api";
import {
  patchedUserInput,
  userInputFromBody,
} from "../../../../../../lib/scim-resource-input";
import {
  assertScimIfMatch,
  readScimJson,
  scimErrorResponse,
} from "../../../../../../lib/scim-protocol";

export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ readonly resourceId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const repository = await scimRepository(request);
    return scimResourceResponse(
      request,
      await repository.getUser((await context.params).resourceId),
      "Users",
    );
  } catch (error) {
    return scimErrorResponse(error);
  }
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  try {
    const repository = await scimRepository(request);
    const id = (await context.params).resourceId;
    const current = await repository.getUser(id);
    const version = scimVersion(current);
    assertScimIfMatch(request, version);
    const updated = await repository.replaceUser(
      id,
      version,
      userInputFromBody(await readScimJson(request)),
    );
    return scimResourceResponse(request, updated, "Users");
  } catch (error) {
    return scimErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const repository = await scimRepository(request);
    const id = (await context.params).resourceId;
    const current = await repository.getUser(id);
    const version = scimVersion(current);
    assertScimIfMatch(request, version);
    const updated = await repository.replaceUser(
      id,
      version,
      patchedUserInput(current, await readScimJson(request)),
    );
    return scimResourceResponse(request, updated, "Users");
  } catch (error) {
    return scimErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const repository = await scimRepository(request);
    const id = (await context.params).resourceId;
    const current = await repository.getUser(id);
    const version = scimVersion(current);
    assertScimIfMatch(request, version);
    await repository.deactivateUser(id, version);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return scimErrorResponse(error);
  }
}
