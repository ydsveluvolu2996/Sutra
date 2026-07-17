import { canonicalJson } from "./canonical-json";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u;
const MAX_FLOWS = 5_000;

export type HubbleFlowDirection = "ingress" | "egress" | "unknown";
export type HubbleFlowVerdict = "forwarded" | "dropped" | "error" | "audit" | "unknown";
export type HubbleFlowProtocol = "TCP" | "UDP" | "ICMP" | "OTHER";

export interface HubbleEndpointIdentity {
  readonly namespace: string | null;
  readonly workloadKind: string | null;
  readonly workloadName: string | null;
  readonly serviceName: string | null;
  readonly world: boolean;
}

export interface NormalizedHubbleFlow {
  readonly observedAt: string;
  readonly source: HubbleEndpointIdentity;
  readonly destination: HubbleEndpointIdentity;
  readonly direction: HubbleFlowDirection;
  readonly verdict: HubbleFlowVerdict;
  readonly protocol: HubbleFlowProtocol;
  readonly destinationPort: number | null;
  readonly observations: number;
  readonly evidenceSha256: string;
}

export interface HubbleFlowBatch {
  readonly schemaVersion: "sutra.hubble-flow-batch.v1";
  readonly clusterId: string;
  readonly collectedAt: string;
  readonly hubbleVersion: string;
  readonly flows: readonly NormalizedHubbleFlow[];
  readonly evidenceSha256: string;
  readonly limitations: readonly [
    "OBSERVED_FLOWS_DO_NOT_PROVE_GENERAL_REACHABILITY",
    "PAYLOADS_DNS_QUERY_CONTENTS_AND_HEADERS_NOT_RETAINED",
    "FLOW_ABSENCE_MAY_REFLECT_SAMPLING_OR_COVERAGE",
  ];
}

export class HubbleFlowEvidenceError extends Error {
  public readonly code = "INVALID_HUBBLE_FLOW_EVIDENCE";
  public constructor() {
    super("Hubble flow evidence was rejected");
    this.name = "HubbleFlowEvidenceError";
  }
}

function invalid(): never {
  throw new HubbleFlowEvidenceError();
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !keys.includes(key))
  ) invalid();
  return record;
}

function identifier(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !IDENTIFIER.test(value)) invalid();
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 40 || value.trim() !== value) invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > Date.now() + 300_000) invalid();
  return new Date(parsed).toISOString();
}

function endpoint(value: unknown): HubbleEndpointIdentity {
  const parsed = exact(value, [
    "namespace", "workloadKind", "workloadName", "serviceName", "world",
  ]);
  const namespace = identifier(parsed.namespace, true);
  const workloadKind = identifier(parsed.workloadKind, true);
  const workloadName = identifier(parsed.workloadName, true);
  const serviceName = identifier(parsed.serviceName, true);
  if (typeof parsed.world !== "boolean") invalid();
  if (!parsed.world && workloadName === null && serviceName === null) invalid();
  if (parsed.world && (namespace !== null || workloadKind !== null || workloadName !== null || serviceName !== null)) invalid();
  if ((workloadKind === null) !== (workloadName === null)) invalid();
  return { namespace, workloadKind, workloadName, serviceName, world: parsed.world };
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid();
  return value as T;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function normalizeHubbleFlowBatch(input: {
  readonly clusterId: string;
  readonly value: unknown;
}): Promise<HubbleFlowBatch> {
  const body = exact(input.value, ["collectedAt", "hubbleVersion", "flows"]);
  if (!Array.isArray(body.flows) || body.flows.length > MAX_FLOWS) invalid();
  const clusterId = identifier(input.clusterId);
  if (clusterId === null) invalid();
  const flows: NormalizedHubbleFlow[] = [];
  for (const item of body.flows) {
    const raw = exact(item, [
      "observedAt", "source", "destination", "direction", "verdict",
      "protocol", "destinationPort", "observations",
    ]);
    const destinationPort = raw.destinationPort;
    if (
      destinationPort !== null &&
      (!Number.isSafeInteger(destinationPort) || Number(destinationPort) < 1 || Number(destinationPort) > 65_535)
    ) invalid();
    if (!Number.isSafeInteger(raw.observations) || Number(raw.observations) < 1 || Number(raw.observations) > 1_000_000) invalid();
    const material = {
      observedAt: timestamp(raw.observedAt),
      source: endpoint(raw.source),
      destination: endpoint(raw.destination),
      direction: oneOf(raw.direction, ["ingress", "egress", "unknown"] as const),
      verdict: oneOf(raw.verdict, ["forwarded", "dropped", "error", "audit", "unknown"] as const),
      protocol: oneOf(raw.protocol, ["TCP", "UDP", "ICMP", "OTHER"] as const),
      destinationPort: destinationPort as number | null,
      observations: Number(raw.observations),
    };
    flows.push({ ...material, evidenceSha256: await sha256(canonicalJson(material)) });
  }
  const normalized = {
    schemaVersion: "sutra.hubble-flow-batch.v1" as const,
    clusterId,
    collectedAt: timestamp(body.collectedAt),
    hubbleVersion: identifier(body.hubbleVersion) ?? invalid(),
    flows,
    limitations: [
      "OBSERVED_FLOWS_DO_NOT_PROVE_GENERAL_REACHABILITY",
      "PAYLOADS_DNS_QUERY_CONTENTS_AND_HEADERS_NOT_RETAINED",
      "FLOW_ABSENCE_MAY_REFLECT_SAMPLING_OR_COVERAGE",
    ] as const,
  };
  return { ...normalized, evidenceSha256: await sha256(canonicalJson(normalized)) };
}
