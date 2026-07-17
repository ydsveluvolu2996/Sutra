import { createServer, type Server } from "node:http";

import {
  emptyKubernetesAgentState,
  type KubernetesAgentState,
  type KubernetesAgentStateStore,
  type RotatingAgentCredential,
} from "./agent-state.ts";
import { type KubernetesControlChannel } from "./control-channel.ts";
import { ContinuousKubernetesAgent, retryDelayMs } from "./continuous-agent.ts";

const MIN_CYCLES = 10;
const MAX_CYCLES = 10_000;
const SCAN_INTERVAL_MS = 5 * 60_000;
const CREDENTIAL_LIFETIME_MS = 60 * 60_000;
const SOAK_EPOCH_MS = Date.parse("2026-07-17T00:00:00.000Z");
const MAX_OBSERVED_STATE_BYTES = 256 * 1024;

export interface KubernetesAgentSoakOptions {
  readonly cycles: number;
  readonly seed: number;
  readonly restartEveryCycles?: number;
  readonly networkLossPercent?: number;
  readonly uploadResponseLossPercent?: number;
  readonly stateStore?: KubernetesAgentStateStore;
}

export interface KubernetesAgentSoakInvariant {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface KubernetesAgentSoakReport {
  readonly schema: "sutra.kubernetes-agent-soak.v1";
  readonly cycles: number;
  readonly completedCycles: number;
  readonly failedCycles: number;
  readonly injectedNetworkLossCycles: number;
  readonly injectedUploadResponseLossCycles: number;
  readonly restarts: number;
  readonly successfulEnrollments: number;
  readonly rotations: number;
  readonly heartbeats: number;
  readonly uniquePublications: number;
  readonly replayedUploads: number;
  readonly staleCredentialUses: number;
  readonly finalSequence: number;
  readonly maximumStateBytes: number;
  readonly virtualDurationMs: number;
  readonly invariants: readonly KubernetesAgentSoakInvariant[];
  readonly passed: boolean;
}

class SeededRandom {
  private state: number;

  public constructor(seed: number) {
    this.state = seed >>> 0;
  }

  public next(): number {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  public percent(): number {
    return Math.floor(this.next() * 100);
  }
}

class VirtualClock {
  private currentMs = SOAK_EPOCH_MS;

  public now(): number {
    return this.currentMs;
  }

  public advance(milliseconds: number): void {
    this.currentMs += milliseconds;
  }
}

type CycleFault = "none" | "network-loss" | "upload-response-loss";

class SoakControlChannel implements KubernetesControlChannel {
  public successfulEnrollments = 0;
  public rotations = 0;
  public heartbeats = 0;
  public replayedUploads = 0;
  public staleCredentialUses = 0;
  public readonly publishedKeys = new Set<string>();
  public fault: CycleFault = "none";

  private activeToken: string | null = null;
  private issued = 0;
  private readonly clock: VirtualClock;
  private readonly bootstrapToken: string;

  public constructor(clock: VirtualClock, bootstrapToken: string) {
    this.clock = clock;
    this.bootstrapToken = bootstrapToken;
  }

  private issueCredential(): RotatingAgentCredential {
    this.issued += 1;
    const token = `t${String(this.issued)}`.padEnd(64, "x");
    this.activeToken = token;
    return {
      agentId: "agent_soak_cluster",
      token,
      expiresAt: new Date(this.clock.now() + CREDENTIAL_LIFETIME_MS).toISOString(),
    };
  }

  private assertReachable(): void {
    if (this.fault === "network-loss") {
      throw new Error("soak: control plane unreachable");
    }
  }

  private assertActive(credential: RotatingAgentCredential): void {
    if (this.activeToken === null || credential.token !== this.activeToken) {
      this.staleCredentialUses += 1;
      throw new Error("soak: stale or revoked agent credential");
    }
  }

  public async enroll(bootstrapToken: string): Promise<RotatingAgentCredential> {
    this.assertReachable();
    if (bootstrapToken !== this.bootstrapToken) {
      throw new Error("soak: bootstrap token rejected");
    }
    const credential = this.issueCredential();
    this.successfulEnrollments += 1;
    return credential;
  }

  public async rotate(credential: RotatingAgentCredential): Promise<RotatingAgentCredential> {
    this.assertReachable();
    this.assertActive(credential);
    const next = this.issueCredential();
    this.rotations += 1;
    return next;
  }

