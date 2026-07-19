import type { RotatingAgentCredential } from "./agent-state.ts";

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_HUBBLE_UPLOAD_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const BOOTSTRAP = /^[A-Za-z0-9_-]{32,512}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43,512}$/u;

export interface KubernetesAgentIdentity {
  readonly clusterId: string;
  readonly clusterName: string;
  readonly agentVersion: string;
  readonly capabilities: readonly string[];
}

export interface KubernetesAgentHeartbeat extends KubernetesAgentIdentity {
  readonly agentId: string;
  readonly deployment: {
    readonly namespace: string;
    readonly podName: string;
    readonly startedAt: string;
  };
  readonly modules: Readonly<Record<string, "AVAILABLE" | "DEGRADED" | "NOT_CONFIGURED" | "UNKNOWN">>;
  readonly lastSuccessfulScanAt: string | null;
}

export interface KubernetesHubbleFlowUpload {
  readonly schema: "sutra.hubble-agent-upload.v1";
  readonly collectedAt: string;
  readonly hubbleVersion: string;
  readonly flows: readonly unknown[];
}

export interface KubernetesControlChannel {
  enroll(bootstrapToken: string, identity: KubernetesAgentIdentity): Promise<RotatingAgentCredential>;
  rotate(credential: RotatingAgentCredential): Promise<RotatingAgentCredential>;
  heartbeat(credential: RotatingAgentCredential, heartbeat: KubernetesAgentHeartbeat): Promise<void>;
  uploadScan(
    credential: RotatingAgentCredential,
    idempotencyKey: string,
    payload: unknown,
  ): Promise<void>;
  uploadHubbleFlows(
    credential: RotatingAgentCredential,
    payload: KubernetesHubbleFlowUpload,
  ): Promise<void>;
}

export function resolveKubernetesControlPlaneUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Kubernetes control-plane URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) throw new Error("Kubernetes control-plane URL must be an HTTPS origin");
  return new URL(url.origin);
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new Error("Kubernetes control-plane response exceeded its safe limit");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Kubernetes control-plane response exceeded its safe limit");
      }
      chunks.push(next.value);
    }
  }
  if (!response.ok) throw new Error("Kubernetes control-plane request was rejected");
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer)) as unknown;
  } catch {
    throw new Error("Kubernetes control-plane response was invalid");
  }
}

function rotatingCredential(value: unknown): RotatingAgentCredential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Kubernetes control-plane credential response was invalid");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.agentId !== "string" || !ID.test(candidate.agentId) ||
    typeof candidate.token !== "string" || !TOKEN.test(candidate.token) ||
    typeof candidate.expiresAt !== "string" || !Number.isFinite(Date.parse(candidate.expiresAt)) ||
    Date.parse(candidate.expiresAt) <= Date.now()
  ) throw new Error("Kubernetes control-plane credential response was invalid");
  return {
    agentId: candidate.agentId,
    token: candidate.token,
    expiresAt: new Date(candidate.expiresAt).toISOString(),
  };
}

export class HttpsKubernetesControlChannel implements KubernetesControlChannel {
  private readonly origin: URL;
  private readonly request: typeof fetch;

  public constructor(
    origin: string,
    request: typeof fetch = fetch,
  ) {
    this.origin = resolveKubernetesControlPlaneUrl(origin);
    this.request = request;
  }

  public async enroll(
    bootstrapToken: string,
    identity: KubernetesAgentIdentity,
  ): Promise<RotatingAgentCredential> {
    if (!BOOTSTRAP.test(bootstrapToken)) throw new Error("Kubernetes bootstrap credential is invalid");
    const result = await this.send("/v1/kubernetes/agents/enroll", {
      method: "POST",
      headers: { authorization: `Sutra-Bootstrap ${bootstrapToken}` },
      body: identity,
    });
    return rotatingCredential(result);
  }

  public async rotate(credential: RotatingAgentCredential): Promise<RotatingAgentCredential> {
    const result = await this.send(`/v1/kubernetes/agents/${encodeURIComponent(credential.agentId)}/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}` },
      body: { agentId: credential.agentId },
    });
    return rotatingCredential(result);
  }

  public async heartbeat(
    credential: RotatingAgentCredential,
    heartbeat: KubernetesAgentHeartbeat,
  ): Promise<void> {
    await this.send(`/v1/kubernetes/agents/${encodeURIComponent(credential.agentId)}/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}` },
      body: heartbeat,
    });
  }

  public async uploadScan(
    credential: RotatingAgentCredential,
    idempotencyKey: string,
    payload: unknown,
  ): Promise<void> {
    if (!ID.test(idempotencyKey)) throw new Error("Kubernetes scan idempotency key is invalid");
    await this.send(`/v1/kubernetes/agents/${encodeURIComponent(credential.agentId)}/scans`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.token}`,
        "x-sutra-idempotency-key": idempotencyKey,
      },
      body: payload,
      maximumRequestBytes: MAX_UPLOAD_BYTES,
    });
  }

  public async uploadHubbleFlows(
    credential: RotatingAgentCredential,
    payload: KubernetesHubbleFlowUpload,
  ): Promise<void> {
    await this.send(`/v1/kubernetes/agents/${encodeURIComponent(credential.agentId)}/hubble-flows`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}` },
      body: payload,
      maximumRequestBytes: MAX_HUBBLE_UPLOAD_BYTES,
    });
  }

  private async send(path: string, input: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
    readonly maximumRequestBytes?: number;
  }): Promise<unknown> {
    const body = JSON.stringify(input.body);
    if (Buffer.byteLength(body, "utf8") > (input.maximumRequestBytes ?? MAX_RESPONSE_BYTES)) {
      throw new Error("Kubernetes control-plane request exceeded its safe limit");
    }
    const response = await this.request(new URL(path, this.origin), {
      method: input.method,
      redirect: "error",
      headers: {
        ...input.headers,
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "sutra-kubernetes-agent/1",
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return boundedJson(response);
  }
}
