import { canonicalJson } from "../lib/canonical-json";
import {
  buildSbomComponentDiff,
  type SbomComponentDiffReport,
} from "../lib/kubernetes-sbom-diff";
import {
  evaluateSbomLicensePolicy,
  normalizeObservedLicenses,
  normalizeSbomLicensePolicy,
  type SbomLicenseEvaluation,
  type SbomLicensePolicy,
} from "../lib/kubernetes-sbom-license";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

const CLUSTER_ID = /^kcluster_[a-f0-9]{48}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,253}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAX_ROWS = 20;
const MAX_COMPONENTS_INSPECTED = 25_000;

export interface KubernetesSbomScope {
  readonly orgId: string;
  readonly customerId: string;
  readonly clusterId: string;
}

export interface KubernetesSbomHistoryItem {
  readonly scanRunId: string;
  readonly collectedAt: string;
  readonly evidenceSha256: string;
  readonly reportFingerprint: string;
  readonly namespace: string | null;
  readonly reportName: string;
  readonly imageRepository: string | null;
  readonly imageDigest: string | null;
  readonly imageTag: string | null;
  readonly format: string | null;
  readonly specVersion: string | null;
  readonly componentCount: number;
  readonly declaredComponentCount: number | null;
  readonly scannerName: string;
  readonly scannerVersion: string;
}

export interface KubernetesSbomComponentMatch {
  readonly scanRunId: string;
  readonly collectedAt: string;
  readonly reportFingerprint: string;
  readonly imageRepository: string | null;
  readonly imageDigest: string | null;
  readonly namespace: string | null;
  readonly component: {
    readonly fingerprint: string;
    readonly type: string | null;
    readonly name: string;
    readonly version: string | null;
    readonly packageUrl: string | null;
    readonly licenses: readonly string[];
  };
}

export interface KubernetesSbomComponentSearch {
  readonly matches: readonly KubernetesSbomComponentMatch[];
  readonly componentsInspected: number;
  readonly truncated: boolean;
}

export interface StoredSbomLicensePolicy {
  readonly id: string;
  readonly version: number;
  readonly policy: SbomLicensePolicy;
  readonly policySha256: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

interface ScannerRow {
  scan_run_id: string;
  collected_at: number;
  findings_json: string;
  sboms_json: string;
  evidence_sha256: string;
  finding_count: number;
  sbom_count: number;
}

interface PolicyRow {
  policy_id: string;
  version: number;
  policy_json: string;
  policy_sha256: string;
  created_by: string;
  created_at: number;
}

interface ParsedComponent {
  fingerprint: string;
  type: string | null;
  name: string;
  version: string | null;
  packageUrl: string | null;
  licenses: readonly string[];
}

interface ParsedSbom {
  fingerprint: string;
  namespace: string | null;
  reportName: string;
  artifact: { repository: string | null; digest: string | null; tag: string | null };
  bomFormat: string | null;
  specVersion: string | null;
  declaredComponentCount: number | null;
  components: readonly ParsedComponent[];
  scanner: { name: string; version: string };
}

export class KubernetesSbomRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "VERSION_CONFLICT" | "EVIDENCE_MISMATCH";

  public constructor(code: KubernetesSbomRepositoryError["code"]) {
    super("Kubernetes SBOM persistence operation rejected");
    this.name = "KubernetesSbomRepositoryError";
    this.code = code;
  }
}

function invalid(): never {
  throw new KubernetesSbomRepositoryError("INVALID_INPUT");
}

