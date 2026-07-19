import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.ts";
import {
  FALCO_PRIORITIES,
  type FalcoPriority,
  type NormalizedFalcoRuntimeEvent,
} from "./falco-runtime-types.ts";

export const FALCO_MAXIMUM_BODY_BYTES = 256 * 1024;
export const FALCO_MAXIMUM_BATCH_EVENTS = 100;

const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;
const SAFE_TEXT = /^[^\0\r\n]*$/u;
const PRIORITIES = new Set<string>(FALCO_PRIORITIES);

export class FalcoRuntimeBoundaryError extends Error {
  public readonly code: "INVALID_INPUT" | "BODY_TOO_LARGE";

  public constructor(code: "INVALID_INPUT" | "BODY_TOO_LARGE") {
    super("Falco runtime event rejected");
    this.name = "FalcoRuntimeBoundaryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new FalcoRuntimeBoundaryError("INVALID_INPUT");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number, nullable = true): string | null {
  if (value === undefined || value === null || value === "") {
    if (nullable) return null;
    invalid();
  }
  if (typeof value !== "string" || value.length > maximum || !SAFE_TEXT.test(value)) invalid();
  return value;
}

function integer(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value :
    typeof value === "string" && /^\d{1,10}$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) return null;
  return parsed;
}

function field(fields: Record<string, unknown>, name: string): unknown {
  return fields[name];
}

function image(fields: Record<string, unknown>): string | null {
  const repository = text(field(fields, "container.image.repository"), 512);
  const tag = text(field(fields, "container.image.tag"), 128);
  return repository === null ? null : tag === null ? repository : `${repository}:${tag}`;
}

function priority(value: unknown): FalcoPriority {
  if (typeof value !== "string") invalid();
  const normalized = value.toLowerCase();
  if (!PRIORITIES.has(normalized)) invalid();
  return normalized as FalcoPriority;
}

function occurredAt(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) invalid();
  return new Date(parsed).toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeOne(
  clusterId: string,
  input: unknown,
): NormalizedFalcoRuntimeEvent {
  const event = record(input);
  const fields = event.output_fields === undefined ? {} : record(event.output_fields);
  const safe = {
    schemaVersion: "sutra.falco.runtime-event.v1" as const,
    clusterId,
    occurredAt: occurredAt(event.time),
    rule: text(event.rule, 256, false) as string,
    priority: priority(event.priority),
    source: text(event.source, 64) ?? "syscall",
    nodeName: text(event.hostname, 253),
    namespace: text(field(fields, "k8s.ns.name"), 253),
    podName: text(field(fields, "k8s.pod.name"), 253),
    podUid: text(field(fields, "k8s.pod.uid"), 128),
    containerId: text(field(fields, "container.id"), 128),
    containerName: text(field(fields, "container.name"), 253),
    containerImage: image(fields),
    process: {
      name: text(field(fields, "proc.name"), 128),
      executable: text(field(fields, "proc.exepath"), 512),
      pid: integer(field(fields, "proc.pid")),
      parentPid: integer(field(fields, "proc.ppid")),
      userName: text(field(fields, "user.name"), 128),
      userId: text(field(fields, "user.uid"), 64),
      eventType: text(field(fields, "evt.type"), 64),
    },
  };
  const evidenceSha256 = sha256(canonicalJson(safe));
  return {
    ...safe,
    eventId: `frte_${sha256(`${clusterId}\0${evidenceSha256}`).slice(0, 48)}`,
    evidenceSha256,
  };
}

/**
 * Accepts an unmodified Falcosidekick webhook event or Sutra's bounded
 * `{events:[...]}` envelope. `output`, tags, command lines, environment data,
 * file contents and every non-allowlisted output field are discarded.
 */
export function parseFalcoRuntimePayload(input: {
  readonly clusterId: string;
  readonly body: Uint8Array;
}): readonly NormalizedFalcoRuntimeEvent[] {
  if (!CLUSTER_ID.test(input.clusterId)) invalid();
  if (!(input.body instanceof Uint8Array)) invalid();
  if (input.body.byteLength > FALCO_MAXIMUM_BODY_BYTES) {
    throw new FalcoRuntimeBoundaryError("BODY_TOO_LARGE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body));
  } catch {
    invalid();
  }
  const root = record(parsed);
  const candidates = Object.keys(root).length === 1 && Array.isArray(root.events)
    ? root.events
    : [root];
  if (candidates.length < 1 || candidates.length > FALCO_MAXIMUM_BATCH_EVENTS) invalid();
  return candidates.map((candidate) => normalizeOne(input.clusterId, candidate));
}
