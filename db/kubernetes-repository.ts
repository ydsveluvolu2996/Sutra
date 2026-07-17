import { canonicalJson } from "../lib/canonical-json";
import {
  evaluateKubernetesPosture,
  normalizeKubernetesEvidence,
  type KubernetesEvidenceKind,
  type KubernetesEvidenceSnapshot,
  type KubernetesPostureReport,
} from "../lib/kubernetes-posture";
import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import { normalizeObservedLicenses } from "../lib/kubernetes-sbom-license";
import type {
  TrivyOperatorFinding,
  TrivySbomEvidence,
} from "../services/kubernetes-collector/src/types";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{7,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_ATOMIC_ROWS = 1_000;
const COMPLETE_KINDS = new Set<KubernetesEvidenceKind>([
  "Workload", "Service", "Ingress", "RbacRole", "Namespace", "NetworkPolicy",
]);

export interface KubernetesTenantScope {
  readonly orgId: string;
  readonly customerId: string;
}

export interface KubernetesCoverageInput {
  readonly evidenceKind: KubernetesEvidenceKind;
  readonly state: "COMPLETE" | "PARTIAL" | "UNKNOWN" | "FAILED";
  readonly itemsObserved: number;
  readonly errorCode?: string;
}

export interface StoredKubernetesScan {
  readonly id: string;
  readonly orgId: string;
  readonly customerId: string;
  readonly clusterId: string;
  readonly status: "complete" | "partial" | "failed";
  readonly collectedAt: string;
  readonly evidenceSha256: string;
  readonly postureSha256: string;
  readonly resourceCount: number;
  readonly findingCount: number;
  readonly coverageCount: number;
}

export interface StoredKubernetesCluster {
  readonly id: string;
  readonly clusterUid: string;
  readonly name: string;
  readonly distribution: string | null;
  readonly version: string | null;
  readonly status: "active" | "disabled";
  readonly latestCompleteScan: StoredKubernetesScan | null;
}

export interface KubernetesStoredFinding {
  readonly controlId: string;
  readonly subject: string;
  readonly state: "PASS" | "FAIL" | "UNKNOWN";
  readonly severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly message: string;
  readonly evidence: readonly string[];
}

export interface KubernetesStoredWorkspace {
  readonly cluster: StoredKubernetesCluster;
  readonly scan: StoredKubernetesScan | null;
  readonly resources: readonly KubernetesEvidenceSnapshot["resources"][number][];
  readonly findings: readonly KubernetesStoredFinding[];
  readonly coverage: readonly KubernetesCoverageInput[];
  readonly scannerEvidence: KubernetesScannerEvidence;
}

export interface KubernetesScannerEvidence {
  readonly findings: readonly TrivyOperatorFinding[];
  readonly sboms: readonly TrivySbomEvidence[];
}

interface ScanRow {
  id: string;
  org_id: string;
  customer_id: string;
  cluster_id: string;
  status: StoredKubernetesScan["status"];
  collected_at: number;
  evidence_sha256: string;
  posture_sha256: string;
  resource_count: number;
  finding_count: number;
  coverage_count: number;
}

export class KubernetesRepositoryError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "IDEMPOTENCY_CONFLICT";

  public constructor(
    code: "INVALID_INPUT" | "SCOPE_NOT_FOUND" | "IDEMPOTENCY_CONFLICT",
  ) {
    super("Kubernetes persistence operation rejected");
    this.name = "KubernetesRepositoryError";
    this.code = code;
  }
}

function validIdentifier(value: string): boolean {
  return IDENTIFIER.test(value);
}

function assertScope(scope: KubernetesTenantScope): void {
  if (!validIdentifier(scope.orgId) || !validIdentifier(scope.customerId)) {
    throw new KubernetesRepositoryError("INVALID_INPUT");
  }
}

