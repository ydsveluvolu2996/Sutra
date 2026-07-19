/**
 * Bidirectional ITSM sync engine (Jira / ServiceNow): pure mapping in both
 * directions plus the inbound-webhook trust decisions.
 *
 * Honesty rules:
 * - Status maps are explicit tables. A remote status that is not in the table
 *   is returned as `unmapped` — it is NEVER guessed onto a local status.
 * - Conflicts resolve remote-newer-wins, and every applied inbound change
 *   carries a provenance note naming the connector and the remote timestamp.
 * - Inbound requests authenticate with an HMAC-SHA256 signature over the raw
 *   body; comparison is constant-time.
 */

export type ItsmConnectorType = "jira" | "servicenow";
export type CaseStatusLike = "open" | "investigating" | "resolved" | "accepted_risk";

export interface ItsmCaseLike {
  readonly caseId: string;
  readonly title: string;
  readonly summary: string;
  readonly severity: string;
  readonly priority: string;
  readonly status: CaseStatusLike;
}

/** Explicit outbound status tables — local → remote. */
const OUTBOUND_STATUS: Record<ItsmConnectorType, Record<CaseStatusLike, string>> = {
  jira: { open: "To Do", investigating: "In Progress", resolved: "Done", accepted_risk: "Closed" },
  servicenow: { open: "New", investigating: "In Progress", resolved: "Resolved", accepted_risk: "Closed" },
};

/** Explicit inbound status tables — remote (lowercased) → local. */
const INBOUND_STATUS: Record<ItsmConnectorType, Record<string, CaseStatusLike>> = {
  jira: {
    "to do": "open",
    "open": "open",
    "backlog": "open",
    "in progress": "investigating",
    "in review": "investigating",
    "done": "resolved",
    "closed": "accepted_risk",
  },
  servicenow: {
    "new": "open",
    "in progress": "investigating",
    "on hold": "investigating",
    "resolved": "resolved",
    "closed": "accepted_risk",
    "canceled": "accepted_risk",
  },
};

export interface OutboundTicket {
  readonly connectorType: ItsmConnectorType;
  readonly externalStatus: string;
  readonly payload: Record<string, unknown>;
}

/** Build the outbound ticket payload for a case. Pure and deterministic. */
export function buildOutboundTicket(itsmCase: ItsmCaseLike, connectorType: ItsmConnectorType, projectKey: string | null): OutboundTicket {
  const externalStatus = OUTBOUND_STATUS[connectorType][itsmCase.status];
  if (connectorType === "jira") {
    return {
      connectorType,
      externalStatus,
      payload: {
        fields: {
          ...(projectKey === null ? {} : { project: { key: projectKey } }),
          summary: `[Sutra ${itsmCase.caseId}] ${itsmCase.title}`,
          description: `${itsmCase.summary}\n\nSeverity: ${itsmCase.severity} · Priority: ${itsmCase.priority}\nManaged by Sutra — status: ${externalStatus}`,
          labels: ["sutra", `sutra-case-${itsmCase.caseId}`],
        },
      },
    };
  }
  return {
    connectorType,
    externalStatus,
    payload: {
      short_description: `[Sutra ${itsmCase.caseId}] ${itsmCase.title}`,
      description: `${itsmCase.summary}\n\nSeverity: ${itsmCase.severity} · Priority: ${itsmCase.priority}`,
      state: externalStatus,
      correlation_id: `sutra-case-${itsmCase.caseId}`,
    },
  };
}

export type InboundMapping =
  | { readonly kind: "mapped"; readonly status: CaseStatusLike }
  | { readonly kind: "unmapped"; readonly remoteStatus: string };

/** Map a remote status to a local case status — or say honestly that it doesn't map. */
export function mapInboundStatus(connectorType: ItsmConnectorType, remoteStatus: string): InboundMapping {
  const normalized = remoteStatus.trim().toLowerCase();
  const mapped = INBOUND_STATUS[connectorType][normalized];
  return mapped === undefined ? { kind: "unmapped", remoteStatus } : { kind: "mapped", status: mapped };
}

export type InboundDecision =
  | { readonly kind: "apply"; readonly status: CaseStatusLike; readonly provenanceNote: string }
  | { readonly kind: "skip-stale"; readonly provenanceNote: string }
  | { readonly kind: "skip-no-change" }
  | { readonly kind: "skip-unmapped"; readonly remoteStatus: string };

/**
 * Conflict policy: remote-newer-wins. An inbound update only applies when the
 * remote change is newer than the last local change AND actually changes the
 * status. Every decision that touches the case carries a provenance note.
 */
export function decideInboundTransition(input: {
  readonly connectorType: ItsmConnectorType;
  readonly connectorName: string;
  readonly currentStatus: CaseStatusLike;
  readonly remoteStatus: string;
  readonly remoteUpdatedAtMs: number;
  readonly lastLocalChangeMs: number;
}): InboundDecision {
  const mapping = mapInboundStatus(input.connectorType, input.remoteStatus);
  if (mapping.kind === "unmapped") return { kind: "skip-unmapped", remoteStatus: mapping.remoteStatus };
  if (mapping.status === input.currentStatus) return { kind: "skip-no-change" };
  const remoteIso = new Date(input.remoteUpdatedAtMs).toISOString();
  if (input.remoteUpdatedAtMs <= input.lastLocalChangeMs) {
    return {
      kind: "skip-stale",
      provenanceNote: `Inbound ${input.connectorType} update from '${input.connectorName}' (remote status '${input.remoteStatus}' at ${remoteIso}) was older than the last local change and was not applied.`,
    };
  }
  return {
    kind: "apply",
    status: mapping.status,
    provenanceNote: `Status set to '${mapping.status}' from ${input.connectorType} connector '${input.connectorName}' (remote status '${input.remoteStatus}' at ${remoteIso}).`,
  };
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Constant-time hex comparison — length leak only, never content. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Verify an inbound webhook signature over the RAW request body. */
export async function verifyInboundSignature(secret: string, rawBody: string, signatureHex: string | null): Promise<boolean> {
  if (signatureHex === null || !/^[a-fA-F0-9]{64}$/u.test(signatureHex)) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqualHex(expected, signatureHex.toLowerCase());
}

/** Sign an outbound body so the receiver can verify it came from Sutra. */
export async function signOutboundBody(secret: string, rawBody: string): Promise<string> {
  return hmacSha256Hex(secret, rawBody);
}
