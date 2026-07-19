import { readFile } from "node:fs/promises";

import { evaluateKubernetesPosture } from "../../../lib/kubernetes-posture.ts";
import {
  type KubernetesAgentState,
  type KubernetesAgentStateStore,
  type RotatingAgentCredential,
} from "./agent-state.ts";
import {
  type KubernetesAgentHeartbeat,
  type KubernetesAgentIdentity,
  type KubernetesControlChannel,
} from "./control-channel.ts";
import { type HubbleFlowSource } from "./hubble-flow-source.ts";
import { ReadOnlyKubernetesCollector } from "./collector.ts";
import {
  HttpFalcoGatewayHealthProbe,
  KubernetesDiscoveryModuleHealthProbe,
  mergeKubernetesModuleHealth,
  type FalcoGatewayHealthProbe,
  type KubernetesModuleHealth,
  type KubernetesModuleHealthProbe,
  type KubernetesModuleState,
} from "./module-health.ts";
import { toKubernetesEvidenceSnapshot } from "./posture-adapter.ts";

const MIN_SCAN_INTERVAL_MS = 5 * 60_000;
const MAX_SCAN_INTERVAL_MS = 24 * 60 * 60_000;
const MIN_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;
const ROTATE_BEFORE_MS = 15 * 60_000;
const MAX_BOOTSTRAP_BYTES = 4 * 1024;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u;
const CAPABILITY = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export interface KubernetesAgentConfiguration extends KubernetesAgentIdentity {
  readonly clusterServerUrl: string;
  readonly scanIntervalMs: number;
  readonly stateStore: KubernetesAgentStateStore;
  readonly controlChannel: KubernetesControlChannel;
  readonly bootstrapToken: () => Promise<string>;
  readonly serviceAccountToken: () => Promise<string>;
  readonly certificateAuthorityPem?: string;
  readonly deployment: {
    readonly namespace: string;
    readonly podName: string;
    readonly startedAt: string;
  };
  readonly moduleHealthProbe?: KubernetesModuleHealthProbe;
  readonly hubbleFlowSource?: HubbleFlowSource;
  readonly falcoGateway?: {
    readonly healthUrl: string;
    readonly probe?: FalcoGatewayHealthProbe;
  };
  readonly now?: () => number;
}

export function retryDelayMs(
  consecutiveFailures: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.min(16, consecutiveFailures - 1));
  const ceiling = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** exponent);
  return Math.floor(ceiling * (0.75 + Math.max(0, Math.min(1, random())) * 0.25));
}

export async function readKubernetesAgentSecretFile(path: string): Promise<string> {
  const source = await readFile(path);
  if (source.byteLength < 32 || source.byteLength > MAX_BOOTSTRAP_BYTES) {
    throw new Error("Kubernetes agent bootstrap file is invalid");
  }
  const value = source.toString("utf8").trim();
  if (value.length < 32 || /[\0\r\n\t ]/u.test(value)) {
    throw new Error("Kubernetes agent bootstrap file is invalid");
  }
  return value;
}

function serviceAccountToken(value: string): string {
  if (value.length < 8 || value.length > 16 * 1024 || /[\0\r\n\t ]/u.test(value)) {
    throw new Error("Kubernetes service-account token is invalid");
  }
  return value;
}

function validInterval(value: number): boolean {
  return Number.isSafeInteger(value) && value >= MIN_SCAN_INTERVAL_MS && value <= MAX_SCAN_INTERVAL_MS;
}

function needsRotation(credential: RotatingAgentCredential, now: number): boolean {
  return Date.parse(credential.expiresAt) - now <= ROTATE_BEFORE_MS;
}

function isPrivateIpv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((value) => value > 255)) return false;
  const [a, b] = octets;
  return a === 127 || a === 10 ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31);
}

function isInClusterHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1") return true;
  if (isPrivateIpv4(hostname)) return true;
  // Kubernetes in-cluster DNS: bare service names (no dot) or cluster-suffixed.
  if (!hostname.includes(".")) return true;
  return /\.(?:svc|cluster\.local|local|internal)$/u.test(hostname);
}