function assertPlainText(value: string | undefined, maximum: number): string | null {
  if (value === undefined) return null;
  if (value.length < 1 || value.length > maximum || /[\0\r\n]/u.test(value)) {
    throw new KubernetesRepositoryError("INVALID_INPUT");
  }
  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

async function deterministicId(prefix: string, value: string): Promise<string> {
  return `${prefix}_${(await sha256(value)).slice(0, 48)}`;
}

function storedScan(row: ScanRow): StoredKubernetesScan {
  if (!HASH.test(row.evidence_sha256) || !HASH.test(row.posture_sha256)) {
    throw new KubernetesRepositoryError("INVALID_INPUT");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    customerId: row.customer_id,
    clusterId: row.cluster_id,
    status: row.status,
    collectedAt: new Date(Number(row.collected_at)).toISOString(),
    evidenceSha256: row.evidence_sha256,
    postureSha256: row.posture_sha256,
    resourceCount: Number(row.resource_count),
    findingCount: Number(row.finding_count),
    coverageCount: Number(row.coverage_count),
  };
}

export class KubernetesRepository {
  private readonly database: D1Database;

  public constructor(database: D1Database = getRawDb()) {
    this.database = database;
  }

  private async ready(): Promise<D1Database> {
    await ensureRuntimeSchema(this.database);
    return this.database;
  }

  public async registerCluster(input: {
    readonly scope: KubernetesTenantScope;
    readonly clusterUid: string;
    readonly name: string;
    readonly distribution?: string;
    readonly version?: string;
  }): Promise<{ readonly id: string; readonly clusterUid: string; readonly name: string }> {
    assertScope(input.scope);
    if (!validIdentifier(input.clusterUid)) throw new KubernetesRepositoryError("INVALID_INPUT");
    const name = assertPlainText(input.name, 253);
    if (name === null) throw new KubernetesRepositoryError("INVALID_INPUT");
    const distribution = assertPlainText(input.distribution, 128);
    const version = assertPlainText(input.version, 128);
    const id = await deterministicId(
      "kcluster",
      `${input.scope.orgId}\0${input.scope.customerId}\0${input.clusterUid}`,
    );
    const db = await this.ready();
    await db.prepare(
      `INSERT INTO kubernetes_clusters
        (id, org_id, customer_id, cluster_uid, name, distribution, version, status)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'active'
        WHERE EXISTS (
          SELECT 1 FROM customers
           WHERE id = ? AND org_id = ? AND status IN ('active', 'trial')
        )
       ON CONFLICT (org_id, customer_id, cluster_uid) DO NOTHING`,
    ).bind(
      id, input.scope.orgId, input.scope.customerId, input.clusterUid,
      name, distribution, version, input.scope.customerId, input.scope.orgId,
    ).run();
    const row = await db.prepare(
      `SELECT id, cluster_uid, name FROM kubernetes_clusters
        WHERE org_id = ? AND customer_id = ? AND cluster_uid = ? AND status = 'active'
        LIMIT 1`,
    ).bind(input.scope.orgId, input.scope.customerId, input.clusterUid)
      .first<{ id: string; cluster_uid: string; name: string }>();
    if (row === null) throw new KubernetesRepositoryError("SCOPE_NOT_FOUND");
    return { id: row.id, clusterUid: row.cluster_uid, name: row.name };
  }

  public async publishScan(input: {
    readonly scope: KubernetesTenantScope;
    readonly clusterId: string;
    readonly idempotencyKey: string;
    readonly status: "complete" | "partial" | "failed";
    readonly evidence: KubernetesEvidenceSnapshot;
    readonly coverage: readonly KubernetesCoverageInput[];
    readonly scannerEvidence?: KubernetesScannerEvidence;
  }): Promise<StoredKubernetesScan> {
    assertScope(input.scope);
    if (!validIdentifier(input.clusterId) || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw new KubernetesRepositoryError("INVALID_INPUT");
    }
    const evidence = normalizeKubernetesEvidence(input.evidence);
    const scannerEvidence = normalizeScannerEvidence(input.scannerEvidence ?? {
      findings: [],
      sboms: [],
    });
    if (
      scannerEvidence.findings.some((item) => item.clusterId !== evidence.clusterId) ||
      scannerEvidence.sboms.some((item) => item.clusterId !== evidence.clusterId)
    ) throw new KubernetesRepositoryError("INVALID_INPUT");
    const posture = evaluateKubernetesPosture(evidence);
    const coverage = validateCoverage(evidence, input.coverage);
    if (
      input.status === "complete" &&
      (
        coverage.some((item) => item.state !== "COMPLETE") ||
        evidence.observedKinds.length !== COMPLETE_KINDS.size ||
        evidence.observedKinds.some((kind) => !COMPLETE_KINDS.has(kind))
      )
    ) {
      throw new KubernetesRepositoryError("INVALID_INPUT");
    }
    const totalRows = evidence.resources.length + posture.results.length + coverage.length + 1;
    if (totalRows > MAX_ATOMIC_ROWS) throw new KubernetesRepositoryError("INVALID_INPUT");

    const evidenceJson = canonicalJson({ evidence, scannerEvidence });
    const postureJson = canonicalJson(posture);
    const scannerFindingsJson = canonicalJson(scannerEvidence.findings);
    const scannerSbomsJson = canonicalJson(scannerEvidence.sboms);
    if (evidenceJson.length > 4 * 1024 * 1024 || postureJson.length > 2 * 1024 * 1024) {
      throw new KubernetesRepositoryError("INVALID_INPUT");
    }
    const [evidenceSha256, postureSha256] = await Promise.all([
      sha256(evidenceJson), sha256(postureJson),
    ]);
    const scanId = await deterministicId(
      "kscan",
      `${input.scope.orgId}\0${input.clusterId}\0${input.idempotencyKey}`,
    );
    const db = await this.ready();
    const existing = await this.getScanById(input.scope, input.clusterId, scanId);
    if (existing !== null) {
      if (
        existing.evidenceSha256 !== evidenceSha256 ||
        existing.postureSha256 !== postureSha256 ||
        existing.status !== input.status
      ) {
        throw new KubernetesRepositoryError("IDEMPOTENCY_CONFLICT");
      }
      return existing;
    }

    const collectedAt = Date.parse(evidence.collectedAt);
    const statements: D1PreparedStatement[] = [
      db.prepare(
        `INSERT INTO kubernetes_scan_runs
          (id, org_id, customer_id, cluster_id, status, collected_at,
           idempotency_key, evidence_sha256, posture_sha256,
           resource_count, finding_count, coverage_count)
         SELECT ?, c.org_id, c.customer_id, c.id, ?, ?, ?, ?, ?, ?, ?, ?
           FROM kubernetes_clusters c
          WHERE c.id = ? AND c.org_id = ? AND c.customer_id = ?
            AND c.cluster_uid = ? AND c.status = 'active'`,
      ).bind(
        scanId, input.status, collectedAt, input.idempotencyKey,
        evidenceSha256, postureSha256, evidence.resources.length,
        posture.results.length, coverage.length, input.clusterId,
        input.scope.orgId, input.scope.customerId, evidence.clusterId,
      ),
    ];

    for (const resource of evidence.resources) {
      const resourceKey = `${resource.kind}/${resource.namespace ?? ""}/${resource.name}`;
      const resourceJson = canonicalJson(resource);
      statements.push(db.prepare(
        `INSERT INTO kubernetes_scan_resources
          (id, org_id, customer_id, cluster_id, scan_run_id, resource_key,
           kind, namespace, name, evidence_json, evidence_sha256)
         SELECT ?, r.org_id, r.customer_id, r.cluster_id, r.id, ?, ?, ?, ?, ?, ?
           FROM kubernetes_scan_runs r
          WHERE r.id = ? AND r.org_id = ? AND r.customer_id = ? AND r.cluster_id = ?`,
      ).bind(
        await deterministicId("kres", `${scanId}\0${resourceKey}`),
        resourceKey, resource.kind, resource.namespace, resource.name,
        resourceJson, await sha256(resourceJson), scanId,
        input.scope.orgId, input.scope.customerId, input.clusterId,
      ));
    }
    for (const finding of posture.results) {
      const findingJson = canonicalJson(finding.evidence);
      statements.push(db.prepare(
        `INSERT INTO kubernetes_scan_findings
          (id, org_id, customer_id, cluster_id, scan_run_id, control_id,
           subject, state, severity, message, evidence_json, finding_sha256)
         SELECT ?, r.org_id, r.customer_id, r.cluster_id, r.id, ?, ?, ?, ?, ?, ?, ?
           FROM kubernetes_scan_runs r
          WHERE r.id = ? AND r.org_id = ? AND r.customer_id = ? AND r.cluster_id = ?`,
      ).bind(
        await deterministicId("kfinding", `${scanId}\0${finding.controlId}\0${finding.subject}`),
        finding.controlId, finding.subject, finding.state, finding.severity,
        finding.message, findingJson, await sha256(canonicalJson(finding)), scanId,
        input.scope.orgId, input.scope.customerId, input.clusterId,
      ));
    }
    for (const item of coverage) {
      statements.push(db.prepare(
        `INSERT INTO kubernetes_scan_coverage
          (id, org_id, customer_id, cluster_id, scan_run_id, evidence_kind,
           state, items_observed, error_code)
         SELECT ?, r.org_id, r.customer_id, r.cluster_id, r.id, ?, ?, ?, ?
           FROM kubernetes_scan_runs r
          WHERE r.id = ? AND r.org_id = ? AND r.customer_id = ? AND r.cluster_id = ?`,
      ).bind(
        await deterministicId("kcoverage", `${scanId}\0${item.evidenceKind}`),
        item.evidenceKind, item.state, item.itemsObserved, item.errorCode ?? null,
        scanId, input.scope.orgId, input.scope.customerId, input.clusterId,
      ));
    }
    const scannerJson = canonicalJson(scannerEvidence);
    statements.push(db.prepare(
      `INSERT INTO kubernetes_scan_scanner_evidence
        (id, org_id, customer_id, cluster_id, scan_run_id, findings_json,
         sboms_json, evidence_sha256, finding_count, sbom_count)
       SELECT ?, r.org_id, r.customer_id, r.cluster_id, r.id, ?, ?, ?, ?, ?
         FROM kubernetes_scan_runs r
        WHERE r.id = ? AND r.org_id = ? AND r.customer_id = ? AND r.cluster_id = ?`,
    ).bind(
      await deterministicId("kscanner", scanId),
      scannerFindingsJson,
      scannerSbomsJson,
      await sha256(scannerJson),
      scannerEvidence.findings.length,
      scannerEvidence.sboms.length,
      scanId,
      input.scope.orgId,
      input.scope.customerId,
      input.clusterId,
    ));
    if (input.status === "complete") {
      statements.push(db.prepare(
        `INSERT INTO kubernetes_scan_heads
          (cluster_id, org_id, customer_id, scan_run_id, collected_at, updated_at)
         SELECT r.cluster_id, r.org_id, r.customer_id, r.id, r.collected_at, ?
           FROM kubernetes_scan_runs r
          WHERE r.id = ? AND r.org_id = ? AND r.customer_id = ?
            AND r.cluster_id = ? AND r.status = 'complete'
         ON CONFLICT (cluster_id) DO UPDATE SET
           org_id = excluded.org_id,
           customer_id = excluded.customer_id,
           scan_run_id = excluded.scan_run_id,
           collected_at = excluded.collected_at,
           updated_at = excluded.updated_at
         WHERE excluded.org_id = kubernetes_scan_heads.org_id
           AND excluded.customer_id = kubernetes_scan_heads.customer_id
           AND (
             excluded.collected_at > kubernetes_scan_heads.collected_at OR
             (excluded.collected_at = kubernetes_scan_heads.collected_at AND
              excluded.scan_run_id > kubernetes_scan_heads.scan_run_id)
           )`,
      ).bind(Date.now(), scanId, input.scope.orgId, input.scope.customerId, input.clusterId));
    }
    await db.batch(statements);
    const stored = await this.getScanById(input.scope, input.clusterId, scanId);
    if (stored === null) throw new KubernetesRepositoryError("SCOPE_NOT_FOUND");
    return stored;
  }

  public async getLatestCompleteScan(
    scope: KubernetesTenantScope,
    clusterId: string,
  ): Promise<StoredKubernetesScan | null> {
    assertScope(scope);
    if (!validIdentifier(clusterId)) throw new KubernetesRepositoryError("INVALID_INPUT");
    const db = await this.ready();
    const row = await db.prepare(
      `SELECT r.id, r.org_id, r.customer_id, r.cluster_id, r.status,
              r.collected_at, r.evidence_sha256, r.posture_sha256,
              r.resource_count, r.finding_count, r.coverage_count
         FROM kubernetes_scan_heads h
         JOIN kubernetes_scan_runs r
           ON r.id = h.scan_run_id AND r.org_id = h.org_id
          AND r.customer_id = h.customer_id AND r.cluster_id = h.cluster_id
        WHERE h.org_id = ? AND h.customer_id = ? AND h.cluster_id = ?
          AND r.status = 'complete'
        LIMIT 1`,
    ).bind(scope.orgId, scope.customerId, clusterId).first<ScanRow>();
    return row === null ? null : storedScan(row);
  }

  public async listClusters(scope: KubernetesTenantScope): Promise<readonly StoredKubernetesCluster[]> {
    assertScope(scope);
    const db = await this.ready();
    const rows = await db.prepare(
      `SELECT c.id, c.cluster_uid, c.name, c.distribution, c.version, c.status,
              r.id AS scan_id, r.org_id AS scan_org_id, r.customer_id AS scan_customer_id,
              r.cluster_id AS scan_cluster_id, r.status AS scan_status,
              r.collected_at, r.evidence_sha256, r.posture_sha256,
              r.resource_count, r.finding_count, r.coverage_count
         FROM kubernetes_clusters c
         LEFT JOIN kubernetes_scan_heads h
           ON h.cluster_id = c.id AND h.org_id = c.org_id AND h.customer_id = c.customer_id
         LEFT JOIN kubernetes_scan_runs r
           ON r.id = h.scan_run_id AND r.org_id = h.org_id
          AND r.customer_id = h.customer_id AND r.cluster_id = h.cluster_id
        WHERE c.org_id = ? AND c.customer_id = ?
        ORDER BY c.name, c.id`,
    ).bind(scope.orgId, scope.customerId).all<{
      id: string;
      cluster_uid: string;
      name: string;
      distribution: string | null;
      version: string | null;
      status: "active" | "disabled";
      scan_id: string | null;
      scan_org_id: string | null;
      scan_customer_id: string | null;
      scan_cluster_id: string | null;
      scan_status: StoredKubernetesScan["status"] | null;
      collected_at: number | null;
      evidence_sha256: string | null;
      posture_sha256: string | null;
      resource_count: number | null;
      finding_count: number | null;
      coverage_count: number | null;
    }>();
    return (rows.results ?? []).map((row) => ({
      id: row.id,
      clusterUid: row.cluster_uid,
      name: row.name,
      distribution: row.distribution,
      version: row.version,
      status: row.status,
      latestCompleteScan: row.scan_id === null ? null : storedScan({
        id: row.scan_id,
        org_id: row.scan_org_id ?? scope.orgId,
        customer_id: row.scan_customer_id ?? scope.customerId,
        cluster_id: row.scan_cluster_id ?? row.id,
        status: row.scan_status ?? "complete",
        collected_at: row.collected_at ?? 0,
        evidence_sha256: row.evidence_sha256 ?? "",
        posture_sha256: row.posture_sha256 ?? "",
        resource_count: row.resource_count ?? 0,
        finding_count: row.finding_count ?? 0,
        coverage_count: row.coverage_count ?? 0,
      }),
    }));
  }

  public async getLatestWorkspace(
    scope: KubernetesTenantScope,
    clusterId: string,
  ): Promise<KubernetesStoredWorkspace | null> {
    assertScope(scope);
    if (!validIdentifier(clusterId)) throw new KubernetesRepositoryError("INVALID_INPUT");
    const clusters = await this.listClusters(scope);
    const cluster = clusters.find((item) => item.id === clusterId);
    if (cluster === undefined) return null;
    const scan = cluster.latestCompleteScan;
    if (scan === null) {
      return {
        cluster,
        scan: null,
        resources: [],
        findings: [],
        coverage: [],
        scannerEvidence: { findings: [], sboms: [] },
      };
    }
    const db = await this.ready();
    const [resourceRows, findingRows, coverageRows, scannerRow] = await Promise.all([
      db.prepare(
        `SELECT evidence_json FROM kubernetes_scan_resources
          WHERE org_id = ? AND customer_id = ? AND cluster_id = ? AND scan_run_id = ?
          ORDER BY kind, namespace, name, id`,
      ).bind(scope.orgId, scope.customerId, clusterId, scan.id).all<{ evidence_json: string }>(),
      db.prepare(
        `SELECT control_id, subject, state, severity, message, evidence_json
           FROM kubernetes_scan_findings
          WHERE org_id = ? AND customer_id = ? AND cluster_id = ? AND scan_run_id = ?
          ORDER BY control_id, subject`,
      ).bind(scope.orgId, scope.customerId, clusterId, scan.id).all<{
        control_id: string;
        subject: string;
        state: KubernetesStoredFinding["state"];
        severity: KubernetesStoredFinding["severity"];
        message: string;
        evidence_json: string;
      }>(),
      db.prepare(
        `SELECT evidence_kind, state, items_observed, error_code
           FROM kubernetes_scan_coverage
          WHERE org_id = ? AND customer_id = ? AND cluster_id = ? AND scan_run_id = ?
          ORDER BY evidence_kind`,
      ).bind(scope.orgId, scope.customerId, clusterId, scan.id).all<{
        evidence_kind: KubernetesEvidenceKind;
        state: KubernetesCoverageInput["state"];
        items_observed: number;
        error_code: string | null;
      }>(),
      db.prepare(
        `SELECT findings_json, sboms_json, evidence_sha256, finding_count, sbom_count
           FROM kubernetes_scan_scanner_evidence
          WHERE org_id = ? AND customer_id = ? AND cluster_id = ? AND scan_run_id = ?
          LIMIT 1`,
      ).bind(scope.orgId, scope.customerId, clusterId, scan.id).first<{
        findings_json: string;
        sboms_json: string;
        evidence_sha256: string;
        finding_count: number;
        sbom_count: number;
      }>(),
    ]);
    const resources = (resourceRows.results ?? []).map((row) => {
      const parsed = JSON.parse(row.evidence_json) as unknown;
      const normalized = normalizeKubernetesEvidence({
        schema: "sutra.kubernetes-evidence.v1",
        clusterId: cluster.clusterUid,
        collectedAt: scan.collectedAt,
        observedKinds: [recordKind(parsed)],
        resources: [parsed],
      });
      return normalized.resources[0];
    });
    const findings = (findingRows.results ?? []).map((row) => ({
      controlId: row.control_id,
      subject: row.subject,
      state: row.state,
      severity: row.severity,
      message: row.message,
      evidence: stringArrayJson(row.evidence_json),
    }));
    const coverage = (coverageRows.results ?? []).map((row) => ({
      evidenceKind: row.evidence_kind,
      state: row.state,
      itemsObserved: Number(row.items_observed),
      ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    }));
    const scannerEvidence = scannerRow === null
      ? { findings: [], sboms: [] }
      : normalizeScannerEvidence({
        findings: parseJsonArray(scannerRow.findings_json),
        sboms: parseJsonArray(scannerRow.sboms_json),
      });
    if (
      scannerRow !== null &&
      (
        !HASH.test(scannerRow.evidence_sha256) ||
        scannerEvidence.findings.length !== Number(scannerRow.finding_count) ||
        scannerEvidence.sboms.length !== Number(scannerRow.sbom_count)
      )
    ) throw new KubernetesRepositoryError("INVALID_INPUT");
    return { cluster, scan, resources, findings, coverage, scannerEvidence };
  }

  private async getScanById(
    scope: KubernetesTenantScope,
    clusterId: string,
    scanId: string,
  ): Promise<StoredKubernetesScan | null> {
    const row = await this.database.prepare(
      `SELECT id, org_id, customer_id, cluster_id, status, collected_at,
              evidence_sha256, posture_sha256, resource_count,
              finding_count, coverage_count
         FROM kubernetes_scan_runs
        WHERE id = ? AND org_id = ? AND customer_id = ? AND cluster_id = ?
        LIMIT 1`,
    ).bind(scanId, scope.orgId, scope.customerId, clusterId).first<ScanRow>();
    return row === null ? null : storedScan(row);
  }
}

function recordKind(value: unknown): KubernetesEvidenceKind {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new KubernetesRepositoryError("INVALID_INPUT");
  }
  const kind = (value as Record<string, unknown>).kind;
  if (
    kind !== "Workload" && kind !== "Service" && kind !== "Ingress" &&
    kind !== "RbacRole" && kind !== "Namespace" && kind !== "NetworkPolicy"
  ) {
    throw new KubernetesRepositoryError("INVALID_INPUT");
  }
  return kind;
}

