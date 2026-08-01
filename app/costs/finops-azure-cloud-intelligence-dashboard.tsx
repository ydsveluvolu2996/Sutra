"use client";

import { useEffect, useState } from "react";
import type { FinopsDashboardCatalogEntry } from "../../lib/finops-dashboard-catalog";
import { FinopsCapabilityShell, type FinopsCapabilityViewState } from "./finops-capability-shell";
import styles from "./finops-azure-cloud-intelligence-dashboard.module.css";

type Filters = {
  subscriptionId: string;
  serviceName: string;
  regionName: string;
  resourceGroupName: string;
  pricingCategory: string;
  chargeCategory: string;
  tagKey: string;
  tagValue: string;
};

const EMPTY_FILTERS: Filters = { subscriptionId: "", serviceName: "", regionName: "", resourceGroupName: "", pricingCategory: "", chargeCategory: "", tagKey: "", tagValue: "" };
interface Amounts { currency: string; billedCostMicros: string; effectiveCostMicros: string | null; calculatedListDeltaMicros: string | null; calculatedContractedDeltaMicros: string | null }
interface Group { name: string; amounts: readonly Amounts[]; rowCount: number }
interface Resource { rowId: string; chargeDay: string; subscriptionName: string; resourceGroupName: string | null; resourceId: string | null; resourceName: string | null; resourceType: string | null; regionName: string | null; serviceName: string; productName: string | null; publisherName: string | null; chargeCategory: string; pricingCategory: string; commitmentDiscountType: string | null; commitmentDiscountStatus: string | null; consumedQuantityMicros: string; consumedUnit: string | null; billingCurrency: string; billedCostMicros: string; effectiveCostMicros: string | null; listCostMicros: string | null; contractedCostMicros: string | null; tags: readonly { key: string; value: string }[] }
interface SourceOption { sourceId: string; azureTenantId: string; billingScopeKind: string; status: string; activationReason: string }
export interface AzureCidReport {
  schema: "sutra.finops-azure-cid-dashboard.v1";
  sourceId: string;
  sourceState: string;
  availableSources: readonly SourceOption[];
  dashboard: { filterOptions: { subscriptions: readonly { id: string; name: string }[]; services: readonly string[]; regions: readonly string[]; resourceGroups: readonly string[]; pricingCategories: readonly string[]; chargeCategories: readonly string[]; tagKeys: readonly string[] }; summary: readonly Amounts[]; monthly: readonly Group[]; daily30: readonly Group[]; services: readonly Group[]; subscriptions: readonly Group[]; regions: readonly Group[]; resourceGroups: readonly Group[]; pricing: readonly Group[]; charges: readonly Group[]; resources: readonly Resource[]; resourcesTruncated: boolean; resultCount: number; limitations: readonly string[] };
  history: readonly { generationId: string; sourceGenerationId: string; state: string; completedAt: string; dataThroughAt: string; rowCount: number; currencyCount: number; datasetKind: string }[];
  freshness: { dataThroughAt: string; ageHours: number; staleAfterHours: number };
  evidence: { generationId: string; activeGenerationId: string | null; latestGenerationId: string | null; newerIncomplete: boolean; sourceGenerationId: string; manifestSha256: string; exportName: string; exportRunId: string; datasetKind: string; reconciliationState: string; rowsExhausted: boolean; coverage: { summaryMonths: number; resourceDetailDays: number; actualCostAvailable: boolean; amortizedOrEffectiveCostAvailable: boolean; priceSheetJoined: boolean; reservationRecommendationsJoined: boolean }; contentSha256: string; billingScopeKind: string; billingScopeHash: string };
  collector: { contractAvailable: true; durableRuntimeImplemented: true; cadence: string; sharedRuntimeRegistered: false; providerAdapterAvailable: false; reason: string };
}
interface AzureCidDiscovery { schema: "sutra.finops-azure-cid-dashboard.v1"; sourceId: string | null; sourceState: "configuration_required"; dashboard: null; availableSources: readonly SourceOption[]; activation: { ready: false; reason: string } }

