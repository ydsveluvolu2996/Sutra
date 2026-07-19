import { open } from "node:fs/promises";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_UPLOAD_FLOWS = 2_000;
const SOURCE_CLOCK_SKEW_MS = 60_000;

export interface HubbleRawEndpoint {
  readonly namespace: string | null;
  readonly workloadKind: string | null;
  readonly workloadName: string | null;
  readonly serviceName: string | null;
  readonly world: boolean;
}

export interface HubbleRawFlow {
  readonly observedAt: string;
  readonly source: HubbleRawEndpoint;
  readonly destination: HubbleRawEndpoint;
  readonly direction: "ingress" | "egress" | "unknown";
  readonly verdict: "forwarded" | "dropped" | "error" | "audit" | "unknown";
  readonly protocol: "TCP" | "UDP" | "ICMP" | "OTHER";
  readonly destinationPort: number | null;
  readonly observations: number;
}

export interface HubbleFlowCollection {
  readonly hubbleVersion: string;
  readonly flows: readonly HubbleRawFlow[];
  readonly linesRead: number;
  readonly flowsSkipped: number;
}

export interface HubbleFlowSource {
  collect(input: { readonly now: number }): Promise<HubbleFlowCollection | null>;
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : null;
}

function isWorld(labels: unknown): boolean {
  return Array.isArray(labels) && labels.includes("reserved:world");
}

const WORLD_ENDPOINT: HubbleRawEndpoint = {
  namespace: null,
  workloadKind: null,
  workloadName: null,
  serviceName: null,
  world: true,
};

function endpoint(
  value: unknown,
  service: unknown,
): HubbleRawEndpoint | null {
  const parsed = record(value) ?? {};
  if (isWorld(parsed.labels)) return WORLD_ENDPOINT;
  const namespace = identifier(parsed.namespace);
  const serviceRecord = record(service);
  const serviceName = serviceRecord === null ? null : identifier(serviceRecord.name);
  const workloads = Array.isArray(parsed.workloads) ? parsed.workloads : [];
  const workload = record(workloads[0]);
  let workloadKind = workload === null ? null : identifier(workload.kind);
  let workloadName = workload === null ? null : identifier(workload.name);
  if ((workloadKind === null) !== (workloadName === null)) {
    workloadKind = null;
    workloadName = null;
  }
  if (workloadName === null) {
    const podName = identifier(parsed.pod_name);
    if (podName !== null) {
      workloadKind = "Pod";
      workloadName = podName;
    }
  }
  if (workloadName === null && serviceName === null) return null;
  return { namespace, workloadKind, workloadName, serviceName, world: false };
}

function direction(value: unknown): HubbleRawFlow["direction"] {
  if (value === "INGRESS") return "ingress";
  if (value === "EGRESS") return "egress";
  return "unknown";
}

function verdict(value: unknown): HubbleRawFlow["verdict"] {
  switch (value) {
    case "FORWARDED": return "forwarded";
    case "DROPPED": return "dropped";
    case "ERROR": return "error";
    case "AUDIT": return "audit";
    default: return "unknown";
  }
}

function layer4(value: unknown): {
  readonly protocol: HubbleRawFlow["protocol"];
  readonly destinationPort: number | null;
} {
  const parsed = record(value);
  if (parsed === null) return { protocol: "OTHER", destinationPort: null };
  for (const key of ["TCP", "UDP"] as const) {
    const transport = record(parsed[key]);
    if (transport === null) continue;
    const port = transport.destination_port;
    return {
      protocol: key,
      destinationPort:
        Number.isSafeInteger(port) && Number(port) >= 1 && Number(port) <= 65_535
          ? Number(port)
          : null,
    };
  }
  if (record(parsed.ICMPv4) !== null || record(parsed.ICMPv6) !== null) {
    return { protocol: "ICMP", destinationPort: null };
  }
  return { protocol: "OTHER", destinationPort: null };
}

function observedAt(flow: Record<string, unknown>, envelope: Record<string, unknown>, now: number): string | null {
  const raw = typeof flow.time === "string" ? flow.time : envelope.time;
  if (typeof raw !== "string" || raw.length > 40) return null;
  const parsed = Date.parse(raw);
  // Hubble observations are past events; allow only a small clock-skew margin.
  // This stays well inside the control plane's own +5-minute future tolerance,
  // so a batch the agent accepts is never rejected wholesale on cross-clock
  // re-validation at ingest.
  if (!Number.isFinite(parsed) || parsed > now + SOURCE_CLOCK_SKEW_MS) return null;
  return new Date(parsed).toISOString();
}

