import { getRawDb } from "../../../db";
import { ensureRuntimeSchema } from "../../../db/runtime-migrations";
import { getCollectorHealth } from "../../../lib/pilot-server";

export const dynamic = "force-dynamic";

function response(ok: boolean, status: 200 | 503): Response {
  return Response.json(
    { ok },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

/** Public liveness/readiness probe. Never returns configuration or dependency details. */
export async function GET(): Promise<Response> {
  try {
    const db = getRawDb();
    await ensureRuntimeSchema(db);
    const database = await db.prepare("SELECT 1 AS healthy").first<{ healthy: number }>();
    if (database?.healthy !== 1) return response(false, 503);
    const collector = await getCollectorHealth();
    if (!collector.ok) return response(false, 503);
    return response(true, 200);
  } catch {
    return response(false, 503);
  }
}
