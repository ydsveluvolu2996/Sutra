/**
 * Adapter: attribute ALREADY-persisted CUR/FOCUS line items to customers for the
 * pure showback engine. Attribution is by an AWS account-id → customerId map
 * and/or a configurable cost-allocation tag (e.g. "Customer"/"Tenant"). The
 * basis that attributed each line is recorded so the engine can disclose it.
 *
 * Precedence when both bases are configured AND both match: the account map wins
 * (an account belongs to exactly one customer, whereas a tag is per-resource and
 * can drift), and the basis is disclosed as "account-map". A line that matches
 * neither is emitted with customerId=null (unattributed) — it is never guessed.
 * Lines with an unusable currency/amount are dropped AND disclosed in `skipped`.
 * Pure, no I/O.
 */
import type { NormalizedCurLine } from "./finops-cur.ts";
import type {
  AttributedCurLine,
  AttributionBasis,
  ShowbackInput,
  SkippedShowbackLine,
} from "./finops-showback.ts";

export interface ShowbackAdapterInput {
  readonly curLines: readonly NormalizedCurLine[];
  /** Map of AWS usageAccountId → customerId. Optional. */
  readonly accountToCustomer?: Readonly<Record<string, string>>;
  /** Cost-allocation tag key whose value is the customerId (e.g. "Customer"). Optional. */
  readonly customerTagKey?: string;
}

const MICROS_INT = /^-?\d+$/u;
const CURRENCY_RE = /^[A-Z]{3}$/u;

/** Resolve (customerId, basis) for a line, honoring account-map-wins precedence. */
function attribute(
  line: NormalizedCurLine,
  accountToCustomer: Readonly<Record<string, string>> | undefined,
  customerTagKey: string | undefined,
): { customerId: string | null; basis: AttributionBasis | null } {
  if (accountToCustomer !== undefined) {
    const mapped = Object.prototype.hasOwnProperty.call(accountToCustomer, line.usageAccountId)
      ? accountToCustomer[line.usageAccountId]
      : undefined;
    if (typeof mapped === "string" && mapped.length > 0) {
      return { customerId: mapped, basis: "account-map" };
    }
  }
  if (customerTagKey !== undefined && customerTagKey.length > 0) {
    const tagged = Object.prototype.hasOwnProperty.call(line.tags, customerTagKey)
      ? line.tags[customerTagKey]
      : undefined;
    if (typeof tagged === "string" && tagged.length > 0) {
      return { customerId: tagged, basis: "tag" };
    }
  }
  return { customerId: null, basis: null };
}

export function buildShowbackInput({
  curLines,
  accountToCustomer,
  customerTagKey,
}: ShowbackAdapterInput): ShowbackInput {
  const lines: AttributedCurLine[] = [];
  const skipped: SkippedShowbackLine[] = [];

  for (const line of curLines) {
    if (!CURRENCY_RE.test(line.currency)) {
      skipped.push({ reason: "currency is missing or not a 3-letter code" });
      continue;
    }
    if (!MICROS_INT.test(line.amountMicros)) {
      skipped.push({ reason: "amount is not an integer micro-unit value" });
      continue;
    }
    const { customerId, basis } = attribute(line, accountToCustomer, customerTagKey);
    lines.push({
      customerId,
      basis,
      currency: line.currency,
      amountMicros: line.amountMicros,
      usageAccountId: line.usageAccountId,
      service: line.service,
    });
  }

  return { lines, skipped };
}