function stringArrayJson(value: string): readonly string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) || parsed.length > 256 ||
      parsed.some((item) => typeof item !== "string" || item.length > 1_024)
    ) throw new Error("invalid");
    return parsed;
  } catch {
    throw new KubernetesRepositoryError("INVALID_INPUT");
  }
}

function parseJsonArray(value: string): readonly unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error("invalid");
    return parsed;
  } catch {
    throw new KubernetesRepositoryError("INVALID_INPUT");
  }
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new KubernetesRepositoryError("INVALID_INPUT");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !keys.includes(key))
  ) throw new KubernetesRepositoryError("INVALID_INPUT");
  return record;
}

function boundedString(value: unknown, maximum: number, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" || value.length < 1 || value.length > maximum ||
    /[\0\r\n]/u.test(value)
  ) throw new KubernetesRepositoryError("INVALID_INPUT");
  return value;
}

function scannerProvenance(value: unknown): TrivyOperatorFinding["scanner"] {
  const record = exactObject(value, [
    "name", "vendor", "version", "reportUid", "reportResourceVersion", "reportUpdatedAt",
  ]);
  const reportUpdatedAt = boundedString(record.reportUpdatedAt, 64, true);
  if (reportUpdatedAt !== null && !Number.isFinite(Date.parse(reportUpdatedAt))) {
    throw new KubernetesRepositoryError("INVALID_INPUT");
  }
  return {
    name: boundedString(record.name, 128) ?? "",
    vendor: boundedString(record.vendor, 128) ?? "",
    version: boundedString(record.version, 128) ?? "",
    reportUid: boundedString(record.reportUid, 253) ?? "",
    reportResourceVersion: boundedString(record.reportResourceVersion, 253, true),
    reportUpdatedAt,
  };
}

