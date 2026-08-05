/**
 * Normalizes the three Foundational dashboards' pinned official definitions
 * into one sheet descriptor so a single shell can present all of them.
 *
 * The three audits were written independently and do not share a shape: CUDOS
 * records one nullable `gap` and counts parameter and filter controls
 * separately, Cost Intelligence records a `gaps` array with its own support
 * vocabulary, and KPI records named control lists plus formula ids. This module
 * is the one place that reconciles them, so no component has to guess.
 *
 * Support vocabulary is preserved, never upgraded. A sheet that the audit calls
 * `PARTIAL_EVIDENCE` stays partial here, and its named gaps travel with it, so a
 * rendered sheet cannot imply coverage the evidence does not support.
 */

import { FINOPS_CUDOS_OFFICIAL_DEFINITION } from "../../lib/finops-cudos-official-definition.ts";
import { FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION } from "../../lib/finops-cost-intelligence-official-definition.ts";
import { FINOPS_KPI_OFFICIAL_DEFINITION } from "../../lib/finops-kpi-official-definition.ts";

/** Normalized coverage of one official sheet. */
export type FinopsSheetSupport = "SUPPORTED" | "PARTIAL";

export interface FinopsSheetDescriptor {
  /** Stable slug derived from the official sheet name; used for tab ids and hashes. */
  readonly key: string;
  /** Official sheet name, verbatim from the pinned definition. */
  readonly name: string;
  readonly visualCount: number;
  readonly controlCount: number;
  /** Normalized two-state coverage for badge colour and ordering. */
  readonly support: FinopsSheetSupport;
  /** The audit's own classification literal, preserved for disclosure. */
  readonly supportLabel: string;
  /** Named limitations from the audit. Empty only when the audit names none. */
  readonly gaps: readonly string[];
  /** Governed formula identifiers, where the audit records them (KPI only). */
  readonly formulaIds: readonly string[];
}

export interface FinopsSheetInventory {
  readonly sheets: readonly FinopsSheetDescriptor[];
  readonly totalSheets: number;
  readonly totalVisuals: number;
  readonly totalControls: number;
  readonly supportedSheets: number;
  readonly partialSheets: number;
  /** Source pin so the UI can show exactly which definition it mirrors. */
  readonly source: {
    readonly repository: string;
    readonly commit: string;
    readonly path: string;
    readonly sha256: string;
    readonly version: string | null;
  };
}

/** Slugify an official sheet name without collapsing distinct names together. */
export function sheetKey(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug === "" ? "sheet" : slug;
}

/**
 * Only `SUPPORTED` and `IMPLEMENTED_LOCAL` count as fully covered. Every other
 * classification — including any future one — normalizes to partial, so an
 * unrecognized literal fails towards disclosure rather than towards a claim.
 */
function normalizeSupport(label: string): FinopsSheetSupport {
  return label === "SUPPORTED" || label === "IMPLEMENTED_LOCAL" ? "SUPPORTED" : "PARTIAL";
}

function uniqueKeys(sheets: readonly FinopsSheetDescriptor[]): readonly FinopsSheetDescriptor[] {
  const seen = new Map<string, number>();
  return sheets.map((sheet) => {
    const count = seen.get(sheet.key) ?? 0;
    seen.set(sheet.key, count + 1);
    return count === 0 ? sheet : Object.freeze({ ...sheet, key: `${sheet.key}-${count + 1}` });
  });
}

function inventory(
  sheets: readonly FinopsSheetDescriptor[],
  source: FinopsSheetInventory["source"],
): FinopsSheetInventory {
  const keyed = uniqueKeys(sheets);
  return Object.freeze({
    sheets: Object.freeze(keyed),
    totalSheets: keyed.length,
    totalVisuals: keyed.reduce((sum, sheet) => sum + sheet.visualCount, 0),
    totalControls: keyed.reduce((sum, sheet) => sum + sheet.controlCount, 0),
    supportedSheets: keyed.filter((sheet) => sheet.support === "SUPPORTED").length,
    partialSheets: keyed.filter((sheet) => sheet.support === "PARTIAL").length,
    source: Object.freeze(source),
  });
}

