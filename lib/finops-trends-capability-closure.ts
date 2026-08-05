/**
 * Evidence-honest closure for the official AWS Trends feature inventory.
 *
 * The cost engine remains authoritative for period completeness and exact
 * totals. This projection uses only its already-validated active CUR2 rows.
 * QuickSight or Organizations output is never inferred from CUR2 fields.
 */
import type { FinopsCostBasis } from "./finops-billing-projections.ts";
import type { CanonicalCurLine } from "./finops-cur.ts";
import type {
  FinopsTrendsActivePeriodInput,
  FinopsTrendsIntelligenceSnapshot,
} from "./finops-trends-intelligence.ts";

const INTEGER = /^-?(?:0|[1-9]\d{0,127})$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]{1,1024}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/u;
const MAX_GROUPS = 50_000;
const MAX_AUTOMATION_ROWS = 200;
const FORECAST_PERIODS = 3;
const FORECAST_TRAINING_PERIODS = 12;
const ZERO = BigInt(0);

export interface FinopsTrendsAutomationStatus {
  readonly available: boolean;
  readonly configuredCount: number | null;
  readonly enabledCount: number | null;
  readonly reason: "SUTRA_TENANT_SCOPED_RUNTIME" | "RUNTIME_STATUS_UNAVAILABLE";
}

export interface FinopsTrendsCapabilityClosureInput {
  readonly report: FinopsTrendsIntelligenceSnapshot;
  readonly periods: readonly FinopsTrendsActivePeriodInput[];
  readonly automation?: {
    readonly alertRules: FinopsTrendsAutomationStatus;
    readonly scheduledReports: FinopsTrendsAutomationStatus;
  };
}

export type FinopsTrendsCapabilityState = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";

export interface FinopsTrendsForecastAvailable {
  readonly available: true;
  readonly currency: string;
  readonly costBasis: FinopsCostBasis;
  readonly model: "sutra_integer_linear_trend_v1";
  readonly estimate: true;
  readonly trainingWindow: {
    readonly fromPeriod: string;
    readonly toPeriod: string;
    readonly periodCount: number;
    readonly generationIds: readonly string[];
  };
  readonly points: readonly {
    readonly period: string;
    readonly forecastMicros: string;
    readonly lowerMicros: string;
    readonly upperMicros: string;
  }[];
  readonly errorBand: {
    readonly method: "mean_absolute_residual";
    readonly meanAbsoluteResidualMicros: string;
    readonly statisticalConfidence: false;
  };
  readonly disclosure: "SUTRA_DETERMINISTIC_ESTIMATE_NOT_AWS_QUICKSIGHT_ML_NOT_A_QUOTE";
}

export interface FinopsTrendsForecastUnavailable {
  readonly available: false;
  readonly currency: string;
  readonly costBasis: FinopsCostBasis;
  readonly reason:
    | "INSUFFICIENT_CONTIGUOUS_COMPLETE_HISTORY"
    | "NO_COMPLETE_COST_EVIDENCE";
  readonly observedCompletePeriods: number;
  readonly minimumRequired: 3;
}

export type FinopsTrendsForecast =
  | FinopsTrendsForecastAvailable
  | FinopsTrendsForecastUnavailable;