function affectedResource(value: unknown): TrivyOperatorFinding["affectedResource"] {
  const record = exactObject(value, ["kind", "namespace", "name"]);
  return {
    kind: boundedString(record.kind, 128, true),
    namespace: boundedString(record.namespace, 253, true),
    name: boundedString(record.name, 253, true),
  };
}

function normalizeScannerFinding(value: unknown): TrivyOperatorFinding {
  const record = exactObject(value, [
    "fingerprint", "clusterId", "source", "severity", "namespace", "reportName",
    "affectedResource", "title", "checkId", "cveId", "packageName", "packageType",
    "installedVersion", "fixedVersion", "target", "score", "remediation", "scanner",
  ]);
  const fingerprint = boundedString(record.fingerprint, 64) ?? "";
  const clusterId = boundedString(record.clusterId, 253) ?? "";
  if (!HASH.test(fingerprint) || !validIdentifier(clusterId)) {
    throw new KubernetesRepositoryError("INVALID_INPUT");
  }
  if (
    record.source !== "vulnerability_report" &&
    record.source !== "cluster_vulnerability_report" &&
    record.source !== "config_audit_report" &&
    record.source !== "exposed_secret_report" &&
    record.source !== "rbac_assessment_report" &&
    record.source !== "cluster_rbac_assessment_report" &&
    record.source !== "infra_assessment_report" &&
    record.source !== "cluster_infra_assessment_report" &&
    record.source !== "cluster_compliance_report"
  ) throw new KubernetesRepositoryError("INVALID_INPUT");
  if (
    record.severity !== "critical" && record.severity !== "high" &&
    record.severity !== "medium" && record.severity !== "low" &&
    record.severity !== "unknown"
  ) throw new KubernetesRepositoryError("INVALID_INPUT");
  if (
    record.score !== null &&
    (typeof record.score !== "number" || !Number.isFinite(record.score) || record.score < 0 || record.score > 10)
  ) throw new KubernetesRepositoryError("INVALID_INPUT");
  return {
    fingerprint,
    clusterId,
    source: record.source,
    severity: record.severity,
    namespace: boundedString(record.namespace, 253, true),
    reportName: boundedString(record.reportName, 253) ?? "",
    affectedResource: affectedResource(record.affectedResource),
    title: boundedString(record.title, 512) ?? "",
    checkId: boundedString(record.checkId, 256, true),
    cveId: boundedString(record.cveId, 64, true),
    packageName: boundedString(record.packageName, 256, true),
    packageType: boundedString(record.packageType, 128, true),
    installedVersion: boundedString(record.installedVersion, 256, true),
    fixedVersion: boundedString(record.fixedVersion, 256, true),
    target: boundedString(record.target, 512, true),
    score: record.score,
    remediation: boundedString(record.remediation, 2_048, true),
    scanner: scannerProvenance(record.scanner),
  };
}

