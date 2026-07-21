// End-to-end "does the whole product work after onboarding" integration test.
//
// Seeds ONE fully-onboarded customer (organization + customer + active AWS
// connection + a complete CMDB snapshot with resources/findings/coverage + a
// Kubernetes cluster with a complete scan + the per-section fixtures each
// workspace reads) and then drives EVERY app/api/**/route.ts as an
// authenticated org_owner, asserting no section crashes (500), 404s, or is
// wrongly gated (401/403) with a valid authed+scoped request.
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

// Local mode + loopback host is what lib/api-auth.ts requires for a session to
// be honored. These must be set before the modules under test are imported.
process.env.SUTRA_LOCAL_MODE = "true";
process.env.SUTRA_DEPLOYMENT_ENV = "development";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const cloudflare = await import("cloudflare:workers");
const runtimeMigrations = await import("../db/runtime-migrations.ts");
const authRepository = await import("../db/auth-repository.ts");
const pilotRepository = await import("../db/pilot-repository.ts");
const { KubernetesRepository } = await import("../db/kubernetes-repository.ts");
const { ApiTokenRepository } = await import("../db/api-token-repository.ts");

const JOB_RUNNER_TOKEN = "e2e-job-runner-token-0123456789abcdef";

// The cloudflare:workers env stub is a plain object; the auth + pilot layers
// read SUTRA_LOCAL_MODE off it (not process.env), so mirror the flags there.
cloudflare.env.SUTRA_LOCAL_MODE = "true";
cloudflare.env.SUTRA_DEPLOYMENT_ENV = "development";
cloudflare.env.SUTRA_JOB_RUNNER_TOKEN = JOB_RUNNER_TOKEN;
// Collector secrets so the onboarded tenant reads as CONFIGURED. The local
// collector sidecar itself is not part of this DB-only harness, so the four
// broker-proxy routes below surface BROKER_UNAVAILABLE — the honest boundary
// for a unit test, not a code fault. (43-char base64url = 32-byte dummy keys.)
cloudflare.env.SUTRA_CONNECTION_ENCRYPTION_KEY = "A".repeat(43);
cloudflare.env.SUTRA_CONNECTION_KEY_VERSION = "local-v1";
cloudflare.env.SUTRA_BROKER_SHARED_SECRET = "B".repeat(43);
cloudflare.env.SUTRA_BROKER_URL = "http://127.0.0.1:8788";

const ORG_ID = "org_local_sutra";
const CUSTOMER_ID = "cust_c0ffeec0ffeec0ffeec0ffeec0ffee00";
const CONNECTION_ID = "conn_aabbccddeeff00112233445566778899";
const ACCOUNT_ID = "123456789012";
const SNAPSHOT_ID = "snap_11111111111111111111111111111111";
const SYNC_RUN_ID = "sync_11111111111111111111111111111111";
const SEV_RUN_ID = "serun_seed1111111111111111111111111111111111";
const ORIGIN = "http://127.0.0.1";

function sha256HexDummy(seed) {
  // A fixed 64-hex string; only used where a *_sha256 column is required.
  return seed.padEnd(64, "0").slice(0, 64).replace(/[^a-f0-9]/g, "a");
}

