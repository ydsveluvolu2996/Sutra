import { canonicalJson } from "./canonical-json.ts";

export interface AuditExportEvent {
  readonly eventId: string;
  readonly orgId: string;
  readonly customerId: string | null;
  readonly occurredAt: number;
  readonly actorType: "user" | "service" | "system";
  readonly actorId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly outcome: "allowed" | "denied" | "failed";
  readonly requestId: string;
  /** Exact stored canonical JSON used by the event hash. */
  readonly metadataJson: string;
  readonly previousEventHash: string | null;
  readonly eventHash: string;
  /** v1 omits actorType; v2 covers it and is mandatory for all new events. */
  readonly hashVersion: 1 | 2;
}

export interface VerifiedAuditExport {
  readonly schemaVersion: "sutra.audit-export.v1";
  readonly orgId: string;
  readonly exportedAt: string;
  readonly eventCount: number;
  readonly chainHead: string | null;
  readonly events: readonly AuditExportEvent[];
  readonly exportSha256: string;
}

export class AuditIntegrityError extends Error {
  public readonly code = "AUDIT_INTEGRITY_FAILED";

  public constructor() {
    super("The audit chain failed integrity verification");
    this.name = "AuditIntegrityError";
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type AuditEventHashInput = Omit<AuditExportEvent, "eventHash">;

function v1HashPayload(event: AuditEventHashInput): Record<string, unknown> {
  return {
    eventId: event.eventId,
    orgId: event.orgId,
    customerId: event.customerId,
    occurredAt: event.occurredAt,
    actorId: event.actorId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    outcome: event.outcome,
    requestId: event.requestId,
    metadataJson: event.metadataJson,
    previousHash: event.previousEventHash,
  };
}

function v2HashPayload(event: AuditEventHashInput): Record<string, unknown> {
  return {
    ...v1HashPayload(event),
    actorType: event.actorType,
  };
}

/** Generate one event hash. All new writers must use version 2. */
export async function computeAuditEventHash(event: AuditEventHashInput): Promise<string> {
  if (event.hashVersion === 1) {
    // The original pilot writer used this exact property insertion order.
    return sha256Hex(JSON.stringify(v1HashPayload(event)));
  }
  if (event.hashVersion === 2) {
    return sha256Hex(canonicalJson(v2HashPayload(event)));
  }
  throw new AuditIntegrityError();
}

async function eventHashMatches(event: AuditExportEvent): Promise<boolean> {
  if (event.hashVersion === 2) {
    return event.eventHash === await computeAuditEventHash(event);
  }
  if (event.hashVersion !== 1) return false;
  // Legacy rows were written by two historical paths: the pilot writer used
  // insertion-order JSON and session administration used canonical JSON.
  const payload = v1HashPayload(event);
  const [pilotHash, sessionHash] = await Promise.all([
    sha256Hex(JSON.stringify(payload)),
    sha256Hex(canonicalJson(payload)),
  ]);
  return event.eventHash === pilotHash || event.eventHash === sessionHash;
}

/**
 * Verify every link and event digest before an audit batch can leave Sutra.
 * Empty exports are valid only with a null chain head.
 */
export async function buildVerifiedAuditExport(input: {
  readonly orgId: string;
  readonly exportedAt: string;
  readonly events: readonly AuditExportEvent[];
}): Promise<VerifiedAuditExport> {
  let previousHash: string | null = null;
  let previousOccurredAt = -1;
  let previousEventId = "";
  for (const event of input.events) {
    const isOrdered =
      event.occurredAt > previousOccurredAt ||
      (event.occurredAt === previousOccurredAt && event.eventId > previousEventId);
    if (
      event.orgId !== input.orgId ||
      event.previousEventHash !== previousHash ||
      !isOrdered ||
      !/^[a-f0-9]{64}$/u.test(event.eventHash) ||
      !await eventHashMatches(event)
    ) {
      throw new AuditIntegrityError();
    }
    try {
      if (canonicalJson(JSON.parse(event.metadataJson)) !== event.metadataJson) {
        throw new AuditIntegrityError();
      }
    } catch {
      throw new AuditIntegrityError();
    }
    previousHash = event.eventHash;
    previousOccurredAt = event.occurredAt;
    previousEventId = event.eventId;
  }
  const unsigned = {
    schemaVersion: "sutra.audit-export.v1" as const,
    orgId: input.orgId,
    exportedAt: input.exportedAt,
    eventCount: input.events.length,
    chainHead: previousHash,
    events: input.events,
  };
  return {
    ...unsigned,
    exportSha256: await sha256Hex(canonicalJson(unsigned)),
  };
}
