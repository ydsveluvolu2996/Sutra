export const SCIM_MEDIA_TYPE = "application/scim+json";
export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

const TOKEN = /^sutra_scim_[a-f0-9]{64}$/u;
const ETAG = /^W\/"([1-9][0-9]{0,9})"$/u;
const FILTER = /^(id|userName|externalId|active|displayName)\s+eq\s+(?:"([^"\\]{0,254})"|(true|false))$/iu;

export class ScimError extends Error {
  public readonly status: number;
  public readonly scimType: string | null;

  public constructor(status: number, detail: string, scimType: string | null = null) {
    super(detail);
    this.name = "ScimError";
    this.status = status;
    this.scimType = scimType;
  }
}

export interface ScimPagination {
  readonly startIndex: number;
  readonly count: number;
}

export interface ScimFilter {
  readonly attribute: "id" | "userName" | "externalId" | "active" | "displayName";
  readonly value: string | boolean;
}

export function scimResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", SCIM_MEDIA_TYPE);
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function scimErrorResponse(error: unknown): Response {
  const failure = error instanceof ScimError
    ? error
    : new ScimError(500, "The provisioning operation could not be completed");
  const headers = new Headers();
  if (failure.status === 401) headers.set("www-authenticate", 'Bearer realm="Sutra SCIM"');
  return scimResponse({
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(failure.status),
    detail: failure.message,
    ...(failure.scimType === null ? {} : { scimType: failure.scimType }),
  }, { status: failure.status, headers });
}

export function scimBearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/iu.exec(header);
  if (match === null || !TOKEN.test(match[1])) {
    throw new ScimError(401, "A valid SCIM bearer token is required");
  }
  return match[1];
}

export function requireScimContentType(request: Request): void {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== SCIM_MEDIA_TYPE) {
    throw new ScimError(415, "SCIM mutations require application/scim+json", "invalidSyntax");
  }
}

export async function readScimJson(request: Request): Promise<Record<string, unknown>> {
  requireScimContentType(request);
  let value: unknown;
  try {
    const maximumBytes = 64 * 1024;
    const declaredLength = request.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^[0-9]+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)
    ) {
      throw new Error("SCIM request body is too large");
    }
    if (request.body === null) throw new Error("SCIM request body is missing");
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maximumBytes) {
          await reader.cancel();
          throw new Error("SCIM request body is too large");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ScimError(400, "The SCIM request body is invalid", "invalidSyntax");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScimError(400, "The SCIM request body must be an object", "invalidSyntax");
  }
  return value as Record<string, unknown>;
}

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value === null || value === "") return fallback;
  if (!/^[0-9]{1,10}$/u.test(value)) {
    throw new ScimError(400, "The SCIM pagination request is invalid", "invalidValue");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ScimError(400, "The SCIM pagination request is invalid", "invalidValue");
  }
  return parsed;
}

export function parseScimPagination(url: URL): ScimPagination {
  return {
    startIndex: boundedInteger(url.searchParams.get("startIndex"), 1, 1, 1_000_000),
    count: boundedInteger(url.searchParams.get("count"), 100, 0, 100),
  };
}

export function parseScimFilter(url: URL, allowed: ReadonlySet<ScimFilter["attribute"]>): ScimFilter | null {
  const source = url.searchParams.get("filter");
  if (source === null || source.trim() === "") return null;
  if (source.length > 512) throw new ScimError(400, "The SCIM filter is too large", "tooMany");
  const match = FILTER.exec(source.trim());
  if (match === null) {
    throw new ScimError(400, "Only a single bounded eq filter is supported", "invalidFilter");
  }
  const canonical = match[1].toLowerCase();
  const attribute =
    canonical === "username" ? "userName"
    : canonical === "externalid" ? "externalId"
    : canonical === "displayname" ? "displayName"
    : canonical as ScimFilter["attribute"];
  if (!allowed.has(attribute)) {
    throw new ScimError(400, `Filtering by ${attribute} is not supported for this resource`, "invalidFilter");
  }
  return {
    attribute,
    value: match[3] === undefined ? match[2] : match[3].toLowerCase() === "true",
  };
}

export function scimEtag(version: number): string {
  return `W/"${version}"`;
}

export function assertScimIfMatch(request: Request, version: number): void {
  const source = request.headers.get("if-match");
  if (source === null || source.trim() === "*") return;
  const match = ETAG.exec(source.trim());
  if (match === null) throw new ScimError(400, "The If-Match value is invalid", "invalidValue");
  if (Number(match[1]) !== version) {
    throw new ScimError(412, "The SCIM resource changed since it was read", "mutability");
  }
}

export function exactScimString(
  value: unknown,
  label: string,
  maximum: number,
  options: { readonly optional?: boolean; readonly email?: boolean } = {},
): string | null {
  if (value === undefined || value === null) {
    if (options.optional === true) return null;
    throw new ScimError(400, `${label} is required`, "invalidValue");
  }
  if (typeof value !== "string") throw new ScimError(400, `${label} is invalid`, "invalidValue");
  const result = value.trim();
  if (
    result.length < 1 ||
    result.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(result) ||
    (options.email === true && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(result))
  ) {
    throw new ScimError(400, `${label} is invalid`, "invalidValue");
  }
  return options.email === true ? result.toLocaleLowerCase("en-US") : result;
}

export function requireSchema(body: Record<string, unknown>, expected: string): void {
  if (
    !Array.isArray(body.schemas) ||
    !body.schemas.every((value) => typeof value === "string") ||
    !body.schemas.includes(expected)
  ) {
    throw new ScimError(400, `The ${expected} schema is required`, "invalidSyntax");
  }
}

export interface ScimPatchOperation {
  readonly op: "add" | "replace" | "remove";
  readonly path: string | null;
  readonly value: unknown;
}

export function parsePatchOperations(body: Record<string, unknown>): readonly ScimPatchOperation[] {
  requireSchema(body, SCIM_PATCH_SCHEMA);
  if (!Array.isArray(body.Operations) || body.Operations.length < 1 || body.Operations.length > 100) {
    throw new ScimError(400, "Patch Operations must contain between 1 and 100 entries", "invalidSyntax");
  }
  return body.Operations.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new ScimError(400, "A patch operation is invalid", "invalidSyntax");
    }
    const operation = candidate as Record<string, unknown>;
    const op = typeof operation.op === "string" ? operation.op.toLowerCase() : "";
    if (op !== "add" && op !== "replace" && op !== "remove") {
      throw new ScimError(400, "A patch operation verb is invalid", "invalidSyntax");
    }
    const path =
      operation.path === undefined || operation.path === null
        ? null
        : exactScimString(operation.path, "Patch path", 512);
    return { op, path, value: operation.value };
  });
}

export function listResponse(resources: readonly unknown[], total: number, pagination: ScimPagination): Record<string, unknown> {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: total,
    startIndex: pagination.startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}