  public async heartbeat(credential: RotatingAgentCredential): Promise<void> {
    this.assertReachable();
    this.assertActive(credential);
    this.heartbeats += 1;
  }

  public async uploadScan(
    credential: RotatingAgentCredential,
    idempotencyKey: string,
  ): Promise<void> {
    this.assertReachable();
    this.assertActive(credential);
    if (this.publishedKeys.has(idempotencyKey)) {
      this.replayedUploads += 1;
      return;
    }
    this.publishedKeys.add(idempotencyKey);
    if (this.fault === "upload-response-loss") {
      this.fault = "none";
      throw new Error("soak: upload response lost after durable acceptance");
    }
  }
}

class MeasuringStateStore implements KubernetesAgentStateStore {
  public maximumStateBytes = 0;
  private readonly inner: KubernetesAgentStateStore;

  public constructor(inner: KubernetesAgentStateStore) {
    this.inner = inner;
  }

  public async load(): Promise<KubernetesAgentState> {
    return await this.inner.load();
  }

  public async save(state: KubernetesAgentState): Promise<void> {
    this.maximumStateBytes = Math.max(
      this.maximumStateBytes,
      Buffer.byteLength(JSON.stringify(state), "utf8"),
    );
    await this.inner.save(state);
  }
}

class MemoryAgentStateStore implements KubernetesAgentStateStore {
  private state: KubernetesAgentState = emptyKubernetesAgentState();

  public async load(): Promise<KubernetesAgentState> {
    return structuredClone(this.state);
  }

  public async save(state: KubernetesAgentState): Promise<void> {
    this.state = structuredClone(state);
  }
}

async function withLoopbackKubernetesApi<T>(
  run: (url: string) => Promise<T>,
): Promise<T> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ metadata: {}, items: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address !== "object") {
      throw new Error("soak: loopback Kubernetes API failed to start");
    }
    return await run(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())));
  }
}

function invariant(
  name: string,
  passed: boolean,
  detail: string,
): KubernetesAgentSoakInvariant {
  return { name, passed, detail };
}

