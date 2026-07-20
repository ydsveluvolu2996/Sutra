/**
 * Adapter: map ALREADY-persisted CUR/FOCUS line items + PROVIDED unit counts
 * into the pure unit-economics engine input. Attribution reuses the showback
 * adapter (account-id map and/or cost-allocation tag, account-map-wins
 * precedence), so a customer's spend is identified identically across the
 * showback and unit-economics engines. Unit counts are passed through unchanged;
 * they are business metrics that are never inferred from billing data. Pure.
 */
import type { NormalizedCurLine } from "./finops-cur.ts";
import { buildShowbackInput } from "./finops-showback-inputs.ts";
import type {
  CustomerUnitCount,
  GlobalUnitCount,
  UnitEconomicsInput,
} from "./finops-unit-economics.ts";

export interface UnitEconomicsAdapterInput {
  readonly curLines: readonly NormalizedCurLine[];
  /** Map of AWS usageAccountId → customerId. Optional. */
  readonly accountToCustomer?: Readonly<Record<string, string>>;
  /** Cost-allocation tag key whose value is the customerId. Optional. */
  readonly customerTagKey?: string;
  /** Per-customer, per-currency unit denominators (provided, never inferred). */
  readonly customerUnits?: readonly CustomerUnitCount[];
  /** Global, per-currency unit denominators (provided, never inferred). */
  readonly globalUnits?: readonly GlobalUnitCount[];
  readonly unitLabel?: string;
}

export function buildUnitEconomicsInput({
  curLines,
  accountToCustomer,
  customerTagKey,
  customerUnits,
  globalUnits,
  unitLabel,
}: UnitEconomicsAdapterInput): UnitEconomicsInput {
  const { lines, skipped } = buildShowbackInput({ curLines, accountToCustomer, customerTagKey });
  return {
    lines,
    customerUnits: customerUnits ?? [],
    globalUnits: globalUnits ?? [],
    unitLabel,
    skipped,
  };
}
