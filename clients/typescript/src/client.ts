// Idiomatic TypeScript client for the Sutra Public API v1.
//
// Hand-written, zero external dependencies — it uses the global `fetch`,
// available in Node 18+, Deno, Bun, Cloudflare Workers and browsers. Keep the
// endpoint surface in ENDPOINTS in lock-step with the OpenAPI spec; the drift
// guard in tests/public-api-sdk-contract.test.ts enforces this.

import type {
  Case,
  CaseStatusRequest,
  ComplianceReport,
  Envelope,
  Finding,
  ListParams,
  Page,
  Resource,
  SnapshotStatus,
  Vulnerability,
} from "./types.ts";

export interface SutraClientOptions {
  /** Base URL of the API root, e.g. "https://app.sutra.example/api/public/v1". */
  readonly baseUrl: string;
  /** Service-account token (sutra_pat_...). Sent as a Bearer credential. */
  readonly token: string;
  /**
   * Optional fetch implementation. Defaults to the global `fetch`. Supplying
   * one keeps the client testable without a live server.
   */
  readonly fetch?: typeof fetch;
}

/** The stable error envelope every non-2xx response carries. */
export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

/** Base class for every error surfaced by the client. */
export class SutraApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SutraApiError";
    this.status = status;
    this.code = code;
  }
}

/** 401 — the token is missing, unknown, revoked or expired. */
export class SutraAuthError extends SutraApiError {
  public constructor(code: string, message: string) {
    super(401, code, message);
    this.name = "SutraAuthError";
  }
}

/** 403 — the token does not carry the scope this endpoint requires. */
export class SutraScopeError extends SutraApiError {
  public constructor(code: string, message: string) {
    super(403, code, message);
    this.name = "SutraScopeError";
  }
}

/** 400 — a malformed request (bad cursor, limit, body or missing key). */
export class SutraBadRequestError extends SutraApiError {
  public constructor(code: string, message: string) {
    super(400, code, message);
    this.name = "SutraBadRequestError";
  }
}

/** 429 — the per-minute quota (120 req/min) was exceeded. */
export class SutraRateLimitError extends SutraApiError {
  /** Seconds to wait before retrying, from the Retry-After header when present. */
  public readonly retryAfterSeconds: number | null;

  public constructor(code: string, message: string, retryAfterSeconds: number | null) {
    super(429, code, message);
    this.name = "SutraRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** HTTP method + templated path for a single operation. */
export interface EndpointDescriptor {
  readonly operationId: string;
  readonly method: "get" | "patch";
  readonly path: string;
  /** The SutraClient method that services this operation. */
  readonly clientMethod: string;
}

/**
 * The complete operation surface, one entry per OpenAPI operation. The paths
 * and methods here must match the spec exactly (enforced by the contract test).
 */
export const ENDPOINTS: readonly EndpointDescriptor[] = [
  { operationId: "listResources", method: "get", path: "/resources", clientMethod: "listResources" },
  { operationId: "listFindings", method: "get", path: "/findings", clientMethod: "listFindings" },
  { operationId: "listCases", method: "get", path: "/cases", clientMethod: "listCases" },
  { operationId: "updateCaseStatus", method: "patch", path: "/cases/{caseId}", clientMethod: "updateCaseStatus" },
  { operationId: "getSnapshots", method: "get", path: "/snapshots", clientMethod: "getSnapshots" },
  { operationId: "getCompliance", method: "get", path: "/compliance", clientMethod: "getCompliance" },
  { operationId: "listVulnerabilities", method: "get", path: "/vulnerabilities", clientMethod: "listVulnerabilities" },
];

function buildError(status: number, body: ApiErrorBody | null): SutraApiError {
  const code = body?.error.code ?? "UNKNOWN";
  const message = body?.error.message ?? `Request failed with status ${status}`;
  if (status === 401) return new SutraAuthError(code, message);
  if (status === 403) return new SutraScopeError(code, message);
  if (status === 400) return new SutraBadRequestError(code, message);
  return new SutraApiError(status, code, message);
}

export class SutraClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: SutraClientOptions) {
    // Normalize away a trailing slash so path joins are unambiguous.
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /** List a page of normalized resources from the published snapshot. */
  public listResources(params: ListParams = {}): Promise<Page<Resource>> {
    return this.request<Page<Resource>>("GET", this.pathWithQuery("/resources", params));
  }

