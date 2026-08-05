import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const [route, component, css] = await Promise.all([
  readFile(path.join(root, "app/api/v1/finops/media-services-insights/route.ts"), "utf8"),
  readFile(path.join(root, "app/costs/finops-media-services-insights-dashboard.tsx"), "utf8"),
  readFile(path.join(root, "app/costs/finops-media-services-insights-dashboard.module.css"), "utf8"),
]);

test("Media Services API exposes the pinned definition in every HTTP-200 state", () => {
  assert.equal(route.match(/officialDefinition: MEDIA_SERVICES_OFFICIAL_DEFINITION/gu)?.length, 2);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getConnectionForOrg\(authenticated\.subject\.orgId/u);
  assert.match(route, /assertSessionCapability\(authenticated,"connection:read",connection\.customerId\)/u);
  assert.match(route, /MEDIA_SERVICES_AWS_ADAPTER_JOB_HANDLER_NOT_REGISTERED/u);
  assert.doesNotMatch(route, /searchParams\.get\("(?:orgId|customerId|payerAccountId)"\)/u);
});

test("Media Services official panel remains report-independent and responsive", () => {
  assert.match(component, /Official Media Services Insights definition coverage/u);
  assert.match(component, /state\.report\?\.officialDefinition \?\? state\.officialDefinition/u);
  assert.match(component, /upstream|complete public definition/iu);
  for (const selector of [".official", ".officialArtifacts", ".officialSheets", ".officialControls", ".officialPurposes"]) {
    assert.match(css, new RegExp(selector.replace(".", "\\."), "u"));
  }
  assert.match(css, /min-height:44px/u);
  assert.match(css, /@media\(max-width:760px\)/u);
});

test("Media Services official panel renders all sheets, purposes, controls and honest savings state", async () => {
  const vite = await createServer({ root, configFile:false, logLevel:"silent", plugins:[react()], server:{ middlewareMode:true } });
  try {
    const [dashboardModule, definitionModule] = await Promise.all([
      vite.ssrLoadModule("/app/costs/finops-media-services-insights-dashboard.tsx"),
      vite.ssrLoadModule("/lib/finops-media-services-official-definition.ts"),
    ]);
    const markup = renderToStaticMarkup(createElement(
      dashboardModule.MediaServicesOfficialDefinitionPanel,
      { definition: definitionModule.MEDIA_SERVICES_OFFICIAL_DEFINITION },
    ));
    for (const sheet of ["Executive Summary", "MediaLive Reservation &amp; Savings", "MediaConvert", "MediaConnect", "MediaLive", "MediaTailor", "MediaPackage", "Raw Data", "About"]) {
      assert.match(markup, new RegExp(sheet, "u"), sheet);
    }
    for (const purpose of ["Total media-services costs and month-over-month trends", "Current and potential MediaLive reservation savings", "Bandwidth utilization and peak usage", "Revenue per session", "Origin-request patterns and caching efficiency"]) {
      assert.match(markup, new RegExp(purpose, "u"), purpose);
    }
    assert.match(markup, /9 sheets · 144 visuals · 92 control placements/u);
    assert.match(markup, /Potential Reservation Savings Rate/u);
    assert.match(markup, /Versioned on-demand comparison rates/u);
    assert.match(markup, /up-to-75-percent reservation savings.*not tenant savings evidence/iu);
    assert.match(markup, /ab485a191da780a2/u);
    assert.match(markup, /a29384174b7eafb5/u);
    assert.doesNotMatch(markup, /fixture|sample|placeholder/iu);
  } finally {
    await vite.close();
  }
});