export interface FinopsTrendsCapabilityClosure {
  readonly schema: "sutra.finops-trends-capability-closure.v1";
  readonly forecast: {
    readonly provider: {
      readonly available: false;
      readonly reason: "AWS_QUICKSIGHT_ML_FORECAST_EVIDENCE_NOT_INGESTED";
    };
    readonly sutra: readonly FinopsTrendsForecast[];
  };
  readonly serviceTaxonomy: {
    readonly state: FinopsTrendsCapabilityState;
    readonly evidenceBasis: "ACTIVE_CUR2_SERVICE_CATEGORY_FIELDS";
    readonly missingTaxonomyRowCount: number;
    readonly groups: readonly {
      readonly category: string;
      readonly subcategory: string | null;
      readonly services: readonly string[];
    }[];
    readonly costTrends: readonly {
      readonly period: string;
      readonly category: string;
      readonly subcategory: string | null;
      readonly service: string;
      readonly currency: string;
      readonly costBasis: FinopsCostBasis;
      readonly totalMicros: string;
      readonly rowCount: number;
    }[];
  };
  readonly serviceUsage: {
    readonly state: FinopsTrendsCapabilityState;
    readonly evidenceBasis: "ACTIVE_CUR2_METERED_QUANTITY_AND_UNIT";
    readonly missingQuantityRowCount: number;
    readonly missingUnitRowCount: number;
    readonly groups: readonly {
      readonly period: string;
      readonly category: string | null;
      readonly service: string;
      readonly usageType: string | null;
      readonly unit: string;
      readonly usageAmountMicros: string;
      readonly rowCount: number;
    }[];
  };
  readonly accounts: {
    readonly state: FinopsTrendsCapabilityState;
    readonly evidenceBasis: "ACTIVE_CUR2_ACCOUNT_NAME_FIELDS_NOT_ORGANIZATIONS_API";
    readonly organizationsApiEvidenceAvailable: false;
    readonly missingPayerAccountIdRowCount: number;
    readonly missingNameRowCount: number;
    readonly entries: readonly {
      readonly role: "PAYER" | "USAGE";
      readonly accountId: string;
      readonly friendlyName: string | null;
      readonly nameState: "CUR2_FIELD" | "UNAVAILABLE" | "CONFLICT";
    }[];
  };
  readonly geography: {
    readonly state: FinopsTrendsCapabilityState;
    readonly evidenceBasis: "ACTIVE_CUR2_REGION_COST_AND_METERED_USAGE";
    readonly map: {
      readonly available: false;
      readonly reason: "AUTHORITATIVE_REGION_COORDINATES_NOT_INGESTED";
    };
    readonly missingRegionRowCount: number;
    readonly regions: readonly {
      readonly region: string;
      readonly costs: readonly {
        readonly currency: string;
        readonly costBasis: FinopsCostBasis;
        readonly totalMicros: string;
      }[];
      readonly usage: readonly {
        readonly unit: string;
        readonly usageAmountMicros: string;
      }[];
    }[];
  };
  readonly automation: {
    readonly quickSightThresholdAlerts: {
      readonly available: false;
      readonly reason: "AWS_QUICKSIGHT_ALERT_EVIDENCE_NOT_INGESTED";
    };
    readonly quickSightScheduledDelivery: {
      readonly available: false;
      readonly reason: "AWS_QUICKSIGHT_SCHEDULE_EVIDENCE_NOT_INGESTED";
    };
    readonly sutraAlertRules: FinopsTrendsAutomationStatus;
    readonly sutraScheduledCostReports: FinopsTrendsAutomationStatus;
  };
}

export class FinopsTrendsCapabilityClosureError extends Error {
  public readonly code: "INVALID_INPUT" | "SCOPE_MISMATCH" | "DIMENSION_LIMIT_EXCEEDED";

  public constructor(code: FinopsTrendsCapabilityClosureError["code"]) {
    super("Trends capability evidence was rejected");
    this.name = "FinopsTrendsCapabilityClosureError";
    this.code = code;
  }
}

function reject(code: FinopsTrendsCapabilityClosureError["code"] = "INVALID_INPUT"): never {
  throw new FinopsTrendsCapabilityClosureError(code);
}

function validText(value: unknown): value is string {
  return typeof value === "string" && SAFE_TEXT.test(value);
}

function exactCost(line: CanonicalCurLine, basis: FinopsCostBasis): string | null {
  switch (basis) {
    case "unblended": return line.amountMicros;
    case "net": return line.netUnblendedCostMicros;
    case "amortized": return line.amortizedMicros;
    case "list": return line.listCostMicros;
    case "contracted": return line.contractedCostMicros;
    case "public": return line.publicOnDemandCostMicros;
  }
}

