import type {
  AwsMarketplaceCur2SpendRow,
  AwsMarketplaceSpendSummary,
  AwsMarketplaceSpgSnapshot,
} from "./finops-marketplace-spg.ts";

export interface MarketplaceSpgDashboardFilters {
  readonly accountId: string | null;
  readonly product: string | null;
  readonly seller: string | null;
  readonly currency: string | null;
  readonly billingPeriod: string | null;
  readonly agreementStatus: string | null;
  readonly expirationState: string | null;
  readonly licenseStatus: string | null;
}

export const MARKETPLACE_SPG_DASHBOARD_BOUNDS = Object.freeze({
  filterOptions: 250,
  rankedRows: 100,
  aggregateRows: 250,
  detailRows: 500,
});

interface MoneyBucket {
  billed: bigint;
  amortized: bigint;
  hasAmortized: boolean;
  rowCount: number;
}

function contains(value: string | null, expected: string | null): boolean {
  return expected === null
    || (value ?? "").toLocaleLowerCase().includes(expected.toLocaleLowerCase());
}

function addSpend(bucket: MoneyBucket, row: AwsMarketplaceCur2SpendRow): void {
  bucket.billed += BigInt(row.billedAmountMicros);
  if (row.amortizedAmountMicros !== null) {
    bucket.amortized += BigInt(row.amortizedAmountMicros);
    bucket.hasAmortized = true;
  }
  bucket.rowCount += 1;
}

export function sumMarketplaceSpend(
  rows: readonly AwsMarketplaceCur2SpendRow[],
): AwsMarketplaceSpendSummary[] {
  const totals = new Map<string, MoneyBucket>();
  for (const row of rows) {
    const bucket = totals.get(row.currency) ?? {
      billed: BigInt(0), amortized: BigInt(0), hasAmortized: false, rowCount: 0,
    };
    addSpend(bucket, row);
    totals.set(row.currency, bucket);
  }
  return [...totals].sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, value]) => ({
      currency,
      billedAmountMicros: value.billed.toString(),
      amortizedAmountMicros: value.hasAmortized
        ? value.amortized.toString() : null,
      rowCount: value.rowCount,
    }));
}

function spendRanking(
  rows: readonly AwsMarketplaceCur2SpendRow[],
  keyFor: (row: AwsMarketplaceCur2SpendRow) => string,
) {
  const grouped = new Map<string, Map<string, MoneyBucket>>();
  for (const row of rows) {
    const key = keyFor(row);
    const currencies = grouped.get(key) ?? new Map<string, MoneyBucket>();
    const bucket = currencies.get(row.currency) ?? {
      billed: BigInt(0), amortized: BigInt(0), hasAmortized: false, rowCount: 0,
    };
    addSpend(bucket, row);
    currencies.set(row.currency, bucket);
    grouped.set(key, currencies);
  }
  return [...grouped].flatMap(([key, currencies]) =>
    [...currencies].map(([currency, value]) => ({
      key,
      currency,
      billedAmountMicros: value.billed.toString(),
      amortizedAmountMicros: value.hasAmortized
        ? value.amortized.toString() : null,
      rowCount: value.rowCount,
    })))
    .sort((left, right) => left.currency.localeCompare(right.currency)
      || (BigInt(left.billedAmountMicros) === BigInt(right.billedAmountMicros)
        ? left.key.localeCompare(right.key)
        : BigInt(left.billedAmountMicros) > BigInt(right.billedAmountMicros) ? -1 : 1));
}

function bounded<T>(values: readonly T[], maximum: number) {
  return {
    values: values.slice(0, maximum),
    truncated: values.length > maximum,
  };
}

function decimalToMicros(value: string): bigint {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const micros = BigInt(whole) * BigInt(1_000_000)
    + BigInt(fraction.padEnd(6, "0"));
  return negative ? -micros : micros;
}

function licenseExpiration(endAt: string | null, nowEpochMs: number): string {
  if (endAt === null) return "NO_END_DATE";
  const remaining = Date.parse(endAt) - nowEpochMs;
  if (remaining < 0) return "EXPIRED";
  if (remaining <= 30 * 86_400_000) return "EXPIRING_30_DAYS";
  if (remaining <= 60 * 86_400_000) return "EXPIRING_60_DAYS";
  if (remaining <= 90 * 86_400_000) return "EXPIRING_90_DAYS";
  return "ACTIVE_BEYOND_90_DAYS";
}