export async function runKubernetesAgentSoak(
  options: KubernetesAgentSoakOptions,
): Promise<KubernetesAgentSoakReport> {
  if (
    !Number.isSafeInteger(options.cycles) ||
    options.cycles < MIN_CYCLES ||
    options.cycles > MAX_CYCLES
  ) {
    throw new Error(`Soak cycles must be from ${String(MIN_CYCLES)} through ${String(MAX_CYCLES)}`);
  }
  if (!Number.isSafeInteger(options.seed) || options.seed < 0) {
    throw new Error("Soak seed must be a non-negative integer");
  }
  const restartEveryCycles = options.restartEveryCycles ?? 7;
  const networkLossPercent = options.networkLossPercent ?? 15;
  const uploadResponseLossPercent = options.uploadResponseLossPercent ?? 10;
  if (restartEveryCycles < 2 || networkLossPercent > 40 || uploadResponseLossPercent > 40) {
    throw new Error("Soak fault plan is out of the supported bounds");
  }

  const clock = new VirtualClock();
  const random = new SeededRandom(options.seed);
  const bootstrapToken = `bootstrap_${"s".repeat(48)}`;
  const kubeToken = "soak-service-account-token-never-persisted";
  const channel = new SoakControlChannel(clock, bootstrapToken);
  const store = new MeasuringStateStore(options.stateStore ?? new MemoryAgentStateStore());
  // The final tenth of the run is fault-free so pending work always drains.
  const faultFreeTail = Math.max(2, Math.floor(options.cycles / 10));

  return await withLoopbackKubernetesApi(async (url) => {
    const buildAgent = () =>
      new ContinuousKubernetesAgent({
        clusterId: "cluster_soak",
        clusterName: "Soak validation cluster",
        clusterServerUrl: url,
        agentVersion: "0.2.0-soak",
        capabilities: ["inventory.v1", "posture.v1", "durable-idempotency.v1"],
        scanIntervalMs: SCAN_INTERVAL_MS,
        stateStore: store,
        controlChannel: channel,
        bootstrapToken: async () => bootstrapToken,
        serviceAccountToken: async () => kubeToken,
        deployment: {
          namespace: "sutra-system",
          podName: "sutra-agent-soak",
          startedAt: new Date(SOAK_EPOCH_MS).toISOString(),
        },
        moduleHealthProbe: {
          async inspect() {
            return {
              trivy: "NOT_CONFIGURED",
              kyverno: "NOT_CONFIGURED",
              falco: "NOT_CONFIGURED",
              cilium: "NOT_CONFIGURED",
            } as const;
          },
        },
        now: () => clock.now(),
      });

    let agent = buildAgent();
    let restarts = 0;
    let completedCycles = 0;
    let failedCycles = 0;
    let injectedNetworkLossCycles = 0;
    let injectedUploadResponseLossCycles = 0;
    let recoveredAfterFailure = 0;
    let consecutiveFailures = 0;
    let sawFailureBeforeSuccess = false;

    for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
      if (cycle % restartEveryCycles === 0) {
        agent = buildAgent();
        restarts += 1;
      }
      const inFaultFreeTail = cycle > options.cycles - faultFreeTail;
      const roll = random.percent();
      if (!inFaultFreeTail && roll < networkLossPercent) {
        channel.fault = "network-loss";
        injectedNetworkLossCycles += 1;
      } else if (!inFaultFreeTail && roll < networkLossPercent + uploadResponseLossPercent) {
        channel.fault = "upload-response-loss";
        injectedUploadResponseLossCycles += 1;
      } else {
        channel.fault = "none";
      }
      try {
        await agent.runCycle();
        completedCycles += 1;
        if (sawFailureBeforeSuccess) {
          recoveredAfterFailure += 1;
          sawFailureBeforeSuccess = false;
        }
        consecutiveFailures = 0;
        clock.advance(SCAN_INTERVAL_MS);
      } catch {
        failedCycles += 1;
        consecutiveFailures += 1;
        sawFailureBeforeSuccess = true;
        clock.advance(retryDelayMs(consecutiveFailures, () => random.next()));
      } finally {
        channel.fault = "none";
      }
    }

    const finalState = await store.load();
    const serializedFinalState = JSON.stringify(finalState);
    const failuresInjected = failedCycles > 0;
    const invariants: KubernetesAgentSoakInvariant[] = [
      invariant(
        "single-enrollment",
        channel.successfulEnrollments === 1,
        `successful enrollments=${String(channel.successfulEnrollments)}`,
      ),
      invariant(
        "credential-rotation",
        channel.rotations >= 1 && channel.staleCredentialUses === 0,
        `rotations=${String(channel.rotations)} staleCredentialUses=${String(channel.staleCredentialUses)}`,
      ),
      invariant(
        "recovers-after-network-loss",
        !failuresInjected || recoveredAfterFailure >= 1,
        `failedCycles=${String(failedCycles)} recoveries=${String(recoveredAfterFailure)}`,
      ),
      invariant(
        "replay-safe-publication",
        channel.publishedKeys.size === finalState.sequence &&
          (injectedUploadResponseLossCycles === 0 || channel.replayedUploads >= 1),
        `uniquePublications=${String(channel.publishedKeys.size)} finalSequence=${String(finalState.sequence)} replays=${String(channel.replayedUploads)}`,
      ),
      invariant(
        "pending-work-drained",
        finalState.pendingUpload === null && finalState.credential !== null,
        `pendingUpload=${finalState.pendingUpload === null ? "null" : "present"}`,
      ),
      invariant(
        "bounded-agent-state",
        store.maximumStateBytes > 0 && store.maximumStateBytes <= MAX_OBSERVED_STATE_BYTES,
        `maximumStateBytes=${String(store.maximumStateBytes)}`,
      ),
      invariant(
        "no-secret-persisted",
        !serializedFinalState.includes(kubeToken) && !serializedFinalState.includes(bootstrapToken),
        "kube service-account and bootstrap tokens never enter persisted state",
      ),
    ];

    return {
      schema: "sutra.kubernetes-agent-soak.v1",
      cycles: options.cycles,
      completedCycles,
      failedCycles,
      injectedNetworkLossCycles,
      injectedUploadResponseLossCycles,
      restarts,
      successfulEnrollments: channel.successfulEnrollments,
      rotations: channel.rotations,
      heartbeats: channel.heartbeats,
      uniquePublications: channel.publishedKeys.size,
      replayedUploads: channel.replayedUploads,
      staleCredentialUses: channel.staleCredentialUses,
      finalSequence: finalState.sequence,
      maximumStateBytes: store.maximumStateBytes,
      virtualDurationMs: clock.now() - SOAK_EPOCH_MS,
      invariants,
      passed: invariants.every((entry) => entry.passed),
    };
  });
}
