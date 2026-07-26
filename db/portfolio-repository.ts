import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";
import type { AuthorizationSubject } from "../lib/auth-policy";
import type {
  PortfolioConnectionSummary,
  PortfolioCustomerSummary,
  PortfolioState,
} from "../lib/portfolio-types";
import type { ConnectionStatus } from "../lib/pilot-types";

interface CustomerRow {
  id: string;
  slug: string;
  name: string;
  status: PortfolioCustomerSummary["status"];
  connection_count: number;
  resource_count: number;
  open_finding_count: number;
  latest_snapshot_at: number | null;
}

interface ConnectionRow {
  id: string;
  customer_id: string;
  source_kind: PortfolioConnectionSummary["sourceKind"];
  fixture_id: string | null;
  fixture_version: string | null;
  partition: PortfolioConnectionSummary["partition"];
  aws_account_id: string;
  role_arn: string;
  status: ConnectionStatus;
  enabled_regions_json: string;
  permission_pack_version: string;
  last_successful_sync_at: number | null;
  latest_snapshot_at: number | null;
  latest_snapshot_origin: PortfolioConnectionSummary["latestSnapshotOrigin"];
  resource_count: number;
  open_finding_count: number;
}

function numberValue(value: number): number {
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : 0;
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function regions(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function scopeSql(alias: "c" | "a"): string {
  const customerExpression = alias === "c" ? "c.id" : "a.customer_id";
  const orgExpression = alias === "c" ? "c.org_id" : "a.org_id";
  return `(? = 'all_customers' OR EXISTS (
    SELECT 1 FROM customer_access ca
     WHERE ca.org_id = ${orgExpression}
       AND ca.customer_id = ${customerExpression}
       AND ca.membership_id = ?
  ))`;
}

/**
 * Return only rows proven accessible by the persisted membership/grant tables.
 * The scope predicate stays inside each SQL statement so inaccessible customer
 * names and counts never enter an application-level result to be filtered later.
 */
export async function getPortfolio(subject: AuthorizationSubject, now = Date.now()): Promise<PortfolioState> {
  const db = getRawDb();
  await ensureRuntimeSchema(db);
  // Per-customer aggregates are pre-grouped once and LEFT JOINed by (org, customer)
  // instead of being recomputed as a correlated subquery for every customer row.
  // Each aggregate stays in its own grouped derived table so the one-to-many joins
  // never fan out across each other; connection_heads has a single row per connection
  // (PK connection_id) and finding_workflow_states is unique per (org, connection,
  // fingerprint), so every join below matches at most one row and the COUNT/MAX values
  // are identical to the previous correlated form. Missing groups yield NULL, which
  // COALESCE restores to 0 exactly as the correlated COUNT(*) did.
  const customerResult = await db.prepare(
    `SELECT c.id, c.slug, c.name, c.status,
            COALESCE(cc.connection_count, 0) AS connection_count,
            COALESCE(rc.resource_count, 0) AS resource_count,
            COALESCE(fc.open_finding_count, 0) AS open_finding_count,
            ls.latest_snapshot_at AS latest_snapshot_at
       FROM customers c
       LEFT JOIN (
         SELECT a.org_id, a.customer_id, COUNT(*) AS connection_count
           FROM aws_connections a
          GROUP BY a.org_id, a.customer_id
       ) cc ON cc.org_id = c.org_id AND cc.customer_id = c.id
       LEFT JOIN (
         SELECT r.org_id, r.customer_id, COUNT(*) AS resource_count
           FROM cmdb_resources r
           JOIN connection_heads h ON h.snapshot_id = r.snapshot_id
             AND h.connection_id = r.connection_id AND h.org_id = r.org_id
          GROUP BY r.org_id, r.customer_id
       ) rc ON rc.org_id = c.org_id AND rc.customer_id = c.id
       LEFT JOIN (
         SELECT f.org_id, f.customer_id, COUNT(*) AS open_finding_count
           FROM cmdb_findings f
           JOIN connection_heads h ON h.snapshot_id = f.snapshot_id
             AND h.connection_id = f.connection_id AND h.org_id = f.org_id
           LEFT JOIN finding_workflow_states w ON w.org_id = f.org_id
             AND w.connection_id = f.connection_id AND w.fingerprint = f.fingerprint
          WHERE COALESCE(w.status, f.status) = 'open'
          GROUP BY f.org_id, f.customer_id
       ) fc ON fc.org_id = c.org_id AND fc.customer_id = c.id
       LEFT JOIN (
         SELECT s.org_id, s.customer_id, MAX(s.collected_at) AS latest_snapshot_at
           FROM cmdb_snapshots s
           JOIN connection_heads h ON h.snapshot_id = s.id AND h.connection_id = s.connection_id
          GROUP BY s.org_id, s.customer_id
       ) ls ON ls.org_id = c.org_id AND ls.customer_id = c.id
      WHERE c.org_id = ? AND ${scopeSql("c")}
      ORDER BY c.name, c.id`,
  ).bind(subject.orgId, subject.scopeMode, subject.membershipId).all<CustomerRow>();

  // The single head snapshot (connection_heads PK = connection_id) is LEFT JOINed once
  // for both snapshot columns instead of two per-row LIMIT 1 subqueries; the two count
  // aggregates stay in their own grouped derived tables so resources and findings never
  // fan out across each other. Every join matches at most one row, so the emitted
  // collected_at/origin_kind/COUNT values are identical to the previous correlated form.
  const connectionResult = await db.prepare(
    `SELECT a.id, a.customer_id, a.source_kind, a.fixture_id, a.fixture_version,
            a.partition, a.aws_account_id, a.role_arn,
            a.status, a.enabled_regions_json, a.permission_pack_version,
            a.last_successful_sync_at,
            hs.collected_at AS latest_snapshot_at,
            hs.origin_kind AS latest_snapshot_origin,
            COALESCE(rc.resource_count, 0) AS resource_count,
            COALESCE(fc.open_finding_count, 0) AS open_finding_count
       FROM aws_connections a
       LEFT JOIN connection_heads hd ON hd.org_id = a.org_id AND hd.connection_id = a.id
       LEFT JOIN cmdb_snapshots hs ON hs.id = hd.snapshot_id AND hs.connection_id = hd.connection_id
       LEFT JOIN (
         SELECT h.org_id, h.connection_id, COUNT(*) AS resource_count
           FROM connection_heads h
           JOIN cmdb_resources r ON r.snapshot_id = h.snapshot_id AND r.connection_id = h.connection_id
          GROUP BY h.org_id, h.connection_id
       ) rc ON rc.org_id = a.org_id AND rc.connection_id = a.id
       LEFT JOIN (
         SELECT h.org_id, h.connection_id, COUNT(*) AS open_finding_count
           FROM connection_heads h
           JOIN cmdb_findings f ON f.snapshot_id = h.snapshot_id AND f.connection_id = h.connection_id
           LEFT JOIN finding_workflow_states w ON w.org_id = f.org_id
             AND w.connection_id = f.connection_id AND w.fingerprint = f.fingerprint
          WHERE COALESCE(w.status, f.status) = 'open'
          GROUP BY h.org_id, h.connection_id
       ) fc ON fc.org_id = a.org_id AND fc.connection_id = a.id
      WHERE a.org_id = ? AND ${scopeSql("a")}
      ORDER BY a.customer_id, a.created_at, a.id`,
  ).bind(subject.orgId, subject.scopeMode, subject.membershipId).all<ConnectionRow>();

  const connectionsByCustomer = new Map<string, PortfolioConnectionSummary[]>();
  for (const row of connectionResult.results ?? []) {
    const connection: PortfolioConnectionSummary = {
      id: row.id,
      customerId: row.customer_id,
      sourceKind: row.source_kind,
      fixtureId: row.fixture_id,
      fixtureVersion: row.fixture_version,
      awsAccountId: row.aws_account_id,
      partition: row.partition,
      status: row.status,
      roleArn: row.role_arn.length > 0 ? row.role_arn : null,
      enabledRegions: regions(row.enabled_regions_json),
      permissionPackVersion: row.permission_pack_version,
      lastSuccessfulSyncAt: iso(row.last_successful_sync_at),
      latestSnapshotAt: iso(row.latest_snapshot_at),
      latestSnapshotOrigin: row.latest_snapshot_origin,
      resourceCount: numberValue(row.resource_count),
      openFindingCount: numberValue(row.open_finding_count),
    };
    const values = connectionsByCustomer.get(row.customer_id) ?? [];
    values.push(connection);
    connectionsByCustomer.set(row.customer_id, values);
  }

  const customers: PortfolioCustomerSummary[] = (customerResult.results ?? []).map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    connectionCount: numberValue(row.connection_count),
    resourceCount: numberValue(row.resource_count),
    openFindingCount: numberValue(row.open_finding_count),
    latestSnapshotAt: iso(row.latest_snapshot_at),
    connections: connectionsByCustomer.get(row.id) ?? [],
  }));
  return {
    organizationId: subject.orgId,
    scopeMode: subject.scopeMode,
    measuredAt: new Date(now).toISOString(),
    totals: {
      customers: customers.length,
      connections: customers.reduce((total, customer) => total + customer.connectionCount, 0),
      resources: customers.reduce((total, customer) => total + customer.resourceCount, 0),
      openFindings: customers.reduce((total, customer) => total + customer.openFindingCount, 0),
    },
    customers,
  };
}
