/**
 * Locates the newest billing-period manifest under a discovered AWS Data Export
 * and produces the evidence an observation carries.
 *
 * This is the second half of Foundational billing discovery. The reader
 * (`finops-data-export-discovery-reader.ts`) resolves *where* an export writes;
 * this resolves *what has actually been delivered there*, which is a different
 * fact and the one the dashboards are waiting on. A granted permission, a
 * configured export and an existing prefix all prove nothing about delivery.
 *
 * It runs under the CUR 2.0 add-on's session, whose S3 grants are bounded to the
 * export's own prefix. Nothing here widens that: every key it reads is verified
 * to sit under the prefix it was given.
 */
import type { DiscoveredDataExport } from "./finops-data-export-discovery-reader.js";

/** Manifests are written per billing period at a fixed, AWS-owned path. */
const BILLING_PERIOD_MANIFEST =
  /^metadata\/BILLING_PERIOD=(\d{4}-\d{2})\/manifest\.json$/u;

const SHA256 = /^[a-f0-9]{64}$/u;

export interface DiscoveredManifest {
  readonly billingPeriod: string;
  readonly key: string;
  readonly eTag: string | null;
  readonly versionId: string | null;
  readonly sizeBytes: number;
  readonly lastModifiedIso: string;
}

export interface ManifestObjectListing {
  readonly key: string;
  readonly eTag: string | null;
  readonly versionId: string | null;
  readonly sizeBytes: number;
  readonly lastModifiedIso: string;
}

/**
 * The independent evidence an observation carries.
 *
 * "Independent" is the point: the ingest job re-reads the manifest itself and
 * compares. If the producer's totals and the consumer's disagree, the delivery
 * is rejected rather than reconciled, so a corrupted or swapped manifest cannot
 * enter the billing engine by being asserted twice.
 */
export interface DiscoveredExportEvidence {
  readonly manifestSha256: string;
  readonly rowCount: number;
  readonly currencies: readonly { readonly currency: string; readonly rowCount: number }[];
}

export type ManifestDiscoveryOutcome =
  | { readonly kind: "delivered"; readonly manifest: DiscoveredManifest }
  | { readonly kind: "awaiting-first-delivery" }
  | { readonly kind: "unavailable"; readonly reason: "ACCESS_DENIED" | "PROVIDER_ERROR" };

export class ManifestDiscoveryError extends Error {
  public constructor(public readonly code: "INVALID_PREFIX" | "KEY_OUTSIDE_PREFIX" | "ABORTED") {
    super("Billing export manifest discovery failed");
    this.name = "ManifestDiscoveryError";
  }
}

export interface ManifestDiscoveryReader {
  /** Lists objects under one exact prefix. Bounded by the add-on's S3 grant. */
  listPrefix(input: {
    readonly bucket: string;
    readonly prefix: string;
    readonly token: string | null;
  }, signal: AbortSignal): Promise<{
    readonly objects: readonly ManifestObjectListing[];
    readonly nextToken: string | null;
  }>;
}

// A tenant with more than this many objects under the metadata prefix is not a
// billing export; refusing to page forever is cheaper than discovering that at
// runtime. Truncation is reported, never silently treated as the whole set.
const MAX_PAGES = 20;

function assertUnderPrefix(key: string, prefix: string): void {
  // Defence against a provider response that points outside the boundary the
  // add-on grant covers. `..` cannot appear in an S3 key returned by List, but
  // the check costs nothing and the failure mode it prevents is reading an
  // object this session was never granted.
  if (!key.startsWith(prefix) || key.includes("..")) {
    throw new ManifestDiscoveryError("KEY_OUTSIDE_PREFIX");
  }
}

/**
 * Finds the newest billing period that has a manifest.
 *
 * Newest is chosen by billing period, not by `LastModified`: a correction
 * republished for an older period must not displace a later period's delivery.
 * Within one period the manifest is unique, so no tie-break is needed.
 */