function money(micros: string | null, currency: string): string {
  if (micros === null) return "Not supplied";
  const negative = micros.startsWith("-");
  const digits = negative ? micros.slice(1) : micros;
  const padded = digits.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const fraction = padded.slice(-6).replace(/0+$/u, "");
  return `${negative ? "-" : ""}${currency} ${whole}${fraction ? `.${fraction}` : ""}`;
}

export function azureCidCsvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function buildAzureCidCsv(rows: readonly Resource[]): string {
  const columns = ["date", "subscription", "resource_group", "resource_id", "resource_name", "resource_type", "region", "service", "product", "publisher", "charge_category", "pricing_category", "commitment_type", "commitment_status", "quantity_micros", "unit", "currency", "billed_cost_micros", "effective_cost_micros", "list_cost_micros", "contracted_cost_micros", "tags"];
  const lines = rows.map((row) => [row.chargeDay, row.subscriptionName, row.resourceGroupName ?? "", row.resourceId ?? "", row.resourceName ?? "", row.resourceType ?? "", row.regionName ?? "", row.serviceName, row.productName ?? "", row.publisherName ?? "", row.chargeCategory, row.pricingCategory, row.commitmentDiscountType ?? "", row.commitmentDiscountStatus ?? "", row.consumedQuantityMicros, row.consumedUnit ?? "", row.billingCurrency, row.billedCostMicros, row.effectiveCostMicros ?? "", row.listCostMicros ?? "", row.contractedCostMicros ?? "", row.tags.map((tag) => `${tag.key}=${tag.value}`).join(";")].map(azureCidCsvCell).join(","));
  return [columns.join(","), ...lines].join("\n");
}