function normalizeSbomComponent(value: unknown): TrivySbomEvidence["components"][number] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new KubernetesRepositoryError("INVALID_INPUT");
  }
  const record = value as Record<string, unknown>;
  const keys = ["fingerprint", "type", "name", "version", "packageUrl", "licenses"];
  const required = keys.slice(0, 5);
  if (
    required.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !keys.includes(key))
  ) throw new KubernetesRepositoryError("INVALID_INPUT");
  const fingerprint = boundedString(record.fingerprint, 64) ?? "";
  if (!HASH.test(fingerprint)) throw new KubernetesRepositoryError("INVALID_INPUT");
  let licenses: readonly string[] | undefined;
  try {
    licenses = "licenses" in record ? normalizeObservedLicenses(record.licenses) : undefined;
  } catch {
    throw new KubernetesRepositoryError("INVALID_INPUT");
  }
  return {
    fingerprint,
    type: boundedString(record.type, 128, true),
    name: boundedString(record.name, 256) ?? "",
    version: boundedString(record.version, 256, true),
    packageUrl: boundedString(record.packageUrl, 1_024, true),
    ...(licenses === undefined ? {} : { licenses }),
  };
}

function normalizeScannerSbom(value: unknown): TrivySbomEvidence {
  const record = exactObject(value, [
    "fingerprint", "clusterId", "namespace", "reportName", "affectedResource",
    "artifact", "bomFormat", "specVersion", "declaredComponentCount",
    "declaredDependencyCount", "components", "scanner",
  ]);
  const fingerprint = boundedString(record.fingerprint, 64) ?? "";
  const clusterId = boundedString(record.clusterId, 253) ?? "";
  if (!HASH.test(fingerprint) || !validIdentifier(clusterId) || !Array.isArray(record.components)) {
    throw new KubernetesRepositoryError("INVALID_INPUT");
  }
  if (record.components.length > 1_000) throw new KubernetesRepositoryError("INVALID_INPUT");
  const count = (value: unknown): number | null => {
    if (value === null) return null;
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) {
      throw new KubernetesRepositoryError("INVALID_INPUT");
    }
    return value as number;
  };
  const artifact = exactObject(record.artifact, ["repository", "digest", "tag"]);
  return {
    fingerprint,
    clusterId,
    namespace: boundedString(record.namespace, 253, true),
    reportName: boundedString(record.reportName, 253) ?? "",
    affectedResource: affectedResource(record.affectedResource),
    artifact: {
      repository: boundedString(artifact.repository, 512, true),
      digest: boundedString(artifact.digest, 256, true),
      tag: boundedString(artifact.tag, 256, true),
    },
    bomFormat: boundedString(record.bomFormat, 64, true),
    specVersion: boundedString(record.specVersion, 64, true),
    declaredComponentCount: count(record.declaredComponentCount),
    declaredDependencyCount: count(record.declaredDependencyCount),
    components: record.components.map(normalizeSbomComponent),
    scanner: scannerProvenance(record.scanner),
  };
}

