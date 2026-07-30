import {
  scimRepository,
  scimResourceResponse,
  scimVersion,
} from "../../../../../../lib/scim-api";
import {
  groupInputFromBody,
  patchedGroupInput,
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
      await repository.getGroup((await context.params).resourceId),
      "Groups",
    );
  } catch (error) {
    return scimErrorResponse(error);
  }
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  try {
    const repository = await scimRepository(request);
    const id = (await context.params).resourceId;
    const current = await repository.getGroup(id);
    const version = scimVersion(current);
    assertScimIfMatch(request, version);
    const updated = await repository.replaceGroup(
      id,
      version,
      groupInputFromBody(await readScimJson(request)),
    );
    return scimResourceResponse(request, updated, "Groups");
  } catch (error) {
    return scimErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const repository = await scimRepository(request);
    const id = (await context.params).resourceId;
    const current = await repository.getGroup(id);
    const version = scimVersion(current);
    assertScimIfMatch(request, version);
    const updated = await repository.replaceGroup(
      id,
      version,
      patchedGroupInput(current, await readScimJson(request)),
    );
    return scimResourceResponse(request, updated, "Groups");
  } catch (error) {
    return scimErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const repository = await scimRepository(request);
    const id = (await context.params).resourceId;
    const current = await repository.getGroup(id);
    const version = scimVersion(current);
    assertScimIfMatch(request, version);
    await repository.deleteGroup(id, version);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return scimErrorResponse(error);
  }
}