async function seedBaseline(db) {
  const now = Date.now();
  // 1) Bootstrap the local org + org_owner user + membership + session. This is
  //    exactly how a real local operator is created, and it returns a live
  //    session token we can carry as the cookie.
  const bootstrap = await authRepository.bootstrapLocalAdmin(
    {
      email: "admin@sutra.local",
      displayName: "Sutra Admin",
      password: "Sutra-Local-Admin-9271-Passphrase",
      organizationName: "Sutra Local",
    },
    now,
  );
  const userId = bootstrap.session.subject.userId;
  // 2) Make the session MFA-verified so requireApiSession() (which enforces MFA
  //    by default) accepts it. A confirmed TOTP credential marks the account
  //    enrolled; setting mfa_verified_at on the session marks it verified.
  await db.batch([
    db.prepare(
      `INSERT INTO totp_credentials (user_id, secret_ciphertext, secret_key_version, confirmed_at, last_used_step, created_at, updated_at)
       VALUES (?, 'seed-ciphertext', 'local-auth-v1', ?, 1, ?, ?)`,
    ).bind(userId, now, now, now),
    db.prepare(
      `UPDATE local_sessions SET mfa_verified_at = ? WHERE user_id = ?`,
    ).bind(now, userId),
  ]);

  // 3) Onboarded customer + active AWS trust-role connection.
  await db.batch([
    db.prepare(
      "INSERT INTO customers (id, org_id, slug, name, status, created_at, updated_at) VALUES (?, ?, 'acme', 'Acme Corp', 'active', ?, ?)",
    ).bind(CUSTOMER_ID, ORG_ID, now, now),
    db.prepare(
      `INSERT INTO aws_connections
        (id, org_id, customer_id, source_kind, partition, aws_account_id,
         role_arn, external_id_ciphertext, external_id_key_version,
         permission_pack_version, status, enabled_regions_json, created_at, updated_at)
       VALUES (?, ?, ?, 'aws_trust_role', 'aws', ?, ?, ?, 'test-key-v1', ?, 'active', '["us-east-1"]', ?, ?)`,
    ).bind(
      CONNECTION_ID, ORG_ID, CUSTOMER_ID, ACCOUNT_ID,
      `arn:aws:iam::${ACCOUNT_ID}:role/sutra/SutraReadOnlyRole`,
      "ciphertext-not-a-real-secret",
      pilotRepository.CURRENT_PILOT_PERMISSION_PACK,
      now, now,
    ),
    db.prepare(
      `INSERT INTO sync_runs
        (id, org_id, customer_id, connection_id, trigger_kind, status,
         coverage_state, collector_pack_version, totals_json, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, 'manual', 'succeeded', 'complete', 'aws-pilot-v1', '{}', 'e2e-baseline', ?)`,
    ).bind(SYNC_RUN_ID, ORG_ID, CUSTOMER_ID, CONNECTION_ID, now),
    db.prepare(
      `INSERT INTO cmdb_snapshots
        (id, org_id, customer_id, connection_id, sync_run_id, status,
         collected_at, completed_at, coverage_json, summary_json, snapshot_sha256, origin_kind)
       VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, '[]', '{"resources":3,"findings":3}', ?, 'live_aws')`,
    ).bind(SNAPSHOT_ID, ORG_ID, CUSTOMER_ID, CONNECTION_ID, SYNC_RUN_ID, now, now, sha256HexDummy("snap")),
    db.prepare(
      `INSERT INTO connection_heads (connection_id, org_id, customer_id, snapshot_id, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(CONNECTION_ID, ORG_ID, CUSTOMER_ID, SNAPSHOT_ID, now),
  ]);

  // 4) A varied resource set so the exposure/detection/compliance engines have
  //    real input: a public-facing EC2 instance, an S3 bucket, a security group,
  //    an EKS cluster resource, and an IAM role.
  const resources = [
    {
      key: `aws:ec2:us-east-1:${ACCOUNT_ID}:instance/i-0e2e`,
      service: "ec2", type: "ec2.instance", nativeId: "i-0e2e", name: "web-01",
      config: { publicIpAddress: "203.0.113.10", state: "running", securityGroups: ["sg-0e2e"] },
    },
    {
      key: `aws:s3:us-east-1:${ACCOUNT_ID}:bucket/acme-public-assets`,
      service: "s3", type: "s3.bucket", nativeId: "acme-public-assets", name: "acme-public-assets",
      config: { publicAccessBlock: { blockPublicAcls: false }, encryption: null },
    },
    {
      key: `aws:ec2:us-east-1:${ACCOUNT_ID}:security-group/sg-0e2e`,
      service: "ec2", type: "ec2.security-group", nativeId: "sg-0e2e", name: "web-sg",
      config: { ingress: [{ cidr: "0.0.0.0/0", fromPort: 22, toPort: 22, protocol: "tcp" }] },
    },
    {
      key: `aws:eks:us-east-1:${ACCOUNT_ID}:cluster/acme-prod`,
      service: "eks", type: "aws.eks.cluster", nativeId: "acme-prod", name: "acme-prod",
      config: { kubernetesVersion: "1.30", endpointPublicAccess: true },
    },
    {
      key: `aws:iam:global:${ACCOUNT_ID}:role/admin`,
      service: "iam", type: "iam.role", nativeId: "admin", name: "admin",
      config: { assumeRolePolicyDocument: { Statement: [{ Effect: "Allow", Principal: { AWS: "*" } }] } },
    },
  ];
  await db.batch(resources.map((r) =>
    db.prepare(
      `INSERT INTO cmdb_resources
        (id, snapshot_id, org_id, customer_id, connection_id, resource_key,
         provider_key, service, resource_type, native_id, name, region_key,
         state, tags_json, configuration_json, source_json, content_sha256, collected_at)
       VALUES (?, ?, ?, ?, ?, ?, 'aws', ?, ?, ?, ?, 'us-east-1', 'running', '{"env":"prod"}', ?, ?, ?, ?)`,
    ).bind(
      `${SNAPSHOT_ID}:${r.key}`, SNAPSHOT_ID, ORG_ID, CUSTOMER_ID, CONNECTION_ID, r.key,
      r.service, r.type, r.nativeId, r.name,
      JSON.stringify(r.config),
      JSON.stringify({ api: "collected", accountId: ACCOUNT_ID, collectedAt: new Date(now).toISOString() }),
      sha256HexDummy(r.nativeId), now,
    ),
  ));

  // 5) A few CMDB findings across severities.
  const findings = [
    { fp: "f".repeat(64), rk: resources[1].key, control: "s3.public-access", sev: "critical", title: "S3 bucket allows public ACLs" },
    { fp: "e".repeat(64), rk: resources[2].key, control: "ec2.ssh-open", sev: "high", title: "Security group opens SSH to the world" },
    { fp: "d".repeat(64), rk: resources[4].key, control: "iam.wildcard-trust", sev: "medium", title: "IAM role trusts any AWS principal" },
  ];
  await db.batch(findings.map((f) =>
    db.prepare(
      `INSERT INTO cmdb_findings
        (id, snapshot_id, org_id, customer_id, connection_id, resource_key,
         control_key, control_version, fingerprint, severity, status, title,
         summary, remediation, evidence_json, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'v1', ?, ?, 'open', ?, ?, ?, '{}', ?)`,
    ).bind(
      `${SNAPSHOT_ID}:finding:${f.fp}`, SNAPSHOT_ID, ORG_ID, CUSTOMER_ID, CONNECTION_ID, f.rk,
      f.control, f.fp, f.sev, f.title, `${f.title}.`, "Remediate per control guidance.", now,
    ),
  ));

  // 6) Collector coverage rows (so coverage-aware views report a complete run).
  const collectors = ["ec2", "s3", "iam", "eks"];
  await db.batch(collectors.map((c) =>
    db.prepare(
      `INSERT INTO collector_runs
        (id, org_id, customer_id, connection_id, sync_run_id, collector_key,
         region_key, status, items_observed, pages_observed, error_code, error_message, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, 'us-east-1', 'succeeded', 1, 1, NULL, NULL, ?, ?)`,
    ).bind(`${SYNC_RUN_ID}:${c}:us-east-1`, ORG_ID, CUSTOMER_ID, CONNECTION_ID, SYNC_RUN_ID, c, now, now),
  ));

  // 7) A public-API service-account token carrying every read scope, so the
  //    public/v1 endpoints can be exercised as a real integrator would.
  const minted = await new ApiTokenRepository().mint(
    { orgId: ORG_ID, customerId: CUSTOMER_ID },
    "E2E Journey Token",
    ["read:resources", "read:findings", "read:cases", "read:snapshots", "read:compliance", "read:vulnerabilities"],
    null,
    userId,
  );

  return { token: bootstrap.token, userId, apiToken: minted.token };
}

// --- Section seed blocks (filled in from repository/schema study) ------------
// Seeds one onboarded Kubernetes cluster + a complete scan (posture, scanner
// findings, one SBOM) + supply-chain, hubble-flow, falco-runtime and agent rows
// so every kubernetes GET route returns 200 with realistic data. Returns the
// generated kcluster_ id.
async function seedKubernetes(db) {
  const DB = db;
  const scope = { orgId: ORG_ID, customerId: CUSTOMER_ID };
  const clusterUid = "738663485493:ap-south-1:sutra-e2e-prod";

  const enc = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sha256Hex = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  const randHex64 = () => sha256Hex(crypto.randomUUID() + crypto.randomUUID());
  const canonicalJson = (value) => {
    const walk = (v) => {
      if (v === null || typeof v === "string" || typeof v === "boolean" ||
          (typeof v === "number" && Number.isFinite(v))) return v;
      if (Array.isArray(v)) return v.map(walk);
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    };
    return JSON.stringify(walk(value));
  };
  const now = Date.now();
  const pastIso = new Date(now - 3_600_000).toISOString();
  const digest64 = "a".repeat(64);

  const repository = new KubernetesRepository();
  const cluster = await repository.registerCluster({
    scope, clusterUid, name: "Sutra E2E Production", distribution: "Amazon EKS", version: "1.34",
  });
  const clusterId = cluster.id;

  const kinds = ["Workload", "Service", "Ingress", "RbacRole", "RbacBinding",
    "ServiceAccount", "Namespace", "NetworkPolicy"];
  const evidence = {
    schema: "sutra.kubernetes-evidence.v1",
    clusterId: clusterUid,
    collectedAt: pastIso,
    observedKinds: kinds,
    resources: [
      { kind: "Namespace", name: "payments", namespace: null,
        podSecurityEnforce: "restricted", podSecurityWarn: "restricted", podSecurityAudit: "restricted" },
      { kind: "Workload", workloadKind: "Deployment", namespace: "payments", name: "api",
        hostNetwork: false, hostPid: false, hostIpc: false, hasHostPath: false,
        runAsNonRoot: true, seccompProfile: "RuntimeDefault",
        containers: [{
          name: "api", image: `registry.example/api@sha256:${digest64}`,
          privileged: false, allowPrivilegeEscalation: false, runAsNonRoot: true,
          capabilitiesAdd: [], capabilitiesDrop: ["ALL"],
          hasCpuRequest: true, hasMemoryRequest: true, hasCpuLimit: true, hasMemoryLimit: true,
          hasLivenessProbe: true, hasReadinessProbe: true,
        }] },
      { kind: "Service", namespace: "payments", name: "api", serviceType: "ClusterIP", externalAddressCount: 0 },
      { kind: "Ingress", namespace: "payments", name: "api",
        ruleHosts: ["api.example.com"], tlsHosts: ["api.example.com"] },
      { kind: "RbacRole", namespace: "payments", name: "reader", clusterScoped: false,
        rules: [{ verbs: ["get"], apiGroups: [""], resources: ["pods"] }] },
      { kind: "RbacBinding", namespace: "payments", name: "reader-binding", clusterScoped: false,
        roleRefKind: "Role", roleRefName: "reader",
        subjects: [{ kind: "ServiceAccount", namespace: "payments", name: "api" }] },
      { kind: "ServiceAccount", namespace: "payments", name: "api",
        iamRoleArn: "arn:aws:iam::111122223333:role/payments-api" },
      { kind: "NetworkPolicy", namespace: "payments", name: "default-deny", coversAllPods: true },
    ],
  };
  const coverage = kinds.map((evidenceKind) => ({ evidenceKind, state: "COMPLETE", itemsObserved: 1 }));
  const scannerEvidence = {
    findings: [{
      fingerprint: "e".repeat(64), clusterId: clusterUid, source: "vulnerability_report",
      severity: "high", namespace: "payments", reportName: "deployment-api",
      affectedResource: { kind: "Deployment", namespace: "payments", name: "api" },
      title: "CVE-2026-1234 openssl buffer overflow", checkId: null, cveId: "CVE-2026-1234",
      packageName: "openssl", packageType: "os", installedVersion: "1.0", fixedVersion: "1.1",
      target: "registry.example/api", score: 8.1, remediation: "Upgrade the affected package",
      scanner: { name: "Trivy", vendor: "Aqua Security", version: "0.60.0",
        reportUid: "report-uid", reportResourceVersion: "42", reportUpdatedAt: pastIso },
    }],
    sboms: [{
      fingerprint: "1".repeat(64), clusterId: clusterUid, namespace: "payments", reportName: "deployment-api",
      affectedResource: { kind: "Deployment", namespace: "payments", name: "api" },
      artifact: { repository: "registry.example/api", digest: `sha256:${digest64}`, tag: "release-17" },
      bomFormat: "CycloneDX", specVersion: "1.5", declaredComponentCount: 2, declaredDependencyCount: 1,
      components: [
        { fingerprint: "2".repeat(64), type: "library", name: "openssl", version: "1.0.2", packageUrl: "pkg:deb/openssl@1.0.2", licenses: ["Apache-2.0"] },
        { fingerprint: "3".repeat(64), type: "library", name: "zlib", version: "1.2.13", packageUrl: "pkg:deb/zlib@1.2.13", licenses: ["Zlib"] },
      ],
      scanner: { name: "Trivy", vendor: "Aqua Security", version: "0.60.0",
        reportUid: "sbom-uid", reportResourceVersion: "7", reportUpdatedAt: pastIso },
    }],
  };
  await repository.publishScan({
    scope, clusterId, idempotencyKey: "seed-k8s-complete-0001", status: "complete",
    evidence, coverage, scannerEvidence,
  });

  // Hubble network flow (source + one flow).
  await DB.prepare(
    `INSERT INTO hubble_flow_sources
       (cluster_id, org_id, customer_id, hubble_version, last_batch_at, last_flow_at, last_batch_sha256, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (cluster_id) DO NOTHING`,
  ).bind(clusterId, ORG_ID, CUSTOMER_ID, "1.15.3", now - 60_000, now - 60_000, await randHex64(), now).run();
  await DB.prepare(
    `INSERT INTO hubble_flow_evidence
       (id, org_id, customer_id, cluster_id, observed_at,
        source_namespace, source_workload_kind, source_workload_name, source_service_name, source_world,
        destination_namespace, destination_workload_kind, destination_workload_name, destination_service_name, destination_world,
        direction, verdict, protocol, destination_port, observations, evidence_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (cluster_id, evidence_sha256) DO NOTHING`,
  ).bind(
    `hflow_${(await randHex64()).slice(0, 48)}`, ORG_ID, CUSTOMER_ID, clusterId, now - 90_000,
    "payments", "Deployment", "api", null, 0,
    "payments", "Deployment", "postgres", null, 0,
    "egress", "forwarded", "TCP", 5432, 128, await randHex64(),
  ).run();

  // Falco runtime source + event.
  const falcoMaterial = {
    schemaVersion: "sutra.falco.runtime-event.v1", clusterId, occurredAt: pastIso,
    rule: "Terminal shell in container", priority: "warning", source: "syscall",
    nodeName: "ip-10-0-1-23.ap-south-1.compute.internal", namespace: "payments",
    podName: "api-7c9f8b6d5-abcde", podUid: "11111111-2222-3333-4444-555555555555",
    containerId: "abc123", containerName: "api", containerImage: "registry.example/api:release-17",
    process: { name: "bash", executable: "/bin/bash", pid: 4242, parentPid: 1, userName: "root", userId: "0", eventType: "execve" },
  };
  await DB.prepare(
    `INSERT INTO falco_runtime_sources
       (cluster_id, org_id, customer_id, last_heartbeat_at, last_event_at, falco_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (cluster_id) DO NOTHING`,
  ).bind(clusterId, ORG_ID, CUSTOMER_ID, now - 30_000, now - 120_000, "0.38.1", now).run();
  await DB.prepare(
    `INSERT INTO falco_runtime_events
       (id, org_id, customer_id, cluster_id, occurred_at, rule_name, priority, source,
        node_name, namespace_name, pod_name, pod_uid, container_id, container_name, container_image,
        process_name, process_executable, process_id, parent_process_id, user_name, user_id, event_type,
        evidence_json, evidence_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (cluster_id, evidence_sha256) DO NOTHING`,
  ).bind(
    `frte_${(await randHex64()).slice(0, 48)}`, ORG_ID, CUSTOMER_ID, clusterId, now - 120_000,
    falcoMaterial.rule, falcoMaterial.priority, falcoMaterial.source,
    falcoMaterial.nodeName, falcoMaterial.namespace, falcoMaterial.podName, falcoMaterial.podUid,
    falcoMaterial.containerId, falcoMaterial.containerName, falcoMaterial.containerImage,
    falcoMaterial.process.name, falcoMaterial.process.executable, falcoMaterial.process.pid,
    falcoMaterial.process.parentPid, falcoMaterial.process.userName, falcoMaterial.process.userId,
    falcoMaterial.process.eventType, canonicalJson(falcoMaterial), await randHex64(),
  ).run();

  // Kubernetes agent (active).
  await DB.prepare(
    `INSERT INTO kubernetes_agents
       (id, org_id, customer_id, connection_id, cluster_id, status,
        current_token_digest, credential_expires_at, agent_version, capabilities_json,
        deployment_namespace, deployment_pod_name, deployment_started_at,
        module_health_json, last_heartbeat_at, last_scan_at, enrolled_at, node_name)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(
    `kagent_${crypto.randomUUID().replaceAll("-", "")}`,
    ORG_ID, CUSTOMER_ID, CONNECTION_ID, clusterId,
    await randHex64(), now + 3_600_000, "1.4.2",
    JSON.stringify(["posture", "vulnerability", "sbom", "runtime"]),
    "sutra-system", "sutra-agent-0", now - 86_400_000,
    JSON.stringify({ posture: "healthy", vulnerability: "healthy", runtime: "healthy" }),
    now - 30_000, now - 120_000, now - 86_400_000,
  ).run();

  // Supply-chain evidence (registry/inventory + supply-chain routes). Canonical
  // JSON is round-trip validated by the read path, so it must be byte-exact.
  const scImageRepo = "738663485493.dkr.ecr.ap-south-1.amazonaws.com/payments";
  const scImageDigest = `sha256:${digest64}`;
  const scCore = {
    schemaVersion: "sutra.kubernetes-supply-chain.v1", clusterId, collectedAt: pastIso,
    image: { repository: scImageRepo, digest: scImageDigest, tag: "release-17" },
    vulnerabilityScan: { scanner: "Trivy", scannerVersion: "0.69.1", scannedAt: pastIso,
      critical: 1, high: 2, medium: 3, low: 4, unknown: 0, fixedAvailable: 3 },
    sbom: { format: "CycloneDX", componentCount: 147, documentSha256: "b".repeat(64) },
    signature: { state: "verified", issuer: "https://token.actions.githubusercontent.com",
      subject: "repo:customer/payments:ref:refs/heads/main", transparencyLogVerified: true },
    provenance: { state: "verified", builderId: "https://github.com/customer/build/.github/workflows/release.yml",
      sourceRepository: "https://github.com/customer/payments", commitSha: "c".repeat(40) },
    priority: { score: 38, rating: "medium",
      factors: ["1 critical package vulnerability", "2 high package vulnerabilities", "3 findings with a known fix"] },
    limitations: [
      "EVIDENCE_DESCRIBES_ONE_IMMUTABLE_IMAGE_DIGEST",
      "VULNERABILITY_PRESENCE_DOES_NOT_PROVE_EXPLOITABILITY",
      "SIGNATURE_VERIFICATION_DOES_NOT_ESTABLISH_SOURCE_CODE_SAFETY",
    ],
  };
  const scSha = await sha256Hex(canonicalJson(scCore));
  const scEvidenceJson = canonicalJson({ ...scCore, evidenceSha256: scSha });
  const scId = `ksce_${(await sha256Hex(`${clusterId}\0${scSha}`)).slice(0, 48)}`;
  await DB.prepare(
    `INSERT INTO kubernetes_supply_chain_evidence
       (id, org_id, customer_id, cluster_id, image_repository, image_digest,
        collected_at, priority_score, priority_rating, evidence_json, evidence_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (cluster_id, evidence_sha256) DO NOTHING`,
  ).bind(
    scId, ORG_ID, CUSTOMER_ID, clusterId, scImageRepo, scImageDigest,
    Date.parse(pastIso), scCore.priority.score, scCore.priority.rating, scEvidenceJson, scSha,
  ).run();

  return { clusterId };
}

// Cloud/registry vulnerabilities, security events + detections, network-exposure
// resources, and CMDB change events.
async function seedVulnAndCloud(db) {
  const NOW = Date.now();
  const DAY = 86_400_000;
  const T_NOW = NOW - 60_000;
  const T_OLD = NOW - 7 * DAY;
  const HEX64 = "a".repeat(64);

  await db.batch([
    db.prepare(
      `INSERT INTO cloud_vulnerability_findings
         (id, org_id, customer_id, connection_id, finding_key, resource_key, resource_kind,
          cve_id, package_name, installed_version, fixed_version, severity, cvss_score, source,
          status, first_seen_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`,
    ).bind(
      "cvf_seed00000000000000000000000000000000000000000001",
      ORG_ID, CUSTOMER_ID, CONNECTION_ID,
      "inspector|CVE-2024-3094|i-0abc123def456|openssl",
      `arn:aws:ec2:us-east-1:${ACCOUNT_ID}:instance/i-0abc123def456`, "aws.ec2.instance",
      "CVE-2024-3094", "openssl", "3.0.2-0ubuntu1", "3.0.2-0ubuntu1.15", "critical", 10.0, "aws-inspector", T_OLD, T_NOW,
    ),
    db.prepare(
      `INSERT INTO cloud_vulnerability_findings
         (id, org_id, customer_id, connection_id, finding_key, resource_key, resource_kind,
          cve_id, package_name, installed_version, fixed_version, severity, cvss_score, source,
          status, first_seen_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`,
    ).bind(
      "cvf_seed00000000000000000000000000000000000000000002",
      ORG_ID, CUSTOMER_ID, CONNECTION_ID,
      "inspector|CVE-2023-44487|lambda-payments|nghttp2",
      `arn:aws:lambda:us-east-1:${ACCOUNT_ID}:function:payments`, "aws.lambda.function",
      "CVE-2023-44487", "nghttp2", "1.43.0", "1.57.0", "high", 7.5, "aws-inspector", T_NOW, T_NOW,
    ),
    db.prepare(
      `INSERT INTO registry_vulnerability_findings
         (id, org_id, customer_id, connection_id, finding_key, resource_key, resource_kind, image_ref,
          cve_id, package_name, installed_version, fixed_version, severity, cvss_score, source,
          status, first_seen_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)`,
    ).bind(
      "rvf_seed00000000000000000000000000000000000000000001",
      ORG_ID, CUSTOMER_ID, CONNECTION_ID,
      "trivy|CVE-2024-24790|payments@sha256:abc|stdlib",
      `${ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/payments@sha256:abcabcabcabc`, "container.image",
      `${ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/payments@sha256:abcabcabcabc`,
      "CVE-2024-24790", "stdlib", "1.21.0", "1.21.11", "critical", 9.8, "trivy-image", T_OLD, T_NOW,
    ),
    db.prepare(
      `INSERT INTO security_event_runs
         (id, org_id, customer_id, connection_id, source, status, window_start, window_end,
          collected_at, finished_at, coverage_json, events_observed, events_inserted,
          duplicate_events, detections_observed, payload_sha256)
       VALUES (?,?,?,?,'aws_cloudtrail_lookup_events','COMPLETE',?,?,?,?,?,?,?,0,?,?)`,
    ).bind(
      SEV_RUN_ID, ORG_ID, CUSTOMER_ID, CONNECTION_ID, T_NOW - DAY, T_NOW, T_NOW, T_NOW,
      JSON.stringify([{ region: "us-east-1", status: "SUCCEEDED" }]), 3, 3, 3, HEX64,
    ),
    db.prepare(
      `INSERT INTO security_event_sources
         (id, org_id, customer_id, connection_id, source, status, retention_days, lookback_hours,
          overlap_minutes, last_window_start, last_window_end, last_collected_at, last_run_id,
          last_error_code, created_at, updated_at)
       VALUES (?,?,?,?,'aws_cloudtrail_lookup_events','COMPLETE',30,1,5,?,?,?,?,NULL,?,?)`,
    ).bind(
      "sesrc_seed111111111111111111111111111111111111111",
      ORG_ID, CUSTOMER_ID, CONNECTION_ID, T_NOW - DAY, T_NOW, T_NOW, SEV_RUN_ID, NOW, NOW,
    ),
    db.prepare(
      `INSERT INTO security_events
         (id, org_id, customer_id, connection_id, source_run_id, provider_event_id, account_id,
          region_key, event_time, event_name, event_source, read_only, management_event,
          event_category, username, identity_type, principal_arn, source_ip, user_agent,
          error_code, request_id, console_login_result, mfa_used, detail_status, resources_json, ingested_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,1,'Management',?,?,?,?,?,NULL,?,NULL,NULL,'AVAILABLE','[]',?)`,
    ).bind(
      "sevt_seed000000000000000000000000000000000000000001",
      ORG_ID, CUSTOMER_ID, CONNECTION_ID, SEV_RUN_ID, "cf-evt-0000000000000001", ACCOUNT_ID, "us-east-1", T_NOW - 3000,
      "StopLogging", "cloudtrail.amazonaws.com", "deploybot", "IAMUser",
      `arn:aws:iam::${ACCOUNT_ID}:user/deploybot`, "203.0.113.7", "aws-cli/2.15.0", "req-0000000000000001", NOW,
    ),
    db.prepare(
      `INSERT INTO security_events
         (id, org_id, customer_id, connection_id, source_run_id, provider_event_id, account_id,
          region_key, event_time, event_name, event_source, read_only, management_event,
          event_category, username, identity_type, principal_arn, source_ip, user_agent,
          error_code, request_id, console_login_result, mfa_used, detail_status, resources_json, ingested_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,1,'Management',?,?,?,?,?,NULL,?,'Success',0,'AVAILABLE','[]',?)`,
    ).bind(
      "sevt_seed000000000000000000000000000000000000000002",
      ORG_ID, CUSTOMER_ID, CONNECTION_ID, SEV_RUN_ID, "cf-evt-0000000000000002", ACCOUNT_ID, "us-east-1", T_NOW - 2000,
      "ConsoleLogin", "signin.amazonaws.com", "alice", "IAMUser",
      `arn:aws:iam::${ACCOUNT_ID}:user/alice`, "198.51.100.22", "Mozilla/5.0", "req-0000000000000002", NOW,
    ),
    db.prepare(
      `INSERT INTO security_events
         (id, org_id, customer_id, connection_id, source_run_id, provider_event_id, account_id,
          region_key, event_time, event_name, event_source, read_only, management_event,
          event_category, username, identity_type, principal_arn, source_ip, user_agent,
          error_code, request_id, console_login_result, mfa_used, detail_status, resources_json, ingested_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,1,'Management',?,?,?,?,?,NULL,?,NULL,NULL,'AVAILABLE','[]',?)`,
    ).bind(
      "sevt_seed000000000000000000000000000000000000000003",
      ORG_ID, CUSTOMER_ID, CONNECTION_ID, SEV_RUN_ID, "cf-evt-0000000000000003", ACCOUNT_ID, "us-east-1", T_NOW - 1000,
      "CreateAccessKey", "iam.amazonaws.com", "root", "Root",
      `arn:aws:iam::${ACCOUNT_ID}:root`, "203.0.113.9", "console.amazonaws.com", "req-0000000000000003", NOW,
    ),
    // Network-exposure resources appended to the baseline snapshot: a public ENI
    // behind an SG open to 0.0.0.0/0:443, in a public subnet with an IGW route.
    db.prepare(
      `INSERT INTO cmdb_resources
         (id, snapshot_id, org_id, customer_id, connection_id, resource_key, provider_key, service,
          resource_type, native_id, arn, name, region_key, state, tags_json, configuration_json,
          source_json, content_sha256, collected_at)
       VALUES (?,?,?,?,?,?, 'aws', ?,?,?,?,?, 'us-east-1', 'available', '{}', ?, ?, ?, ?)`,
    ).bind(
      "cres_seed_eni_0001", SNAPSHOT_ID, ORG_ID, CUSTOMER_ID, CONNECTION_ID,
      "ec2:network-interface:eni-0aaa111", "ec2", "network-interface", "eni-0aaa111",
      `arn:aws:ec2:us-east-1:${ACCOUNT_ID}:network-interface/eni-0aaa111`, "eni-payments",
      JSON.stringify({ publicIpAddress: "52.10.0.5", subnetId: "subnet-0aaa", securityGroupIds: ["sg-0aaa"], instanceId: "i-0abc123def456", privateIpAddress: "10.0.1.10" }),
      JSON.stringify({ api: "ec2:DescribeNetworkInterfaces", accountId: ACCOUNT_ID }), HEX64, NOW,
    ),
    db.prepare(
      `INSERT INTO cmdb_resources
         (id, snapshot_id, org_id, customer_id, connection_id, resource_key, provider_key, service,
          resource_type, native_id, arn, name, region_key, state, tags_json, configuration_json,
          source_json, content_sha256, collected_at)
       VALUES (?,?,?,?,?,?, 'aws', ?,?,?,?,?, 'us-east-1', 'available', '{}', ?, ?, ?, ?)`,
    ).bind(
      "cres_seed_sg_0001", SNAPSHOT_ID, ORG_ID, CUSTOMER_ID, CONNECTION_ID,
      "ec2:security-group:sg-0aaa", "ec2", "security-group", "sg-0aaa",
      `arn:aws:ec2:us-east-1:${ACCOUNT_ID}:security-group/sg-0aaa`, "payments-sg",
      JSON.stringify({ ingress: [{ protocol: "tcp", fromPort: 443, toPort: 443, ipv4Cidrs: ["0.0.0.0/0"] }] }),
      JSON.stringify({ api: "ec2:DescribeSecurityGroups", accountId: ACCOUNT_ID }), HEX64, NOW,
    ),
    db.prepare(
      `INSERT INTO cmdb_resources
         (id, snapshot_id, org_id, customer_id, connection_id, resource_key, provider_key, service,
          resource_type, native_id, arn, name, region_key, state, tags_json, configuration_json,
          source_json, content_sha256, collected_at)
       VALUES (?,?,?,?,?,?, 'aws', ?,?,?,?,?, 'us-east-1', 'available', '{}', ?, ?, ?, ?)`,
    ).bind(
      "cres_seed_subnet_0001", SNAPSHOT_ID, ORG_ID, CUSTOMER_ID, CONNECTION_ID,
      "ec2:subnet:subnet-0aaa", "ec2", "subnet", "subnet-0aaa",
      `arn:aws:ec2:us-east-1:${ACCOUNT_ID}:subnet/subnet-0aaa`, "public-1a",
      JSON.stringify({ vpcId: "vpc-0aaa", mapPublicIpOnLaunch: true }),
      JSON.stringify({ api: "ec2:DescribeSubnets", accountId: ACCOUNT_ID }), HEX64, NOW,
    ),
    db.prepare(
      `INSERT INTO cmdb_resources
         (id, snapshot_id, org_id, customer_id, connection_id, resource_key, provider_key, service,
          resource_type, native_id, arn, name, region_key, state, tags_json, configuration_json,
          source_json, content_sha256, collected_at)
       VALUES (?,?,?,?,?,?, 'aws', ?,?,?,?,?, 'us-east-1', 'available', '{}', ?, ?, ?, ?)`,
    ).bind(
      "cres_seed_rtb_0001", SNAPSHOT_ID, ORG_ID, CUSTOMER_ID, CONNECTION_ID,
      "ec2:route-table:rtb-0aaa", "ec2", "route-table", "rtb-0aaa",
      `arn:aws:ec2:us-east-1:${ACCOUNT_ID}:route-table/rtb-0aaa`, "main-rt",
      JSON.stringify({ vpcId: "vpc-0aaa", main: true, associatedSubnetIds: ["subnet-0aaa"], routes: [{ destination: "0.0.0.0/0", target: "igw-0aaa" }, { destination: "10.0.0.0/16", target: "local" }] }),
      JSON.stringify({ api: "ec2:DescribeRouteTables", accountId: ACCOUNT_ID }), HEX64, NOW,
    ),
    db.prepare(
      `INSERT INTO cmdb_resources
         (id, snapshot_id, org_id, customer_id, connection_id, resource_key, provider_key, service,
          resource_type, native_id, arn, name, region_key, state, tags_json, configuration_json,
          source_json, content_sha256, collected_at)
       VALUES (?,?,?,?,?,?, 'aws', ?,?,?,?,?, 'us-east-1', 'available', '{}', '{}', ?, ?, ?)`,
    ).bind(
      "cres_seed_igw_0001", SNAPSHOT_ID, ORG_ID, CUSTOMER_ID, CONNECTION_ID,
      "ec2:internet-gateway:igw-0aaa", "ec2", "internet-gateway", "igw-0aaa",
      `arn:aws:ec2:us-east-1:${ACCOUNT_ID}:internet-gateway/igw-0aaa`, "igw",
      JSON.stringify({ api: "ec2:DescribeInternetGateways", accountId: ACCOUNT_ID }), HEX64, NOW,
    ),
    db.prepare(
      `INSERT INTO cmdb_change_events
         (id, org_id, customer_id, connection_id, from_snapshot_id, to_snapshot_id, resource_key,
          change_type, changed_paths_json, before_json, after_json, occurred_at)
       VALUES (?,?,?,?,NULL,?,?, 'added', '[]', NULL, ?, ?)`,
    ).bind(
      "cce_seed0000000000000000000000000000000001",
      ORG_ID, CUSTOMER_ID, CONNECTION_ID, SNAPSHOT_ID, "ec2:network-interface:eni-0aaa111",
      JSON.stringify({ resourceKey: "ec2:network-interface:eni-0aaa111", service: "ec2", resourceType: "network-interface" }), NOW - 2 * DAY,
    ),
    db.prepare(
      `INSERT INTO cmdb_change_events
         (id, org_id, customer_id, connection_id, from_snapshot_id, to_snapshot_id, resource_key,
          change_type, changed_paths_json, before_json, after_json, occurred_at)
       VALUES (?,?,?,?,NULL,?,?, 'modified', ?, ?, ?, ?)`,
    ).bind(
      "cce_seed0000000000000000000000000000000002",
      ORG_ID, CUSTOMER_ID, CONNECTION_ID, SNAPSHOT_ID, "ec2:security-group:sg-0aaa",
      JSON.stringify(["configuration.ingress"]),
      JSON.stringify({ resourceKey: "ec2:security-group:sg-0aaa", configuration: { ingress: [] } }),
      JSON.stringify({ resourceKey: "ec2:security-group:sg-0aaa", configuration: { ingress: [{ protocol: "tcp", fromPort: 443, toPort: 443, ipv4Cidrs: ["0.0.0.0/0"] }] } }), NOW - DAY,
    ),
  ]);
}

async function seedComplianceAndOps(db, userId) {
  const ADMIN_USER_ID = userId;
  const hex32 = () => crypto.randomUUID().replaceAll("-", "");
  const hex64 = () => hex32() + hex32();
  const mkId = (p) => `${p}_${hex32()}`;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const dueMs = nowMs + 7 * 24 * 60 * 60 * 1000;
  const futureMs = nowMs + 90 * 24 * 60 * 60 * 1000;

  const costPayload = {
    schemaVersion: "sutra.aws-costs.v1", status: "COMPLETE", accountId: ACCOUNT_ID,
    currency: "USD", collectedAt: "2026-07-19T12:00:00.000Z",
    periodStart: "2026-06-01", periodEnd: "2026-06-30",
    totalCost: 48213.55, monthToDateCost: 48213.55, previousMonthCost: 44120.1, trendPercent: 9.28,
    monthlyTrend: [
      { start: "2026-05-01", end: "2026-05-31", amount: 44120.1 },
      { start: "2026-06-01", end: "2026-06-30", amount: 48213.55 },
    ],
    serviceBreakdown: [
      { key: "AmazonEC2", label: "Amazon EC2", amount: 21050.2, sharePercent: 43.66 },
      { key: "AmazonRDS", label: "Amazon RDS", amount: 12110.0, sharePercent: 25.12 },
      { key: "AmazonS3", label: "Amazon S3", amount: 6053.35, sharePercent: 12.56 },
    ],
    accountBreakdown: [
      { key: ACCOUNT_ID, label: "Production (123456789012)", amount: 48213.55, sharePercent: 100 },
    ],
    forecast: {
      status: "FALLBACK", source: "SUTRA_LINEAR_PROJECTION", amount: 50120.0,
      periodStart: "2026-07-01", periodEnd: "2026-07-31", reasonCode: "COST_EXPLORER_FORECAST_UNAVAILABLE",
    },
    anomalies: [{
      id: "anomaly-ec2-spike-2026-06", severity: "medium",
      title: "EC2 spend rose 24% week-over-week",
      summary: "Amazon EC2 spend increased notably in the final week of the period.",
      evidence: { service: "AmazonEC2", deltaPercent: 24 },
    }],
    recommendations: [{
      id: "rec-ec2-concentration", category: "concentration",
      title: "EC2 is 43% of spend",
      summary: "A single service dominates cost; review rightsizing and commitment coverage.",
      evidence: { service: "AmazonEC2", sharePercent: 43 },
    }],
    limitations: ["Cost Explorer forecast API was unavailable; a linear projection was used."],
    unavailableReason: null,
  };
  const costJson = JSON.stringify(costPayload);

  const savedQuery = { combine: "and", predicates: [
    { kind: "field", field: "service", op: "eq", value: "s3" },
    { kind: "tag", key: "env", op: "eq", value: "prod" },
  ], limit: 100 };

  const cfControls = [
    { controlId: "CC6.1", title: "Logical access controls",
      sutraControlIds: ["SUTRA.AWS.S3.PUBLIC_ACCESS_BLOCK", "SUTRA.AWS.EC2.IMDSV2_REQUIRED"] },
    { controlId: "CC7.2", title: "Audit logging enabled",
      sutraControlIds: ["SUTRA.AWS.CLOUDTRAIL.LOGGING"] },
  ];

  await db.batch([
    db.prepare(
      `INSERT INTO case_routing_rules
         (id, org_id, customer_id, priority, match_severity, match_customer_id, route_assignee, route_team, route_destination)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(mkId("croute"), ORG_ID, CUSTOMER_ID, 10, "critical,high", null, null, "Cloud Security Team", null),
    db.prepare(
      `INSERT INTO finops_cur_lines
         (id, org_id, customer_id, connection_id, billing_period, line_item_id, usage_account_id, service, charge_category, usage_start, amount_micros, currency, tags_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(mkId("fl"), ORG_ID, CUSTOMER_ID, CONNECTION_ID, "2026-06", "li-ec2-0001", ACCOUNT_ID, "AmazonEC2", "Usage", "2026-06-01T00:00:00.000Z", "21050200000", "USD", JSON.stringify({ env: "prod", team: "platform" }), nowIso),
    db.prepare(
      `INSERT INTO finops_cur_lines
         (id, org_id, customer_id, connection_id, billing_period, line_item_id, usage_account_id, service, charge_category, usage_start, amount_micros, currency, tags_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(mkId("fl"), ORG_ID, CUSTOMER_ID, CONNECTION_ID, "2026-06", "li-rds-0001", ACCOUNT_ID, "AmazonRDS", "Usage", "2026-06-01T00:00:00.000Z", "12110000000", "USD", JSON.stringify({ env: "prod", team: "data" }), nowIso),
    db.prepare(
      `INSERT INTO finops_cur_lines
         (id, org_id, customer_id, connection_id, billing_period, line_item_id, usage_account_id, service, charge_category, usage_start, amount_micros, currency, tags_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(mkId("fl"), ORG_ID, CUSTOMER_ID, CONNECTION_ID, "2026-06", "li-s3-0001", ACCOUNT_ID, "AmazonS3", "Usage", "2026-06-01T00:00:00.000Z", "6053350000", "USD", JSON.stringify({ env: "prod", team: "platform" }), nowIso),
    db.prepare(
      `INSERT INTO finops_budgets
         (id, org_id, customer_id, name, currency, limit_micros, filter_json, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(`fb_${hex32()}`, ORG_ID, CUSTOMER_ID, "Monthly cloud budget", "USD", "50000000000", null, ADMIN_USER_ID, nowIso, nowIso),
    db.prepare(
      `INSERT INTO cost_snapshots
         (id, org_id, customer_id, connection_id, source, status, currency, period_start, period_end, collected_at, payload_json, payload_sha256)
       VALUES (?,?,?,?, 'aws_cost_explorer', ?,?,?,?,?,?,?)`,
    ).bind(mkId("cost"), ORG_ID, CUSTOMER_ID, CONNECTION_ID, "complete", "USD", "2026-06-01", "2026-06-30", Date.parse(costPayload.collectedAt), costJson, hex64()),
    db.prepare(
      `INSERT INTO compliance_trend_points
         (id, org_id, customer_id, connection_id, framework_id, snapshot_id, collected_at, pass_count, fail_count, unknown_count, not_collected_count, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(mkId("ct"), ORG_ID, CUSTOMER_ID, CONNECTION_ID, "soc-2-tsc", SNAPSHOT_ID, nowMs - 24 * 60 * 60 * 1000, 42, 6, 3, 5, nowIso),
    db.prepare(
      `INSERT INTO custom_frameworks
         (id, org_id, customer_id, name, title, claim_boundary, controls_json, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(`cf_${hex32()}`, ORG_ID, CUSTOMER_ID, "acme-internal", "Acme Internal Baseline", "Operator-defined mapping; readiness view only.", JSON.stringify(cfControls), ADMIN_USER_ID, nowIso, nowIso),
    db.prepare(
      `INSERT INTO control_assignments
         (id, org_id, customer_id, control_id, owner_team, owner_email, updated_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(mkId("ca"), ORG_ID, CUSTOMER_ID, "SUTRA.AWS.S3.PUBLIC_ACCESS_BLOCK", "Platform Security", "secops@acme.example", ADMIN_USER_ID, nowIso, nowIso),
    db.prepare(
      `INSERT INTO compliance_signoffs
         (id, org_id, customer_id, connection_id, report_sha256, decision, note, signed_by, mfa_verified, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(mkId("cs"), ORG_ID, CUSTOMER_ID, CONNECTION_ID, hex64(), "approved", "Reviewed against Q2 evidence pack.", ADMIN_USER_ID, 1, nowIso),
    db.prepare(
      `INSERT INTO finding_cases
         (id, case_number, org_id, customer_id, connection_id, finding_fingerprint, finding_snapshot_id, finding_severity, title, status, priority, assignee_membership_id, due_at, created_by_user_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?, 'open', ?, ?, ?, ?, ?, ?)`,
    ).bind(mkId("case"), "SUTRA-2026-0001", ORG_ID, CUSTOMER_ID, CONNECTION_ID, "sutra:finding:s3-public-access-block:acme-logs", SNAPSHOT_ID, "high", "S3 bucket missing public access block", "high", null, dueMs, ADMIN_USER_ID, nowMs, nowMs),
    db.prepare(
      `INSERT INTO security_notification_destinations
         (id, org_id, customer_id, channel, display_name, enabled, secret_reference, email_recipients_json, email_from_address, ses_region, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(`ndest_${hex32()}`, ORG_ID, CUSTOMER_ID, "slack", "Security Slack", 1, "secret://sutra/notifications/slack-primary", null, null, null, ADMIN_USER_ID, nowMs, nowMs),
    db.prepare(
      `INSERT INTO itsm_connectors
         (id, org_id, customer_id, name, connector_type, base_url, project_key, shared_secret, enabled, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(`itc_${hex32()}`, ORG_ID, CUSTOMER_ID, "Acme Jira", "jira", "https://acme.atlassian.net", "SEC", "shared-secret-abcdef0123456789", 1, ADMIN_USER_ID, nowIso, nowIso),
    db.prepare(
      `INSERT INTO api_tokens
         (id, org_id, customer_id, name, token_prefix, token_sha256, scopes_json, expires_at, created_by, created_at, last_used_at, revoked_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(`pat_${hex32()}`, ORG_ID, CUSTOMER_ID, "CI read-only token", "sutra_pat_0011aabb", hex64(), JSON.stringify(["read:resources", "read:findings", "read:cases"]), null, ADMIN_USER_ID, nowIso, null, null),
    db.prepare(
      `INSERT INTO identity_invitations
         (id, org_id, email, role, scope_mode, token_digest, invited_by, expires_at, accepted_at, accepted_user_id, revoked_at, created_at, customer_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(mkId("inv"), ORG_ID, "analyst@acme.example", "analyst", "assigned_customers", hex64(), ADMIN_USER_ID, futureMs, null, null, null, nowMs, CUSTOMER_ID),
    db.prepare(
      `INSERT INTO finding_exceptions
         (id, org_id, customer_id, scope_rule_id, scope_resource_ref, justification, approved_by, status, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?, 'active', ?, ?)`,
    ).bind(`fexc_${hex32()}`, ORG_ID, CUSTOMER_ID, "SUTRA.AWS.S3.PUBLIC_ACCESS_BLOCK", null, "Accepted risk pending bucket decommission next quarter.", "admin@sutra.local", nowMs, futureMs),
    db.prepare(
      `INSERT INTO resource_annotations
         (id, org_id, customer_id, connection_id, resource_key, owner_team, owner_email, custom_fields_json, updated_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(mkId("ra"), ORG_ID, CUSTOMER_ID, CONNECTION_ID, `aws:s3:us-east-1:${ACCOUNT_ID}:bucket/acme-public-assets`, "Platform Security", "secops@acme.example", JSON.stringify({ costCenter: "CC-1024" }), ADMIN_USER_ID, nowIso, nowIso),
    db.prepare(
      `INSERT INTO cmdb_saved_queries
         (id, org_id, customer_id, name, description, query_json, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(`sq_${hex32()}`, ORG_ID, CUSTOMER_ID, "public-s3-buckets", "Production S3 buckets", JSON.stringify(savedQuery), ADMIN_USER_ID, nowIso, nowIso),
    db.prepare(
      `INSERT INTO compliance_exceptions
         (id, org_id, customer_id, connection_id, control_key, finding_fingerprint, status, owner_user_id, requested_by, rationale, compensating_control, expires_at, requested_at, updated_at)
       VALUES (?,?,?,?,?,?, 'approved', ?,?,?,?,?,?,?)`,
    ).bind(mkId("cex"), ORG_ID, CUSTOMER_ID, CONNECTION_ID, "SUTRA.AWS.S3.PUBLIC_ACCESS_BLOCK", "sutra:finding:s3-public-access-block:acme-logs", ADMIN_USER_ID, ADMIN_USER_ID, "Bucket holds only non-sensitive public web assets; exposure is intentional.", "Object-level ACL review and CloudFront OAI enforced quarterly.", futureMs, nowMs, nowMs),
  ]);
}

// --- Driver ------------------------------------------------------------------
function authedRequest(path, { method = "GET", token, apiToken, jobToken, auth = "session", params = {}, body, origin = false } = {}) {
  const url = new URL(`${ORIGIN}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const headers = {};
  if (auth === "session") headers.cookie = `sutra_session=${token}`;
  else if (auth === "bearer") headers.authorization = `Bearer ${apiToken}`;
  else if (auth === "job") headers["x-sutra-job-token"] = jobToken;
  if (origin) {
    headers.origin = ORIGIN;
    headers["sec-fetch-site"] = "same-origin";
  }
  const init = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  return new Request(url, init);
}

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-e2e-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const db = await miniflare.getD1Database("DB");
    cloudflare.env.DB = db;
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(db);
    await run(db);
  } finally {
    await miniflare.dispose();
  }
}

test("onboarded customer can exercise every app section without a crash", async () => {
  await withDatabase(async (db) => {
    const { token, userId, apiToken } = await seedBaseline(db);
    const { clusterId } = await seedKubernetes(db);
    await seedVulnAndCloud(db);
    await seedComplianceAndOps(db, userId);

    const conn = { connectionId: CONNECTION_ID };
    const connCluster = clusterId === null ? conn : { connectionId: CONNECTION_ID, clusterId };

    // [modulePath, label, options]
    const routes = [
      // Dashboard / pilot
      ["app/api/pilot/state/route.ts", "pilot/state", { params: conn }],
      ["app/api/pilot/export/route.ts", "pilot/export", { params: { format: "json", connectionId: CONNECTION_ID } }],
      ["app/api/pilot/health/route.ts", "pilot/health", { params: {} }],
      ["app/api/v1/portfolio/route.ts", "portfolio", { params: {} }],
      ["app/api/v1/sessions/route.ts", "sessions", { params: {} }],
      ["app/api/auth/session/route.ts", "auth/session", { params: {} }],
      ["app/api/healthz/route.ts", "healthz", { params: {} }],
      // CMDB / changes
      ["app/api/v1/changes/route.ts", "changes", { params: { connectionId: CONNECTION_ID, limit: "50" } }],
      ["app/api/v1/cmdb/change-hints/route.ts", "cmdb/change-hints", { params: conn }],
      ["app/api/v1/cmdb/saved-queries/route.ts", "cmdb/saved-queries", { params: {} }],
      ["app/api/v1/cmdb/annotations/route.ts", "cmdb/annotations", { params: conn }],
      ["app/api/v1/cmdb/query/route.ts", "cmdb/query", {
        method: "POST",
        body: { connectionId: CONNECTION_ID, query: { predicates: [{ kind: "field", field: "service", op: "eq", value: "ec2" }] } },
      }],
      // Findings / exceptions
      ["app/api/v1/findings/exceptions/route.ts", "findings/exceptions", { params: conn }],
      // Vulnerabilities
      ["app/api/v1/cloud/vulnerabilities/route.ts", "cloud/vulnerabilities", { params: conn }],
      ["app/api/v1/vulnerabilities/exploitability/route.ts", "vulnerabilities/exploitability", { params: connCluster }],
      ["app/api/v1/network-exposure/route.ts", "network-exposure", { params: conn }],
      ["app/api/v1/registry/inventory/route.ts", "registry/inventory", { params: conn }],
      ["app/api/v1/iac-scan/collected/route.ts", "iac-scan/collected", { params: conn }],
      ["app/api/v1/security-events/route.ts", "security-events", { params: conn }],
      ["app/api/v1/cloud-detections/route.ts", "cloud-detections", { params: conn }],
      // Cases
      ["app/api/v1/cases/route.ts", "cases", { params: conn }],
      ["app/api/v1/cases/routing/route.ts", "cases/routing", { params: conn }],
      // Compliance
      ["app/api/v1/compliance/route.ts", "compliance", { params: conn }],
      ["app/api/v1/compliance/frameworks/route.ts", "compliance/frameworks", { params: conn }],
      ["app/api/v1/compliance/trend/route.ts", "compliance/trend", { params: { connectionId: CONNECTION_ID, framework: "soc-2-tsc" } }],
      ["app/api/v1/compliance/custom-frameworks/route.ts", "compliance/custom-frameworks", { params: conn }],
      ["app/api/v1/compliance/exceptions/route.ts", "compliance/exceptions", { params: conn }],
      ["app/api/v1/compliance/control-assignments/route.ts", "compliance/control-assignments", { params: {} }],
      ["app/api/v1/compliance/signoffs/route.ts", "compliance/signoffs", { params: conn }],
      // FinOps
      ["app/api/v1/finops/insights/route.ts", "finops/insights", { params: { connectionId: CONNECTION_ID, period: "2026-06", dimension: "service" } }],
      ["app/api/v1/finops/budgets/route.ts", "finops/budgets", { params: {} }],
      ["app/api/v1/costs/route.ts", "costs", { params: conn }],
      // Collection schedule / operations
      ["app/api/v1/collection-schedule/status/route.ts", "collection-schedule/status", { params: {} }],
      ["app/api/local/jobs/route.ts", "local/jobs", { params: { limit: "50" } }],
      ["app/api/local/schedules/route.ts", "local/schedules", { params: {} }],
      // Kubernetes
      ["app/api/v1/kubernetes/route.ts", "kubernetes", { params: connCluster }],
      ["app/api/v1/kubernetes/fleet/route.ts", "kubernetes/fleet", { params: conn }],
      ["app/api/v1/kubernetes/iam/route.ts", "kubernetes/iam", { params: connCluster }],
      ["app/api/v1/kubernetes/drift/route.ts", "kubernetes/drift", { params: connCluster }],
      ["app/api/v1/kubernetes/networkpolicies/route.ts", "kubernetes/networkpolicies", { params: connCluster }],
      ["app/api/v1/kubernetes/network-flows/route.ts", "kubernetes/network-flows", { params: connCluster }],
      ["app/api/v1/kubernetes/posture-trend/route.ts", "kubernetes/posture-trend", { params: conn }],
      ["app/api/v1/kubernetes/supply-chain/route.ts", "kubernetes/supply-chain", { params: connCluster }],
      ["app/api/v1/kubernetes/supply-chain/trust/route.ts", "kubernetes/supply-chain/trust", { params: connCluster }],
      ["app/api/v1/kubernetes/vulnerabilities/route.ts", "kubernetes/vulnerabilities", { params: connCluster }],
      ["app/api/v1/kubernetes/vulnerability-delta/route.ts", "kubernetes/vulnerability-delta", { params: connCluster }],
      ["app/api/v1/kubernetes/vulnerability-waivers/route.ts", "kubernetes/vulnerability-waivers", { params: conn }],
      ["app/api/v1/kubernetes/sboms/route.ts", "kubernetes/sboms", { params: { connectionId: CONNECTION_ID, clusterId, view: "history" } }],
      ["app/api/v1/kubernetes/agents/route.ts", "kubernetes/agents", { params: connCluster }],
      ["app/api/v1/kubernetes/runtime-events/route.ts", "kubernetes/runtime-events", { params: connCluster }],
      // Identity / config
      ["app/api/v1/api-tokens/route.ts", "api-tokens", { params: {} }],
      ["app/api/v1/invitations/route.ts", "invitations", { params: {} }],
      ["app/api/v1/customer-assignments/route.ts", "customer-assignments", { params: {} }],
      ["app/api/v1/itsm/connectors/route.ts", "itsm/connectors", { params: {} }],
      ["app/api/v1/notification-destinations/route.ts", "notification-destinations", { params: { customerId: CUSTOMER_ID } }],
      // Public API (service-account bearer token) — minimal coverage.
      ["app/api/public/v1/openapi.json/route.ts", "public/openapi.json", { auth: "none" }],
      ["app/api/public/v1/resources/route.ts", "public/resources", { auth: "bearer" }],
      ["app/api/public/v1/findings/route.ts", "public/findings", { auth: "bearer" }],
      ["app/api/public/v1/cases/route.ts", "public/cases", { auth: "bearer" }],
      ["app/api/public/v1/snapshots/route.ts", "public/snapshots", { auth: "bearer" }],
      ["app/api/public/v1/vulnerabilities/route.ts", "public/vulnerabilities", { auth: "bearer" }],
      ["app/api/public/v1/compliance/route.ts", "public/compliance", { auth: "bearer" }],
      // Release-readiness features (report builder, alerting, patch, universal
      // CMDB relationships/custom-assets, FinOps unit-counts + scheduled reports,
      // automated status).
      ["app/api/v1/reports/saved/route.ts", "reports/saved", { params: {} }],
      ["app/api/v1/reports/run/route.ts", "reports/run", {
        method: "POST",
        body: { definition: { dataset: "cmdb-resources", filters: { combine: "and", predicates: [{ kind: "field", field: "service", op: "eq", value: "ec2" }] }, columns: ["service", "name"] } },
      }],
      ["app/api/v1/alerts/route.ts", "alerts", { params: { customerId: CUSTOMER_ID } }],
      ["app/api/v1/patch/route.ts", "patch", { params: conn }],
      ["app/api/v1/cmdb/relationships/route.ts", "cmdb/relationships", { params: {} }],
      ["app/api/v1/cmdb/custom-assets/route.ts", "cmdb/custom-assets", { params: {} }],
      ["app/api/v1/finops/unit-counts/route.ts", "finops/unit-counts", { params: {} }],
      ["app/api/v1/finops/reports/route.ts", "finops/reports", { params: {} }],
      ["app/api/status/route.ts", "status", { auth: "none" }],
      // System-internal background-job drain (shared runner token).
      ["app/api/internal/jobs/run/route.ts", "internal/jobs/run", { method: "POST", auth: "job" }],
    ];

    const results = [];
    for (const [modulePath, label, options = {}] of routes) {
      const method = options.method ?? "GET";
      const mod = await import(`../${modulePath}`);
      const handler = mod[method];
      let status;
      let bodyText = "";
      let outcome;
      let note = "";
      if (typeof handler !== "function") {
        results.push({ label, method, status: "-", outcome: "NO_HANDLER", note: `no ${method} export` });
        continue;
      }
      try {
        const auth = options.auth ?? "session";
        const request = authedRequest(`/${modulePath.replace(/^app\/api/, "api").replace(/\/route\.ts$/, "")}`, {
          method, token, apiToken, jobToken: JOB_RUNNER_TOKEN, auth,
          params: options.params, body: options.body,
          origin: method !== "GET" && auth === "session",
        });
        const response = await handler(request, { params: Promise.resolve({}) });
        status = response.status;
        bodyText = await response.text();
        if (status === 200 || status === 201) outcome = "PASS";
        else if (status === 500) outcome = "FAIL_500";
        else if (status === 404) outcome = "FAIL_404";
        else if (status === 401 || status === 403) outcome = "FAIL_AUTH";
        else if (status === 503) { outcome = "SOFT_503"; note = `infra gate: ${safeErr(bodyText)}`; }
        else if (status === 400) { outcome = "SOFT_400"; note = safeErr(bodyText); }
        else { outcome = `OTHER_${status}`; note = safeErr(bodyText); }
      } catch (error) {
        outcome = "THREW";
        note = error?.message ?? String(error);
      }
      results.push({ label, method, status, outcome, note });
    }

    // Report matrix.
    const pad = (s, n) => String(s).padEnd(n);
    console.log("\n==== E2E CUSTOMER JOURNEY MATRIX ====");
    for (const r of results) {
      console.log(`${pad(r.outcome, 10)} ${pad(r.method, 5)} ${pad(r.status, 4)} ${pad(r.label, 38)} ${r.note}`);
    }
    const hard = results.filter((r) => ["FAIL_500", "FAIL_404", "FAIL_AUTH", "THREW", "NO_HANDLER"].includes(r.outcome));
    console.log(`\n${results.length} routes driven, ${results.length - hard.length} ok, ${hard.length} hard failures`);
    if (hard.length > 0) {
      console.log("HARD FAILURES:");
      for (const r of hard) console.log(`  ${r.outcome} ${r.method} ${r.label} :: ${r.note}`);
    }
    assert.equal(hard.length, 0, `${hard.length} sections failed (see matrix above)`);
  });
});

function safeErr(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.code ?? parsed?.error?.message ?? "";
  } catch {
    return text.slice(0, 80);
  }
}