function addMonth(period: string, increment: number): string {
  const [yearText, monthText] = period.split("-");
  const index = Number(yearText) * 12 + Number(monthText) - 1 + increment;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function absolute(value: bigint): bigint {
  return value < ZERO ? -value : value;
}

function roundDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator === ZERO) reject();
  const negative = (numerator < ZERO) !== (denominator < ZERO);
  const n = absolute(numerator);
  const d = absolute(denominator);
  const quotient = n / d;
  const remainder = n % d;
  const rounded = remainder * BigInt(2) >= d ? quotient + BigInt(1) : quotient;
  return negative ? -rounded : rounded;
}

function forecast(report: FinopsTrendsIntelligenceSnapshot): readonly FinopsTrendsForecast[] {
  const generations = new Map(report.periods.map((period) => [period.period, period.generationId]));
  return report.series.map((series) => {
    const complete: { period: string; amount: bigint }[] = [];
    for (let index = series.points.length - 1; index >= 0; index -= 1) {
      const point = series.points[index];
      if (point.periodState !== "COMPLETE" || point.costCoverage !== "complete"
        || point.totalMicros === null || !INTEGER.test(point.totalMicros)) {
        if (complete.length > 0) break;
        continue;
      }
      if (complete.length > 0 && addMonth(point.period, 1) !== complete[0]?.period) break;
      complete.unshift({ period: point.period, amount: BigInt(point.totalMicros) });
      if (complete.length === FORECAST_TRAINING_PERIODS) break;
    }
    if (complete.length < 3) {
      return {
        available: false,
        currency: series.currency,
        costBasis: series.costBasis,
        reason: complete.length === 0
          ? "NO_COMPLETE_COST_EVIDENCE"
          : "INSUFFICIENT_CONTIGUOUS_COMPLETE_HISTORY",
        observedCompletePeriods: complete.length,
        minimumRequired: 3,
      };
    }
    const n = BigInt(complete.length);
    let sumX = ZERO;
    let sumY = ZERO;
    let sumXY = ZERO;
    let sumX2 = ZERO;
    complete.forEach((point, index) => {
      const x = BigInt(index);
      sumX += x;
      sumY += point.amount;
      sumXY += x * point.amount;
      sumX2 += x * x;
    });
    const slopeNumerator = n * sumXY - sumX * sumY;
    const slopeDenominator = n * sumX2 - sumX * sumX;
    const predicted = (x: bigint): bigint => roundDivide(
      sumY * slopeDenominator + slopeNumerator * (n * x - sumX),
      n * slopeDenominator,
    );
    const residual = roundDivide(complete.reduce((total, point, index) =>
      total + absolute(point.amount - predicted(BigInt(index))), ZERO), n);
    const lastPeriod = complete.at(-1)!.period;
    return {
      available: true,
      currency: series.currency,
      costBasis: series.costBasis,
      model: "sutra_integer_linear_trend_v1",
      estimate: true,
      trainingWindow: {
        fromPeriod: complete[0]!.period,
        toPeriod: lastPeriod,
        periodCount: complete.length,
        generationIds: complete.map(({ period }) => generations.get(period))
          .filter((value): value is string => value !== null && value !== undefined),
      },
      points: Array.from({ length: FORECAST_PERIODS }, (_, index) => {
        const value = predicted(n + BigInt(index));
        return {
          period: addMonth(lastPeriod, index + 1),
          forecastMicros: value.toString(),
          lowerMicros: (value - residual).toString(),
          upperMicros: (value + residual).toString(),
        };
      }),
      errorBand: {
        method: "mean_absolute_residual",
        meanAbsoluteResidualMicros: residual.toString(),
        statisticalConfidence: false,
      },
      disclosure: "SUTRA_DETERMINISTIC_ESTIMATE_NOT_AWS_QUICKSIGHT_ML_NOT_A_QUOTE",
    };
  });
}

