import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const { FINOPS_AWS_HEALTH_OFFICIAL_DEFINITION: definition } = await import(
  "../lib/finops-aws-health-official-definition.ts"
);

test("ADV-06 pins the independently hashed official v3.1.0 artifacts", () => {
  assert.equal(
    definition.source.commit,
    "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
  );
  assert.equal(definition.source.version, "v3.1.0");
  assert.deepEqual(definition.source.manifest, {
    path: "dashboards/health-events/health-events.yaml",
    sha256:
      "64150dfa317077894fd352bf98e6a1aa59ed7557dc51065ee519095fa5e98509",
  });
  assert.deepEqual(definition.source.definition, {
    path: "dashboards/health-events/health-events-definition.yaml",
    sha256:
      "4c24253e3eb2bfb3d68f2ca39e07968136d82be32e9a63a9cddc6003a3340a6d",
  });
});

test("ADV-06 inventory accounts for every official sheet, visual and control", () => {
  assert.deepEqual(definition.totals, {
    sheets: 3,
    visuals: 33,
    parameterControls: 23,
    filterControls: 5,
    parameterDeclarations: 26,
    calculatedFields: 74,
    filterGroups: 35,
    datasets: 1,
    columnConfigurations: 0,
    visualTypes: {
      KPIVisual: 16,
      PieChartVisual: 2,
      BarChartVisual: 3,
      TableVisual: 8,
      ComboChartVisual: 1,
      PivotTableVisual: 2,
      InsightVisual: 1,
    },
  });
  assert.deepEqual(
    definition.sheets.map((sheet) => sheet.name),
    ["Main", "Quick View", "About"],
  );
  assert.equal(
    definition.sheets.reduce((sum, sheet) => sum + sheet.visualCount, 0),
    definition.totals.visuals,
  );
  assert.equal(
    definition.sheets.reduce(
      (sum, sheet) => sum + sheet.parameterControls.length,
      0,
    ),
    definition.totals.parameterControls,
  );
  assert.equal(
    definition.sheets.reduce(
      (sum, sheet) => sum + sheet.filterControls.length,
      0,
    ),
    definition.totals.filterControls,
  );

  const main = definition.sheets[0];
  assert.equal(main.visualCount, 25);
  assert.equal(main.parameterControls.length, 21);
  assert.deepEqual(main.filterControls, []);
  assert.deepEqual(main.parameterControls, [
    "STARTS AFTER",
    "STARTS BEFORE",
    "EVENT STATUS",
    "CATEGORY",
    "RESOURCE STATUS",
    "SUMMARY FORMAT",
    "ACTIONABILITY",
    "PERSONAS",
    "EVENT SCOPE",
    "CHART GROUPING",
    "DISPLAY MODE",
    "PAGE",
    "Payer Account",
    "SERVICE",
    "Event ARN",
    "Account Display Format",
    "ACCOUNT",
    "SUMMARY LENGTH (characters)",
    "LOOKBACK DAYS",
    "Near Days Threshold",
    "SEARCH",
  ]);

  const quickView = definition.sheets[1];
  assert.equal(quickView.visualCount, 7);
  assert.deepEqual(quickView.parameterControls, ["EVENT SCOPE", "Payer Accounts"]);
  assert.deepEqual(quickView.filterControls, [
    "EVENT STATUS",
    "RESOURCE STATUS",
    "CATEGORY",
    "ACTIONABILITY",
    "SERVICE",
  ]);
  assert.equal(definition.sheets[2].visualCount, 1);
});

test("ADV-06 API and UI expose the frozen definition and honest planning semantics", async () => {
  const [route, dashboard] = await Promise.all([
    readFile(
      new URL("../app/api/v1/finops/health-events/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/costs/finops-health-events-dashboard.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  assert.match(route, /officialDefinition:\s*FINOPS_AWS_HEALTH_OFFICIAL_DEFINITION/gu);
  assert.match(dashboard, /definition\.sheets\.map/gu);
  assert.match(dashboard, /sheet\.parameterControls/gu);
  assert.match(dashboard, /sheet\.filterControls/gu);
  assert.equal(definition.planningSemantics.collectionCadence, "daily");
  assert.equal(definition.planningSemantics.minimumDocumentedLagHours, 48);
  assert.equal(definition.planningSemantics.notRealTime, true);
  assert.equal(definition.sheets[0].nativeCoverage, "PARTIAL");
  assert.equal(definition.sheets[1].nativeCoverage, "PARTIAL");
  assert.equal(definition.sheets[2].nativeCoverage, "SUPPORTED");
});
