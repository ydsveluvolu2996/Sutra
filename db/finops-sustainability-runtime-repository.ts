/** Durable accepted-attempt replay and redacted failure audit for ADD-08. */
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import {
  SustainabilityCarbonRepository,
  type SustainabilityPersistenceScope,
} from "./finops-sustainability-carbon-repository.ts";
import type {
  SustainabilityCarbonAcceptedRuntimeAttempt,
  SustainabilityCarbonImmutableEvidenceHandoff,
} from "../lib/finops-sustainability-carbon-runtime-binding.ts";

const REQUEST = /^scr_[a-f0-9]{64}$/u; const SHA = /^[a-f0-9]{64}$/u;
const MAX_BYTES = 112 * 1_024 * 1_024;
interface AttemptRow { request_id: string; org_id: string; customer_id: string; connection_id: string; scheduled_window: string; source_boundary_sha256: string; snapshot_generation_id: string; evidence_generation_id: string; evidence_object_id: string; evidence_content_sha256: string; accepted_json: string; accepted_sha256: string; created_at: number | string }
export class SustainabilityRuntimeRepositoryError extends Error { public constructor(public readonly code: "INVALID_INPUT" | "STORED_STATE_INVALID" | "IMMUTABLE_CONFLICT") { super("Sustainability runtime persistence rejected"); this.name = "SustainabilityRuntimeRepositoryError"; } }
function reject(code: SustainabilityRuntimeRepositoryError["code"]): never { throw new SustainabilityRuntimeRepositoryError(code); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`; return JSON.stringify(value); }
async function sha256(value: string): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join(""); }
function sameScope(left: SustainabilityPersistenceScope, right: SustainabilityPersistenceScope): boolean { return left.organizationId === right.organizationId && left.customerId === right.customerId && left.connectionId === right.connectionId; }

export class SustainabilityRuntimeRepository implements SustainabilityCarbonImmutableEvidenceHandoff {
  private readonly snapshots: SustainabilityCarbonRepository;
  public constructor(private readonly database: D1Database = getRawDb()) { this.snapshots = new SustainabilityCarbonRepository(database); }
  public async getAccepted(scope: SustainabilityPersistenceScope, requestId: string): Promise<SustainabilityCarbonAcceptedRuntimeAttempt | null> {
    if (!REQUEST.test(requestId)) reject("INVALID_INPUT"); await ensureRuntimeSchema(this.database);
    const row = await this.database.prepare("SELECT * FROM finops_sustainability_runtime_attempts WHERE org_id=? AND customer_id=? AND connection_id=? AND request_id=? LIMIT 1").bind(scope.organizationId, scope.customerId, scope.connectionId, requestId).first<AttemptRow>();
    if (row === null) return null; if (Buffer.byteLength(row.accepted_json, "utf8") > MAX_BYTES || !SHA.test(row.accepted_sha256) || await sha256(row.accepted_json) !== row.accepted_sha256) reject("STORED_STATE_INVALID");
    let accepted: SustainabilityCarbonAcceptedRuntimeAttempt; try { accepted = JSON.parse(row.accepted_json) as SustainabilityCarbonAcceptedRuntimeAttempt; } catch { reject("STORED_STATE_INVALID"); }
    if (accepted.requestId !== row.request_id || accepted.scheduledWindow !== row.scheduled_window || accepted.sourceBoundarySha256 !== row.source_boundary_sha256 || !sameScope(accepted.snapshot.scope, scope) || accepted.snapshot.generationId !== row.snapshot_generation_id || accepted.evidence.generationId !== row.evidence_generation_id || accepted.evidence.objectId !== row.evidence_object_id || accepted.evidence.contentSha256 !== row.evidence_content_sha256) reject("STORED_STATE_INVALID");
    return accepted;
  }
  public async commit(input: Parameters<SustainabilityCarbonImmutableEvidenceHandoff["commit"]>[0]): Promise<{ readonly accepted: SustainabilityCarbonAcceptedRuntimeAttempt; readonly becameActive: boolean }> {
    if (!REQUEST.test(input.requestId) || !SHA.test(input.sourceBoundarySha256) || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) reject("INVALID_INPUT");
    await ensureRuntimeSchema(this.database);
    const stored = await this.snapshots.recordCapture(input.trustedScope, input.capture, input.nowMs);
    if (canonical(stored.generation.snapshot) !== canonical(input.normalizedSnapshot)) reject("IMMUTABLE_CONFLICT");
    const accepted: SustainabilityCarbonAcceptedRuntimeAttempt = { requestId: input.requestId, scheduledWindow: input.scheduledWindow, sourceBoundarySha256: input.sourceBoundarySha256, snapshot: stored.generation, evidence: input.evidence };
    const json = JSON.stringify(accepted); if (Buffer.byteLength(json, "utf8") > MAX_BYTES) reject("INVALID_INPUT"); const hash = await sha256(json);
    await this.database.prepare("INSERT INTO finops_sustainability_runtime_attempts(request_id,org_id,customer_id,connection_id,scheduled_window,source_boundary_sha256,snapshot_generation_id,evidence_generation_id,evidence_object_id,evidence_content_sha256,accepted_json,accepted_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING").bind(input.requestId, input.scope.organizationId, input.scope.customerId, input.scope.connectionId, input.scheduledWindow, input.sourceBoundarySha256, stored.generation.generationId, input.evidence.generationId, input.evidence.objectId, input.evidence.contentSha256, json, hash, input.nowMs).run();
    const persisted = await this.getAccepted(input.scope, input.requestId); if (persisted === null || canonical(persisted) !== canonical(accepted)) reject("IMMUTABLE_CONFLICT");
    return { accepted: persisted, becameActive: stored.becameActive };
  }
  public async recordFailure(input: Parameters<SustainabilityCarbonImmutableEvidenceHandoff["recordFailure"]>[0]): Promise<void> {
    if (!REQUEST.test(input.requestId) || !Number.isSafeInteger(input.completedAtMs) || input.completedAtMs < 0) reject("INVALID_INPUT"); await ensureRuntimeSchema(this.database);
    const id = `srf_${await sha256(canonical(input))}`;
    await this.database.prepare("INSERT INTO finops_sustainability_runtime_failures(failure_id,org_id,customer_id,connection_id,request_id,scheduled_window,failure_code,completed_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING").bind(id, input.scope.organizationId, input.scope.customerId, input.scope.connectionId, input.requestId, input.scheduledWindow, input.code, input.completedAtMs).run();
  }
}
