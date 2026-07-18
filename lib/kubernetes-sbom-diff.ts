// SBOM component diff: compares the software bill of materials between the two
// most recent scans and reports which components were added, removed, or had
// their version change. This is a pure diff of already-collected SBOM component
// metadata — it never infers a component that was not present in the evidence,
// and reports nothing (hasPrevious=false) when there is no earlier scan to
// compare against. It carries no severity: this is inventory drift, not a
// vulnerability judgement.

export interface SbomDiffComponent {
  readonly name: string;
  readonly version: string | null;
  readonly packageUrl: string | null;
  readonly type: string | null;
  readonly licenses?: readonly string[];
}

export type SbomComponentChangeKind = "added" | "removed" | "version-changed" | "license-changed";

export interface SbomComponentChange {
  readonly kind: SbomComponentChangeKind;
  readonly name: string;
  readonly packageUrl: string | null;
  readonly type: string | null;
  /** Prior value (version or license list joined); "absent" when newly added. */
  readonly from: string;
  /** Current value; "absent" when removed. */
  readonly to: string;
}

export interface SbomComponentDiffReport {
  readonly schema: "sutra.kubernetes-sbom-diff.v1";
  readonly hasPrevious: boolean;
  readonly changes: readonly SbomComponentChange[];
  readonly summary: {
    readonly added: number;
    readonly removed: number;
    readonly versionChanged: number;
    readonly licenseChanged: number;
    readonly unchanged: number;
  };
  readonly disclaimer: string;
}

const DIFF_DISCLAIMER =
  "SBOM diff compares the collected component inventory in the two most recent " +
  "scans. Components are keyed by package URL when present, otherwise by " +
  "type and name. It reports added, removed, version-changed and " +
  "license-changed components from the observed SBOM metadata only; it never " +
  "infers a component that was not reported, and reports nothing when there is " +
  "no previous scan to compare against.";

// Package URL is the strongest identity; fall back to type|name so components
// without a purl still diff deterministically instead of all colliding.
function componentKey(component: SbomDiffComponent): string {
  const purl = component.packageUrl?.trim();
  return purl !== undefined && purl.length > 0 ? `purl:${purl}` : `nt:${component.type ?? ""}|${component.name}`;
}

function licenseLabel(component: SbomDiffComponent): string {
  const licenses = [...(component.licenses ?? [])].sort();
  return licenses.length > 0 ? licenses.join(", ") : "none";
}

function first<T>(entries: readonly T[]): T | undefined {
  return entries.length > 0 ? entries[0] : undefined;
}

export function buildSbomComponentDiff(input: {
  readonly current: readonly SbomDiffComponent[];
  readonly previous: readonly SbomDiffComponent[] | null;
}): SbomComponentDiffReport {
  const hasPrevious = input.previous !== null;
  const changes: SbomComponentChange[] = [];
  const summary = { added: 0, removed: 0, versionChanged: 0, licenseChanged: 0, unchanged: 0 };

  // Group by key so duplicate component rows (same purl reported by multiple
  // images) collapse to one identity; the first row is the representative.
  const groupByKey = (components: readonly SbomDiffComponent[]): Map<string, SbomDiffComponent[]> => {
    const map = new Map<string, SbomDiffComponent[]>();
    for (const component of components) {
      const key = componentKey(component);
      const existing = map.get(key) ?? [];
      existing.push(component);
      map.set(key, existing);
    }
    return map;
  };

  const currentGroups = groupByKey(input.current);
  if (!hasPrevious) {
    return { schema: "sutra.kubernetes-sbom-diff.v1", hasPrevious, changes: [], summary, disclaimer: DIFF_DISCLAIMER };
  }
  const previousGroups = groupByKey(input.previous ?? []);

  for (const [key, group] of currentGroups) {
    const current = first(group);
    if (current === undefined) continue;
    const prior = first(previousGroups.get(key) ?? []);
    if (prior === undefined) {
      changes.push({ kind: "added", name: current.name, packageUrl: current.packageUrl, type: current.type, from: "absent", to: current.version ?? "unversioned" });
      summary.added += 1;
      continue;
    }
    let touched = false;
    if ((prior.version ?? null) !== (current.version ?? null)) {
      changes.push({ kind: "version-changed", name: current.name, packageUrl: current.packageUrl, type: current.type, from: prior.version ?? "unversioned", to: current.version ?? "unversioned" });
      summary.versionChanged += 1;
      touched = true;
    }
    if (licenseLabel(prior) !== licenseLabel(current)) {
      changes.push({ kind: "license-changed", name: current.name, packageUrl: current.packageUrl, type: current.type, from: licenseLabel(prior), to: licenseLabel(current) });
      summary.licenseChanged += 1;
      touched = true;
    }
    if (!touched) summary.unchanged += 1;
  }

  for (const [key, group] of previousGroups) {
    if (currentGroups.has(key)) continue;
    const prior = first(group);
    if (prior === undefined) continue;
    changes.push({ kind: "removed", name: prior.name, packageUrl: prior.packageUrl, type: prior.type, from: prior.version ?? "unversioned", to: "absent" });
    summary.removed += 1;
  }

  const kindRank: Readonly<Record<SbomComponentChangeKind, number>> = {
    "version-changed": 0, added: 1, removed: 2, "license-changed": 3,
  };
  changes.sort((left, right) =>
    kindRank[left.kind] - kindRank[right.kind] ||
    left.name.localeCompare(right.name, "en-US") ||
    (left.packageUrl ?? "").localeCompare(right.packageUrl ?? "", "en-US"));

  return { schema: "sutra.kubernetes-sbom-diff.v1", hasPrevious, changes, summary, disclaimer: DIFF_DISCLAIMER };
}