export class ContinuousKubernetesAgent {
  private readonly configuration: KubernetesAgentConfiguration;
  private readonly now: () => number;
  private readonly server: URL;
  private readonly moduleHealthProbe: KubernetesModuleHealthProbe;
  private readonly falcoGatewayUrl: URL | null;
  private readonly falcoGatewayProbe: FalcoGatewayHealthProbe;

  public constructor(configuration: KubernetesAgentConfiguration) {
    if (
      !AGENT_ID.test(configuration.clusterId) ||
      configuration.clusterName.length < 1 ||
      configuration.clusterName.length > 253 ||
      /[\0\r\n]/u.test(configuration.clusterName) ||
      !AGENT_ID.test(configuration.agentVersion) ||
      configuration.capabilities.length < 1 ||
      configuration.capabilities.length > 64 ||
      configuration.capabilities.some((capability) => !CAPABILITY.test(capability))
    ) {
      throw new Error("Kubernetes agent identity is invalid");
    }
    if (!validInterval(configuration.scanIntervalMs)) {
      throw new Error("Kubernetes agent scan interval must be from 5 minutes through 24 hours");
    }
    this.configuration = configuration;
    this.now = configuration.now ?? Date.now;
    this.server = new URL(configuration.clusterServerUrl);
    if (
      (this.server.protocol !== "https:" &&
        !(this.server.protocol === "http:" && this.server.hostname === "127.0.0.1")) ||
      this.server.username !== "" ||
      this.server.password !== "" ||
      this.server.search !== "" ||
      this.server.hash !== "" ||
      (this.server.pathname !== "" && this.server.pathname !== "/")
    ) {
      throw new Error("Kubernetes agent API server must use HTTPS");
    }
    this.moduleHealthProbe = configuration.moduleHealthProbe ?? new KubernetesDiscoveryModuleHealthProbe();
    if (configuration.falcoGateway === undefined) {
      this.falcoGatewayUrl = null;
    } else {
      const gatewayUrl = new URL(configuration.falcoGateway.healthUrl);
      if (
        (gatewayUrl.protocol !== "http:" && gatewayUrl.protocol !== "https:") ||
        gatewayUrl.username !== "" ||
        gatewayUrl.password !== "" ||
        gatewayUrl.search !== "" ||
        gatewayUrl.hash !== "" ||
        // Plaintext http is only allowed to the in-cluster gateway, never to an
        // arbitrary public host; https is required otherwise.
        (gatewayUrl.protocol === "http:" && !isInClusterHost(gatewayUrl.hostname))
      ) {
        throw new Error("Falco gateway health URL is invalid");
      }
      this.falcoGatewayUrl = gatewayUrl;
    }
    this.falcoGatewayProbe = configuration.falcoGateway?.probe ?? new HttpFalcoGatewayHealthProbe();
  }

