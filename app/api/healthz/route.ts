import { env } from "cloudflare:workers";
import { getRawDb } from "../../../db";
import { ensureRuntimeSchema } from "../../../db/runtime-migrations";
import { getCollectorHealth } from "../../../lib/pilot-server";
import {
  RELEASE_IMAGE_HEADER,
  validatedReleaseImage,
} from "../../../lib/release-identity";

export const dynamic = "force-dynamic";

interface HealthRuntimeEnv {
  readonly SUTRA_RELEASE_IMAGE?: string;
}

function response(ok: boolean, status: 200 | 503, releaseImage: string | null): Response {
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (releaseImage !== null) headers[RELEASE_IMAGE_HEADER] = releaseImage;
  return Response.json(
    { ok },
    {
      status,
      headers,
    },
  );
}

/** Public liveness/readiness probe. Never returns configuration or dependency details. */
export async function GET(): Promise<Response> {
  let releaseImage: string | null = null;
  try {
    releaseImage = validatedReleaseImage(
      (env as unknown as HealthRuntimeEnv).SUTRA_RELEASE_IMAGE,
    );
    const db = getRawDb();
    await ensureRuntimeSchema(db);
    const database = await db.prepare("SELECT 1 AS healthy").first<{ healthy: number }>();
    if (database?.healthy !== 1) return response(false, 503, releaseImage);
    const collector = await getCollectorHealth();
    if (!collector.ok) return response(false, 503, releaseImage);
    return response(true, 200, releaseImage);
  } catch {
    return response(false, 503, releaseImage);
  }
}
