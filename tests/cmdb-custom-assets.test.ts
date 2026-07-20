import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUILTIN_ASSET_TYPES,
  MAX_FIELDS,
  normalizeCustomAsset,
  parseAssetImport,
  parseCsvRows,
  toCmdbResource,
  type NormalizedCustomAsset,
} from "../lib/cmdb-custom-assets.ts";

describe("parseCsvRows (RFC-4180)", () => {
  it("parses quoted fields with embedded commas, quotes, and newlines", () => {
    const csv = 'name,notes\n"Acme, Inc","line1\nline2 with ""quote"""';
    const rows = parseCsvRows(csv);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], ["name", "notes"]);
    assert.deepEqual(rows[1], ["Acme, Inc", 'line1\nline2 with "quote"']);
  });

  it("tolerates CRLF line endings and a trailing newline without an empty row", () => {
    const rows = parseCsvRows("name,vendor\r\nOkta,Okta\r\n");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1], ["Okta", "Okta"]);
  });
});

describe("parseAssetImport — CSV", () => {
  it("imports rows, labels them 'imported', and lifts extra columns into fields", () => {
    const csv = 'name,external_id,vendor,environment\n"Acme, Inc",okta-01,Okta,production';
    const result = parseAssetImport({ format: "csv", data: csv, assetType: "saas-app" });
    assert.equal(result.rejected.length, 0);
    assert.equal(result.assets.length, 1);
    const asset = result.assets[0];
    assert.equal(asset.name, "Acme, Inc");
    assert.equal(asset.assetType, "saas-app");
    assert.equal(asset.source, "imported");
    assert.equal(asset.externalId, "okta-01");
    assert.deepEqual(asset.fields, { vendor: "Okta", environment: "production" });
  });

  it("discloses rejected rows with a reason and never drops them silently", () => {
    const csv = [
      "name,vendor",
      ",Okta", // missing name
      "Datadog,Datadog", // ok
      "Datadog,Splunk", // duplicate name
      "Extra,Extra,Extra", // column count mismatch
    ].join("\n");
    const result = parseAssetImport({ format: "csv", data: csv, assetType: "saas-app" });
    assert.deepEqual(result.assets.map((asset) => asset.name), ["Datadog"]);
    const rejectedRows = result.rejected.map((entry) => entry.row);
    // File lines: header=1, so data rows are 2,3,4,5.
    assert.deepEqual(rejectedRows, [2, 4, 5]);
    assert.match(result.rejected[0].reason, /name is required/u);
    assert.match(result.rejected[1].reason, /duplicate name/u);
    assert.match(result.rejected[2].reason, /columns but the header defines/u);
  });

  it("rejects the whole import (row 0) when the header lacks a name column", () => {
    const result = parseAssetImport({ format: "csv", data: "label,vendor\nOkta,Okta", assetType: "saas-app" });
    assert.equal(result.assets.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].row, 0);
    assert.match(result.rejected[0].reason, /must include a 'name' column/u);
  });

  it("rejects the whole import (row 0) for an invalid asset type", () => {
    const result = parseAssetImport({ format: "csv", data: "name\nOkta", assetType: "Not A Type" });
    assert.equal(result.assets.length, 0);
    assert.equal(result.rejected[0].row, 0);
    assert.match(result.rejected[0].reason, /asset type .* is invalid/u);
  });
});

describe("parseAssetImport — JSON", () => {
  it("parses an array of objects and stringifies scalar field values", () => {
    const json = JSON.stringify([
      { name: "core-switch", external_id: "sw-1", ports: 48, managed: true },
      { name: "edge-router" },
    ]);
    const result = parseAssetImport({ format: "json", data: json, assetType: "network-device" });
    assert.equal(result.rejected.length, 0);
    assert.equal(result.assets.length, 2);
    assert.equal(result.assets[0].externalId, "sw-1");
    assert.deepEqual(result.assets[0].fields, { ports: "48", managed: "true" });
    assert.deepEqual(result.assets[1].fields, {});
  });

  it("rejects a non-array (row 0) and a nested field value (per record)", () => {
    assert.equal(parseAssetImport({ format: "json", data: "{}", assetType: "custom" }).rejected[0].row, 0);
    const nested = JSON.stringify([{ name: "x", meta: { a: 1 } }]);
    const result = parseAssetImport({ format: "json", data: nested, assetType: "custom" });
    assert.equal(result.assets.length, 0);
    assert.equal(result.rejected[0].row, 1);
    assert.match(result.rejected[0].reason, /must be a scalar value/u);
  });

  it("reports invalid JSON as an import-level rejection", () => {
    const result = parseAssetImport({ format: "json", data: "not json", assetType: "custom" });
    assert.equal(result.rejected[0].row, 0);
    assert.match(result.rejected[0].reason, /not valid JSON/u);
  });
});

describe("parseAssetImport — empty input", () => {
  it("returns no assets and a row-0 disclosure for empty data", () => {
    const result = parseAssetImport({ format: "csv", data: "   ", assetType: "saas-app" });
    assert.deepEqual(result.assets, []);
    assert.equal(result.rejected[0].row, 0);
  });
});

describe("normalizeCustomAsset (manual single create)", () => {
  it("labels a valid asset 'manual' by default", () => {
    const outcome = normalizeCustomAsset({ assetType: "on-prem-server", name: "db-primary", fields: { rack: "A1" } });
    assert.ok(outcome.ok);
    assert.equal(outcome.asset.source, "manual");
    assert.deepEqual(outcome.asset.fields, { rack: "A1" });
  });

  it("rejects a missing name and an over-long fields map", () => {
    assert.equal(normalizeCustomAsset({ assetType: "custom", name: "" }).ok, false);
    const fields: Record<string, string> = {};
    for (let index = 0; index <= MAX_FIELDS; index += 1) fields[`k${index}`] = "v";
    const outcome = normalizeCustomAsset({ assetType: "custom", name: "ok", fields });
    assert.equal(outcome.ok, false);
  });
});

describe("toCmdbResource", () => {
  it("maps an asset into a PilotResource-compatible, deterministic shape", () => {
    const asset: NormalizedCustomAsset = {
      assetType: "saas-app",
      name: "Okta",
      source: "imported",
      externalId: "okta-01",
      fields: { vendor: "Okta", environment: "production" },
    };
    const resource = toCmdbResource(asset);
    assert.equal(resource.resourceKey, "custom:saas-app:Okta");
    assert.equal(resource.service, "saas-app");
    assert.equal(resource.resourceType, "saas-app");
    assert.equal(resource.nativeId, "okta-01");
    assert.equal(resource.arn, null);
    assert.equal(resource.region, "custom");
    assert.equal(resource.regionKey, "custom");
    assert.equal(resource.state, "unknown");
    assert.deepEqual(resource.tags, { vendor: "Okta", environment: "production" });
    assert.equal(resource.configuration.source, "imported");
    assert.equal(resource.configuration.assetType, "saas-app");
    assert.equal(resource.source.kind, "custom-asset");
    assert.equal(resource.source.origin, "imported");
    // Determinism: same input, identical output.
    assert.deepEqual(toCmdbResource(asset), resource);
  });

  it("falls back to the name as the native id when there is no external id", () => {
    const resource = toCmdbResource({ assetType: "custom", name: "widget", source: "manual", externalId: null, fields: {} });
    assert.equal(resource.nativeId, "widget");
  });
});

describe("built-in asset types", () => {
  it("offers the documented catalog", () => {
    assert.deepEqual([...BUILTIN_ASSET_TYPES], ["saas-app", "network-device", "on-prem-server", "custom"]);
  });
});
