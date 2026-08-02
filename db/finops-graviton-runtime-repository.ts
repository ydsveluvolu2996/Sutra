/** Trusted scope, authority catalog, lease and signed replay archive for ADV-05. */
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import type { GravitonMaterializationRequest } from "../lib/finops-graviton-savings-job.ts";
import type { GravitonRuntimeReceipt } from "../lib/finops-graviton-runtime-binding.ts";
import type { GravitonTenantBoundary } from "../lib/finops-graviton-savings.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u, CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u, REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u, REQUEST = /^gvrq_[a-f0-9]{64}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u, SHA = /^[a-f0-9]{64}$/u;
const MAX_SCOPES = 10_000, MAX_ACCOUNTS = 1_000, MAX_REGIONS = 50, LEASE_MS = 20 * 60 * 1_000;
const REQUIRED_PACK = "standard-2026-08.12";
export interface GravitonRuntimeScope { readonly organizationId: string; readonly customerId: string; readonly connectionId: string }
export interface GravitonRuntimeProviderContext {
  readonly accountTargets: readonly { readonly accountId: string; readonly connectionId: string }[];
  readonly evidenceAuthority: {
    readonly cur2: { readonly generationId: string; readonly contentSha256: string };
    readonly pricing: { readonly catalogVersion: string; readonly contentSha256: string };
    readonly compatibility: { readonly policyVersion: string; readonly contentSha256: string };
    readonly workloadAttestations: { readonly setId: string; readonly contentSha256: string };
    readonly licenseAttestations: { readonly setId: string; readonly contentSha256: string };
  };
}
export interface GravitonRuntimeStatus { readonly state: "unavailable" | "collecting" | "failed" | "ready"; readonly reason: string; readonly lastAttemptAt: string | null }
export interface GravitonProductionAuthorityConfiguration {readonly pricingCatalogVersion:string;readonly pricingContentSha256:string;
  readonly compatibilityPolicyVersion:string;readonly compatibilityContentSha256:string;readonly workloadAttestationSetId:string;
  readonly workloadAttestationSha256:string;readonly licenseAttestationSetId:string;readonly licenseAttestationSha256:string}
interface ConnectionRow { readonly org_id: string; readonly customer_id: string; readonly connection_id: string; readonly account_id: string; readonly partition: GravitonTenantBoundary["partition"]; readonly enabled_regions_json: string; readonly permission_pack_version: string }
interface AuthorityRow { readonly cur2_generation_id: string; readonly cur2_content_sha256: string; readonly pricing_catalog_version: string; readonly pricing_content_sha256: string; readonly compatibility_policy_version: string; readonly compatibility_content_sha256: string; readonly workload_attestation_set_id: string; readonly workload_attestation_sha256: string; readonly license_attestation_set_id: string; readonly license_attestation_sha256: string }
interface AttemptRow { readonly request_key: string; readonly org_id: string; readonly customer_id: string; readonly connection_id: string; readonly scheduled_window: string; readonly state: "IN_PROGRESS" | "SUCCEEDED" | "FAILED"; readonly failure_code: string | null; readonly generation_id: string | null; readonly receipt_json: string | null; readonly lease_token_sha256: string; readonly lease_expires_at: number | string; readonly updated_at: number | string }
export class GravitonRuntimeRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "AUTHORITY_NOT_CONFIGURED" | "STORED_STATE_INVALID" | "BOUND_REACHED" | "ATTEMPT_IN_PROGRESS" | "LEASE_LOST";
  public constructor(code: GravitonRuntimeRepositoryError["code"]) { super("Graviton runtime state rejected"); this.name = "GravitonRuntimeRepositoryError"; this.code = code; }
}
function reject(code: GravitonRuntimeRepositoryError["code"]): never { throw new GravitonRuntimeRepositoryError(code); }
function validScope(scope: GravitonRuntimeScope): boolean { return ID.test(scope.organizationId) && ID.test(scope.customerId) && CONNECTION.test(scope.connectionId); }
function integer(value: number | string): number { const parsed = typeof value === "string" ? Number(value) : value; if (!Number.isSafeInteger(parsed) || parsed < 0) reject("STORED_STATE_INVALID"); return parsed; }
function window(value: string): boolean { return WINDOW.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
async function sha256(value: string): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join(""); }
const LIVE = `FROM aws_connections c JOIN organizations o ON o.id=c.org_id AND o.status='active' JOIN customers cu ON cu.id=c.customer_id AND cu.org_id=c.org_id AND cu.status IN ('active','trial') WHERE c.source_kind='aws_trust_role' AND c.status='active'`;