function scopeValid(scope: KubernetesSbomScope): void {
  if (!IDENTIFIER.test(scope.orgId) || !IDENTIFIER.test(scope.customerId) || !CLUSTER_ID.test(scope.clusterId)) invalid();
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new KubernetesSbomRepositoryError("EVIDENCE_MISMATCH");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" || value.length < 1 || value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new KubernetesSbomRepositoryError("EVIDENCE_MISMATCH");
  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseComponent(value: unknown): ParsedComponent {
  const item = object(value);
  const fingerprint = text(item.fingerprint, 64);
  if (fingerprint === null || !HASH.test(fingerprint)) throw new KubernetesSbomRepositoryError("EVIDENCE_MISMATCH");
  let licenses: readonly string[];
  try {
    licenses = normalizeObservedLicenses(item.licenses);
  } catch {
    throw new KubernetesSbomRepositoryError("EVIDENCE_MISMATCH");
  }
  return {
    fingerprint,
    type: text(item.type, 128, true),
    name: text(item.name, 1_024) ?? "",
    version: text(item.version, 512, true),
    packageUrl: text(item.packageUrl, 2_048, true),
    licenses,
  };
}

function parseSbom(value: unknown): ParsedSbom {
  const item = object(value);
  const artifact = object(item.artifact);
  const scanner = object(item.scanner);
  if (!Array.isArray(item.components) || item.components.length > 5_000) {
    throw new KubernetesSbomRepositoryError("EVIDENCE_MISMATCH");
  }
  const fingerprint = text(item.fingerprint, 64);
  const digest = text(artifact.digest, 256, true);
  if (fingerprint === null || !HASH.test(fingerprint) || (digest !== null && !DIGEST.test(digest))) {
    throw new KubernetesSbomRepositoryError("EVIDENCE_MISMATCH");
  }
  const declared = item.declaredComponentCount;
  if (declared !== null && (!Number.isSafeInteger(declared) || Number(declared) < 0 || Number(declared) > 1_000_000)) {
    throw new KubernetesSbomRepositoryError("EVIDENCE_MISMATCH");
  }
  return {
    fingerprint,
    namespace: text(item.namespace, 253, true),
    reportName: text(item.reportName, 253) ?? "",
    artifact: {
      repository: text(artifact.repository, 1_024, true),
      digest,
      tag: text(artifact.tag, 512, true),
    },
    bomFormat: text(item.bomFormat, 128, true),
    specVersion: text(item.specVersion, 64, true),
    declaredComponentCount: declared === null ? null : Number(declared),
    components: item.components.map(parseComponent),
    scanner: {
      name: text(scanner.name, 128) ?? "",
      version: text(scanner.version, 128) ?? "",
    },
  };
}

async function parseRow(row: ScannerRow): Promise<readonly ParsedSbom[]> {
  if (!HASH.test(row.evidence_sha256) || !Number.isSafeInteger(row.collected_at)) {
    throw new KubernetesSbomRepositoryError("EVIDENCE_MISMATCH");
  }
  let findings: unknown;
  let sboms: unknown;
  try {
    findings = JSON.parse(row.findings_json);
    sboms = JSON.parse(row.sboms_json);
  } catch {
    throw new KubernetesSbomRepositoryError("EVIDENCE_MISMATCH");
  }
  if (
    !Array.isArray(findings) || !Array.isArray(sboms) ||
    findings.length !== Number(row.finding_count) ||
    sboms.length !== Number(row.sbom_count) ||
    await sha256(canonicalJson({ findings, sboms })) !== row.evidence_sha256
  ) throw new KubernetesSbomRepositoryError("EVIDENCE_MISMATCH");
  return sboms.map(parseSbom);
}

function storedPolicy(row: PolicyRow): StoredSbomLicensePolicy {
  if (!HASH.test(row.policy_sha256) || !Number.isSafeInteger(row.version) || row.version < 1) {
    throw new KubernetesSbomRepositoryError("EVIDENCE_MISMATCH");
  }
  let policy: SbomLicensePolicy;
  try {
    policy = normalizeSbomLicensePolicy(JSON.parse(row.policy_json));
  } catch {
    throw new KubernetesSbomRepositoryError("EVIDENCE_MISMATCH");
  }
  return {
    id: row.policy_id,
    version: row.version,
    policy,
    policySha256: row.policy_sha256,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export class KubernetesSbomRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  private async rows(scope: KubernetesSbomScope, limit: number): Promise<readonly ScannerRow[]> {
    scopeValid(scope);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROWS) invalid();
    const db = await this.ready();
    const result = await db.prepare(
      `SELECT s.scan_run_id, r.collected_at, s.findings_json, s.sboms_json,
              s.evidence_sha256, s.finding_count, s.sbom_count
         FROM kubernetes_scan_scanner_evidence s
         JOIN kubernetes_scan_runs r ON r.id = s.scan_run_id
        WHERE s.org_id = ? AND s.customer_id = ? AND s.cluster_id = ?
          AND r.org_id = ? AND r.customer_id = ? AND r.cluster_id = ?
        ORDER BY r.collected_at DESC, s.scan_run_id DESC
        LIMIT ?`,
    ).bind(
      scope.orgId, scope.customerId, scope.clusterId,
      scope.orgId, scope.customerId, scope.clusterId, limit,
    ).all<ScannerRow>();
    return result.results ?? [];
  }

  public async history(scope: KubernetesSbomScope, limit = 10): Promise<readonly KubernetesSbomHistoryItem[]> {
    const result: KubernetesSbomHistoryItem[] = [];
    for (const row of await this.rows(scope, limit)) {
      for (const sbom of await parseRow(row)) {
        result.push({
          scanRunId: row.scan_run_id,
          collectedAt: new Date(row.collected_at).toISOString(),
          evidenceSha256: row.evidence_sha256,
          reportFingerprint: sbom.fingerprint,
          namespace: sbom.namespace,
          reportName: sbom.reportName,
          imageRepository: sbom.artifact.repository,
          imageDigest: sbom.artifact.digest,
          imageTag: sbom.artifact.tag,
          format: sbom.bomFormat,
          specVersion: sbom.specVersion,
          componentCount: sbom.components.length,
          declaredComponentCount: sbom.declaredComponentCount,
          scannerName: sbom.scanner.name,
          scannerVersion: sbom.scanner.version,
        });
      }
    }
    return result;
  }

  public async search(
    scope: KubernetesSbomScope,
    query: string,
    limit = 100,
    scanLimit = 10,
  ): Promise<KubernetesSbomComponentSearch> {
    if (
      query.trim() !== query || query.length < 2 || query.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(query) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 200
    ) invalid();
    const needle = query.toLocaleLowerCase("en-US");
    const matches: KubernetesSbomComponentMatch[] = [];
    let componentsInspected = 0;
    let truncated = false;
    outer: for (const row of await this.rows(scope, scanLimit)) {
      for (const sbom of await parseRow(row)) {
        for (const component of sbom.components) {
          if (componentsInspected >= MAX_COMPONENTS_INSPECTED) {
            truncated = true;
            break outer;
          }
          componentsInspected += 1;
          const haystack = [
            component.name, component.version ?? "", component.packageUrl ?? "",
            component.type ?? "", ...component.licenses,
          ].join(" ").toLocaleLowerCase("en-US");
          if (!haystack.includes(needle)) continue;
          if (matches.length >= limit) {
            truncated = true;
            break outer;
          }
          matches.push({
            scanRunId: row.scan_run_id,
            collectedAt: new Date(row.collected_at).toISOString(),
            reportFingerprint: sbom.fingerprint,
            imageRepository: sbom.artifact.repository,
            imageDigest: sbom.artifact.digest,
            namespace: sbom.namespace,
            component,
          });
        }
      }
    }
    return { matches, componentsInspected, truncated };
  }

  public async publishPolicyVersion(
    scope: KubernetesSbomScope,
    input: unknown,
    actorId: string,
    expectedVersion: number,
  ): Promise<StoredSbomLicensePolicy> {
    scopeValid(scope);
    if (
      !IDENTIFIER.test(actorId) ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0 ||
      expectedVersion > 1_000_000
    ) invalid();
    let policy: SbomLicensePolicy;
    try {
      policy = normalizeSbomLicensePolicy(input);
    } catch {
      invalid();
    }
    const policyId = `klp_${(await sha256(`${scope.orgId}\0${scope.customerId}\0${scope.clusterId}\0${policy.name}`)).slice(0, 48)}`;
    const version = expectedVersion + 1;
    const policyJson = canonicalJson(policy);
    const policySha256 = await sha256(policyJson);
    const versionId = `klpv_${(await sha256(`${policyId}\0${version}\0${policySha256}`)).slice(0, 48)}`;
    const now = Date.now();
    const db = await this.ready();
    const statements = [
      db.prepare(
        `INSERT OR IGNORE INTO kubernetes_sbom_license_policy_versions
          (id, policy_id, version, org_id, customer_id, cluster_id, policy_name,
           policy_json, policy_sha256, created_by, created_at)
         SELECT ?, ?, ?, c.org_id, c.customer_id, c.id, ?, ?, ?, ?, ?
           FROM kubernetes_clusters c
          WHERE c.id = ? AND c.org_id = ? AND c.customer_id = ? AND c.status = 'active'
            AND (
              (? = 0 AND NOT EXISTS (
                SELECT 1 FROM kubernetes_sbom_license_policy_heads h WHERE h.policy_id = ?
              ))
              OR EXISTS (
                SELECT 1 FROM kubernetes_sbom_license_policy_heads h
                 WHERE h.policy_id = ? AND h.org_id = ? AND h.customer_id = ?
                   AND h.cluster_id = ? AND h.current_version = ?
              )
            )`,
      ).bind(
        versionId, policyId, version, policy.name, policyJson, policySha256, actorId, now,
        scope.clusterId, scope.orgId, scope.customerId,
        expectedVersion, policyId, policyId, scope.orgId, scope.customerId, scope.clusterId, expectedVersion,
      ),
      expectedVersion === 0
        ? db.prepare(
          `INSERT OR IGNORE INTO kubernetes_sbom_license_policy_heads
            (policy_id, org_id, customer_id, cluster_id, policy_name,
             current_version, current_version_id, updated_at)
           SELECT policy_id, org_id, customer_id, cluster_id, policy_name, version, id, ?
             FROM kubernetes_sbom_license_policy_versions
            WHERE id = ? AND version = 1`,
        ).bind(now, versionId)
        : db.prepare(
          `UPDATE kubernetes_sbom_license_policy_heads
              SET current_version = ?, current_version_id = ?, updated_at = ?
            WHERE policy_id = ? AND org_id = ? AND customer_id = ? AND cluster_id = ?
              AND current_version = ? AND EXISTS (
                SELECT 1 FROM kubernetes_sbom_license_policy_versions v
                 WHERE v.id = ? AND v.policy_id = kubernetes_sbom_license_policy_heads.policy_id
              )`,
        ).bind(
          version, versionId, now, policyId, scope.orgId, scope.customerId,
          scope.clusterId, expectedVersion, versionId,
        ),
    ];
    await db.batch(statements);
    const stored = await this.getPolicy(scope, policyId);
    if (stored === null) throw new KubernetesSbomRepositoryError("SCOPE_NOT_FOUND");
    if (stored.version !== version || stored.policySha256 !== policySha256) {
      throw new KubernetesSbomRepositoryError("VERSION_CONFLICT");
    }
    return stored;
  }

  public async getPolicy(scope: KubernetesSbomScope, policyId: string): Promise<StoredSbomLicensePolicy | null> {
    scopeValid(scope);
    if (!/^klp_[a-f0-9]{48}$/u.test(policyId)) invalid();
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT v.policy_id, v.version, v.policy_json, v.policy_sha256, v.created_by, v.created_at
         FROM kubernetes_sbom_license_policy_heads h
         JOIN kubernetes_sbom_license_policy_versions v ON v.id = h.current_version_id
        WHERE h.policy_id = ? AND h.org_id = ? AND h.customer_id = ? AND h.cluster_id = ?
          AND v.org_id = ? AND v.customer_id = ? AND v.cluster_id = ?
        LIMIT 1`,
    ).bind(
      policyId, scope.orgId, scope.customerId, scope.clusterId,
      scope.orgId, scope.customerId, scope.clusterId,
    ).first<PolicyRow>();
    return row === null ? null : storedPolicy(row);
  }

  public async listPolicies(scope: KubernetesSbomScope): Promise<readonly StoredSbomLicensePolicy[]> {
    scopeValid(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT v.policy_id, v.version, v.policy_json, v.policy_sha256, v.created_by, v.created_at
         FROM kubernetes_sbom_license_policy_heads h
         JOIN kubernetes_sbom_license_policy_versions v ON v.id = h.current_version_id
        WHERE h.org_id = ? AND h.customer_id = ? AND h.cluster_id = ?
          AND v.org_id = ? AND v.customer_id = ? AND v.cluster_id = ?
        ORDER BY h.policy_name ASC, h.policy_id ASC
        LIMIT 100`,
    ).bind(
      scope.orgId, scope.customerId, scope.clusterId,
      scope.orgId, scope.customerId, scope.clusterId,
    ).all<PolicyRow>();
    return (rows.results ?? []).map(storedPolicy);
  }

  public async evaluateLatest(
    scope: KubernetesSbomScope,
    policyId: string,
    limit = 2_000,
  ): Promise<{ readonly policy: StoredSbomLicensePolicy; readonly evaluation: SbomLicenseEvaluation; readonly scanRunId: string | null; readonly collectedAt: string | null }> {
    const policy = await this.getPolicy(scope, policyId);
    if (policy === null) throw new KubernetesSbomRepositoryError("SCOPE_NOT_FOUND");
    const [row] = await this.rows(scope, 1);
    if (row === undefined) {
      return {
        policy,
        evaluation: {
          ...evaluateSbomLicensePolicy(policy.policy, [], limit),
          status: "not_evaluated",
        },
        scanRunId: null,
        collectedAt: null,
      };
    }
    const components = (await parseRow(row)).flatMap((sbom) => sbom.components.map((component) => ({
      fingerprint: component.fingerprint,
      name: component.name,
      version: component.version,
      licenses: component.licenses,
    })));
    return {
      policy,
      evaluation: evaluateSbomLicensePolicy(policy.policy, components, limit),
      scanRunId: row.scan_run_id,
      collectedAt: new Date(row.collected_at).toISOString(),
    };
  }

  /** SBOM component drift between the two most recent scans of a cluster. */
  public async diffLatest(scope: KubernetesSbomScope): Promise<{
    readonly diff: SbomComponentDiffReport;
    readonly currentScanRunId: string | null;
    readonly previousScanRunId: string | null;
    readonly collectedAt: string | null;
    readonly previousCollectedAt: string | null;
  }> {
    const [current, previous] = await this.rows(scope, 2);
    const flatten = async (row: ScannerRow | undefined) =>
      row === undefined ? null : (await parseRow(row)).flatMap((sbom) => sbom.components.map((component) => ({
        name: component.name,
        version: component.version,
        packageUrl: component.packageUrl,
        type: component.type,
        licenses: component.licenses ?? [],
      })));
    const currentComponents = (await flatten(current)) ?? [];
    return {
      diff: buildSbomComponentDiff({ current: currentComponents, previous: await flatten(previous) }),
      currentScanRunId: current?.scan_run_id ?? null,
      previousScanRunId: previous?.scan_run_id ?? null,
      collectedAt: current === undefined ? null : new Date(current.collected_at).toISOString(),
      previousCollectedAt: previous === undefined ? null : new Date(previous.collected_at).toISOString(),
    };
  }
}