interface RowWithPeriod {
  readonly period: string;
  readonly line: CanonicalCurLine;
}

function boundedSet<K, V>(map: Map<K, V>, key: K, factory: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  if (map.size >= MAX_GROUPS) reject("DIMENSION_LIMIT_EXCEEDED");
  const created = factory();
  map.set(key, created);
  return created;
}

function capabilityState(available: number, missing: number): FinopsTrendsCapabilityState {
  if (available === 0) return "UNAVAILABLE";
  return missing === 0 ? "COMPLETE" : "PARTIAL";
}

function validateAutomation(value: FinopsTrendsAutomationStatus): FinopsTrendsAutomationStatus {
  if (typeof value.available !== "boolean"
    || (value.available && (value.reason !== "SUTRA_TENANT_SCOPED_RUNTIME"
      || !Number.isSafeInteger(value.configuredCount) || value.configuredCount! < 0
      || value.configuredCount! > MAX_AUTOMATION_ROWS
      || !Number.isSafeInteger(value.enabledCount) || value.enabledCount! < 0
      || value.enabledCount! > value.configuredCount!))
    || (!value.available && (value.reason !== "RUNTIME_STATUS_UNAVAILABLE"
      || value.configuredCount !== null || value.enabledCount !== null))) reject();
  return Object.freeze({ ...value });
}

const UNAVAILABLE_AUTOMATION: FinopsTrendsAutomationStatus = Object.freeze({
  available: false,
  configuredCount: null,
  enabledCount: null,
  reason: "RUNTIME_STATUS_UNAVAILABLE",
});

