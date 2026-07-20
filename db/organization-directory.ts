import { getRawDb } from "./index";
import { ensureRuntimeSchema } from "./runtime-migrations";

interface OrgIdRow {
  id: string;
}

/**
 * List every active organization id, ordered deterministically. Used by the
 * system job runner to fan retention sweeps across tenants — it operates only
 * on the ids returned here and each enqueued job carries its own org scope.
 */
export async function listActiveOrgIds(database: D1Database = getRawDb()): Promise<string[]> {
  await ensureRuntimeSchema(database);
  const rows = await database.prepare(
    `SELECT id FROM organizations WHERE status = 'active' ORDER BY id`,
  ).all<OrgIdRow>();
  return (rows.results ?? []).map((row) => row.id);
}
