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
  partition: PortfolioConnectionSummary["partition"];
  aws_account_id: string;
  role_arn: string;
  status: ConnectionStatus;
  enabled_regions_json: string;
  permission_pack_version: string;
  last_successful_sync_at: number | null;
  latest_snapshot_at: number | null;
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
  const customerResult = await db.prepare(
    `SELECT c.id, c.slug, c.name, c.status,
            (SELECT COUNT(*) FROM aws_connections a
              WHERE a.org_id = c.org_id AND a.customer_id = c.id) AS connection_count,
            (SELECT COUNT(*) FROM cmdb_resources r
              JOIN connection_heads h ON h.snapshot_id = r.snapshot_id
                AND h.connection_id = r.connection_id AND h.org_id = r.org_id
             WHERE r.org_id = c.org_id AND r.customer_id = c.id) AS resource_count,
            (SELECT COUNT(*) FROM cmdb_findings f
              JOIN connection_heads h ON h.snapshot_id = f.snapshot_id
                AND h.connection_id = f.connection_id AND h.org_id = f.org_id
              LEFT JOIN finding_workflow_states w ON w.org_id = f.org_id
                AND w.connection_id = f.connection_id AND w.fingerprint = f.fingerprint
             WHERE f.org_id = c.org_id AND f.customer_id = c.id
               AND COALESCE(w.status, f.status) = 'open') AS open_finding_count,
            (SELECT MAX(s.collected_at) FROM cmdb_snapshots s
              JOIN connection_heads h ON h.snapshot_id = s.id AND h.connection_id = s.connection_id
             WHERE s.org_id = c.org_id AND s.customer_id = c.id) AS latest_snapshot_at
       FROM customers c
      WHERE c.org_id = ? AND ${scopeSql("c")}
      ORDER BY c.name, c.id`,
  ).bind(subject.orgId, subject.scopeMode, subject.membershipId).all<CustomerRow>();

  const connectionResult = await db.prepare(
    `SELECT a.id, a.customer_id, a.partition, a.aws_account_id, a.role_arn,
            a.status, a.enabled_regions_json, a.permission_pack_version,
            a.last_successful_sync_at,
            (SELECT s.collected_at FROM connection_heads h
              JOIN cmdb_snapshots s ON s.id = h.snapshot_id AND s.connection_id = h.connection_id
             WHERE h.org_id = a.org_id AND h.connection_id = a.id LIMIT 1) AS latest_snapshot_at,
            (SELECT COUNT(*) FROM connection_heads h
              JOIN cmdb_resources r ON r.snapshot_id = h.snapshot_id AND r.connection_id = h.connection_id
             WHERE h.org_id = a.org_id AND h.connection_id = a.id) AS resource_count,
            (SELECT COUNT(*) FROM connection_heads h
              JOIN cmdb_findings f ON f.snapshot_id = h.snapshot_id AND f.connection_id = h.connection_id
              LEFT JOIN finding_workflow_states w ON w.org_id = f.org_id
                AND w.connection_id = f.connection_id AND w.fingerprint = f.fingerprint
             WHERE h.org_id = a.org_id AND h.connection_id = a.id
               AND COALESCE(w.status, f.status) = 'open') AS open_finding_count
       FROM aws_connections a
      WHERE a.org_id = ? AND ${scopeSql("a")}
      ORDER BY a.customer_id, a.created_at, a.id`,
  ).bind(subject.orgId, subject.scopeMode, subject.membershipId).all<ConnectionRow>();

  const connectionsByCustomer = new Map<string, PortfolioConnectionSummary[]>();
  for (const row of connectionResult.results ?? []) {
    const connection: PortfolioConnectionSummary = {
      id: row.id,
      customerId: row.customer_id,
      awsAccountId: row.aws_account_id,
      partition: row.partition,
      status: row.status,
      roleArn: row.role_arn.length > 0 ? row.role_arn : null,
      enabledRegions: regions(row.enabled_regions_json),
      permissionPackVersion: row.permission_pack_version,
      lastSuccessfulSyncAt: iso(row.last_successful_sync_at),
      latestSnapshotAt: iso(row.latest_snapshot_at),
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