export function buildFinopsTrendsCapabilityClosure(
  input: FinopsTrendsCapabilityClosureInput,
): FinopsTrendsCapabilityClosure {
  if (input.report.ok !== true || !Array.isArray(input.periods)) reject();
  const reportPeriods = new Map(input.report.periods.map((period) => [period.period, period]));
  const rows: RowWithPeriod[] = [];
  const seenPeriods = new Set<string>();
  for (const period of input.periods) {
    if (seenPeriods.has(period.scope.billingPeriod)
      || period.scope.organizationId !== input.report.tenant.organizationId
      || period.scope.customerId !== input.report.tenant.customerId
      || period.scope.connectionId !== input.report.tenant.connectionId
      || period.scope.exportName !== input.report.tenant.exportName
      || reportPeriods.get(period.scope.billingPeriod)?.generationId !== period.scope.generationId) {
      reject("SCOPE_MISMATCH");
    }
    seenPeriods.add(period.scope.billingPeriod);
    for (const row of period.rows) rows.push({ period: period.scope.billingPeriod, line: row.line });
  }

  let missingTaxonomy = 0;
  let missingQuantity = 0;
  let missingUnit = 0;
  let missingPayer = 0;
  let missingNames = 0;
  let missingRegion = 0;
  const taxonomy = new Map<string, { category: string; subcategory: string | null; services: Set<string> }>();
  const costTrends = new Map<string, { period: string; category: string; subcategory: string | null;
    service: string; currency: string; costBasis: FinopsCostBasis; total: bigint; rows: number }>();
  const usage = new Map<string, { period: string; category: string | null; service: string;
    usageType: string | null; unit: string; total: bigint; rows: number }>();
  const accounts = new Map<string, { role: "PAYER" | "USAGE"; accountId: string; names: Set<string> }>();
  const regions = new Map<string, { costs: Map<string, { currency: string; basis: FinopsCostBasis; total: bigint }>;
    usage: Map<string, bigint> }>();

  for (const { period, line } of rows) {
    const category = validText(line.serviceCategory) ? line.serviceCategory : null;
    const subcategory = validText(line.serviceSubcategory) ? line.serviceSubcategory : null;
    if (category === null) {
      missingTaxonomy += 1;
    } else {
      boundedSet(taxonomy, JSON.stringify([category, subcategory]), () =>
        ({ category, subcategory, services: new Set<string>() })).services.add(line.service);
      for (const basis of input.report.selectedCostBases) {
        const amount = exactCost(line, basis);
        if (amount === null || !INTEGER.test(amount)) continue;
        const key = JSON.stringify([period, category, subcategory, line.service, line.currency, basis]);
        const group = boundedSet(costTrends, key, () => ({ period, category, subcategory,
          service: line.service, currency: line.currency, costBasis: basis, total: ZERO, rows: 0 }));
        group.total += BigInt(amount);
        group.rows += 1;
      }
    }

    if (line.usageAmountMicros === null || !INTEGER.test(line.usageAmountMicros)) {
      missingQuantity += 1;
    } else if (!validText(line.usageUnit)) {
      missingUnit += 1;
    } else {
      const usageType = validText(line.usageType) ? line.usageType : null;
      const key = JSON.stringify([period, category, line.service, usageType, line.usageUnit]);
      const group = boundedSet(usage, key, () => ({ period, category, service: line.service,
        usageType, unit: line.usageUnit!, total: ZERO, rows: 0 }));
      group.total += BigInt(line.usageAmountMicros);
      group.rows += 1;
    }

    const usageAccount = boundedSet(accounts, `USAGE:${line.usageAccountId}`, () =>
      ({ role: "USAGE" as const, accountId: line.usageAccountId, names: new Set<string>() }));
    if (validText(line.usageAccountName)) usageAccount.names.add(line.usageAccountName);
    else missingNames += 1;
    if (typeof line.payerAccountId === "string" && ACCOUNT_ID.test(line.payerAccountId)) {
      const payer = boundedSet(accounts, `PAYER:${line.payerAccountId}`, () =>
        ({ role: "PAYER" as const, accountId: line.payerAccountId!, names: new Set<string>() }));
      if (validText(line.payerAccountName)) payer.names.add(line.payerAccountName);
      else missingNames += 1;
    } else missingPayer += 1;

    if (line.region === null || !REGION.test(line.region)) {
      missingRegion += 1;
    } else {
      const region = boundedSet(regions, line.region, () => ({ costs: new Map(), usage: new Map() }));
      for (const basis of input.report.selectedCostBases) {
        const amount = exactCost(line, basis);
        if (amount === null || !INTEGER.test(amount)) continue;
        const key = `${line.currency}:${basis}`;
        const cost = boundedSet(region.costs, key, () => ({ currency: line.currency, basis, total: ZERO }));
        cost.total += BigInt(amount);
      }
      if (line.usageAmountMicros !== null && INTEGER.test(line.usageAmountMicros) && validText(line.usageUnit)) {
        region.usage.set(line.usageUnit, (region.usage.get(line.usageUnit) ?? ZERO) + BigInt(line.usageAmountMicros));
      }
    }
  }

  const accountEntries = [...accounts.values()].map((entry) => {
    const names = [...entry.names].sort();
    return {
      role: entry.role,
      accountId: entry.accountId,
      friendlyName: names.length === 1 ? names[0]! : null,
      nameState: names.length === 0 ? "UNAVAILABLE" as const
        : names.length === 1 ? "CUR2_FIELD" as const : "CONFLICT" as const,
    };
  }).sort((left, right) => left.role.localeCompare(right.role) || left.accountId.localeCompare(right.accountId));
  const resolvedNames = accountEntries.filter((entry) => entry.nameState === "CUR2_FIELD").length;
  const alertRules = validateAutomation(input.automation?.alertRules ?? UNAVAILABLE_AUTOMATION);
  const scheduledReports = validateAutomation(input.automation?.scheduledReports ?? UNAVAILABLE_AUTOMATION);

  const result: FinopsTrendsCapabilityClosure = {
    schema: "sutra.finops-trends-capability-closure.v1",
    forecast: {
      provider: { available: false, reason: "AWS_QUICKSIGHT_ML_FORECAST_EVIDENCE_NOT_INGESTED" },
      sutra: forecast(input.report),
    },
    serviceTaxonomy: {
      state: capabilityState(taxonomy.size, missingTaxonomy),
      evidenceBasis: "ACTIVE_CUR2_SERVICE_CATEGORY_FIELDS",
      missingTaxonomyRowCount: missingTaxonomy,
      groups: [...taxonomy.values()].map((group) => ({ category: group.category,
        subcategory: group.subcategory, services: [...group.services].sort() }))
        .sort((left, right) => left.category.localeCompare(right.category)
          || (left.subcategory ?? "").localeCompare(right.subcategory ?? "")),
      costTrends: [...costTrends.values()].map((group) => ({
        period: group.period, category: group.category, subcategory: group.subcategory,
        service: group.service, currency: group.currency, costBasis: group.costBasis,
        totalMicros: group.total.toString(), rowCount: group.rows,
      }))
        .sort((left, right) => left.period.localeCompare(right.period)
          || left.category.localeCompare(right.category) || left.service.localeCompare(right.service)
          || left.currency.localeCompare(right.currency) || left.costBasis.localeCompare(right.costBasis)),
    },
    serviceUsage: {
      state: capabilityState(usage.size, missingQuantity + missingUnit),
      evidenceBasis: "ACTIVE_CUR2_METERED_QUANTITY_AND_UNIT",
      missingQuantityRowCount: missingQuantity,
      missingUnitRowCount: missingUnit,
      groups: [...usage.values()].map((group) => ({
        period: group.period, category: group.category, service: group.service,
        usageType: group.usageType, unit: group.unit,
        usageAmountMicros: group.total.toString(), rowCount: group.rows,
      }))
        .sort((left, right) => left.period.localeCompare(right.period)
          || left.service.localeCompare(right.service) || left.unit.localeCompare(right.unit)
          || (left.usageType ?? "").localeCompare(right.usageType ?? "")),
    },
    accounts: {
      state: capabilityState(resolvedNames, missingNames + missingPayer
        + accountEntries.filter((entry) => entry.nameState === "CONFLICT").length),
      evidenceBasis: "ACTIVE_CUR2_ACCOUNT_NAME_FIELDS_NOT_ORGANIZATIONS_API",
      organizationsApiEvidenceAvailable: false,
      missingPayerAccountIdRowCount: missingPayer,
      missingNameRowCount: missingNames,
      entries: accountEntries,
    },
    geography: {
      state: capabilityState(regions.size, missingRegion),
      evidenceBasis: "ACTIVE_CUR2_REGION_COST_AND_METERED_USAGE",
      map: { available: false, reason: "AUTHORITATIVE_REGION_COORDINATES_NOT_INGESTED" },
      missingRegionRowCount: missingRegion,
      regions: [...regions.entries()].map(([region, values]) => ({
        region,
        costs: [...values.costs.values()].map((cost) => ({ currency: cost.currency,
          costBasis: cost.basis, totalMicros: cost.total.toString() }))
          .sort((left, right) => left.currency.localeCompare(right.currency)
            || left.costBasis.localeCompare(right.costBasis)),
        usage: [...values.usage.entries()].map(([unit, amount]) =>
          ({ unit, usageAmountMicros: amount.toString() })).sort((left, right) => left.unit.localeCompare(right.unit)),
      })).sort((left, right) => left.region.localeCompare(right.region)),
    },
    automation: {
      quickSightThresholdAlerts: { available: false, reason: "AWS_QUICKSIGHT_ALERT_EVIDENCE_NOT_INGESTED" },
      quickSightScheduledDelivery: { available: false, reason: "AWS_QUICKSIGHT_SCHEDULE_EVIDENCE_NOT_INGESTED" },
      sutraAlertRules: alertRules,
      sutraScheduledCostReports: scheduledReports,
    },
  };
  return Object.freeze(result);
}