export function projectMarketplaceSpgDashboard(
  snapshot: AwsMarketplaceSpgSnapshot,
  filters: MarketplaceSpgDashboardFilters,
  nowEpochMs = Date.now(),
) {
  const agreements = snapshot.agreements.filter((row) =>
    (filters.accountId === null || row.sourceAccountId === filters.accountId)
    && (filters.agreementStatus === null || row.status === filters.agreementStatus)
    && (filters.expirationState === null
      || row.expirationState === filters.expirationState)
    && contains(row.product?.productName ?? row.productId, filters.product)
    && contains(row.product?.sellerDisplayName ?? null, filters.seller));
  const licenses = snapshot.licenses.filter((row) =>
    (filters.accountId === null || row.beneficiaryAccountId === filters.accountId)
    && (filters.licenseStatus === null || row.status === filters.licenseStatus)
    && contains(row.productName, filters.product));
  const licenseIds = new Set(licenses.map((row) => row.licenseArn));
  const grants = snapshot.grants.filter((row) => licenseIds.has(row.licenseArn));
  const spendRows = snapshot.spend.rows.filter((row) =>
    (filters.accountId === null || row.linkedAccountId === filters.accountId)
    && contains(row.productName, filters.product)
    && contains(row.sellerName, filters.seller)
    && (filters.currency === null || row.currency === filters.currency)
    && (filters.billingPeriod === null
      || row.billingPeriod === filters.billingPeriod));

  const trends = new Map<string, AwsMarketplaceCur2SpendRow[]>();
  for (const row of spendRows) {
    const key = `${row.billingPeriod}:${row.currency}`;
    trends.set(key, [...(trends.get(key) ?? []), row]);
  }

  const deployment = new Map<string, {
    count: number;
    commitments: Map<string, bigint>;
  }>();
  for (const agreement of agreements.filter((row) => row.status === "ACTIVE")) {
    const key = agreement.product?.deployedOnAws ?? "METADATA_UNAVAILABLE";
    const bucket = deployment.get(key) ?? { count: 0, commitments: new Map() };
    bucket.count += 1;
    if (agreement.estimatedCharges !== null) {
      const { currency, amountMicros } = agreement.estimatedCharges;
      bucket.commitments.set(currency,
        (bucket.commitments.get(currency) ?? BigInt(0)) + BigInt(amountMicros));
    }
    deployment.set(key, bucket);
  }

  const charges = new Map<string, bigint>();
  for (const agreement of agreements) for (const charge of agreement.charges) {
    if (charge.chargeAt === null) continue;
    const month = charge.chargeAt.slice(0, 7);
    const key = `${month}:${charge.money.currencyCode}`;
    charges.set(key, (charges.get(key) ?? BigInt(0))
      + decimalToMicros(charge.money.amount));
  }

  const licenseExpiry = new Map<string, number>();
  const licenseStatus = new Map<string, number>();
  const licenseProducts = new Map<string, number>();
  for (const license of licenses) {
    const expiration = licenseExpiration(license.validity?.endAt ?? null, nowEpochMs);
    licenseExpiry.set(expiration, (licenseExpiry.get(expiration) ?? 0) + 1);
    licenseStatus.set(license.status, (licenseStatus.get(license.status) ?? 0) + 1);
    licenseProducts.set(license.productName,
      (licenseProducts.get(license.productName) ?? 0) + 1);
  }

  const accounts = bounded([...new Set([
    ...snapshot.agreements.map((row) => row.sourceAccountId),
    ...snapshot.licenses.map((row) => row.beneficiaryAccountId),
    ...snapshot.spend.rows.map((row) => row.linkedAccountId),
  ])].sort(), MARKETPLACE_SPG_DASHBOARD_BOUNDS.filterOptions);
  const products = bounded([...new Set([
    ...snapshot.agreements.map((row) => row.product?.productName ?? row.productId)
      .filter((value): value is string => value !== null),
    ...snapshot.licenses.map((row) => row.productName),
    ...snapshot.spend.rows.map((row) => row.productName),
  ])].sort(), MARKETPLACE_SPG_DASHBOARD_BOUNDS.filterOptions);
  const sellers = bounded([...new Set([
    ...snapshot.agreements.map((row) => row.product?.sellerDisplayName)
      .filter((value): value is string => value !== undefined),
    ...snapshot.spend.rows.map((row) => row.sellerName),
  ])].sort(), MARKETPLACE_SPG_DASHBOARD_BOUNDS.filterOptions);
  const currencies = bounded(
    [...new Set(snapshot.spend.rows.map((row) => row.currency))].sort(),
    MARKETPLACE_SPG_DASHBOARD_BOUNDS.filterOptions,
  );
  const periods = bounded(
    [...new Set(snapshot.spend.rows.map((row) => row.billingPeriod))]
      .sort().reverse(),
    MARKETPLACE_SPG_DASHBOARD_BOUNDS.filterOptions,
  );
  const sellerRanking = bounded(spendRanking(spendRows, (row) => row.sellerName),
    MARKETPLACE_SPG_DASHBOARD_BOUNDS.rankedRows);
  const productRanking = bounded(spendRanking(spendRows, (row) => row.productName),
    MARKETPLACE_SPG_DASHBOARD_BOUNDS.rankedRows);
  const accountRanking = bounded(spendRanking(spendRows, (row) => row.linkedAccountId),
    MARKETPLACE_SPG_DASHBOARD_BOUNDS.rankedRows);
  const invoiceRanking = bounded(spendRanking(spendRows,
    (row) => row.invoiceId ?? "INVOICE_NOT_SUPPLIED"),
  MARKETPLACE_SPG_DASHBOARD_BOUNDS.rankedRows);
  const chargeRows = bounded([...charges].sort(([left], [right]) =>
    left.localeCompare(right)).map(([key, amountMicros]) => ({
    month: key.slice(0, 7),
    currency: key.slice(8),
    amountMicros: amountMicros.toString(),
  })), MARKETPLACE_SPG_DASHBOARD_BOUNDS.aggregateRows);
  const licenseProductRows = bounded([...licenseProducts].sort((left, right) =>
    right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([productName, count]) => ({ productName, count })),
  MARKETPLACE_SPG_DASHBOARD_BOUNDS.aggregateRows);

  return {
    filters,
    filterOptions: {
      accounts: accounts.values,
      products: products.values,
      sellers: sellers.values,
      currencies: currencies.values,
      periods: periods.values,
    },
    summaries: sumMarketplaceSpend(spendRows),
    trends: [...trends].sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, rows]) => sumMarketplaceSpend(rows).map((sum) => ({
        billingPeriod: key.slice(0, 7), ...sum,
      }))),
    spendBySeller: sellerRanking.values,
    spendByProduct: productRanking.values,
    spendByAccount: accountRanking.values,
    spendByInvoice: invoiceRanking.values,
    agreementDeployment: [...deployment].sort(([left], [right]) =>
      left.localeCompare(right)).map(([status, value]) => ({
      status,
      activeAgreementCount: value.count,
      lifecycleCommitments: [...value.commitments].sort(([left], [right]) =>
        left.localeCompare(right)).map(([currency, amountMicros]) => ({
        currency, amountMicros: amountMicros.toString(),
      })),
    })),
    agreementChargesByMonth: chargeRows.values,
    licenseExpirationSummary: [...licenseExpiry].sort(([left], [right]) =>
      left.localeCompare(right)).map(([state, count]) => ({ state, count })),
    licenseStatusSummary: [...licenseStatus].sort(([left], [right]) =>
      left.localeCompare(right)).map(([status, count]) => ({ status, count })),
    licenseProductSummary: licenseProductRows.values,
    projectionTruncation: {
      filterOptions: accounts.truncated || products.truncated || sellers.truncated
        || currencies.truncated || periods.truncated,
      spendRankings: sellerRanking.truncated || productRanking.truncated
        || accountRanking.truncated || invoiceRanking.truncated,
      agreementCharges: chargeRows.truncated,
      licenseProducts: licenseProductRows.truncated,
    },
    agreements: agreements.slice(0, MARKETPLACE_SPG_DASHBOARD_BOUNDS.detailRows),
    agreementsTruncated: agreements.length > MARKETPLACE_SPG_DASHBOARD_BOUNDS.detailRows,
    licenses: licenses.slice(0, MARKETPLACE_SPG_DASHBOARD_BOUNDS.detailRows),
    licensesTruncated: licenses.length > MARKETPLACE_SPG_DASHBOARD_BOUNDS.detailRows,
    grants: grants.slice(0, MARKETPLACE_SPG_DASHBOARD_BOUNDS.detailRows),
    grantsTruncated: grants.length > MARKETPLACE_SPG_DASHBOARD_BOUNDS.detailRows,
    spendRows: spendRows.slice(0, MARKETPLACE_SPG_DASHBOARD_BOUNDS.detailRows),
    spendRowsTruncated: spendRows.length > MARKETPLACE_SPG_DASHBOARD_BOUNDS.detailRows,
    counts: {
      agreements: agreements.length,
      expiringWithin90Days: agreements.filter((row) =>
        row.expirationState.startsWith("EXPIRING_")).length,
      licenses: licenses.length,
      grants: grants.length,
      activeGrants: grants.filter((row) => row.status === "ACTIVE").length,
      spendRows: spendRows.length,
    },
  };
}
