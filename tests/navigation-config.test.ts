import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { Capability } from "../lib/auth-policy.ts";
import { groupContainsActiveItem, navGroups, visibleNavigation } from "../app/components/navigation-config.ts";

const allCapabilities = new Set<Capability>([
  "workspace:read",
  "membership:manage",
  "membership:manage:customer",
  "customer:create",
  "connection:read",
  "connection:manage",
  "sync:run",
  "finding:manage",
  "export:read",
]);

describe("grouped workspace navigation", () => {
  it("presents the customer-facing product areas in a stable order", () => {
    assert.deepEqual(navGroups.map((group) => group.label), [
      "Overview",
      "Onboarding",
      "CMDB",
      "Kubernetes",
      "Security",
      "Compliance",
      "FinOps",
      "Operations",
    ]);
    assert.deepEqual(
      visibleNavigation(allCapabilities).find((group) => group.key === "security")?.items.map((item) => item.label),
      ["Posture findings", "Finding exceptions", "Vulnerability & exposure", "Exploitability ranking", "Network exposure", "Flow-log coverage", "Registry inventory", "IaC scan", "Agentless scanning", "Security events", "Cloud detections", "Remediation cases", "Case routing"],
    );
    assert.deepEqual(
      visibleNavigation(allCapabilities).find((group) => group.key === "kubernetes")?.items.map((item) => item.label),
      [
        "Cluster overview",
        "Fleet health",
        "Posture trends",
        "Onboard cluster",
        "Clusters",
        "Namespaces",
        "Workloads",
        "Images & vulnerabilities",
        "Vulnerability updates",
        "Vulnerability management",
        "Software supply chain",
        "Exposure",
        "Issues",
        "Attack paths",
        "RBAC",
        "Effective permissions",
        "AWS IAM CIEM",
        "Network",
        "Runtime",
        "Drift",
        "Compliance",
        "Admission control",
        "Policies",
        "Scan history",
        "Coverage",
        "Inventory",
        "Security findings",
      ],
    );
    assert.equal(navGroups.some((group) => group.label === "Administration"), false);
  });

  it("keeps administration destinations in the account menu without a duplicate left-nav group", async () => {
    const accountMenu = await readFile(new URL("../app/components/account-menu.tsx", import.meta.url), "utf8");

    assert.equal(navGroups.some((group) => group.label === "Administration"), false);
    for (const href of ["/settings", "/settings/notifications", "/access", "/docs"]) {
      assert.match(accountMenu, new RegExp(`href=["']${href.replace("/", "\\/")}["']`, "u"));
    }
    assert.match(
      accountMenu,
      /capabilities\.has\("membership:manage"\) \|\| capabilities\.has\("membership:manage:customer"\)/u,
      "both organization and customer-scoped administrators keep Access & invitations in the account menu",
    );
  });

  it("sections cover every Kubernetes item exactly once (nothing hidden or duplicated)", () => {
    const kubernetes = navGroups.find((group) => group.key === "kubernetes");
    assert.ok(kubernetes?.sections, "the Kubernetes group defines display sections");
    const sectionKeys = kubernetes.sections.flatMap((section) => section.keys);
    // No duplicates across sections.
    assert.equal(sectionKeys.length, new Set(sectionKeys).size);
    // Exactly the set of item keys — every item is placed, none invented.
    assert.deepEqual(
      [...sectionKeys].sort(),
      [...kubernetes.items.map((item) => item.key)].sort(),
    );
  });

  it("lets customer managers finish assigned onboarding but reserves new client creation for org operators", () => {
    const readerCapabilities = new Set<Capability>(["workspace:read", "connection:read", "export:read"]);
    const readerItems = visibleNavigation(readerCapabilities).flatMap((group) => group.items);
    const customerAdminCapabilities = new Set<Capability>([
      "workspace:read",
      "connection:read",
      "connection:manage",
      "membership:manage:customer",
    ]);
    const customerAdminItems = visibleNavigation(customerAdminCapabilities).flatMap((group) => group.items);

    assert.equal(readerItems.some((item) => item.href === "/onboard"), false);
    // A reader reaches connection health without connection:manage. It used to
    // be an anchor into the onboarding page, which meant "check health" landed
    // on the Disable and Offboard controls; it is now its own read-only page.
    assert.equal(readerItems.some((item) => item.href === "/connection-health"), true);
    assert.equal(
      readerItems.some((item) => item.href.startsWith("/onboard#")),
      false,
      "no navigation entry may deep-link a reader into the onboarding form",
    );
    assert.equal(readerItems.some((item) => item.href === "/operations"), false);
    assert.equal(customerAdminItems.some((item) => item.href === "/onboard"), true);
    assert.equal(customerAdminItems.some((item) => item.href === "/onboard/client"), false);
  });

  it("identifies the active group without broadening route access", () => {
    const security = navGroups.find((group) => group.key === "security");
    assert.ok(security);
    assert.equal(groupContainsActiveItem(security, "vulnerabilities"), true);
    assert.equal(groupContainsActiveItem(security, "costs"), false);
  });
});
