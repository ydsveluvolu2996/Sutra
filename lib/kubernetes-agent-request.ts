const TOKEN = /^[A-Za-z0-9_-]{43,512}$/u;

export class KubernetesAgentRequestError extends Error {
  public readonly code: "AUTHENTICATION_REQUIRED" | "INVALID_INPUT";
  public readonly status: 400 | 401 | 413;

  public constructor(
    code: "AUTHENTICATION_REQUIRED" | "INVALID_INPUT",
    status: 400 | 401 | 413,
  ) {
    super(code === "AUTHENTICATION_REQUIRED"
      ? "The Kubernetes agent credential is invalid"
      : "The Kubernetes agent request is invalid");
    this.name = "KubernetesAgentRequestError";
    this.code = code;
    this.status = status;
  }
}

export function agentAuthorization(request: Request, scheme: "Bearer" | "Sutra-Bootstrap"): string {
  const value = request.headers.get("authorization") ?? "";
  const prefix = `${scheme} `;
  const token = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  if (!TOKEN.test(token)) throw new KubernetesAgentRequestError("AUTHENTICATION_REQUIRED", 401);
  return token;
}

export async function readAgentJson(request: Request, maximumBytes: number): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new KubernetesAgentRequestError("INVALID_INPUT", 400);
    }
    if (length > maximumBytes) throw new KubernetesAgentRequestError("INVALID_INPUT", 413);
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = request.body?.getReader();
  if (reader !== undefined) {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new KubernetesAgentRequestError("INVALID_INPUT", 413);
      }
      chunks.push(next.value);
    }
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged)) as unknown;
  } catch {
    throw new KubernetesAgentRequestError("INVALID_INPUT", 400);
  }
}

export function exactAgentRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new KubernetesAgentRequestError("INVALID_INPUT", 400);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in record))
  ) throw new KubernetesAgentRequestError("INVALID_INPUT", 400);
  return record;
}

export function agentErrorResponse(error: unknown): Response {
  const candidate = error as { code?: unknown; status?: unknown } | null;
  const code = typeof candidate?.code === "string" ? candidate.code : "REQUEST_FAILED";
  const status = typeof candidate?.status === "number" && [400, 401, 404, 409, 413].includes(candidate.status)
    ? candidate.status
    : code === "AUTHENTICATION_REQUIRED" ? 401
      : code === "NOT_FOUND" ? 404
        : code === "CONFLICT" || code === "IDEMPOTENCY_CONFLICT" ? 409
          : code === "INVALID_INPUT" ? 400
            : 500;
  const safeCode = new Set([
    "AUTHENTICATION_REQUIRED", "CONFLICT", "INVALID_INPUT", "NOT_FOUND",
  ]).has(code) ? code : "REQUEST_FAILED";
  return Response.json(
    { error: { code: safeCode, message: "Kubernetes agent request rejected" } },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