  /** List a page of posture findings from the published snapshot. */
  public listFindings(params: ListParams = {}): Promise<Page<Finding>> {
    return this.request<Page<Finding>>("GET", this.pathWithQuery("/findings", params));
  }

  /** List a page of finding cases. */
  public listCases(params: ListParams = {}): Promise<Page<Case>> {
    return this.request<Page<Case>>("GET", this.pathWithQuery("/cases", params));
  }

  /**
   * Transition a case's status. Idempotent: the same `idempotencyKey` replays
   * the stored response, and reusing it with a different body is a 409.
   */
  public async updateCaseStatus(
    caseId: string,
    status: CaseStatusRequest,
    idempotencyKey: string,
  ): Promise<Case> {
    const path = `/cases/${encodeURIComponent(caseId)}`;
    const body = await this.request<Envelope<Case>>("PATCH", path, {
      body: { status },
      idempotencyKey,
    });
    return body.data;
  }

  /** Active snapshot metadata, coverage and the 20 most recent sync runs. */
  public async getSnapshots(): Promise<SnapshotStatus> {
    const body = await this.request<Envelope<SnapshotStatus>>("GET", "/snapshots");
    return body.data;
  }

  /** Per-framework compliance readiness summaries with disclaimers. */
  public async getCompliance(): Promise<ComplianceReport> {
    const body = await this.request<Envelope<ComplianceReport>>("GET", "/compliance");
    return body.data;
  }

  /** List a page of cloud vulnerability findings. */
  public listVulnerabilities(params: ListParams = {}): Promise<Page<Vulnerability>> {
    return this.request<Page<Vulnerability>>("GET", this.pathWithQuery("/vulnerabilities", params));
  }

  /**
   * Async iterator over every page of a paginated endpoint, following
   * `page.next` until it is null. Example:
   *   for await (const page of client.paginate((p) => client.listFindings(p))) { ... }
   */
  public async *paginate<T>(
    fetchPage: (params: ListParams) => Promise<Page<T>>,
    params: ListParams = {},
  ): AsyncGenerator<Page<T>, void, void> {
    let cursor: string | null = params.cursor ?? null;
    do {
      const page: Page<T> = await fetchPage({ ...params, cursor });
      yield page;
      cursor = page.page.next;
    } while (cursor !== null);
  }

  /** Convenience: collect every item across all pages into one array. */
  public async collect<T>(
    fetchPage: (params: ListParams) => Promise<Page<T>>,
    params: ListParams = {},
  ): Promise<T[]> {
    const all: T[] = [];
    for await (const page of this.paginate(fetchPage, params)) all.push(...page.data);
    return all;
  }

  private pathWithQuery(path: string, params: ListParams): string {
    const query = new URLSearchParams();
    if (params.cursor !== undefined && params.cursor !== null) query.set("cursor", params.cursor);
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    const suffix = query.toString();
    return suffix.length === 0 ? path : `${path}?${suffix}`;
  }

  private async request<T>(
    method: "GET" | "PATCH",
    path: string,
    options: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (!response.ok) {
      const errorBody = await this.readErrorBody(response);
      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        const retryAfter = header === null ? null : Number.parseInt(header, 10);
        throw new SutraRateLimitError(
          errorBody?.error.code ?? "RATE_LIMITED",
          errorBody?.error.message ?? "Rate limit exceeded",
          retryAfter !== null && Number.isFinite(retryAfter) ? retryAfter : null,
        );
      }
      throw buildError(response.status, errorBody);
    }

    return (await response.json()) as T;
  }

  private async readErrorBody(response: Response): Promise<ApiErrorBody | null> {
    try {
      const parsed: unknown = await response.json();
      if (
        typeof parsed === "object" && parsed !== null &&
        "error" in parsed && typeof (parsed as ApiErrorBody).error === "object"
      ) {
        return parsed as ApiErrorBody;
      }
    } catch {
      /* non-JSON error body; fall through */
    }
    return null;
  }
}
