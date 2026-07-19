// KEV enrichment source: a compact, refreshable snapshot of the CISA Known
// Exploited Vulnerabilities catalog, bundled so the control plane can flag
// actively-exploited CVEs without a per-request feed call. Refreshed by
// scripts/vuln-feed-refresh.mjs; the asOf stamp is carried so staleness stays
// visible, never hidden. KEV membership means a CVE is exploited in the wild —
// it is disclosure/exploit signal, not proof of exploitability in a given
// environment.
import snapshot from "../data/kev-snapshot.json" with { type: "json" };

interface KevSnapshotEntry {
  readonly knownExploited: boolean;
  readonly dueDate: string | null;
  readonly ransomware: boolean | null;
}

interface KevSnapshot {
  readonly asOf: string | null;
  readonly source: string;
  readonly entries: readonly (readonly [string, KevSnapshotEntry])[];
}

const data = snapshot as unknown as KevSnapshot;
const KEV = new Map<string, KevSnapshotEntry>(data.entries.map(([cve, entry]) => [cve.toUpperCase(), entry]));

export const KEV_AS_OF: string | null = data.asOf;
export const KEV_SOURCE: string = data.source;
export const KEV_COUNT: number = KEV.size;

export function isKnownExploited(cveId: string | null | undefined): boolean {
  return typeof cveId === "string" && KEV.has(cveId.toUpperCase());
}

export function kevEntry(cveId: string | null | undefined): KevSnapshotEntry | null {
  return typeof cveId === "string" ? KEV.get(cveId.toUpperCase()) ?? null : null;
}

export function sampleKevId(): string | null {
  const first = data.entries[0];
  return first ? first[0] : null;
}