  private async falcoGatewayState(): Promise<KubernetesModuleState | null> {
    if (this.falcoGatewayUrl === null) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      return await this.falcoGatewayProbe.inspect({
        url: this.falcoGatewayUrl,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private withFalcoGateway(
    modules: KubernetesModuleHealth,
    gatewayState: KubernetesModuleState | null,
  ): KubernetesAgentHeartbeat["modules"] {
    return gatewayState === null ? modules : { ...modules, "falco-gateway": gatewayState };
  }

  public async runCycle(): Promise<void> {
    let state = await this.configuration.stateStore.load();
    let credential = state.credential;
    if (credential === null) {
      credential = await this.configuration.controlChannel.enroll(
        await this.configuration.bootstrapToken(),
        this.identity(),
      );
      state = { ...state, credential };
      await this.configuration.stateStore.save(state);
    } else if (needsRotation(credential, this.now())) {
      credential = await this.configuration.controlChannel.rotate(credential);
      state = { ...state, credential };
      await this.configuration.stateStore.save(state);
    }

    if (state.pendingUpload !== null) {
      await this.configuration.controlChannel.uploadScan(
        credential,
        state.pendingUpload.idempotencyKey,
        state.pendingUpload.payload,
      );
      state = {
        ...state,
        pendingUpload: null,
        lastSuccessfulScanAt: state.pendingUpload.createdAt,
      };
      await this.configuration.stateStore.save(state);
    }

    const bearerToken = serviceAccountToken(await this.configuration.serviceAccountToken());
    const discoveryController = new AbortController();
    const discoveryTimeout = setTimeout(() => discoveryController.abort(), 10_000);
    let discovery: KubernetesModuleHealth;
    try {
      discovery = await this.moduleHealthProbe.inspect({
        server: this.server,
        bearerToken,
        certificateAuthorityPem: this.configuration.certificateAuthorityPem,
        signal: discoveryController.signal,
      });
    } finally {
      clearTimeout(discoveryTimeout);
    }
    const gatewayState = await this.falcoGatewayState();
    await this.configuration.controlChannel.heartbeat(
      credential,
      this.heartbeat(credential.agentId, this.withFalcoGateway(discovery, gatewayState), state),
    );
    state = {
      ...state,
      lastHeartbeatAt: new Date(this.now()).toISOString(),
    };
    await this.configuration.stateStore.save(state);

    const snapshot = await new ReadOnlyKubernetesCollector({
      trust: "server-side",
      clusterId: this.configuration.clusterId,
      clusterName: this.configuration.clusterName,
      serverUrl: this.server.href,
      auth: {
        kind: "bearer",
        token: bearerToken,
        certificateAuthorityPem: this.configuration.certificateAuthorityPem,
      },
    }).collect(new Date(this.now()));
    const evidence = toKubernetesEvidenceSnapshot(snapshot);
    const posture = evaluateKubernetesPosture(evidence);
    const modules = mergeKubernetesModuleHealth(discovery, snapshot);
    const createdAt = new Date(this.now()).toISOString();
    const sequence = state.sequence + 1;
    const idempotencyKey = `scan_${String(sequence).padStart(20, "0")}`;
    const payload = {
      schema: "sutra.kubernetes-agent-scan.v1",
      agent: this.identity(),
      evidence,
      posture,
      coverage: snapshot.coverage,
      trivyFindings: snapshot.trivyFindings,
      trivySboms: snapshot.trivySboms,
      modules,
      limitations: {
        secretsCollected: false,
        configMapValuesCollected: false,
        falcoEventsCollected: false,
      },
    };
    state = {
      ...state,
      sequence,
      pendingUpload: { idempotencyKey, createdAt, payload },
    };
    await this.configuration.stateStore.save(state);
    await this.configuration.controlChannel.uploadScan(credential, idempotencyKey, payload);
    state = {
      ...state,
      pendingUpload: null,
      lastSuccessfulScanAt: createdAt,
      lastHeartbeatAt: createdAt,
    };
    await this.configuration.stateStore.save(state);
    // Re-probe rather than reuse the pre-scan reading: the collect() above can
    // run for a while, during which the gateway's health may have changed.
    const postScanGatewayState = await this.falcoGatewayState();
    await this.configuration.controlChannel.heartbeat(
      credential,
      this.heartbeat(credential.agentId, this.withFalcoGateway(modules, postScanGatewayState), state),
    );

    if (this.configuration.hubbleFlowSource !== undefined) {
      const collection = await this.configuration.hubbleFlowSource.collect({ now: this.now() });
      if (collection !== null && collection.flows.length > 0) {
        await this.configuration.controlChannel.uploadHubbleFlows(credential, {
          schema: "sutra.hubble-agent-upload.v1",
          collectedAt: new Date(this.now()).toISOString(),
          hubbleVersion: collection.hubbleVersion,
          flows: collection.flows,
        });
      }
    }
  }

  public async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      let delay = this.configuration.scanIntervalMs;
      try {
        await this.runCycle();
        failures = 0;
      } catch {
        failures += 1;
        delay = retryDelayMs(failures);
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, delay);
        signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
    }
  }

  private identity(): KubernetesAgentIdentity {
    return {
      clusterId: this.configuration.clusterId,
      clusterName: this.configuration.clusterName,
      agentVersion: this.configuration.agentVersion,
      capabilities: [...this.configuration.capabilities].sort(),
    };
  }

  private heartbeat(
    agentId: string,
    modules: KubernetesAgentHeartbeat["modules"],
    state: KubernetesAgentState,
  ): KubernetesAgentHeartbeat {
    return {
      ...this.identity(),
      agentId,
      deployment: this.configuration.deployment,
      modules,
      lastSuccessfulScanAt: state.lastSuccessfulScanAt,
    };
  }
}
