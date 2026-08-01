import assert from "node:assert/strict";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");

test("Data Transfer dashboard renders official categories, filters, drilldown, export and lineage", async () => {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    server: { middlewareMode: true },
  });
  try {
    const panel = await vite.ssrLoadModule(
      "/app/costs/finops-cur-intelligence-panels.tsx",
    );
    const engine = await vite.ssrLoadModule("/lib/finops-data-transfer.ts");
    const costs = ["unblended", "net", "amortized", "list", "contracted", "public"]
      .map((basis) => ({
        basis,
        totalMicros: "1250000",
        contributingRowCount: 1,
        missingRowCount: 0,
        coverage: "complete",
      }));
    const drilldown = {
      category: "GLOBAL_ACCELERATOR",
      direction: "OUTBOUND",
      currency: "USD",
      usageAccountId: "123456789012",
      service: "AWS Global Accelerator",
      path: { sourceLocation: "North America", sourceLocationType: "AWS Region",
        destinationLocation: "Europe", evidence: "CUR2_PROVIDER_REPORTED" },
      provider: { serviceCode: "AWSGlobalAccelerator", serviceName: "AWS Global Accelerator",
        productCode: "AWSGlobalAccelerator", productName: "AWS Global Accelerator",
        operation: "Accelerator", transferType: "AWS Outbound" },
      region: "us-east-1",
      availabilityZone: "use1-az1",
      resourceId: "accelerator/evidence",
      rowCount: 1,
      costs,
      quantities: [{
        sourceUnit: "GB",
        quantityMicros: "1000000",
        normalizedBytesMicros: "1000000000000000",
        rowCount: 1,
      }],
      normalizedBytesMicros: "1000000000000000",
      classificationRuleIds: ["GLOBAL_ACCELERATOR_TRANSFER_PREMIUM_V1"],
      usageTypes: ["NA-EU-OUT-Bytes-Internet"],
      usageTypesTruncated: false,
      sourceLineIdCount: 1,
      sourceLineIds: ["line-render-1"],
      sourceLineIdsTruncated: false,
    };
    const report = {
      schemaVersion: "sutra.finops-data-transfer-snapshot.v1",
      state: "COMPLETE",
      complete: true,
      scope: {
        organizationId: "org_render",
        customerId: "customer_render",
        connectionId: "conn_render",
        exportName: "cur2-export",
        billingPeriod: "2026-07",
        generationId: `fbg_${"a".repeat(64)}`,
      },
      source: {
        kind: "AWS_CUR2_ACTIVE_GENERATION",
        evidenceId: "s3://billing/manifest.json#version",
        generationId: `fbg_${"a".repeat(64)}`,
        manifestSha256: "b".repeat(64),
        status: "SUCCEEDED",
        generatedAtIso: "2026-08-01T08:00:00.000Z",
        dataThroughAtIso: "2026-08-01T08:00:00.000Z",
        evaluatedAtIso: "2026-08-01T09:00:00.000Z",
        ageHours: 1,
        freshnessSlaHours: 48,
        errorCode: null,
        objectCoverage: {
          status: "complete",
          manifestObjectCount: 1,
          processedObjectCount: 1,
        },
      },
      taxonomy: engine.DATA_TRANSFER_TAXONOMY,
      coverage: {
        scannedRowCount: 1,
        transferCandidateRowCount: 1,
        classifiedRowCount: 1,
        unknownRowCount: 0,
        unclassifiedRowCount: 0,
        excludedNonTransferRowCount: 0,
        missingUsageTypeRowCount: 0,
        classification: "complete",
        dimensions: {
          account: "complete",
          service: "complete",
          region: "complete",
          resource: "complete",
          sourceLocation: "complete",
          destinationLocation: "complete",
          providerService: "complete",
          transferType: "complete",
        },
        byteNormalization: "complete",
        byteNormalizedRowCount: 1,
        missingQuantityRowCount: 0,
        unknownUnitRowCount: 0,
      },
      categorySummaries: [{
        category: "GLOBAL_ACCELERATOR",
        currency: "USD",
        rowCount: 1,
        directionCounts: { INBOUND: 0, OUTBOUND: 1, UNKNOWN: 0 },
        costs,
        quantities: drilldown.quantities,
        normalizedBytesMicros: drilldown.normalizedBytesMicros,
        byteNormalizedRowCount: 1,
        missingOrUnknownUnitRowCount: 0,
      }],
      drilldowns: [drilldown],
      limitations: ["CUR Region fields are not inferred traffic endpoints."],
    };
    const markup = renderToStaticMarkup(createElement(
      panel.DataTransferReport,
      { report },
    ));
    assert.match(markup, /Transfer cost intelligence/u);
    assert.match(markup, /Global Accelerator/u);
    assert.match(markup, /Data-transfer drilldown filters/u);
    assert.match(markup, /All categories/u);
    assert.match(markup, /All directions/u);
    assert.match(markup, /All accounts/u);
    assert.match(markup, /All services/u);
    assert.match(markup, /All Regions/u);
    assert.match(markup, /All source locations/u);
    assert.match(markup, /All destination locations/u);
    assert.match(markup, /All transfer types/u);
    assert.match(markup, /Export filtered evidence/u);
    assert.match(markup, /use1-az1/u);
    assert.match(markup, /North America/u);
    assert.match(markup, /Europe/u);
    assert.match(markup, /AWS Outbound/u);
    assert.match(markup, /GLOBAL_ACCELERATOR_TRANSFER_PREMIUM_V1/u);
    assert.match(markup, /Evidence, lineage, classification, and official parity limits/u);
    assert.match(markup, new RegExp("b".repeat(64), "u"));
    assert.doesNotMatch(markup, />PARTIAL</u);
  } finally {
    await vite.close();
  }
});
