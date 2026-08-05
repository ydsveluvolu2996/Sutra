import type {
  MirrorRow,
  VulnerabilityMirrorRepository,
} from "../db/vulnerability-mirror-repository.ts";
import { validateCisaKevCatalog } from "./exploitability-feed.ts";
import {
  productionOutboundFetch,
  type ManagedOutboundEnvironment,
} from "./managed-outbound-fetch.ts";
import { parseNvdRecord } from "./vulnerability-database.ts";

const KEV_URL =
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const NVD_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const CVE_ID = /^CVE-\d{4}-\d{4,}$/u;

async function boundedJson(
  url: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/json",
      "user-agent": "sutra-vulnerability-feed-refresh",
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`upstream-http-${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("upstream-response-too-large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("upstream-response-too-large");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("upstream-response-invalid");
  }
}

export async function refreshBoundedVulnerabilityFeed(input: {
  readonly feed: "kev" | "nvd";
  readonly nvdWindowDays?: number;
  readonly repository: VulnerabilityMirrorRepository;
  readonly environment?: ManagedOutboundEnvironment;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}): Promise<number> {
  const fetchImpl = productionOutboundFetch(
    input.environment ?? {},
    input.fetchImpl,
  );
  const nowMs = (input.now ?? Date.now)();
  const asOf = new Date(nowMs).toISOString();
  let rows: readonly MirrorRow[];
  if (input.feed === "kev") {
    const validation = validateCisaKevCatalog(await boundedJson(KEV_URL, fetchImpl));
    if (!validation.valid) throw new Error(`kev-feed-invalid:${validation.reason}`);
    rows = [...validation.feed.entries.keys()]
      .filter((cveId) => CVE_ID.test(cveId.toUpperCase()))
      .slice(0, 25_000)
      .map((cveId) => ({
        cveId,
        epssScore: null,
        epssPercentile: null,
        cvssScore: null,
        cvssVector: null,
        severity: null,
        summary: "CISA Known Exploited Vulnerabilities catalog membership",
        source: "cisa-kev",
        asOf,
      }));
  } else {
    const windowDays = Math.max(1, Math.min(120, input.nvdWindowDays ?? 3));
    const end = new Date(nowMs);
    const start = new Date(nowMs - windowDays * 24 * 60 * 60 * 1000);
    const query = new URLSearchParams({
      lastModStartDate: start.toISOString(),
      lastModEndDate: end.toISOString(),
      resultsPerPage: "2000",
      startIndex: "0",
    });
    const payload = await boundedJson(`${NVD_URL}?${query.toString()}`, fetchImpl);
    const values = typeof payload === "object" && payload !== null &&
      Array.isArray((payload as { vulnerabilities?: unknown }).vulnerabilities)
      ? (payload as { vulnerabilities: readonly unknown[] }).vulnerabilities
      : [];
    rows = values
      .slice(0, 2_000)
      .map(parseNvdRecord)
      .filter((record) => record !== null)
      .map((record) => ({
        cveId: record.id,
        epssScore: null,
        epssPercentile: null,
        cvssScore: record.cvssScore,
        cvssVector: record.cvssVector,
        severity: record.severity,
        summary: record.summary,
        source: "nvd",
        asOf,
      }));
  }
  if (rows.length === 0) throw new Error(`${input.feed}-feed-empty`);
  return input.repository.upsertFeedRows(input.feed, rows);
}