/** FND-01 CUDOS — 19 sheets. */
export const FINOPS_CUDOS_SHEETS: FinopsSheetInventory = inventory(
  FINOPS_CUDOS_OFFICIAL_DEFINITION.sheets.map((sheet) => Object.freeze({
    key: sheetKey(sheet.name),
    name: sheet.name,
    visualCount: sheet.visualCount,
    controlCount: sheet.parameterControlCount + sheet.filterControlCount,
    support: normalizeSupport(sheet.support),
    supportLabel: sheet.support,
    // CUDOS records a single nullable gap rather than a list.
    gaps: Object.freeze(sheet.gap === null ? [] : [sheet.gap]),
    formulaIds: Object.freeze([]),
  })),
  {
    repository: FINOPS_CUDOS_OFFICIAL_DEFINITION.source.repository,
    commit: FINOPS_CUDOS_OFFICIAL_DEFINITION.source.commit,
    path: FINOPS_CUDOS_OFFICIAL_DEFINITION.source.path,
    sha256: FINOPS_CUDOS_OFFICIAL_DEFINITION.source.sha256,
    version: null,
  },
);

/** FND-02 Cost Intelligence — 10 sheets. */
export const FINOPS_COST_INTELLIGENCE_SHEETS: FinopsSheetInventory = inventory(
  FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION.sheets.map((sheet) => Object.freeze({
    // One official sheet name carries a trailing space ("OPTICS Explorer "),
    // which the slug drops; the displayed name stays verbatim.
    key: sheetKey(sheet.name),
    name: sheet.name.trim(),
    visualCount: sheet.visualCount,
    controlCount: sheet.parameterControlCount + sheet.filterControlCount,
    support: normalizeSupport(sheet.support),
    supportLabel: sheet.support,
    gaps: Object.freeze([...sheet.gaps]),
    formulaIds: Object.freeze([]),
  })),
  {
    repository: FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION.repository,
    commit: FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION.commit,
    path: FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION.path,
    sha256: FINOPS_COST_INTELLIGENCE_OFFICIAL_DEFINITION.sha256,
    version: null,
  },
);

/** Count every control placement the KPI audit records for a sheet. */
function kpiControlCount(sheet: (typeof FINOPS_KPI_OFFICIAL_DEFINITION.sheets)[number]): number {
  const filters = Object.values(sheet.filterControls as Readonly<Record<string, number>>)
    .reduce((sum, value) => sum + value, 0);
  return sheet.parameterControls.length + filters;
}

/** FND-03 KPI and Modernization — 10 sheets, v2.2.1. */
export const FINOPS_KPI_SHEETS: FinopsSheetInventory = inventory(
  FINOPS_KPI_OFFICIAL_DEFINITION.sheets.map((sheet) => Object.freeze({
    key: sheetKey(sheet.name),
    name: sheet.name,
    visualCount: sheet.visualCount,
    controlCount: kpiControlCount(sheet),
    support: normalizeSupport(sheet.support),
    supportLabel: sheet.support,
    gaps: Object.freeze([...sheet.gaps]),
    formulaIds: Object.freeze([...sheet.formulaIds]),
  })),
  {
    repository: FINOPS_KPI_OFFICIAL_DEFINITION.source.repository,
    commit: FINOPS_KPI_OFFICIAL_DEFINITION.source.commit,
    path: FINOPS_KPI_OFFICIAL_DEFINITION.source.definitionPath,
    sha256: FINOPS_KPI_OFFICIAL_DEFINITION.source.definitionSha256,
    version: FINOPS_KPI_OFFICIAL_DEFINITION.source.version,
  },
);

/** Look up one sheet by key, or null when the key is not part of the dashboard. */
export function findSheet(
  inventoryValue: FinopsSheetInventory,
  key: string,
): FinopsSheetDescriptor | null {
  return inventoryValue.sheets.find((sheet) => sheet.key === key) ?? null;
}