export async function discoverNewestManifest(
  input: {
    readonly export: DiscoveredDataExport;
    readonly reader: ManifestDiscoveryReader;
  },
  signal: AbortSignal,
): Promise<ManifestDiscoveryOutcome> {
  const prefix = input.export.prefix;
  if (!prefix.endsWith("/") || prefix.startsWith("/") || prefix.includes("..")) {
    throw new ManifestDiscoveryError("INVALID_PREFIX");
  }

  const found: DiscoveredManifest[] = [];
  let token: string | null = null;
  let pages = 0;
  do {
    if (signal.aborted) throw new ManifestDiscoveryError("ABORTED");
    let page: Awaited<ReturnType<ManifestDiscoveryReader["listPrefix"]>>;
    try {
      page = await input.reader.listPrefix(
        { bucket: input.export.bucket, prefix: `${prefix}metadata/`, token },
        signal,
      );
    } catch (error) {
      const name = typeof error === "object" && error !== null && "name" in error
        ? String((error as { name: unknown }).name)
        : "";
      if (name === "AbortError") throw new ManifestDiscoveryError("ABORTED");
      // A denial is not an absence. The customer may have the export configured
      // and the add-on missing, and telling them "no data yet" would send them
      // to the wrong place entirely.
      if (name === "AccessDenied" || name === "AccessDeniedException") {
        return { kind: "unavailable", reason: "ACCESS_DENIED" };
      }
      return { kind: "unavailable", reason: "PROVIDER_ERROR" };
    }

    for (const object of page.objects) {
      assertUnderPrefix(object.key, prefix);
      const relative = object.key.slice(prefix.length);
      const match = BILLING_PERIOD_MANIFEST.exec(relative);
      if (match === null) continue;
      found.push({
        billingPeriod: match[1]!,
        key: object.key,
        eTag: object.eTag,
        versionId: object.versionId,
        sizeBytes: object.sizeBytes,
        lastModifiedIso: object.lastModifiedIso,
      });
    }
    token = page.nextToken;
    pages += 1;
  } while (token !== null && pages < MAX_PAGES);

  if (found.length === 0) return { kind: "awaiting-first-delivery" };

  // Lexicographic order is chronological for YYYY-MM, so no date parsing is
  // needed and no timezone can shift a period boundary.
  const newest = [...found].sort((a, b) => b.billingPeriod.localeCompare(a.billingPeriod))[0]!;
  return { kind: "delivered", manifest: newest };
}

/**
 * Derives the observation's independent evidence from a validated manifest.
 *
 * Row counts and currency splits come from the manifest's own declarations, not
 * from reading data files: discovery must stay cheap and must never touch
 * billing rows. The ingest job reads the rows and will reject the delivery if
 * its own totals disagree with these.
 */
export function evidenceFromManifest(manifest: {
  readonly manifestSha256: string;
  readonly dataFiles: readonly { readonly rowCount?: number | null }[];
  readonly declaredRowCount?: number | null;
  readonly declaredCurrencies?: readonly { readonly currency: string; readonly rowCount: number }[] | null;
}): DiscoveredExportEvidence {
  if (!SHA256.test(manifest.manifestSha256)) {
    throw new ManifestDiscoveryError("INVALID_PREFIX");
  }

  // Prefer what the manifest declares. Fall back to summing per-file counts only
  // when every file declares one: a partial sum would understate the delivery
  // and the ingest comparison would reject it for the wrong reason.
  function counted(value: number | null | undefined): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  }
  const perFile = manifest.dataFiles.map((file) => file.rowCount);
  const everyFileCounted = perFile.length > 0 && perFile.every(counted);
  const rowCount = counted(manifest.declaredRowCount)
    ? manifest.declaredRowCount
    : everyFileCounted
      ? perFile.filter(counted).reduce((total, count) => total + count, 0)
      : -1;

  if (rowCount < 0) {
    // The ingest payload requires an exact count. Guessing one would create
    // evidence the manifest does not support.
    throw new ManifestDiscoveryError("INVALID_PREFIX");
  }

  const declared = manifest.declaredCurrencies ?? [];
  const currencies = declared
    .filter((entry) => /^[A-Z]{3}$/u.test(entry.currency) && counted(entry.rowCount))
    // Deterministic order: the observation is deduped on a payload hash, so two
    // discoveries of the same delivery must serialize identically.
    .map((entry) => ({ currency: entry.currency, rowCount: entry.rowCount }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return { manifestSha256: manifest.manifestSha256, rowCount, currencies };
}
