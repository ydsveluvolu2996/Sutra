import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43,512}$/u;
const MAX_STATE_BYTES = 12 * 1024 * 1024;

export interface RotatingAgentCredential {
  readonly agentId: string;
  readonly token: string;
  readonly expiresAt: string;
}

export interface PendingAgentUpload {
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly payload: unknown;
}

export interface KubernetesAgentState {
  readonly schema: "sutra.kubernetes-agent-state.v1";
  readonly sequence: number;
  readonly credential: RotatingAgentCredential | null;
  readonly pendingUpload: PendingAgentUpload | null;
  readonly lastHeartbeatAt: string | null;
  readonly lastSuccessfulScanAt: string | null;
}

export interface KubernetesAgentStateStore {
  load(): Promise<KubernetesAgentState>;
  save(state: KubernetesAgentState): Promise<void>;
}

export function validateKubernetesAgentState(input: unknown): KubernetesAgentState {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Kubernetes agent state is invalid");
  }
  const value = input as Record<string, unknown>;
  if (
    value.schema !== "sutra.kubernetes-agent-state.v1" ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 0
  ) throw new Error("Kubernetes agent state is invalid");

  let credential: RotatingAgentCredential | null = null;
  if (value.credential !== null) {
    if (typeof value.credential !== "object" || value.credential === null || Array.isArray(value.credential)) {
      throw new Error("Kubernetes agent state is invalid");
    }
    const candidate = value.credential as Record<string, unknown>;
    if (
      typeof candidate.agentId !== "string" || !ID.test(candidate.agentId) ||
      typeof candidate.token !== "string" || !TOKEN.test(candidate.token) ||
      typeof candidate.expiresAt !== "string" || !Number.isFinite(Date.parse(candidate.expiresAt))
    ) throw new Error("Kubernetes agent state is invalid");
    credential = {
      agentId: candidate.agentId,
      token: candidate.token,
      expiresAt: new Date(candidate.expiresAt).toISOString(),
    };
  }

  let pendingUpload: PendingAgentUpload | null = null;
  if (value.pendingUpload !== null) {
    if (typeof value.pendingUpload !== "object" || value.pendingUpload === null || Array.isArray(value.pendingUpload)) {
      throw new Error("Kubernetes agent state is invalid");
    }
    const candidate = value.pendingUpload as Record<string, unknown>;
    if (
      typeof candidate.idempotencyKey !== "string" || !ID.test(candidate.idempotencyKey) ||
      typeof candidate.createdAt !== "string" || !Number.isFinite(Date.parse(candidate.createdAt)) ||
      !Object.hasOwn(candidate, "payload")
    ) throw new Error("Kubernetes agent state is invalid");
    pendingUpload = {
      idempotencyKey: candidate.idempotencyKey,
      createdAt: new Date(candidate.createdAt).toISOString(),
      payload: candidate.payload,
    };
  }

  const timestamp = (candidate: unknown): string | null => {
    if (candidate === null) return null;
    if (typeof candidate !== "string" || !Number.isFinite(Date.parse(candidate))) {
      throw new Error("Kubernetes agent state is invalid");
    }
    return new Date(candidate).toISOString();
  };
  return {
    schema: "sutra.kubernetes-agent-state.v1",
    sequence: Number(value.sequence),
    credential,
    pendingUpload,
    lastHeartbeatAt: timestamp(value.lastHeartbeatAt),
    lastSuccessfulScanAt: timestamp(value.lastSuccessfulScanAt),
  };
}

export function emptyKubernetesAgentState(): KubernetesAgentState {
  return {
    schema: "sutra.kubernetes-agent-state.v1",
    sequence: 0,
    credential: null,
    pendingUpload: null,
    lastHeartbeatAt: null,
    lastSuccessfulScanAt: null,
  };
}

export class FileKubernetesAgentStateStore implements KubernetesAgentStateStore {
  private readonly path: string;

  public constructor(path: string) {
    this.path = resolve(path);
  }

  public async load(): Promise<KubernetesAgentState> {
    let handle;
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyKubernetesAgentState();
      throw new Error("Kubernetes agent state must be a protected regular file");
    }
    try {
      const status = await handle.stat();
      if (
        !status.isFile() ||
        status.size > MAX_STATE_BYTES ||
        (status.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && status.uid !== process.getuid())
      ) throw new Error("Kubernetes agent state must be a protected regular file");
      return validateKubernetesAgentState(JSON.parse(await handle.readFile("utf8")) as unknown);
    } finally {
      await handle.close();
    }
  }

  public async save(state: KubernetesAgentState): Promise<void> {
    const normalized = validateKubernetesAgentState(state);
    const source = `${JSON.stringify(normalized)}\n`;
    if (Buffer.byteLength(source, "utf8") > MAX_STATE_BYTES) {
      throw new Error("Kubernetes agent state exceeds its safe limit");
    }
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(source, "utf8");
      await handle.sync();
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
  }
}