function exportResources(rows: readonly Resource[]): void {
  const url = URL.createObjectURL(new Blob([buildAzureCidCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "sutra-azure-cid-visible-resources.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: readonly { value: string; label: string }[]; onChange(value: string): void }) {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}><option value="">All</option>{options.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>;
}
function choices(values: readonly string[]) { return values.map((value) => ({ value, label: value.replaceAll("_", " ") })); }
function state(value: string): FinopsCapabilityViewState { if (value === "complete") return "complete"; if (value === "empty") return "empty"; if (value === "stale") return "stale"; if (value === "partial") return "partial"; return "failed"; }

function GroupTable({ title, detail, rows }: { title: string; detail: string; rows: readonly Group[] }) {
  return <section className={styles.panel}><header><div><h3>{title}</h3><span>{detail}</span></div><strong>{rows.length} groups</strong></header><div className={styles.scroll} role="region" tabIndex={0} aria-label={title}><table><thead><tr><th>Dimension</th><th>Currency</th><th>Exported billed cost</th><th>Effective cost</th><th>Calculated list delta</th><th>Calculated contracted delta</th><th>Rows</th></tr></thead><tbody>{rows.flatMap((row) => row.amounts.map((amount) => <tr key={`${row.name}:${amount.currency}`}><td>{row.name}</td><td>{amount.currency}</td><td>{money(amount.billedCostMicros, amount.currency)}</td><td>{money(amount.effectiveCostMicros, amount.currency)}</td><td>{money(amount.calculatedListDeltaMicros, amount.currency)}</td><td>{money(amount.calculatedContractedDeltaMicros, amount.currency)}</td><td>{row.rowCount}</td></tr>))}</tbody></table></div></section>;
}

export function AzureCidReportView({ report, filters, onFiltersChange }: { report: AzureCidReport; filters: Filters; onFiltersChange(filters: Filters): void }) {
  const set = (key: keyof Filters, value: string) => onFiltersChange({ ...filters, [key]: value });
  const max = Math.max(1, ...report.dashboard.monthly.flatMap((point) => point.amounts.map((amount) => Math.abs(Number(BigInt(amount.billedCostMicros) / BigInt(1_000_000))))));
  const tagValues = [...new Set(report.dashboard.resources.flatMap((row) => row.tags.filter((tag) => filters.tagKey === "" || tag.key === filters.tagKey).map((tag) => tag.value)))].sort();
  return <section className={styles.root} aria-label="Cloud Intelligence Dashboard for Azure">
    <div className={styles.notice}><strong>Realized and calculated values remain separate.</strong> Exported billed cost is the realized cost measure. List-price and contracted-price deltas are calculated comparison opportunities—not realized savings. Currencies and consumption units are never combined.</div>
    {report.evidence.newerIncomplete ? <div className={styles.warning} role="status">A newer incomplete export is disclosed while the last complete immutable generation remains active.</div> : null}
    <section className={styles.filters} aria-label="Azure cost allocation filters"><Select label="Subscription" value={filters.subscriptionId} options={report.dashboard.filterOptions.subscriptions.map((item) => ({ value: item.id, label: `${item.name} · ${item.id}` }))} onChange={(value) => set("subscriptionId", value)} /><Select label="Service" value={filters.serviceName} options={choices(report.dashboard.filterOptions.services)} onChange={(value) => set("serviceName", value)} /><Select label="Region" value={filters.regionName} options={choices(report.dashboard.filterOptions.regions)} onChange={(value) => set("regionName", value)} /><Select label="Resource group" value={filters.resourceGroupName} options={choices(report.dashboard.filterOptions.resourceGroups)} onChange={(value) => set("resourceGroupName", value)} /><Select label="Pricing" value={filters.pricingCategory} options={choices(report.dashboard.filterOptions.pricingCategories)} onChange={(value) => set("pricingCategory", value)} /><Select label="Charge" value={filters.chargeCategory} options={choices(report.dashboard.filterOptions.chargeCategories)} onChange={(value) => set("chargeCategory", value)} /><Select label="Tag key" value={filters.tagKey} options={choices(report.dashboard.filterOptions.tagKeys)} onChange={(value) => onFiltersChange({ ...filters, tagKey: value, tagValue: "" })} /><Select label="Tag value" value={filters.tagValue} options={choices(tagValues)} onChange={(value) => set("tagValue", value)} /><button type="button" onClick={() => onFiltersChange(EMPTY_FILTERS)}>Clear filters</button></section>
    <section className={styles.cards} aria-label="Azure cost summary">{report.dashboard.summary.map((amount) => <article key={amount.currency}><span>Exported billed cost</span><strong>{money(amount.billedCostMicros, amount.currency)}</strong><small>{report.dashboard.resultCount} filtered rows · exact signed micros</small></article>)}<article><span>Dataset</span><strong>{report.evidence.datasetKind.replaceAll("_", " ")}</strong><small>{report.evidence.coverage.summaryMonths}-month summary · {report.evidence.coverage.resourceDetailDays}-day resource detail</small></article><article><span>Freshness</span><strong>{report.freshness.ageHours}h</strong><small>Data through {report.freshness.dataThroughAt}</small></article></section>
    <section className={styles.panel}><header><div><h3>Six-month cost trend</h3><span>Exported billed cost by month and currency</span></div></header><div className={styles.trend} role="img" aria-label="Six-month Azure billed cost trend">{report.dashboard.monthly.flatMap((point) => point.amounts.map((amount) => { const magnitude = Math.abs(Number(BigInt(amount.billedCostMicros) / BigInt(1_000_000))); return <div key={`${point.name}:${amount.currency}`} title={`${point.name}: ${money(amount.billedCostMicros, amount.currency)}`}><i style={{ height: `${Math.max(4, magnitude / max * 100)}%` }} /><small>{point.name}<br />{amount.currency}</small></div>; }))}</div></section>
    <section className={styles.grid}><GroupTable title="Service intelligence" detail="Cost by Azure service" rows={report.dashboard.services} /><GroupTable title="Subscription allocation" detail="Cost ownership by subscription" rows={report.dashboard.subscriptions} /><GroupTable title="Region allocation" detail="Cost by resource location" rows={report.dashboard.regions} /><GroupTable title="Resource-group allocation" detail="Cost by resource group" rows={report.dashboard.resourceGroups} /></section>
    <section className={styles.grid}><GroupTable title="Pricing and commitment coverage" detail="On-demand, commitment discount, spot, and other" rows={report.dashboard.pricing} /><GroupTable title="Charge classification" detail="Usage, purchase, tax, credit, refund, adjustment, and other" rows={report.dashboard.charges} /></section>
    <GroupTable title="30-day resource cost activity" detail="Daily resource-detail evidence; dates never inferred" rows={report.dashboard.daily30} />
    <section className={styles.panel}><header><div><h3>Resource and tag allocation detail</h3><span>Visible filtered Azure cost-export rows</span></div><button type="button" onClick={() => exportResources(report.dashboard.resources)}>Export visible resources</button></header><div className={styles.scroll} role="region" tabIndex={0} aria-label="Azure resource cost detail"><table><thead><tr><th>Date</th><th>Resource</th><th>Subscription / group</th><th>Service / region</th><th>Pricing / charge</th><th>Quantity</th><th>Billed cost</th><th>Effective cost</th><th>Tags</th></tr></thead><tbody>{report.dashboard.resources.map((row) => <tr key={row.rowId}><td>{row.chargeDay}</td><td>{row.resourceName ?? "Unnamed resource"}<small>{row.resourceType ?? "Type not supplied"} · {row.resourceId}</small></td><td>{row.subscriptionName}<small>{row.resourceGroupName ?? "Unattributed"}</small></td><td>{row.serviceName}<small>{row.regionName ?? "Unattributed"}</small></td><td>{row.pricingCategory.replaceAll("_", " ")}<small>{row.chargeCategory.replaceAll("_", " ")} · {row.commitmentDiscountType ?? "No commitment type"}</small></td><td>{row.consumedQuantityMicros} micro-units<small>{row.consumedUnit ?? "Unit not supplied"}</small></td><td>{money(row.billedCostMicros, row.billingCurrency)}</td><td>{money(row.effectiveCostMicros, row.billingCurrency)}</td><td>{row.tags.map((tag) => `${tag.key}=${tag.value}`).join(", ") || "No exported tags"}</td></tr>)}</tbody></table></div>{report.dashboard.resourcesTruncated ? <p>Only the first 500 filtered resource rows are rendered and exported. Refine filters for a narrower result.</p> : null}</section>
    <details className={styles.evidence}><summary>Export provenance, coverage, history, and explicit gaps</summary><dl><div><dt>Accepted generation</dt><dd>{report.evidence.activeGenerationId ?? "No complete accepted head"}</dd></div><div><dt>Source generation</dt><dd>{report.evidence.sourceGenerationId}</dd></div><div><dt>Export / run</dt><dd>{report.evidence.exportName} · {report.evidence.exportRunId}</dd></div><div><dt>Manifest SHA-256</dt><dd>{report.evidence.manifestSha256}</dd></div><div><dt>Billing scope</dt><dd>{report.evidence.billingScopeKind} · {report.evidence.billingScopeHash}</dd></div><div><dt>Daily durable runtime</dt><dd>{report.collector.durableRuntimeImplemented ? "Implemented" : "Unavailable"} · shared registration {report.collector.sharedRuntimeRegistered ? "active" : "pending"}</dd></div><div><dt>Collector adapter</dt><dd>{report.collector.reason}</dd></div></dl><h4>Immutable collection history</h4><ul>{report.history.map((item) => <li key={item.generationId}>{item.completedAt}: {item.state} · {item.datasetKind} · {item.rowCount} rows · {item.currencyCount} currencies</li>)}</ul><h4>Evidence limitations</h4><ul>{report.dashboard.limitations.map((item) => <li key={item}>{item.replaceAll("_", " ")}</li>)}</ul></details>
  </section>;
}

export function FinopsAzureCloudIntelligenceDashboard({ sourceId, dashboard }: { sourceId: string | null; dashboard: FinopsDashboardCatalogEntry }) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selectedSourceId, setSelectedSourceId] = useState(sourceId ?? "");
  const [request, setRequest] = useState<{ loading: boolean; report: AzureCidReport | null; sources: readonly SourceOption[]; activationReason: string | null; error: string | null }>({ loading: true, report: null, sources: [], activationReason: null, error: null });
  useEffect(() => { const controller = new AbortController(); const query = new URLSearchParams(); if (selectedSourceId !== "") query.set("sourceId", selectedSourceId); for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value); const frame = window.requestAnimationFrame(() => { setRequest((current) => ({ ...current, loading: true, report: null, error: null })); void fetch(`/api/v1/finops/azure-cloud-intelligence?${query}`, { signal: controller.signal, credentials: "same-origin" }).then(async (response) => { if (!response.ok) throw new Error("Azure cost export evidence request failed"); return response.json() as Promise<AzureCidReport | AzureCidDiscovery>; }).then((body) => { if (body.dashboard === null) { setRequest({ loading: false, report: null, sources: body.availableSources, activationReason: body.activation.reason, error: null }); if (selectedSourceId === "" && body.availableSources.length === 1) setSelectedSourceId(body.availableSources[0]?.sourceId ?? ""); } else setRequest({ loading: false, report: body, sources: body.availableSources, activationReason: "READY", error: null }); }, (error: unknown) => { if (!controller.signal.aborted) setRequest((current) => ({ ...current, loading: false, report: null, error: error instanceof Error ? error.message : "Azure cost export evidence request failed" })); }); }); return () => { window.cancelAnimationFrame(frame); controller.abort(); }; }, [selectedSourceId, filters]);
  const shown = request.error ? { state: "failed" as const, title: "Azure export evidence could not be verified", detail: request.error } : request.loading ? { state: "loading" as const, title: "Loading Azure cost intelligence", detail: "Discovering authorized Azure sources and reading the selected immutable generation." } : request.report === null ? { state: "configuration_required" as const, title: request.activationReason === "AZURE_SOURCE_NOT_SELECTED" ? "Select an Azure CID source" : "Azure export delivery is not ready", detail: request.sources.length === 0 ? "Register a tenant-scoped Azure identity and recurring Standard or FOCUS cost export. No sample data is shown." : `Activation state: ${request.activationReason ?? "AZURE_SOURCE_NOT_SELECTED"}. Configure identity, export delivery, storage access, and the provider adapter as indicated.` } : { state: state(request.report.sourceState), title: "Cloud Intelligence Dashboard for Azure", detail: "Six-month cost overview, 30-day resource detail, allocation, pricing, commitment, and charge views from exported evidence." };
  const report = request.report;
  const evidence = report === null ? null : { sourceLabel: `Azure Cost Management ${report.evidence.datasetKind} recurring export`, collectedAt: report.history[0]?.completedAt ?? null, dataThroughAt: report.freshness.dataThroughAt, freshnessAgeHours: report.freshness.ageHours, freshnessSlaHours: report.freshness.staleAfterHours, acceptedRecords: report.dashboard.resultCount, rejectedRecords: null, generationId: report.evidence.generationId, contentSha256: report.evidence.contentSha256, limitations: report.dashboard.limitations };
  const sourceSelector = request.sources.length === 0 ? undefined : <label className={styles.sourceSelector}>Azure source<select value={selectedSourceId} onChange={(event) => { setSelectedSourceId(event.target.value); setFilters(EMPTY_FILTERS); }}><option value="">Select source</option>{request.sources.map((source) => <option key={source.sourceId} value={source.sourceId}>{source.billingScopeKind.replaceAll("_", " ")} · {source.azureTenantId} · {source.activationReason.replaceAll("_", " ")}</option>)}</select></label>;
  return <FinopsCapabilityShell dashboard={dashboard} state={shown.state} stateTitle={shown.title} stateDetail={shown.detail} evidence={evidence} actions={sourceSelector}>{report === null ? null : <AzureCidReportView report={report} filters={filters} onFiltersChange={setFilters} />}</FinopsCapabilityShell>;
}