function normalizeScannerEvidence(value: {
  readonly findings: readonly unknown[];
  readonly sboms: readonly unknown[];
}): KubernetesScannerEvidence {
  if (
    !Array.isArray(value.findings) || !Array.isArray(value.sboms) ||
    value.findings.length > 2_000 || value.sboms.length > 200
  ) throw new KubernetesRepositoryError("INVALID_INPUT");
  const findings = value.findings.map(normalizeScannerFinding);
  const sboms = value.sboms.map(normalizeScannerSbom);
  for (const item of [...findings, ...sboms]) {
    if (item.clusterId.length < 1) throw new KubernetesRepositoryError("INVALID_INPUT");
  }
  return {
    findings: findings.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
    sboms: sboms.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
  };
}

function validateCoverage(
  evidence: KubernetesEvidenceSnapshot,
  input: readonly KubernetesCoverageInput[],
): readonly KubernetesCoverageInput[] {
  if (!Array.isArray(input) || input.length !== evidence.observedKinds.length) {
    throw new KubernetesRepositoryError("INVALID_INPUT");
  }
  const observed = new Set(evidence.observedKinds);
  const seen = new Set<string>();
  const result = input.map((item) => {
    if (
      !observed.has(item.evidenceKind) ||
      seen.has(item.evidenceKind) ||
      !new Set(["COMPLETE", "PARTIAL", "UNKNOWN", "FAILED"]).has(item.state) ||
      !Number.isSafeInteger(item.itemsObserved) ||
      item.itemsObserved < 0
    ) {
      throw new KubernetesRepositoryError("INVALID_INPUT");
    }
    seen.add(item.evidenceKind);
    const errorCode = item.errorCode === undefined
      ? undefined
      : assertPlainText(item.errorCode, 128) ?? undefined;
    if ((item.state === "COMPLETE") === (errorCode !== undefined)) {
      throw new KubernetesRepositoryError("INVALID_INPUT");
    }
    return { ...item, errorCode };
  });
  return result.sort((left, right) => left.evidenceKind.localeCompare(right.evidenceKind));
}

export function deriveKubernetesPostureForPersistence(
  evidence: KubernetesEvidenceSnapshot,
): KubernetesPostureReport {
  return evaluateKubernetesPosture(normalizeKubernetesEvidence(evidence));
}