export class GravitonRuntimeRepository {
  private readonly leases = new Map<string, string>(); private readonly now: () => number;
  public constructor(private readonly database: D1Database = getRawDb(), options: { readonly now?: () => number; readonly skipRuntimeSchema?: boolean } = {}) { this.now = options.now ?? Date.now; this.skipRuntimeSchema = options.skipRuntimeSchema ?? false; }
  private readonly skipRuntimeSchema: boolean;
  private async ready() { if (!this.skipRuntimeSchema) await ensureRuntimeSchema(this.database); return this.database; }
  private clock() { const value = this.now(); if (!Number.isSafeInteger(value) || value < 0) reject("INVALID_INPUT"); return value; }
  public async bindProductionAuthorities(config:GravitonProductionAuthorityConfiguration):Promise<number>{
    const ids=[config.pricingCatalogVersion,config.compatibilityPolicyVersion,config.workloadAttestationSetId,config.licenseAttestationSetId],
      hashes=[config.pricingContentSha256,config.compatibilityContentSha256,config.workloadAttestationSha256,config.licenseAttestationSha256];
    if(ids.some(value=>!ID.test(value))||hashes.some(value=>!SHA.test(value)))reject("INVALID_INPUT");
    const db=await this.ready(),connections=await db.prepare(`SELECT c.org_id,c.customer_id,c.id AS connection_id
      ${LIVE} AND c.permission_pack_version=? ORDER BY c.id LIMIT ?`).bind(REQUIRED_PACK,MAX_SCOPES+1)
      .all<{org_id:string;customer_id:string;connection_id:string}>();const rows=connections.results??[];
    if(rows.length>MAX_SCOPES)reject("BOUND_REACHED");let bound=0;const now=this.clock();
    for(const row of rows){const cur2=await db.prepare(`SELECT active_generation_id,active_manifest_sha256
      FROM finops_export_partitions WHERE org_id=? AND customer_id=? AND connection_id=?
      AND active_generation_id IS NOT NULL AND active_manifest_sha256 IS NOT NULL
      ORDER BY active_committed_at DESC,billing_period DESC,id ASC LIMIT 1`).bind(row.org_id,row.customer_id,row.connection_id)
      .first<{active_generation_id:string;active_manifest_sha256:string}>();if(cur2===null||!ID.test(cur2.active_generation_id)
        ||!SHA.test(cur2.active_manifest_sha256))continue;
      await db.prepare(`INSERT INTO finops_graviton_runtime_authorities(org_id,customer_id,connection_id,cur2_generation_id,
        cur2_content_sha256,pricing_catalog_version,pricing_content_sha256,compatibility_policy_version,compatibility_content_sha256,
        workload_attestation_set_id,workload_attestation_sha256,license_attestation_set_id,license_attestation_sha256,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(org_id,customer_id,connection_id) DO UPDATE SET
        cur2_generation_id=excluded.cur2_generation_id,cur2_content_sha256=excluded.cur2_content_sha256,
        pricing_catalog_version=excluded.pricing_catalog_version,pricing_content_sha256=excluded.pricing_content_sha256,
        compatibility_policy_version=excluded.compatibility_policy_version,compatibility_content_sha256=excluded.compatibility_content_sha256,
        workload_attestation_set_id=excluded.workload_attestation_set_id,workload_attestation_sha256=excluded.workload_attestation_sha256,
        license_attestation_set_id=excluded.license_attestation_set_id,license_attestation_sha256=excluded.license_attestation_sha256,
        updated_at=excluded.updated_at`).bind(row.org_id,row.customer_id,row.connection_id,cur2.active_generation_id,
        cur2.active_manifest_sha256,config.pricingCatalogVersion,config.pricingContentSha256,config.compatibilityPolicyVersion,
        config.compatibilityContentSha256,config.workloadAttestationSetId,config.workloadAttestationSha256,
        config.licenseAttestationSetId,config.licenseAttestationSha256,now).run();bound+=1;}
    return bound;
  }
  public async listEligibleScopes(limit = MAX_SCOPES): Promise<readonly GravitonRuntimeScope[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SCOPES) reject("INVALID_INPUT");
    const rows = await (await this.ready()).prepare(`SELECT c.org_id,c.customer_id,c.id AS connection_id,c.aws_account_id AS account_id,c.partition,c.enabled_regions_json,c.permission_pack_version ${LIVE} AND c.permission_pack_version=? AND EXISTS(SELECT 1 FROM finops_graviton_runtime_authorities a WHERE a.org_id=c.org_id AND a.customer_id=c.customer_id AND a.connection_id=c.id) ORDER BY c.id LIMIT ?`).bind(REQUIRED_PACK, limit + 1).all<ConnectionRow>();
    if ((rows.results ?? []).length > limit) reject("BOUND_REACHED");
    return (rows.results ?? []).map((row) => Object.freeze({ organizationId: row.org_id, customerId: row.customer_id, connectionId: row.connection_id }));
  }
  private async primary(scope: GravitonRuntimeScope): Promise<ConnectionRow> {
    if (!validScope(scope)) reject("INVALID_INPUT");
    const row = await (await this.ready()).prepare(`SELECT c.org_id,c.customer_id,c.id AS connection_id,c.aws_account_id AS account_id,c.partition,c.enabled_regions_json,c.permission_pack_version ${LIVE} AND c.org_id=? AND c.customer_id=? AND c.id=? LIMIT 1`).bind(scope.organizationId, scope.customerId, scope.connectionId).first<ConnectionRow>();
    if (row === null) reject("SCOPE_NOT_FOUND");
    if (!ACCOUNT.test(row.account_id) || !["aws", "aws-cn", "aws-us-gov"].includes(row.partition) || row.permission_pack_version !== REQUIRED_PACK) reject("STORED_STATE_INVALID");
    return row;
  }
  private regions(rows: readonly ConnectionRow[]): readonly string[] {
    const result = new Set<string>();
    for (const row of rows) { let parsed: unknown; try { parsed = JSON.parse(row.enabled_regions_json); } catch { reject("STORED_STATE_INVALID"); }
      if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string" || !REGION.test(value))) reject("STORED_STATE_INVALID");
      for (const value of parsed) result.add(value as string); }
    const values = [...result].sort(); if (values.length < 1 || values.length > MAX_REGIONS) reject("BOUND_REACHED"); return values;
  }
  private async targets(scope: GravitonRuntimeScope, partition: GravitonTenantBoundary["partition"]): Promise<readonly ConnectionRow[]> {
    const rows = await (await this.ready()).prepare(`SELECT c.org_id,c.customer_id,c.id AS connection_id,c.aws_account_id AS account_id,c.partition,c.enabled_regions_json,c.permission_pack_version ${LIVE} AND c.org_id=? AND c.customer_id=? AND c.partition=? AND c.permission_pack_version=? ORDER BY c.aws_account_id,c.id LIMIT ?`).bind(scope.organizationId, scope.customerId, partition, REQUIRED_PACK, MAX_ACCOUNTS + 1).all<ConnectionRow>();
    const values = rows.results ?? []; if (values.length < 1) reject("SCOPE_NOT_FOUND"); if (values.length > MAX_ACCOUNTS) reject("BOUND_REACHED");
    if (new Set(values.map((row) => row.account_id)).size !== values.length || new Set(values.map((row) => row.connection_id)).size !== values.length) reject("STORED_STATE_INVALID"); return values;
  }
  public async loadBoundary(scope: GravitonRuntimeScope): Promise<GravitonTenantBoundary> {
    const primary = await this.primary(scope), targets = await this.targets(scope, primary.partition);
    if (!targets.some((row) => row.connection_id === primary.connection_id && row.account_id === primary.account_id)) reject("STORED_STATE_INVALID");
    return Object.freeze({ scope: Object.freeze({ orgId: scope.organizationId, customerId: scope.customerId, connectionId: scope.connectionId }), managementAccountId: primary.account_id, partition: primary.partition,
      accountIds: Object.freeze(targets.map((row) => row.account_id)), regions: Object.freeze(this.regions(targets)) });
  }
  public async loadProviderContext(request: GravitonMaterializationRequest): Promise<GravitonRuntimeProviderContext> {
    const scope = { organizationId: request.boundary.scope.orgId, customerId: request.boundary.scope.customerId, connectionId: request.boundary.scope.connectionId };
    const trusted = await this.loadBoundary(scope); if (JSON.stringify(trusted) !== JSON.stringify(request.boundary)) reject("STORED_STATE_INVALID");
    const targets = await this.targets(scope, trusted.partition);
    const authority = await (await this.ready()).prepare("SELECT * FROM finops_graviton_runtime_authorities WHERE org_id=? AND customer_id=? AND connection_id=? LIMIT 1").bind(scope.organizationId, scope.customerId, scope.connectionId).first<AuthorityRow>();
    if (authority === null) reject("AUTHORITY_NOT_CONFIGURED");
    const hashes = [authority.cur2_content_sha256, authority.pricing_content_sha256, authority.compatibility_content_sha256, authority.workload_attestation_sha256, authority.license_attestation_sha256];
    if (hashes.some((value) => !SHA.test(value))) reject("STORED_STATE_INVALID");
    return Object.freeze({ accountTargets: Object.freeze(targets.map((row) => Object.freeze({ accountId: row.account_id, connectionId: row.connection_id }))), evidenceAuthority: Object.freeze({
      cur2: Object.freeze({ generationId: authority.cur2_generation_id, contentSha256: authority.cur2_content_sha256 }),
      pricing: Object.freeze({ catalogVersion: authority.pricing_catalog_version, contentSha256: authority.pricing_content_sha256 }),
      compatibility: Object.freeze({ policyVersion: authority.compatibility_policy_version, contentSha256: authority.compatibility_content_sha256 }),
      workloadAttestations: Object.freeze({ setId: authority.workload_attestation_set_id, contentSha256: authority.workload_attestation_sha256 }),
      licenseAttestations: Object.freeze({ setId: authority.license_attestation_set_id, contentSha256: authority.license_attestation_sha256 }),
    }) });
  }
  public async prepareAttempt(scope: GravitonTenantBoundary["scope"], requestKey: `gvrq_${string}`, scheduledWindow: string): Promise<void> {
    const persistence = { organizationId: scope.orgId, customerId: scope.customerId, connectionId: scope.connectionId };
    if (!validScope(persistence) || !REQUEST.test(requestKey) || !window(scheduledWindow)) reject("INVALID_INPUT"); await this.primary(persistence);
    const now = this.clock(), lease = await sha256(crypto.randomUUID());
    await (await this.ready()).prepare("INSERT INTO finops_graviton_runtime_attempts(request_key,org_id,customer_id,connection_id,scheduled_window,state,failure_code,generation_id,receipt_json,lease_token_sha256,lease_expires_at,started_at,completed_at,updated_at) VALUES(?,?,?,?,?,'FAILED','NOT_STARTED',NULL,NULL,?,?,?, ?,?) ON CONFLICT(request_key) DO NOTHING").bind(requestKey, scope.orgId, scope.customerId, scope.connectionId, scheduledWindow, lease, now, now, now, now).run();
  }
  public async loadReceipt(scope: GravitonTenantBoundary["scope"], requestKey: `gvrq_${string}`): Promise<GravitonRuntimeReceipt | null> {
    if (!REQUEST.test(requestKey)) reject("INVALID_INPUT"); const db = await this.ready(), now = this.clock();
    const row = await db.prepare("SELECT * FROM finops_graviton_runtime_attempts WHERE request_key=? AND org_id=? AND customer_id=? AND connection_id=? LIMIT 1").bind(requestKey, scope.orgId, scope.customerId, scope.connectionId).first<AttemptRow>();
    if (row === null) reject("STORED_STATE_INVALID");
    if (row.state === "SUCCEEDED") {
      if (row.receipt_json === null || row.generation_id === null) reject("STORED_STATE_INVALID");
      try {
        const receipt = JSON.parse(row.receipt_json) as GravitonRuntimeReceipt;
        if (receipt.requestKey !== row.request_key || receipt.generationId !== row.generation_id
          || receipt.scheduledWindow !== row.scheduled_window || receipt.scope.orgId !== row.org_id
          || receipt.scope.customerId !== row.customer_id || receipt.scope.connectionId !== row.connection_id) reject("STORED_STATE_INVALID");
        return receipt;
      } catch (error) { if (error instanceof GravitonRuntimeRepositoryError) throw error; reject("STORED_STATE_INVALID"); }
    }
    if (row.state === "IN_PROGRESS" && integer(row.lease_expires_at) > now) reject("ATTEMPT_IN_PROGRESS");
    const lease = await sha256(crypto.randomUUID());
    const result = await db.prepare("UPDATE finops_graviton_runtime_attempts SET state='IN_PROGRESS',failure_code=NULL,generation_id=NULL,receipt_json=NULL,lease_token_sha256=?,lease_expires_at=?,completed_at=NULL,updated_at=? WHERE request_key=? AND state<>'SUCCEEDED' AND (state='FAILED' OR lease_expires_at<=?)").bind(lease, now + LEASE_MS, now, requestKey, now).run();
    if ((result.meta?.changes ?? 0) !== 1) reject("LEASE_LOST"); this.leases.set(requestKey, lease); return null;
  }
  public async recordReceipt(receipt: GravitonRuntimeReceipt): Promise<void> {
    if (!REQUEST.test(receipt.requestKey) || !/^gvg_[a-f0-9]{64}$/u.test(receipt.generationId)
      || !window(receipt.scheduledWindow) || !ID.test(receipt.scope.orgId) || !ID.test(receipt.scope.customerId)
      || !CONNECTION.test(receipt.scope.connectionId)) reject("INVALID_INPUT");
    const lease = this.leases.get(receipt.requestKey); if (lease === undefined) reject("LEASE_LOST"); const now = this.clock(), json = JSON.stringify(receipt);
    if (new TextEncoder().encode(json).byteLength > 65_536) reject("INVALID_INPUT");
    const result = await (await this.ready()).prepare("UPDATE finops_graviton_runtime_attempts SET state='SUCCEEDED',generation_id=?,receipt_json=?,completed_at=?,updated_at=? WHERE request_key=? AND state='IN_PROGRESS' AND lease_token_sha256=? AND lease_expires_at>=?").bind(receipt.generationId, json, now, now, receipt.requestKey, lease, now).run();
    if ((result.meta?.changes ?? 0) !== 1) reject("LEASE_LOST"); this.leases.delete(receipt.requestKey);
  }
  public async recordFailure(scope: GravitonTenantBoundary["scope"], requestKey: `gvrq_${string}`, code: "COLLECTION_FAILED" | "EVIDENCE_REJECTED"): Promise<void> {
    const lease = this.leases.get(requestKey); if (lease === undefined) return; const now = this.clock();
    const result = await (await this.ready()).prepare("UPDATE finops_graviton_runtime_attempts SET state='FAILED',failure_code=?,completed_at=?,updated_at=? WHERE request_key=? AND org_id=? AND customer_id=? AND connection_id=? AND state='IN_PROGRESS' AND lease_token_sha256=?").bind(code, now, now, requestKey, scope.orgId, scope.customerId, scope.connectionId, lease).run();
    if ((result.meta?.changes ?? 0) !== 1) reject("LEASE_LOST"); this.leases.delete(requestKey);
  }
  public async getRuntimeStatus(scope: GravitonRuntimeScope): Promise<GravitonRuntimeStatus> {
    if (!validScope(scope)) reject("INVALID_INPUT");
    const row = await (await this.ready()).prepare("SELECT * FROM finops_graviton_runtime_attempts WHERE org_id=? AND customer_id=? AND connection_id=? ORDER BY updated_at DESC,request_key DESC LIMIT 1").bind(scope.organizationId, scope.customerId, scope.connectionId).first<AttemptRow>();
    if (row === null) return { state: "unavailable", reason: "GRAVITON_COLLECTION_NOT_STARTED", lastAttemptAt: null };
    const at = new Date(integer(row.updated_at)).toISOString();
    if (row.state === "IN_PROGRESS") return integer(row.lease_expires_at) > this.clock() ? { state: "collecting", reason: "GRAVITON_COLLECTION_IN_PROGRESS", lastAttemptAt: at } : { state: "failed", reason: "GRAVITON_COLLECTION_LEASE_EXPIRED", lastAttemptAt: at };
    if (row.state === "FAILED") return { state: "failed", reason: row.failure_code ?? "GRAVITON_COLLECTION_FAILED", lastAttemptAt: at };
    return { state: "ready", reason: "GRAVITON_COLLECTION_READY", lastAttemptAt: at };
  }
}