function aggregationKey(flow: Omit<HubbleRawFlow, "observedAt" | "observations">): string {
  return JSON.stringify([
    flow.source, flow.destination, flow.direction,
    flow.verdict, flow.protocol, flow.destinationPort,
  ]);
}

export function normalizeHubbleExportLines(input: {
  readonly lines: readonly string[];
  readonly now: number;
}): { readonly flows: readonly HubbleRawFlow[]; readonly flowsSkipped: number } {
  const aggregated = new Map<string, HubbleRawFlow>();
  let flowsSkipped = 0;
  for (const line of input.lines) {
    if (line.trim() === "") continue;
    let envelope: Record<string, unknown> | null;
    try {
      envelope = record(JSON.parse(line));
    } catch {
      envelope = null;
    }
    const flow = envelope === null ? null : record(envelope.flow) ?? envelope;
    if (envelope === null || flow === null) {
      flowsSkipped += 1;
      continue;
    }
    const time = observedAt(flow, envelope, input.now);
    const source = endpoint(flow.source, flow.source_service);
    const destination = endpoint(flow.destination, flow.destination_service);
    if (time === null || source === null || destination === null) {
      flowsSkipped += 1;
      continue;
    }
    const transport = layer4(flow.l4);
    const material = {
      source,
      destination,
      direction: direction(flow.traffic_direction),
      verdict: verdict(flow.verdict),
      protocol: transport.protocol,
      destinationPort: transport.destinationPort,
    };
    const key = aggregationKey(material);
    const existing = aggregated.get(key);
    if (existing === undefined) {
      if (aggregated.size >= MAX_UPLOAD_FLOWS) {
        flowsSkipped += 1;
        continue;
      }
      aggregated.set(key, { ...material, observedAt: time, observations: 1 });
    } else {
      aggregated.set(key, {
        ...existing,
        observedAt: time > existing.observedAt ? time : existing.observedAt,
        observations: Math.min(1_000_000, existing.observations + 1),
      });
    }
  }
  return { flows: [...aggregated.values()], flowsSkipped };
}

async function readTailLines(path: string): Promise<string[] | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const windowStart = Math.max(0, size - MAX_TAIL_BYTES);
    // Read one extra preceding byte so we can tell whether the window begins on
    // a record boundary (previous byte is a newline) or mid-record.
    const readStart = windowStart > 0 ? windowStart - 1 : 0;
    const length = size - readStart;
    if (length === 0) return [];
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, readStart);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (windowStart > 0) {
      // Drop through the first newline: that discards either the preceding
      // sentinel byte (boundary-aligned window) or a leading partial record.
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text.split("\n").filter((line) => Buffer.byteLength(line, "utf8") <= MAX_LINE_BYTES);
  } finally {
    await handle.close();
  }
}

/**
 * Reads bounded, aggregated flow metadata from a mounted Hubble flow-export
 * file (Cilium `hubble.export`). Only identity, direction, verdict, protocol
 * and destination port are retained; payloads, DNS query contents, HTTP
 * headers and raw records never leave the node. A missing file means Hubble
 * export is not configured and the source reports null rather than an empty
 * observation.
 */
export class HubbleExportFileFlowSource implements HubbleFlowSource {
  private readonly path: string;
  private readonly hubbleVersion: string;

  public constructor(input: { readonly path: string; readonly hubbleVersion: string }) {
    if (input.path.length === 0 || input.path.includes("\0")) {
      throw new Error("Hubble export file path is invalid");
    }
    if (!IDENTIFIER.test(input.hubbleVersion)) {
      throw new Error("Hubble version is invalid");
    }
    this.path = input.path;
    this.hubbleVersion = input.hubbleVersion;
  }

  public async collect(input: { readonly now: number }): Promise<HubbleFlowCollection | null> {
    const lines = await readTailLines(this.path);
    if (lines === null) return null;
    const { flows, flowsSkipped } = normalizeHubbleExportLines({ lines, now: input.now });
    return { hubbleVersion: this.hubbleVersion, flows, linesRead: lines.length, flowsSkipped };
  }
}
