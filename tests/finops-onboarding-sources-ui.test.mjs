import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * The onboarding screen must tell an operator exactly which FinOps dashboards
 * and data sources an onboarded account can feed, and must never imply that
 * data will flow when the permission pack is undeployed, reserved, or when the
 * provider adapter is not registered.
 *
 * These assertions are deliberately anchored to the existing declarations
 * (dashboard catalog, capability definitions, runtime registry, immutable
 * CloudFormation pack metadata) so the UI cannot drift into invention.
 */

const root = new URL("..", import.meta.url).pathname;

const vite = await createServer({
  root,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
after(async () => vite.close());

const ui = await vite.ssrLoadModule("/app/onboard/finops-onboarding-sources.tsx");
const map = await vite.ssrLoadModule("/app/onboard/finops-onboarding-source-map.ts");
const catalog = await vite.ssrLoadModule("/lib/finops-dashboard-catalog.ts");
const health = await vite.ssrLoadModule("/lib/finops-source-health.ts");
const registry = await vite.ssrLoadModule("/lib/finops-source-runtime-registry.ts");
const templateContract = await vite.ssrLoadModule("/lib/aws-template-contract.ts");

const html = renderToStaticMarkup(createElement(ui.FinopsOnboardingSources));
const coverage = map.buildFinopsOnboardingCoverage();

test("every catalog dashboard is rendered under its official level", () => {
  assert.equal(
    coverage.levels.reduce((total, group) => total + group.dashboards.length, 0),
    catalog.FINOPS_DASHBOARD_CATALOG.length,
  );
  for (const group of coverage.levels) {
    for (const dashboard of group.dashboards) assert.equal(dashboard.level, group.level);
  }
  assert.deepEqual(coverage.levels.map((group) => group.label), [
    "Foundational",
    "Advanced",
    "Additional",
  ]);
  for (const entry of catalog.FINOPS_DASHBOARD_CATALOG) {
    assert.ok(html.includes(entry.catalogId), `${entry.catalogId} is missing from the UI`);
    assert.ok(
      html.includes(entry.shortName.replaceAll("&", "&amp;")),
      `${entry.shortName} is missing from the UI`,
    );
  }
});

test("each dashboard keeps the catalog's glyph and tone", () => {
  for (const entry of catalog.FINOPS_DASHBOARD_CATALOG) {
    const dashboard = coverage.levels
      .flatMap((group) => group.dashboards)
      .find((candidate) => candidate.catalogId === entry.catalogId);
    assert.equal(dashboard.icon, entry.icon);
    assert.equal(dashboard.tone, entry.tone);
    assert.equal(dashboard.maturity, entry.currentMaturity);
  }
  assert.match(html, /nav-glyph-chip[^"]*" data-tone="cyan"/u);
});

test("source-to-dashboard mapping is taken from the capability definitions", () => {
  assert.equal(coverage.summary.awsBackedDashboards, health.FINOPS_CAPABILITY_DEFINITIONS.length);
  assert.equal(coverage.summary.awsBackedDashboards, 27);
  for (const definition of health.FINOPS_CAPABILITY_DEFINITIONS) {
    const entry = catalog.getFinopsDashboardCatalogEntry(definition.id);
    const dashboard = coverage.levels
      .flatMap((group) => group.dashboards)
      .find((candidate) => candidate.catalogId === entry.catalogId);
    assert.deepEqual(
      dashboard.requiredSources.map((source) => source.sourceId),
      [...definition.requiredSourceIds],
    );
    assert.deepEqual(
      dashboard.supplementalSources.map((source) => source.sourceId),
      [...definition.supplementalSourceIds],
    );
  }
});

test("no dashboard is presented as available or collecting", () => {
  assert.equal(coverage.summary.collectingNow, 0);
  for (const group of coverage.levels) {
    for (const dashboard of group.dashboards) {
      assert.ok(
        dashboard.blockers.length > 0,
        `${dashboard.catalogId} must state why it is not collecting`,
      );
      assert.match(
        dashboard.stateLabel,
        /Not collecting|Not collecting yet|Not fed by an AWS account/u,
      );
      assert.ok(html.includes(dashboard.stateLabel));
    }
  }
  // No dashboard may be badged as available, enabled or ready to collect. Having
  // every permission granted is still not collecting, so "awaiting first
  // delivery" must never soften into a positive claim.
  assert.doesNotMatch(html, /\bAvailable\b|\bEnabled\b|\bReady to collect\b/u);
  // Every AWS-backed dashboard states one of the three not-collecting reasons.
  assert.equal(
    (html.match(/Not collecting(?: yet)? — (?:permission pack|awaiting first delivery)/gu) ?? [])
      .length,
    coverage.summary.awsBackedDashboards,
  );
  assert.equal(
    coverage.summary.awaitingFirstDelivery
      + coverage.summary.awaitingPackDeployment
      + coverage.summary.packUnavailable,
    coverage.summary.awsBackedDashboards,
  );
});

test("the deployed onboarding template pack is read from the template, not assumed", async () => {
  assert.equal(coverage.templatePackVersion, templateContract.AWS_CUSTOMER_ROLE_TEMPLATE_VERSION);
  assert.ok(html.includes(coverage.templatePackVersion));
  const deployedTemplate = await readFile(
    `${root}infrastructure/customer-onboarding-role.yaml`,
    "utf8",
  );

  // The template the screen hands the customer now declares its FinOps source
  // contracts, and the version it tags must be the version this screen states.
  assert.match(deployedTemplate, /AdvancedFinopsSources: /u);
  assert.match(deployedTemplate, /FoundationalFinopsAddOn: /u);
  assert.match(
    deployedTemplate,
    new RegExp(`Key: sutra:permission-pack\\s*\\n\\s*Value: ${coverage.templatePackVersion.replaceAll(".", "\\.")}`, "u"),
  );

  // A pack is reported as deployed exactly when it is at or below the pack the
  // template tags. Nothing may claim deployment of a higher pack.
  const templateOrdinal = Number(/^standard-2026-08\.(\d+)$/u.exec(coverage.templatePackVersion)[1]);
  for (const group of coverage.levels) {
    for (const dashboard of group.dashboards) {
      if (dashboard.requiredPack === null) continue;
      assert.equal(
        dashboard.requiredPack.deployedByOnboardingTemplate,
        dashboard.requiredPack.ordinal <= templateOrdinal,
        `${dashboard.catalogId} requires ${dashboard.requiredPack.version}`,
      );
    }
  }

  // Deployment is never delivery: no dashboard is collecting regardless.
  assert.equal(coverage.summary.collectingNow, 0);
});

test("every declared source states its reads and its permission requirement", () => {
  const sources = coverage.levels
    .flatMap((group) => group.dashboards)
    .flatMap((dashboard) => [...dashboard.requiredSources, ...dashboard.supplementalSources]);
  assert.equal(new Set(sources.map((source) => source.sourceId)).size, 25);
  for (const source of sources) {
    const binding = registry.getFinopsSourceRuntimeBinding(source.sourceId);
    assert.equal(source.transport, binding.queryContract.transport);
    assert.equal(
      source.adapterRegistered,
      binding.evidenceAdapter.kind === "code_reference",
    );
    const reads = map.describeSourceReads(source);
    assert.ok(reads.length > 20, `${source.sourceId} does not describe what it reads`);
    if (binding.queryContract.operationSet.kind === "fixed_operations") {
      for (const operation of binding.queryContract.operationSet.operations) {
        assert.ok(reads.includes(operation), `${operation} missing from ${source.sourceId}`);
      }
    }
    assert.ok(
      ["successor_pack", "reserved_pack", "unassigned_pack", "no_aws_permission"]
        .includes(source.grant.kind),
    );
  }
});

test("declared source contracts match the immutable pack templates", async () => {
  const files = (await readdir(`${root}infrastructure`))
    .filter((name) => /^customer-onboarding-role-standard-2026-08\.\d+\.yaml$/u.test(name));
  const declaredBy = new Map();
  for (const name of files) {
    const version = `standard-2026-08.${/\.(\d+)\.yaml$/u.exec(name)[1]}`;
    const text = await readFile(`${root}infrastructure/${name}`, "utf8");
    const contracts = [
      ...(/AdvancedFinopsSources: (.+)/u.exec(text)?.[1].split(",") ?? []),
      ...(/FoundationalFinopsAddOn: (.+)/u.exec(text)?.[1].split(",") ?? []),
    ].map((value) => value.trim());
    for (const contract of contracts) {
      const existing = declaredBy.get(contract);
      const ordinal = Number(/\.(\d+)$/u.exec(version)[1]);
      if (existing === undefined || ordinal < existing.ordinal) {
        declaredBy.set(contract, { version, ordinal });
      }
    }
  }
  for (const [sourceId, grant] of Object.entries(map.FINOPS_ONBOARDING_SOURCE_GRANTS)) {
    if (grant.kind !== "successor_pack" || grant.contractId === null) continue;
    const earliest = declaredBy.get(grant.contractId);
    assert.ok(earliest !== undefined, `${sourceId}: no template declares ${grant.contractId}`);
    assert.equal(
      grant.pack.version,
      earliest.version,
      `${sourceId} must cite the earliest template declaring ${grant.contractId}`,
    );
  }
  // Sources the UI reports as having no pack at all: no template may declare a
  // contract for AWS Budgets, media services, or Trusted Advisor Priority.
  assert.deepEqual(
    Object.entries(map.FINOPS_ONBOARDING_SOURCE_GRANTS)
      .filter(([, grant]) => grant.kind === "unassigned_pack")
      .map(([sourceId]) => sourceId)
      .sort(),
    ["aws_budgets", "media_services_telemetry", "trusted_advisor_organization"],
  );
  for (const contract of declaredBy.keys()) {
    assert.doesNotMatch(contract, /budget|media|priority/u, `${contract} contradicts the UI`);
  }
});

test("reserved packs are exactly the successors this build's collector does not accept", async () => {
  const types = await readFile(`${root}services/aws-collector/src/types.ts`, "utf8");
  const exported = new Set(
    [...types.matchAll(/"(standard-2026-08\.\d+)" as const/gu)].map((found) => found[1]),
  );
  assert.deepEqual(
    [...exported].sort(),
    [...map.ACCEPTED_SUCCESSOR_PACK_VERSIONS].sort(),
    "the collector's pack constants changed: update app/onboard/finops-onboarding-source-map.ts so the onboarding UI stops calling a published pack reserved",
  );
  const reserved = Object.values(map.FINOPS_ONBOARDING_SOURCE_GRANTS)
    .filter((grant) => grant.kind === "reserved_pack");
  assert.ok(reserved.length >= 6, "the reserved Additional packs must be reported");
  for (const grant of reserved) {
    assert.equal(grant.pack.accepted, false);
    assert.ok(html.includes(grant.pack.version), `${grant.pack.version} is missing from the UI`);
    assert.ok(html.includes(grant.reservedFor));
  }
});

test("dashboards blocked by a reserved pack say so plainly", () => {
  const unavailable = coverage.levels
    .flatMap((group) => group.dashboards)
    .filter((dashboard) => dashboard.state === "pack_unavailable");
  const ids = unavailable.map((dashboard) => dashboard.catalogId).sort();
  // Every one of these Additional dashboards needs a successor pack that does
  // not exist in this build, or a source no pack declares at all.
  assert.deepEqual(ids, [
    "ADD-01", "ADD-04", "ADD-05", "ADD-08", "ADD-11", "ADD-12", "ADD-13",
    "ADV-08", "ADV-13",
  ]);
  for (const dashboard of unavailable) {
    assert.equal(dashboard.stateLabel, "Not collecting — permission pack unavailable");
    assert.ok(dashboard.blockers.some((blocker) =>
      /reserved for|No permission pack declares/u.test(blocker)));
  }
});

test("a source with no registered provider adapter is reported as not collecting", () => {
  const deferred = ["extended_support_inventory", "aws_pricing_catalog", "aws_organizations_taxonomy"];
  for (const sourceId of deferred) {
    assert.equal(
      registry.getFinopsSourceRuntimeBinding(sourceId).evidenceAdapter.kind,
      "deferred",
    );
  }
  const affected = coverage.levels
    .flatMap((group) => group.dashboards)
    .filter((dashboard) =>
      dashboard.requiredSources.some((source) => deferred.includes(source.sourceId)));
  assert.ok(affected.length >= 3);
  for (const dashboard of affected) {
    assert.ok(dashboard.blockers.some((blocker) =>
      blocker.includes("no registered provider evidence adapter")));
  }
  assert.ok(html.includes("Provider adapter not registered"));
});

test("Azure and GCP catalog entries are not claimed to be fed by an AWS role", () => {
  const nonAws = coverage.levels
    .flatMap((group) => group.dashboards)
    .filter((dashboard) => dashboard.state === "not_aws_backed");
  assert.deepEqual(nonAws.map((dashboard) => dashboard.catalogId), ["ADD-02", "ADD-03"]);
  for (const dashboard of nonAws) {
    assert.equal(dashboard.requiredSources.length, 0);
    assert.equal(dashboard.requiredPack, null);
    assert.equal(dashboard.stateLabel, "Not fed by an AWS account");
  }
});

test("the section renders no credential, ExternalId, account number or ARN", () => {
  assert.doesNotMatch(html, /arn:aws/u);
  assert.doesNotMatch(html, /\b\d{12}\b/u);
  assert.doesNotMatch(html, /ExternalId|AKIA|SecretAccess|aws_secret/u);
});

test("the existing onboarding flow is still mounted alongside the new section", async () => {
  const page = await readFile(`${root}app/onboard/page.tsx`, "utf8");
  assert.match(page, /<OnboardAccount \/>/u);
  assert.match(page, /<FinopsOnboardingSources \/>/u);
  const client = await readFile(`${root}app/onboard/onboard-account.tsx`, "utf8");
  assert.match(client, /^"use client";/u);
  // The coverage section must stay server-rendered: the runtime registry is
  // server-owned policy and must not be pulled into the client bundle.
  assert.doesNotMatch(
    await readFile(`${root}app/onboard/finops-onboarding-sources.tsx`, "utf8"),
    /"use client"/u,
  );
});
