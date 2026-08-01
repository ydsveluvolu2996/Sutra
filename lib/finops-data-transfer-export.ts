import type {
  DataTransferCostBasis,
  DataTransferDrilldown,
  DataTransferSnapshot,
} from "./finops-data-transfer.ts";

function csvCell(value: string | number | null): string {
  const raw = String(value ?? "");
  // CSV quoting does not disable spreadsheet formula execution. Preserve
  // signed integer evidence while neutralizing every other control prefix.
  const safe = /^(?:[=+@]|-(?!\d)|[\t\r])/u.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function costMicros(
  row: DataTransferDrilldown,
  costBasis: DataTransferCostBasis,
): string | null {
  return row.costs.find((cost) => cost.basis === costBasis)?.totalMicros ?? null;
}

/** Export only the currently filtered evidence rows; money stays exact micros. */
export function buildDataTransferEvidenceCsv(
  report: DataTransferSnapshot,
  rows: readonly DataTransferDrilldown[],
  costBasis: DataTransferCostBasis,
): string {
  const header = [
    "billing_period",
    "state",
    "currency",
    "cost_basis",
    "cost_micros",
    "category",
    "direction",
    "usage_account_id",
    "service",
    "provider_service_code",
    "provider_service_name",
    "provider_product_code",
    "provider_product_name",
    "provider_operation",
    "transfer_type",
    "source_location",
    "source_location_type",
    "destination_location",
    "path_evidence",
    "region",
    "availability_zone",
    "resource_id",
    "row_count",
    "normalized_bytes_micros",
    "classification_rule_ids",
    "usage_types",
    "source_line_ids",
    "generation_id",
    "manifest_sha256",
    "taxonomy_version",
    "taxonomy_sha256",
  ];
  const body = rows.map((row) => [
    report.scope.billingPeriod,
    report.state,
    row.currency,
    costBasis,
    costMicros(row, costBasis),
    row.category,
    row.direction,
    row.usageAccountId,
    row.service,
    row.provider.serviceCode,
    row.provider.serviceName,
    row.provider.productCode,
    row.provider.productName,
    row.provider.operation,
    row.provider.transferType,
    row.path.sourceLocation,
    row.path.sourceLocationType,
    row.path.destinationLocation,
    row.path.evidence,
    row.region,
    row.availabilityZone,
    row.resourceId,
    row.rowCount,
    row.normalizedBytesMicros,
    row.classificationRuleIds.join("|"),
    row.usageTypes.join("|"),
    row.sourceLineIds.join("|"),
    report.scope.generationId,
    report.source.manifestSha256,
    report.taxonomy.version,
    report.taxonomy.sha256,
  ].map(csvCell).join(","));
  return [header.map(csvCell).join(","), ...body].join("\n");
}
