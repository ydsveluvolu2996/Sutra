import {
  listFinopsDashboardsByLevel,
  type FinopsDashboardCatalogEntry,
  type FinopsDashboardLevel,
  type FinopsDashboardMaturity,
} from "../../../lib/finops-dashboard-catalog";

/**
 * Presentation helpers shared by the dashboard index and the per-dashboard
 * route. Kept free of React so both server components and tests can use them,
 * and derived entirely from the catalog so there is no second source of truth.
 */

export const FINOPS_DASHBOARD_LEVEL_ORDER: readonly FinopsDashboardLevel[] =
  Object.freeze(["foundational", "advanced", "additional"]);

export const FINOPS_DASHBOARD_LEVEL_LABEL: Readonly<Record<FinopsDashboardLevel, string>> =
  Object.freeze({
    foundational: "Foundational",
    advanced: "Advanced",
    additional: "Additional",
  });

/** Level descriptions taken from the AWS catalog's own framing. */
export const FINOPS_DASHBOARD_LEVEL_SUMMARY: Readonly<Record<FinopsDashboardLevel, string>> =
  Object.freeze({
    foundational:
      "Built entirely on the AWS Cost and Usage Report. AWS recommends starting here.",
    advanced:
      "Require the advanced data collection stack: provider APIs beyond billing data.",
    additional:
      "Depend on other data sources or cover a narrower use case than the CUR alone.",
  });

export const FINOPS_MATURITY_LABEL: Readonly<Record<FinopsDashboardMaturity, string>> =
  Object.freeze({
    LOCAL_VERTICAL_CANDIDATE: "Local candidate",
    PARTIAL_PIPELINE: "Partial pipeline",
    ENGINE_ONLY: "Engine only",
    ABSENT: "Absent",
    LOCAL_VERTICAL_VERIFIED: "Local verified",
    LIVE_ACCEPTED: "Live accepted",
  });

/**
 * What each maturity actually means for a reader, so a badge is never mistaken
 * for a production guarantee. Wording deliberately mirrors the implementation
 * tracker's status vocabulary.
 */
export const FINOPS_MATURITY_MEANING: Readonly<Record<FinopsDashboardMaturity, string>> =
  Object.freeze({
    LOCAL_VERTICAL_CANDIDATE:
      "Collector, persistence, API and UI exist locally. Not production-ready and not live-accepted.",
    PARTIAL_PIPELINE:
      "More than an engine exists, but the provider-to-visual path is incomplete.",
    ENGINE_ONLY: "A bounded engine exists; collector, persistence, API or UI is missing.",
    ABSENT: "No capability-specific end-to-end implementation exists.",
    LOCAL_VERTICAL_VERIFIED: "Every local stage is proven at one exact commit.",
    LIVE_ACCEPTED: "The deployed digest passed controlled provider and post-deploy acceptance.",
  });

/** Route for one dashboard. Slugs are unique across the catalog. */
export function finopsDashboardHref(slug: string): string {
  return `/costs/dashboards/${slug}`;
}

export interface FinopsMaturityTally {
  readonly maturity: FinopsDashboardMaturity;
  readonly label: string;
  readonly count: number;
}

/**
 * Count dashboards by maturity, in the catalog's declared maturity order so the
 * result is stable rather than dependent on iteration order.
 */
export function tallyMaturity(
  dashboards: readonly { readonly currentMaturity: FinopsDashboardMaturity }[],
): readonly FinopsMaturityTally[] {
  const order: readonly FinopsDashboardMaturity[] = [
    "LIVE_ACCEPTED",
    "LOCAL_VERTICAL_VERIFIED",
    "LOCAL_VERTICAL_CANDIDATE",
    "PARTIAL_PIPELINE",
    "ENGINE_ONLY",
    "ABSENT",
  ];
  return Object.freeze(order
    .map((maturity) => ({
      maturity,
      label: FINOPS_MATURITY_LABEL[maturity],
      count: dashboards.filter((entry) => entry.currentMaturity === maturity).length,
    }))
    .filter((tally) => tally.count > 0));
}

/** Tone for a maturity in charts: green for proven, amber for partial, red for absent. */
export function maturityTone(maturity: FinopsDashboardMaturity):
  "green" | "teal" | "amber" | "red" | "slate" {
  switch (maturity) {
    case "LIVE_ACCEPTED": return "green";
    case "LOCAL_VERTICAL_VERIFIED": return "teal";
    case "LOCAL_VERTICAL_CANDIDATE": return "teal";
    case "PARTIAL_PIPELINE": return "amber";
    case "ENGINE_ONLY": return "red";
    case "ABSENT": return "red";
    default: return "slate";
  }
}

export interface FinopsLevelGroup {
  readonly level: FinopsDashboardLevel;
  readonly label: string;
  readonly summary: string;
  readonly dashboards: readonly FinopsDashboardCatalogEntry[];
  readonly tallies: readonly FinopsMaturityTally[];
}

export function groupFinopsDashboardsByLevel(): readonly FinopsLevelGroup[] {
  return Object.freeze(FINOPS_DASHBOARD_LEVEL_ORDER.map((level) => {
    const dashboards = listFinopsDashboardsByLevel(level);
    return Object.freeze({
      level,
      label: FINOPS_DASHBOARD_LEVEL_LABEL[level],
      summary: FINOPS_DASHBOARD_LEVEL_SUMMARY[level],
      dashboards,
      tallies: tallyMaturity(dashboards),
    });
  }));
}
